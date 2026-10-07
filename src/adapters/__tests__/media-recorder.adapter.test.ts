import { describe, expect, it, vi } from 'vitest';
import { MediaRecorderAdapter, type RecorderLike } from '../media-recorder.adapter';
import type { RecorderEventMap } from '../../ports/recorder.port';

interface FakeRecorder extends RecorderLike {
  /** 不经过主动 stop，模拟设备/系统直接令录制停止 */
  deviceStop: () => void;
  startCount: number;
}

function setup(options: { deny?: boolean; empty?: boolean } = {}) {
  const timers = new Map<number, { ordinal: number; fn: () => void }>();
  const intervals: Record<number, Array<() => void>> = { 1: [], 2: [] };
  let nowMs = 10_000;
  let nextId = 1;
  let sessionOrdinal = 0;
  const stoppedTracks: number[] = [];
  const makeStream = () => ({ getTracks: () => [{ stop: () => { stoppedTracks.push(nowMs); } }] }) as unknown as MediaStream;
  const createRecorder = vi.fn((stream: MediaStream) => {
    const recorder: FakeRecorder = {
      state: 'inactive', ondataavailable: null, onstop: null, startCount: 0,
      start() { this.state = 'recording'; this.startCount += 1; },
      stop() {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        if (!options.empty) this.ondataavailable?.({ data: new Blob(['voice'], { type: 'audio/webm' }) });
        this.onstop?.();
      },
      deviceStop() {
        this.state = 'inactive';
        // 真实浏览器在中断时同样会先冲刷缓冲数据再触发 stop（无有效声音时除外）
        if (!options.empty) this.ondataavailable?.({ data: new Blob(['voice'], { type: 'audio/webm' }) });
        this.onstop?.();
      },
    };
    return recorder;
  });
  const adapter = new MediaRecorderAdapter({
    getUserMedia: async () => {
      if (options.deny) throw new DOMException('denied', 'NotAllowedError');
      return makeStream();
    },
    createRecorder,
    setTimeout: (callback) => { const id = nextId++; timers.set(id, { ordinal: sessionOrdinal, fn: callback }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: (callback) => { const ordinal = sessionOrdinal; intervals[ordinal as 1 | 2].push(callback); return nextId++; },
    clearInterval: () => {},
    now: () => nowMs,
  });
  const events: { [K in keyof RecorderEventMap]?: RecorderEventMap[K][] } = {};
  (Object.keys({ status: 1, level: 1, elapsed: 1, stopped: 1, failed: 1 }) as Array<keyof RecorderEventMap>)
    .forEach((event) => { events[event] = [] as never; adapter.on(event, (payload) => (events[event] as unknown[]).push(payload)); });
  return {
    adapter, createRecorder,
    beginSession: () => { sessionOrdinal += 1; },
    advance: (ms: number) => { nowMs += ms; },
    fireTimeout: (ordinal?: number) => {
      timers.forEach((entry, id) => {
        if (ordinal === undefined || entry.ordinal === ordinal) { entry.fn(); timers.delete(id); }
      });
    },
    fireIntervals: (ordinal: 1 | 2) => { intervals[ordinal].forEach((fn) => fn()); },
    stoppedTracks: () => stoppedTracks,
    events,
  };
}

describe('MediaRecorderAdapter', () => {
  it('emits levels, reports real elapsed time and returns a complete blob on manual stop', async () => {
    const { adapter, beginSession, fireIntervals, advance, stoppedTracks, events } = setup();
    beginSession();
    await adapter.start((level) => events.level!.push({ level } as never));
    expect(adapter.status).toBe('recording');
    advance(3_500); fireIntervals(1);
    const blob = await adapter.stop();
    expect((events.elapsed!.at(-1) as { elapsed: number }).elapsed).toBeCloseTo(3.5, 5);
    expect(blob.size).toBe(5);
    expect(blob.type).toBe('audio/webm');
    expect(events.stopped).toHaveLength(1);
    expect((events.stopped![0] as { reason: string }).reason).toBe('manual');
    expect(stoppedTracks()).toHaveLength(1);
    expect(adapter.status).toBe('idle');
  });

  it('automatically stops at ten seconds without anyone calling stop()', async () => {
    const { adapter, beginSession, fireTimeout, advance, stoppedTracks, events } = setup();
    beginSession();
    await adapter.start(() => {});
    advance(10_000); fireTimeout();
    expect(events.stopped).toHaveLength(1);
    const payload = events.stopped![0] as { reason: string; duration: number; blob: Blob };
    expect(payload.reason).toBe('time-limit');
    expect(payload.duration).toBe(10);
    expect(payload.blob.size).toBeGreaterThan(0);
    expect(stoppedTracks()).toHaveLength(1);
    // 超时之后再点“结束”不会报错，也不会产生第二个终态
    await expect(adapter.stop()).rejects.toThrow('当前没有正在录制');
    expect(events.stopped).toHaveLength(1);
  });

  it('manual stop happening at the same instant as the time limit finalizes exactly once', async () => {
    const { adapter, beginSession, advance, fireTimeout, events } = setup();
    beginSession();
    await adapter.start(() => {});
    advance(10_000);
    const manual = adapter.stop(); // 手动结束先到
    fireTimeout();                 // 10s 定时器在同一拍触发
    await manual;
    expect(events.stopped).toHaveLength(1);
    expect((events.stopped![0] as { reason: string }).reason).toBe('manual');
  });

  it('treats a stop not initiated by the session as a device stop with a definite result', async () => {
    const { adapter, createRecorder, beginSession, advance, fireIntervals, events } = setup();
    beginSession();
    await adapter.start(() => {});
    advance(2_000); fireIntervals(1); // 心跳记录到真实时长
    createRecorder.mock.results[0].value.deviceStop();
    expect(events.stopped).toHaveLength(1);
    const payload = events.stopped![0] as { reason: string; duration: number };
    expect(payload.reason).toBe('device');
    expect(payload.duration).toBe(2);
  });

  it('reports a recoverable failure when the device stops without any valid audio', async () => {
    const { adapter, createRecorder, beginSession, events, stoppedTracks } = setup({ empty: true });
    beginSession();
    await adapter.start(() => {});
    createRecorder.mock.results[0].value.deviceStop();
    expect(events.failed).toHaveLength(1);
    expect((events.failed![0] as { reason: string; message: string }).reason).toBe('device');
    expect(events.stopped).toHaveLength(0);
    expect(stoppedTracks()).toHaveLength(1); // 即使失败也释放麦克风
    expect(adapter.status).toBe('idle');
  });

  it('turns permission denial into a failed event and never starts', async () => {
    const { adapter, createRecorder, events } = setup({ deny: true });
    await expect(adapter.start(() => {})).rejects.toBeInstanceOf(DOMException);
    expect(createRecorder).not.toHaveBeenCalled();
    expect((events.failed![0] as { reason: string }).reason).toBe('permission');
    expect(adapter.status).toBe('idle');
  });

  it('cancel releases the microphone and discards data', async () => {
    const { adapter, beginSession, stoppedTracks, events } = setup();
    beginSession();
    await adapter.start(() => {});
    await adapter.cancel();
    expect(stoppedTracks()).toHaveLength(1);
    expect(events.stopped).toHaveLength(0);
    expect(events.failed).toHaveLength(0);
    expect(adapter.status).toBe('idle');
  });

  it('a delayed callback from an abandoned session cannot affect a new recording', async () => {
    const { adapter, createRecorder, beginSession, fireTimeout, fireIntervals, advance, events, stoppedTracks } = setup();
    beginSession();
    await adapter.start(() => {});
    const oldRecorder: FakeRecorder = createRecorder.mock.results[0].value;
    await adapter.cancel();

    // 新会话
    beginSession();
    await adapter.start(() => {});
    const newRecorder: FakeRecorder = createRecorder.mock.results[1].value;
    expect(newRecorder).not.toBe(oldRecorder);

    // 旧会话的 10s 定时器与音量回调迟到
    fireTimeout(1); fireIntervals(1);
    expect(events.stopped).toHaveLength(0);

    // 旧 MediaRecorder 的 onstop 也迟到
    oldRecorder.deviceStop();
    expect(events.stopped).toHaveLength(0);
    expect(adapter.status).toBe('recording');
    expect(stoppedTracks()).toHaveLength(1); // 只有旧会话释放过轨道，新会话仍持有麦克风

    // 新会话自己的音量回调仍能更新时长
    advance(4_000); fireIntervals(2);
    expect((events.elapsed!.at(-1) as { elapsed: number }).elapsed).toBe(4);

    // 新会话正常结束，时长和数据只属于新会话
    const blob = await adapter.stop();
    expect(blob.size).toBe(5);
    expect((events.stopped![0] as { duration: number }).duration).toBe(4);
    expect(stoppedTracks()).toHaveLength(2);
  });

  it('starting again while a session is live aborts the old one first', async () => {
    const { adapter, beginSession, stoppedTracks } = setup();
    beginSession();
    await adapter.start(() => {});
    beginSession();
    await adapter.start(() => {});
    expect(stoppedTracks()).toHaveLength(1); // 旧麦克风已释放
    expect(adapter.status).toBe('recording');
    await adapter.stop();
    expect(stoppedTracks()).toHaveLength(2);
  });
});
