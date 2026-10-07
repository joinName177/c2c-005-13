import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import App from '../App.vue';
import type { StudioDependencies } from '../useStudio';
import type { RecorderEventMap, RecorderPort, RecorderStopReason } from '../../ports/recorder.port';
import type { VoiceMeme } from '../../core/models';

type Listener<K extends keyof RecorderEventMap> = (payload: RecorderEventMap[K]) => void;
type AnyListener = (payload: RecorderEventMap[keyof RecorderEventMap]) => void;
class StubRecorder implements RecorderPort {
  status: RecorderPort['status'] = 'idle';
  private listeners: { [K in keyof RecorderEventMap]?: Set<AnyListener> } = {};
  constructor(private readonly options: { denied?: boolean; duration?: number } = {}) {}
  on<K extends keyof RecorderEventMap>(event: K, listener: Listener<K>) {
    const set = (this.listeners[event] ??= new Set<AnyListener>());
    set.add(listener as AnyListener);
    return () => set.delete(listener as AnyListener);
  }
  private emit<K extends keyof RecorderEventMap>(event: K, payload: RecorderEventMap[K]) {
    this.listeners[event]?.forEach((fn) => (fn as Listener<K>)(payload));
  }
  async start() {
    if (this.options.denied) {
      this.emit('failed', { reason: 'permission', message: '无法使用麦克风权限，请在浏览器设置中允许访问或导入音频。' });
      throw new DOMException('denied', 'NotAllowedError');
    }
    this.status = 'recording';
    this.emit('status', { status: 'recording' });
    this.emit('elapsed', { elapsed: 3.5 });
  }
  async stop(reason: RecorderStopReason = 'manual') {
    const blob = new Blob(['voice'], { type: 'audio/webm' });
    this.status = 'idle';
    this.emit('status', { status: 'idle' });
    this.emit('stopped', { reason, blob, duration: this.options.duration ?? 2 });
    return blob;
  }
  async cancel() {
    this.status = 'idle';
    this.emit('status', { status: 'idle' });
  }
}

function deps(options: { denied?: boolean } = {}): StudioDependencies {
  const works: VoiceMeme[] = [];
  return {
    recorder:new StubRecorder({ denied: options.denied }),
    analyzer:{analyze:async()=>({duration:2,features:{loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6}})},
    cropper:{inspect:async()=>({duration:2,needsCrop:false}),crop:async(blob,range)=>({blob,duration:range.end-range.start})},
    renderer:{render:async()=>new Blob(['cover'],{type:'image/png'})},
    repository:{list:async()=>works,save:async(m)=>{works.push(m)},rename:async()=>{},delete:async(id)=>{const i=works.findIndex(w=>w.id===id);if(i>=0)works.splice(i,1)}},
    share:{share:async()=> 'shared'},
  };
}

describe('Voice meme App', () => {
  it('shows the studio stages, time limit and sharing disclosure', () => {
    const wrapper = mount(App,{props:{dependencies:deps()}});
    expect(wrapper.text()).toContain('声音表情包工坊');
    expect(wrapper.text()).toContain('00:10 MAX');
    expect(wrapper.text()).toContain('分享链接不包含原始声音');
  });
  it('shows a recoverable microphone permission error', async () => {
    const wrapper=mount(App,{props:{dependencies:deps({denied:true})}}); await wrapper.get('[data-testid="record"]').trigger('click'); await Promise.resolve();
    expect(wrapper.text()).toContain('麦克风权限');
  });
  it('creates, labels, edits and saves a work to the gallery', async () => {
    const wrapper=mount(App,{props:{dependencies:deps()}}); await wrapper.get('[data-testid="record"]').trigger('click'); await Promise.resolve();
    expect(wrapper.get('[data-testid="stop"]').text()).toContain('结束录音');
    await wrapper.get('[data-testid="stop"]').trigger('click'); await Promise.resolve(); await Promise.resolve();
    await wrapper.get('[data-testid="analyze"]').trigger('click'); await Promise.resolve(); await wrapper.get('[data-emotion="温柔姐姐"]').trigger('click'); expect(wrapper.text()).toContain('已手动选择');
    await wrapper.get('[data-testid="to-cover"]').trigger('click'); await wrapper.get('[aria-label="气泡文字"]').setValue('轻轻说一句'); await wrapper.get('[data-testid="save-work"]').trigger('click'); await Promise.resolve(); await Promise.resolve();
    expect(wrapper.text()).toContain('作品集'); expect(wrapper.text()).toContain('我的声音表情');
  });
  it('shows live elapsed time instead of a fixed placeholder', async () => {
    const wrapper=mount(App,{props:{dependencies:deps()}});
    expect(wrapper.text()).toContain('00:00.0');
    await wrapper.get('[data-testid="record"]').trigger('click'); await Promise.resolve();
    expect(wrapper.text()).toContain('00:03.5');
    expect(wrapper.text()).not.toContain('00:06');
  });
  it('moves straight into crop when the ten-second limit ends the session', async () => {
    const wrapper=mount(App,{props:{dependencies:deps()}});
    await wrapper.get('[data-testid="record"]').trigger('click'); await Promise.resolve();
    const recorder = (wrapper.props() as { dependencies: StudioDependencies }).dependencies.recorder as StubRecorder;
    await recorder.stop('time-limit');
    await Promise.resolve(); await Promise.resolve();
    expect(wrapper.text()).toContain('已录满 10 秒');
    expect(wrapper.find('[data-testid="analyze"]').exists()).toBe(true);
  });
  it('re-records from the crop page and releases the previous take', async () => {
    const wrapper=mount(App,{props:{dependencies:deps()}});
    await wrapper.get('[data-testid="record"]').trigger('click'); await Promise.resolve();
    await wrapper.get('[data-testid="stop"]').trigger('click'); await Promise.resolve(); await Promise.resolve();
    expect(wrapper.find('[data-testid="rerecord"]').exists()).toBe(true);
    await wrapper.get('[data-testid="rerecord"]').trigger('click'); await Promise.resolve();
    expect(wrapper.find('[data-testid="record"]').exists()).toBe(true);
  });
});
