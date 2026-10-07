import { describe, expect, it, vi } from 'vitest';
import { useStudio, type StudioDependencies } from '../useStudio';
import { coverPresetFor } from '../../core/cover-presets';
import type { RecorderEventMap, RecorderPort, RecorderStopReason } from '../../ports/recorder.port';
import type { VoiceMeme } from '../../core/models';

type Listener<K extends keyof RecorderEventMap> = (payload: RecorderEventMap[K]) => void;
type AnyListener = (payload: RecorderEventMap[keyof RecorderEventMap]) => void;

class FakeRecorder implements RecorderPort {
  status: RecorderPort['status'] = 'idle';
  private listeners: { [K in keyof RecorderEventMap]?: Set<AnyListener> } = {};
  durationMs = 6_000;
  empty = false;
  deny = false;
  private elapsedTimer?: ReturnType<typeof setInterval>;
  private startCount = 0;
  private fireTimeLimit: () => void = () => {};

  on<K extends keyof RecorderEventMap>(event: K, listener: Listener<K>) {
    const set = (this.listeners[event] ??= new Set<AnyListener>());
    set.add(listener as AnyListener);
    return () => set.delete(listener as AnyListener);
  }
  private emit<K extends keyof RecorderEventMap>(event: K, payload: RecorderEventMap[K]) {
    this.listeners[event]?.forEach((fn) => (fn as Listener<K>)(payload));
  }

  async start(onLevel: (level: number) => void) {
    if (this.deny) {
      this.emit('failed', { reason: 'permission', message: '无法使用麦克风权限，请在浏览器设置中允许访问或导入音频。' });
      throw new DOMException('denied', 'NotAllowedError');
    }
    this.status = 'recording';
    this.emit('status', { status: 'recording' });
    const id = ++this.startCount;
    const startedAt = Date.now();
    this.elapsedTimer = setInterval(() => {
      if (id !== this.startCount) return;
      onLevel(0.5);
      this.emit('elapsed', { elapsed: Math.min(10, (Date.now() - startedAt) / 1000) });
    }, 10);
    this.fireTimeLimit = () => { if (id === this.startCount) void this.stop('time-limit'); };
  }
  async stop(reason: RecorderStopReason = 'manual') {
    if (this.status !== 'recording') {
      if (this.status === 'idle') throw new Error('当前没有正在录制的声音');
      return new Blob();
    }
    this.status = 'stopping';
    this.emit('status', { status: 'stopping' });
    clearInterval(this.elapsedTimer);
    const blob = this.empty ? new Blob([], { type: 'audio/webm' }) : new Blob(['voice'], { type: 'audio/webm' });
    this.status = 'idle';
    this.emit('status', { status: 'idle' });
    if (this.empty) this.emit('failed', { reason, message: '没有录制到有效声音，请重录。' });
    else this.emit('stopped', { reason, blob, duration: this.durationMs / 1000 });
    return blob;
  }
  /** 测试用：模拟 10 秒时限到达 */
  hitTimeLimit() { this.fireTimeLimit(); }
  /** 不经过主动 stop 模拟设备意外停止 */
  async deviceStop() {
    if (this.status !== 'recording') return;
    clearInterval(this.elapsedTimer);
    this.status = 'idle';
    this.emit('status', { status: 'idle' });
    if (this.empty) this.emit('failed', { reason: 'device', message: '录音被设备意外中断，且没有捕获到有效声音，请重录。' });
    else this.emit('stopped', { reason: 'device', blob: new Blob(['voice'], { type: 'audio/webm' }), duration: this.durationMs / 1000 });
  }
  async cancel() {
    if (this.status === 'idle') return;
    clearInterval(this.elapsedTimer);
    this.startCount += 1; // 旧回调失效
    this.status = 'idle';
    this.emit('status', { status: 'idle' });
  }
}

function dependencies(overrides: Partial<StudioDependencies> = {}, recorder = new FakeRecorder()) {
  const saved: VoiceMeme[] = [];
  const base: StudioDependencies = {
    recorder,
    analyzer: { analyze: async () => ({ duration: 2, features: { loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6 } }) },
    cropper: { inspect: vi.fn(async (blob: Blob) => ({ duration: blob.size ? recorder.durationMs / 1000 : 0, needsCrop:false })), crop: async (blob, range) => ({blob,duration:range.end-range.start}) },
    renderer: { render: async () => new Blob(['cover'], { type: 'image/png' }) },
    repository: { list: async()=>saved, save: async(m)=>{saved.push(m)}, rename:async()=>{}, delete:async()=>{} },
    share: { share: async () => 'shared' },
    ...overrides,
  };
  return base as StudioDependencies & { recorder: FakeRecorder };
}

describe('useStudio', () => {
  it('turns microphone denial into a recoverable error', async () => {
    const recorder = new FakeRecorder(); recorder.deny = true;
    const studio = useStudio(dependencies({}, recorder));
    await studio.startRecording();
    expect(studio.error.value).toContain('麦克风权限');
    expect(studio.stage.value).toBe('record');
    expect(studio.recorderStatus.value).toBe('idle');
  });

  it('moves recording through crop and emotion with manual override', async () => {
    const studio = useStudio(dependencies()); await studio.startRecording(); await studio.stopRecording();
    expect(studio.stage.value).toBe('crop');
    expect(studio.draft.duration).toBe(6); // 真实解码时长，而非固定 6 秒占位
    await studio.analyze(); expect(studio.emotion.value?.label).toBe('元气满满');
    studio.selectEmotion('温柔姐姐'); expect(studio.cover.value.label).toBe('温柔姐姐'); expect(studio.stage.value).toBe('emotion');
  });

  it('reaches crop automatically when the time limit stops the session, without clicking stop', async () => {
    const recorder = new FakeRecorder(); recorder.durationMs = 10_000;
    const studio = useStudio(dependencies({}, recorder));
    await studio.startRecording();
    recorder.hitTimeLimit();
    await Promise.resolve();
    expect(studio.stage.value).toBe('crop');
    expect(studio.recorderStatus.value).toBe('idle');
    expect(studio.draft.audio?.size).toBeGreaterThan(0);
    expect(studio.draft.duration).toBe(10);
    expect(studio.notice.value).toContain('自动结束');
  });

  it('surfaces a definite message and stays recoverable on an unexpected device stop', async () => {
    const recorder = new FakeRecorder(); recorder.durationMs = 2_000;
    const studio = useStudio(dependencies({}, recorder));
    await studio.startRecording();
    await recorder.deviceStop();
    expect(studio.stage.value).toBe('crop');
    expect(studio.notice.value).toContain('设备中断');
    expect(studio.draft.duration).toBe(2);
  });

  it('returns to record when a device stop produced no valid audio', async () => {
    const recorder = new FakeRecorder(); recorder.empty = true;
    const studio = useStudio(dependencies({}, recorder));
    await studio.startRecording();
    await recorder.deviceStop();
    expect(studio.stage.value).toBe('record');
    expect(studio.error.value).toContain('重录');
    expect(studio.draft.audio).toBeUndefined();
  });

  it('cancel during recording releases the session and clears the draft', async () => {
    const recorder = new FakeRecorder();
    const studio = useStudio(dependencies({}, recorder));
    await studio.startRecording();
    await studio.cancelRecording();
    expect(studio.stage.value).toBe('record');
    expect(studio.draft.audio).toBeUndefined();
    expect(studio.recorderStatus.value).toBe('idle');
    // 随后可以立即重录并正常完成
    await studio.startRecording(); await studio.stopRecording();
    expect(studio.stage.value).toBe('crop');
  });

  it('a delayed decode from an old take cannot change the new recording', async () => {
    const recorder = new FakeRecorder();
    const deps = dependencies({}, recorder);
    let resolveOldInspect: (v: { duration: number; needsCrop: boolean }) => void = () => {};
    const oldInspect = new Promise<{ duration: number; needsCrop: boolean }>((resolve) => { resolveOldInspect = resolve; });
    let call = 0;
    vi.mocked(deps.cropper.inspect).mockImplementation((): Promise<{ duration: number; needsCrop: boolean }> => {
      call += 1;
      return call === 1 ? oldInspect : Promise.resolve({ duration: 4, needsCrop: false });
    });
    const studio = useStudio(deps);
    await studio.startRecording();
    await recorder.stop();            // 第一次录音结束，解码挂起
    await studio.newRecording();      // 用户重录：旧 take 作废
    await studio.startRecording();
    await recorder.stop();            // 第二次录音结束并解码完成
    resolveOldInspect({ duration: 6, needsCrop: false }); // 旧解码迟到
    await Promise.resolve();
    expect(studio.stage.value).toBe('crop');
    expect(studio.draft.duration).toBe(4); // 只采用新 take 的时长
  });

  it('keeps the draft when saving fails and can edit an existing work', async () => {
    const studio = useStudio(dependencies({ repository: { list:async()=>[], save:async()=>{throw new DOMException('full','QuotaExceededError')}, rename:async()=>{}, delete:async()=>{} } }));
    studio.draft.audio = new Blob(['a']); studio.draft.duration = 1; studio.cover.value = coverPresetFor('温柔姐姐'); studio.emotion.value = { label:'温柔姐姐',confidence:.8,explanation:'柔和',scores:{'暴躁老哥':0,'温柔姐姐':1,'阴阳怪气':0,'元气满满':0} };
    studio.features.value = { loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2 };
    await studio.save(); expect(studio.error.value).toContain('保存失败'); expect(studio.draft.audio?.size).toBe(1);
    const existing = { id:'old',title:'旧作品',emotion:'温柔姐姐' as const,confidence:.8,features:{loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2},audio:new Blob(['a']),duration:1,cover:new Blob(['c']),coverConfig:coverPresetFor('温柔姐姐'),createdAt:'2026-10-05' };
    studio.editMeme(existing); expect(studio.draft.title).toBe('旧作品'); expect(studio.stage.value).toBe('cover');
  });
});
