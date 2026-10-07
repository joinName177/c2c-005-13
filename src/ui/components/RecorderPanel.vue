<script setup lang="ts">
import { computed } from 'vue';
import WaveformMeter from './WaveformMeter.vue';
const props = defineProps<{ status: 'idle' | 'requesting' | 'recording' | 'stopping'; level: number; elapsed: number }>();
const emit = defineEmits<{ record: []; stop: []; cancel: []; import: [file: File] }>();
const busy = computed(() => props.status !== 'idle');
const timeCode = computed(() => {
  const value = Math.min(10, Math.max(0, props.elapsed));
  const seconds = Math.floor(value);
  const tenths = Math.floor((value - seconds) * 10);
  return `00:${String(seconds).padStart(2, '0')}.${tenths}`;
});</script>
<template><section class="recorder-panel"><div class="time-code"><b>{{ status === 'recording' ? 'REC' : status === 'idle' ? 'READY' : status.toUpperCase() }}</b><strong>{{ timeCode }}</strong><span>00:10 MAX</span></div><WaveformMeter :level="level"/><div class="recorder-actions"><button v-if="status === 'idle'" data-testid="record" class="record-button" type="button" @click="emit('record')"><i></i>开始录音</button><button v-else-if="status === 'recording'" data-testid="stop" class="record-button stop" type="button" @click="emit('stop')">■ 结束录音</button><button v-else data-testid="stop-wait" class="record-button stop" type="button" disabled>{{ status === 'requesting' ? '正在请求麦克风…' : '正在结束…' }}</button><button v-if="busy" data-testid="cancel-record" class="record-button ghost" type="button" @click="emit('cancel')">放弃重录</button><label>导入音频<input type="file" accept="audio/*" @change="($event.target as HTMLInputElement).files?.[0] && emit('import', ($event.target as HTMLInputElement).files![0])"></label></div><p>录音只在本机处理，不会上传。建议靠近麦克风，以正常语速说一句话。</p></section></template>
