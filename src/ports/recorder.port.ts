export type RecorderStatus = 'idle' | 'requesting' | 'recording' | 'stopping';
export type RecorderStopReason = 'manual' | 'time-limit' | 'device';

export interface RecorderEventMap {
  status: { status: RecorderStatus };
  level: { level: number };
  /** 已录制时长（秒），由录音会话基于墙上时钟计算，页面不再自造计时 */
  elapsed: { elapsed: number };
  /**
   * 录音会话唯一的终态出口：手动结束、达到 10 秒时限、设备意外停止
   * 最终都只从这里产生一次结果。
   */
  stopped: { reason: RecorderStopReason; blob: Blob; duration: number };
  /** 没有产出任何有效声音（如设备意外中断且无数据） */
  failed: { reason: RecorderStopReason | 'permission' | 'unknown'; message: string };
}

export interface RecorderPort {
  readonly status: RecorderStatus;
  start(onLevel: (level: number) => void): Promise<void>;
  /** 结束本次会话并返回完整声音；重复调用（含与时限同时发生）只会收尾一次 */
  stop(): Promise<Blob>;
  /** 放弃本次会话：释放麦克风，丢弃数据（重录 / 离页使用） */
  cancel(): Promise<void>;
  on<K extends keyof RecorderEventMap>(event: K, listener: (payload: RecorderEventMap[K]) => void): () => void;
}
