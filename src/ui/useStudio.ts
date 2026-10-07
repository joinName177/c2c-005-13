import { ref, reactive } from 'vue';
import { classifyEmotion } from '../core/emotion-engine';
import { coverPresetFor } from '../core/cover-presets';
import type { AudioFeatures, CoverConfig, EmotionLabel, EmotionResult, StudioStage, VoiceMeme } from '../core/models';
import type { RecorderPort, RecorderStatus, RecorderStopReason } from '../ports/recorder.port';
import type { AudioAnalyzerPort } from '../ports/audio-analyzer.port';
import type { AudioCropperPort } from '../ports/audio-cropper.port';
import type { CoverRendererPort } from '../ports/cover-renderer.port';
import type { MemeRepository } from '../ports/meme-repository.port';
import type { SharePort } from '../ports/share.port';

export interface StudioDependencies { recorder: RecorderPort; analyzer: AudioAnalyzerPort; cropper: AudioCropperPort; renderer: CoverRendererPort; repository: MemeRepository; share: SharePort }

export function useStudio(deps: StudioDependencies) {
  const stage = ref<StudioStage>('record'); const error = ref(''); const notice = ref(''); const level = ref(0);
  const recorderStatus = ref<RecorderStatus>(deps.recorder.status);
  const elapsed = ref(0);
  const draft = reactive<{ id?: string; title: string; audio?: Blob; duration: number; cropStart: number; cropEnd: number }>({ title: '我的声音表情', duration: 0, cropStart: 0, cropEnd: 0 });
  const emotion = ref<EmotionResult>(); const features = ref<AudioFeatures>(); const cover = ref<CoverConfig>(coverPresetFor('元气满满')); const collection = ref<VoiceMeme[]>([]);

  // 每次开始录音递增一个“条目代号”：旧会话迟到的 stopped / 解码结果一律作废，不能影响新录音
  let take = 0;
  // 正在收尾解码的条目代号：同一 take 只解码一次（手动结束恰逢时限），但新 take 不被旧 take 的挂起解码阻塞
  let settlingTake = -1;
  const unsubscribers: Array<() => void> = [];
  unsubscribers.push(deps.recorder.on('status', ({ status }) => { recorderStatus.value = status; }));
  unsubscribers.push(deps.recorder.on('elapsed', ({ elapsed: value }) => { elapsed.value = value; }));
  unsubscribers.push(deps.recorder.on('stopped', (payload) => { void settle(payload.blob, payload.reason); }));
  unsubscribers.push(deps.recorder.on('failed', ({ message }) => {
    // 设备意外停止且无有效声音 / 权限拒绝：麦克风已由会话释放，这里只负责让页面恢复可操作
    settlingTake = -1;
    elapsed.value = 0; level.value = 0;
    error.value = message;
    stage.value = 'record';
  }));

  async function startRecording() {
    if (recorderStatus.value === 'requesting' || recorderStatus.value === 'recording') return;
    error.value = ''; notice.value = '';
    take += 1; settlingTake = -1;
    draft.audio = undefined; draft.duration = 0; draft.cropStart = 0; draft.cropEnd = 0;
    elapsed.value = 0; level.value = 0;
    try {
      await deps.recorder.start((value) => { level.value = value; });
      notice.value = '正在录音，最长 10 秒';
    } catch {
      // 权限失败的文案以会话 failed 事件为准；此处兜底避免未捕获拒绝
      if (!error.value) error.value = '无法使用麦克风权限，请在浏览器设置中允许访问或导入音频。';
    }
  }

  /** 页面上的“结束”只表达意图；真正过场统一由 stopped 事件驱动，避免两条通路重复解码 */
  async function stopRecording() {
    if (recorderStatus.value !== 'recording') return;
    try { await deps.recorder.stop(); } catch { /* 会话已终态时忽略，结果以 stopped 事件为准 */ }
  }

  /** 录音中放弃本次录音：释放麦克风、清空数据，页面回到可重录状态 */
  async function cancelRecording() {
    const id = take;
    try { await deps.recorder.cancel(); } catch { /* 设备已释放 */ }
    if (id !== take) return;
    settlingTake = -1;
    draft.audio = undefined; draft.duration = 0; draft.cropStart = 0; draft.cropEnd = 0;
    elapsed.value = 0; level.value = 0; error.value = '';
    notice.value = '已放弃本次录音，可以重新开始';
    stage.value = 'record';
  }

  /** 三种结束原因（手动 / 时限 / 设备）唯一的过场出口：解码成功、确认有真实时长后才进入裁剪 */
  async function settle(blob: Blob, reason: RecorderStopReason) {
    const id = take;
    if (settlingTake === id) return; // 手动结束恰逢时限：同一 take 只解码、过场一次
    settlingTake = id;
    try {
      const info = await deps.cropper.inspect(blob);
      // 解码期间用户已重录 / 开始新会话：旧 take 的迟到结果直接丢弃
      if (id !== take) return;
      elapsed.value = 0; level.value = 0;
      if (!blob.size || info.duration <= 0) {
        settlingTake = -1;
        error.value = '没有录制到有效声音，请重录。';
        stage.value = 'record';
        return;
      }
      draft.audio = blob;
      draft.duration = info.duration;
      draft.cropStart = 0;
      draft.cropEnd = Math.min(10, info.duration);
      stage.value = 'crop';
      error.value = '';
      notice.value = reason === 'time-limit'
        ? '已录满 10 秒并自动结束，可以试听并裁剪'
        : reason === 'device'
          ? `录音被设备中断，已保留已录制的 ${info.duration.toFixed(1)} 秒声音`
          : info.needsCrop ? '音频超过 10 秒，请选择保留片段' : '录音完成，可以试听并分析';
    } catch {
      if (id !== take) return;
      settlingTake = -1;
      error.value = '录音无法解码，请重录或导入音频。';
      stage.value = 'record';
    }
  }

  async function importAudio(blob: Blob) {
    take += 1; settlingTake = -1; error.value = ''; notice.value = '';
    const info = await deps.cropper.inspect(blob);
    if (info.duration <= 0) { error.value = '该文件没有有效声音，请更换文件。'; return; }
    draft.audio = blob; draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration); stage.value = 'crop';
  }
  async function analyze() { if (!draft.audio) { error.value = '请先录制或导入一段声音'; return; } const cropped = await deps.cropper.crop(draft.audio, { start: draft.cropStart, end: draft.cropEnd }); draft.audio = cropped.blob; draft.duration = cropped.duration; const result = await deps.analyzer.analyze(cropped.blob); features.value = result.features; emotion.value = classifyEmotion(result.features); cover.value = coverPresetFor(emotion.value.label); stage.value = 'emotion'; }
  function selectEmotion(label: EmotionLabel) { const current = emotion.value ?? classifyEmotion({ loudness:0,dynamics:0,pitch:0,zeroCrossing:0,pauseRatio:1,tempoVariation:0 }); emotion.value = { ...current, label, explanation: `已手动选择「${label}」标签。` }; cover.value = { ...coverPresetFor(label), title: cover.value.title || label }; }
  function goCover() { stage.value = 'cover'; }
  async function save(target?: HTMLCanvasElement) { if (!draft.audio || !emotion.value || !features.value) { error.value = '作品信息尚未完整，请先完成声音分析'; return; } try { const coverBlob = await deps.renderer.render(cover.value, target); const meme: VoiceMeme = { id: draft.id ?? `meme-${Date.now()}`, title: draft.title.trim() || '未命名声音', emotion: emotion.value.label, confidence: emotion.value.confidence, features: features.value, audio: draft.audio, duration: draft.duration, cover: coverBlob, coverConfig: { ...cover.value }, createdAt: new Date().toISOString() }; await deps.repository.save(meme); await loadCollection(); stage.value = 'collection'; notice.value = '作品已保存到本地'; } catch { error.value = '保存失败，本次编辑内容仍保留，请检查浏览器存储空间。'; } }
  async function loadCollection() { collection.value = (await deps.repository.list()).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  function editMeme(meme: VoiceMeme) { Object.assign(draft, { id:meme.id,title:meme.title,audio:meme.audio,duration:meme.duration,cropStart:0,cropEnd:meme.duration }); features.value = meme.features; emotion.value = { label:meme.emotion,confidence:meme.confidence,explanation:'编辑已保存作品',scores:{'暴躁老哥':0,'温柔姐姐':0,'阴阳怪气':0,'元气满满':0} }; cover.value = { ...meme.coverConfig }; stage.value = 'cover'; }
  async function deleteMeme(id: string) { await deps.repository.delete(id); await loadCollection(); }
  async function shareMeme(meme: VoiceMeme) { const result = await deps.share.share(meme); notice.value = result === 'shared' ? '已打开系统分享' : '浏览器不支持文件分享，已下载音频和封面'; }
  /** 从裁剪页重录 / 新建：先释放任何仍存活的录音会话，再清空创作状态 */
  async function newRecording() {
    await deps.recorder.cancel();
    take += 1; settlingTake = -1;
    draft.id = undefined; draft.title = '我的声音表情'; draft.audio = undefined; draft.duration = 0; draft.cropStart = 0; draft.cropEnd = 0;
    emotion.value = undefined; features.value = undefined;
    elapsed.value = 0; level.value = 0; error.value = ''; notice.value = '';
    stage.value = 'record';
  }
  /** 离开页面（组件卸载）：放弃录音并释放麦克风，注销全部订阅 */
  async function dispose() {
    await deps.recorder.cancel();
    unsubscribers.forEach((off) => off());
  }
  return { stage,error,notice,level,elapsed,recorderStatus,draft,emotion,features,cover,collection,startRecording,stopRecording,cancelRecording,importAudio,analyze,selectEmotion,goCover,save,loadCollection,editMeme,deleteMeme,shareMeme,newRecording,dispose };
}
