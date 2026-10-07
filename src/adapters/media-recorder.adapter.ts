import type { RecorderEventMap, RecorderPort, RecorderStatus, RecorderStopReason } from '../ports/recorder.port';

export interface RecorderLike {
  state: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
}
interface RecorderDependencies {
  getUserMedia: () => Promise<MediaStream>;
  createRecorder: (stream: MediaStream) => RecorderLike;
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  setInterval: (callback: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
  /** 当前墙上时间（毫秒），测试中可注入 */
  now: () => number;
}

const MAX_DURATION_MS = 10_000;

const defaults = (): RecorderDependencies => ({
  getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true }),
  createRecorder: (stream) => new MediaRecorder(stream) as unknown as RecorderLike,
  setTimeout: (callback, ms) => window.setTimeout(callback, ms), clearTimeout: (id) => window.clearTimeout(id),
  setInterval: (callback, ms) => window.setInterval(callback, ms), clearInterval: (id) => window.clearInterval(id),
  now: () => Date.now(),
});

interface Session {
  id: number;
  recorder: RecorderLike;
  stream: MediaStream;
  chunks: Blob[];
  startedAt: number;
  timeoutId: number;
  intervalId: number;
  /** 终态只允许进入一次：手动结束与 10 秒定时器同时触发时据此合并 */
  settled: boolean;
  /** 本次停止是否由本会话主动发起（手动 / 时限）；否则属于设备意外停止 */
  stopRequested: boolean;
  reason: RecorderStopReason;
  /** 录制期间由定时心跳刷新的已录时长，避免依赖 onstop 到达时刻 */
  lastElapsedMs: number;
  resolveStop?: (blob: Blob) => void;
  rejectStop?: (cause: Error) => void;
}

type Listener<K extends keyof RecorderEventMap> = (payload: RecorderEventMap[K]) => void;
type AnyListener = (payload: RecorderEventMap[keyof RecorderEventMap]) => void;

export class MediaRecorderAdapter implements RecorderPort {
  private session?: Session;
  private pendingStop?: Promise<Blob>;
  private statusValue: RecorderStatus = 'idle';
  private generation = 0;
  private readonly listeners: { [K in keyof RecorderEventMap]?: Set<AnyListener> } = {};

  constructor(private readonly deps: RecorderDependencies = defaults()) {}

  get status() { return this.statusValue; }

  on<K extends keyof RecorderEventMap>(event: K, listener: Listener<K>): () => void {
    const set = (this.listeners[event] ??= new Set<AnyListener>());
    set.add(listener as AnyListener);
    return () => set.delete(listener as AnyListener);
  }

  private emit<K extends keyof RecorderEventMap>(event: K, payload: RecorderEventMap[K]) {
    this.listeners[event]?.forEach((listener) => (listener as Listener<K>)(payload));
  }

  private setStatus(status: RecorderStatus) {
    if (this.statusValue === status) return;
    this.statusValue = status;
    this.emit('status', { status });
  }

  async start(onLevel: (level: number) => void): Promise<void> {
    // 重录时若旧会话仍占着麦克风，先放弃它；旧会话的任何延迟回调都带旧 id，不再影响新会话
    await this.abortSession(this.session);

    const id = ++this.generation;
    this.setStatus('requesting');
    let stream: MediaStream;
    try {
      stream = await this.deps.getUserMedia();
    } catch (cause) {
      if (id === this.generation) {
        this.setStatus('idle');
        this.emit('failed', { reason: 'permission', message: '无法使用麦克风权限，请在浏览器设置中允许访问或导入音频。' });
      }
      throw cause;
    }
    if (id !== this.generation) {
      // 申请权限期间用户已开始另一次会话：释放本次流，绝不覆盖新会话
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    const recorder = this.deps.createRecorder(stream);
    const session: Session = {
      id, recorder, stream, chunks: [], startedAt: this.deps.now(),
      timeoutId: 0, intervalId: 0, settled: false, stopRequested: false, reason: 'manual', lastElapsedMs: 0,
    };
    this.session = session;
    const promise = new Promise<Blob>((resolve, reject) => {
      session.resolveStop = resolve;
      session.rejectStop = reject;
    });
    // 终态以 stopped / failed 事件为准；这个 Promise 只是 stop() 的同步等待便利，内部自吞 rejection
    promise.catch(() => {});
    // 保留 promise 给同一 tick 内可能立即调用的 stop()；终态后清空
    this.pendingStop = promise;

    recorder.ondataavailable = (event) => {
      if (session.id === this.generation && event.data.size) session.chunks.push(event.data);
    };
    recorder.onstop = () => {
      // 设备/浏览器侧停止（iOS 中断、被系统抢占）也只走这一个收尾出口；
      // 主动发起的停止保留既定原因（manual / time-limit），未发起过才判定为 device
      if (session.id === this.generation) {
        void this.finalize(session, session.stopRequested ? session.reason : 'device');
      }
    };

    recorder.start();
    this.setStatus('recording');

    session.intervalId = this.deps.setInterval(() => {
      if (session.id !== this.generation) return;
      onLevel(0.5);
      const elapsedMs = Math.min(MAX_DURATION_MS, this.deps.now() - session.startedAt);
      session.lastElapsedMs = elapsedMs;
      this.emit('elapsed', { elapsed: elapsedMs / 1000 });
    }, 100);

    session.timeoutId = this.deps.setTimeout(() => {
      if (session.id === this.generation) void this.stop('time-limit');
    }, MAX_DURATION_MS);
  }

  async stop(reason: RecorderStopReason = 'manual'): Promise<Blob> {
    const session = this.session;
    if (!session) {
      // 终态之后重复点击结束：返回同一份已完成结果，绝不报“没有正在录制”
      if (this.pendingStop) return this.pendingStop;
      throw new Error('当前没有正在录制的声音');
    }
    const result = this.pendingStop!;
    if (this.statusValue === 'recording') this.setStatus('stopping');
    // 先到的原因生效：手动点击与 10s 定时器同时发生时只收尾一次
    if (!session.stopRequested) {
      session.reason = reason;
      session.stopRequested = true;
      // 在做出停止决定的一刻定格时长，而不是等 onstop 异步到达时再读时钟
      session.lastElapsedMs = Math.min(MAX_DURATION_MS, this.deps.now() - session.startedAt);
    }
    if (session.recorder.state !== 'inactive') session.recorder.stop();
    return result; // onstop 可能已同步把 pendingStop 清空，因此返回提前捕获的同一个 Promise
  }

  async cancel(): Promise<void> {
    await this.abortSession(this.session);
    this.setStatus('idle');
  }

  /** 唯一终态出口：由 MediaRecorder 的 onstop 驱动，三种结束原因汇合于此 */
  private async finalize(session: Session, reason: RecorderStopReason) {
    if (session.settled) return; // 手动结束恰逢时限：去重，只处理一次
    session.settled = true;
    session.reason = reason;
    this.clearTimers(session);

    // 主动结束时时长在停止决定一刻已定格；设备意外停止则取最后一次心跳或当前时钟
    const elapsedMs = Math.max(session.lastElapsedMs, reason === 'device' ? this.deps.now() - session.startedAt : 0);
    const duration = Math.min(MAX_DURATION_MS, elapsedMs) / 1000;
    const blob = new Blob(session.chunks, { type: session.chunks[0]?.type || 'audio/webm' });
    session.stream.getTracks().forEach((track) => track.stop()); // 无论成功失败都释放麦克风

    if (session.id !== this.generation || !this.session) return; // 旧会话的延迟回调，丢弃

    this.session = undefined;
    this.pendingStop = undefined;
    this.setStatus('idle');

    if (!blob.size) {
      const message = reason === 'device' ? '录音被设备意外中断，且没有捕获到有效声音，请重录。' : '没有录制到有效声音，请重录。';
      this.emit('failed', { reason, message });
      session.rejectStop?.(new Error(message));
      return;
    }
    this.emit('stopped', { reason, blob, duration });
    session.resolveStop?.(blob);
  }

  private async abortSession(session: Session | undefined) {
    if (!session) { this.pendingStop = undefined; return; }
    this.generation += 1; // 让该会话的 timeout/interval/ondataavailable/onstop 全部失效
    this.clearTimers(session);
    if (session.recorder.state !== 'inactive') {
      // onstop 仍可能异步触发，但 generation 已变，finalize 不会再产生任何事件
      try { session.recorder.stop(); } catch { /* 设备已释放，忽略 */ }
    }
    session.stream.getTracks().forEach((track) => track.stop());
    session.settled = true;
    const error = new Error('录音已取消');
    // 此时 onstop 可能已同步重入，stop() 拿到的 Promise 未必有人 await：先自吞 rejection 再拒绝
    this.pendingStop?.catch(() => {});
    session.rejectStop?.(error);
    if (this.session === session) { this.session = undefined; this.pendingStop = undefined; }
  }

  private clearTimers(session: Session) {
    this.deps.clearTimeout(session.timeoutId);
    this.deps.clearInterval(session.intervalId);
    session.timeoutId = 0;
    session.intervalId = 0;
  }
}
