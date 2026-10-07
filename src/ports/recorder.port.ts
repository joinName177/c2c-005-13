export type RecordingStopReason = 'manual' | 'timeout' | 'device';

export interface RecordingTick {
  level: number;
  elapsedMs: number;
}

export interface RecorderEvents {
  onLevel?: (tick: RecordingTick) => void;
  /**
   * 录音会话到达终态且拿到声音数据时触发（手动结束 / 达到 10 秒 / 设备意外停止后仍有有效数据）。
   * 同一会话只触发一次；reason 标明真实结束来源。
   */
  onComplete?: (blob: Blob, reason: RecordingStopReason) => void;
  /**
   * 录音会话失败且没有可进入裁剪的声音时触发：权限拒绝、设备中断且无数据、空录音等。
   */
  onError?: (message: string) => void;
}

export interface RecorderPort {
  /** 打开麦克风并开始一段新的录音会话；旧会话的延迟回调不会作用于新会话。 */
  start(events: RecorderEvents): Promise<void>;
  /** 请求结束当前会话（幂等）。若恰好与时限结束/设备停止重合，只结算一次。 */
  stop(): Promise<void>;
  /** 放弃当前会话：停止录音并释放麦克风，不产生任何回调与草稿。 */
  cancel(): Promise<void>;
  /** 会话内已经过的毫秒数，未录音时为 0。 */
  readonly elapsedMs: number;
  readonly isRecording: boolean;
}
