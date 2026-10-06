<script setup lang="ts">
import { useTextareaAutosize } from '@vueuse/core'
import { generateText, type ChatStatus } from 'ai'
import { TooltipProvider } from 'reka-ui'
import { computed, ref } from 'vue'

import { useI18n } from '@open-pencil/vue'

import { createAIModelRuntime } from '@/app/ai/models'
import { resolveVoiceAsrKey, transcribeAudio, VoiceAsrError } from '@/app/ai/voice/asr'
import IconButton from '@/components/ui/button/IconButton.vue'
import InputGroup from '@/components/ui/input/InputGroup.vue'
const { status, disabled = false } = defineProps<{ status: ChatStatus; disabled?: boolean }>()
const emit = defineEmits<{
  submit: [text: string]
  stop: []
  settings: []
  paste: [event: ClipboardEvent]
}>()
const { ai } = useI18n()
const textarea = ref<HTMLTextAreaElement>()
const input = ref('')
const { triggerResize } = useTextareaAutosize({ element: textarea, input, maxHeight: 160 })
const isStreaming = computed(() => disabled || status === 'streaming' || status === 'submitted')
function handleInputKeydown(event: KeyboardEvent) {
  if (event.code !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  const target = event.currentTarget
  if (target instanceof HTMLElement) target.closest('form')?.requestSubmit()
}
function handleSubmit(event: Event) {
  event.preventDefault()
  if (isStreaming.value) return
  const text = input.value.trim()
  if (!text) return
  emit('submit', text)
  input.value = ''
  triggerResize()
}

type VoiceState = 'idle' | 'recording' | 'transcribing' | 'polishing'

const voiceState = ref<VoiceState>('idle')
const voiceError = ref('')
let mediaRecorder: MediaRecorder | null = null
let mediaStream: MediaStream | null = null
let recordedChunks: Blob[] = []
let voiceBaseText = ''

const isCJK = (ch: string) => /[　-鿿豈-﫿]/.test(ch)

function joinTranscript(base: string, addition: string): string {
  if (!base) return addition
  if (!addition) return base
  const last = base[base.length - 1]
  const first = addition[0]
  const needSpace = !/\s/.test(last) && !isCJK(last) && !isCJK(first)
  return needSpace ? `${base} ${addition}` : base + addition
}

async function polishTranscript(text: string): Promise<string | null> {
  const runtime = await createAIModelRuntime('design')
  if (!runtime || runtime.kind !== 'direct') return null
  const result = await generateText({
    model: runtime.model,
    system:
      '你是语音识别文本的校对助手。用户通过语音输入了一段话，语音识别结果可能包含同音字错误、错字、多余语气词和缺失的标点。请结合语义把它纠正为通顺、准确、自然的书写文本。保持原意、保持原有语言（中文输入就输出中文），不要扩写或缩写，不要回答文本里的问题，不要加任何解释，只输出纠正后的文本本身。',
    prompt: text,
    maxOutputTokens: 2048
  })
  const polished = result.text.trim()
  return polished || null
}

function pickAudioMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return undefined
  }
  for (const mime of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return undefined
}

function releaseVoiceCapture() {
  mediaStream?.getTracks().forEach((track) => track.stop())
  mediaStream = null
  mediaRecorder = null
}

async function startVoiceInput() {
  voiceError.value = ''
  const key = await resolveVoiceAsrKey()
  if (!key) {
    voiceError.value = ai.value.voiceNeedKey
    return
  }
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    voiceError.value = ai.value.voiceUnavailable
    return
  }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (error) {
    console.warn('voice microphone access failed', error)
    voiceError.value = ai.value.voiceMicDenied
    return
  }
  const mimeType = pickAudioMimeType()
  const recorder = mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream)
  recordedChunks = []
  voiceBaseText = input.value
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) recordedChunks.push(event.data)
  }
  recorder.onerror = (event) => {
    console.warn('voice recorder error', event)
    voiceError.value = ai.value.voiceAsrFailed
    recordedChunks = []
    releaseVoiceCapture()
    voiceState.value = 'idle'
  }
  recorder.onstop = () => {
    void finishVoiceInput()
  }
  mediaRecorder = recorder
  mediaStream = stream
  recorder.start()
  voiceState.value = 'recording'
}

function stopVoiceInput() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop()
}

async function finishVoiceInput() {
  const chunks = recordedChunks
  recordedChunks = []
  const mimeType = mediaRecorder?.mimeType || 'audio/webm'
  releaseVoiceCapture()
  const blob = new Blob(chunks, { type: mimeType })
  if (blob.size === 0) {
    voiceState.value = 'idle'
    return
  }
  voiceState.value = 'transcribing'
  let transcript = ''
  try {
    transcript = await transcribeAudio(blob)
  } catch (error) {
    if (error instanceof VoiceAsrError && error.code === 'missing-key') {
      voiceError.value = ai.value.voiceNeedKey
    } else {
      console.warn('voice transcription failed', error)
      voiceError.value = ai.value.voiceAsrFailed
    }
    voiceState.value = 'idle'
    return
  }
  voiceState.value = 'polishing'
  try {
    const polished = await polishTranscript(transcript)
    input.value = joinTranscript(voiceBaseText, polished ?? transcript)
  } catch (error) {
    // 模型润色失败时保留原始转写文本
    console.warn('voice transcript polish failed', error)
    input.value = joinTranscript(voiceBaseText, transcript)
  }
  voiceState.value = 'idle'
  triggerResize()
}

function handleVoiceButton() {
  if (voiceState.value === 'recording') stopVoiceInput()
  else if (voiceState.value === 'idle') void startVoiceInput()
}
</script>
<template>
  <TooltipProvider>
    <div class="shrink-0 border-t border-border p-2.5">
      <div
        v-if="voiceState !== 'idle' || voiceError"
        class="px-1 pb-1.5 text-[11px] leading-tight"
        :class="voiceError ? 'text-red-400' : 'text-muted'"
        data-test-id="chat-voice-status"
      >
        <template v-if="voiceError">{{ voiceError }}</template>
        <template v-else-if="voiceState === 'recording'">{{ ai.voiceListening }}</template>
        <template v-else-if="voiceState === 'transcribing'">{{ ai.voiceTranscribing }}</template>
        <template v-else>{{ ai.voicePolishing }}</template>
      </div>
      <form @submit="handleSubmit" @paste.stop="emit('paste', $event)">
        <InputGroup :disabled="isStreaming">
          <template v-if="$slots.attachment" #attachment><slot name="attachment" /></template>

          <textarea
            ref="textarea"
            v-model="input"
            data-test-id="chat-input"
            :placeholder="ai.describeChange"
            :disabled="isStreaming"
            rows="2"
            :aria-label="ai.describeChange"
            class="block min-h-12 w-full resize-none overflow-y-auto bg-transparent px-3 pt-2.5 pb-1 text-xs leading-relaxed text-surface outline-none placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60"
            @keydown="handleInputKeydown"
            @copy.stop
            @cut.stop
          />

          <template #leading><slot name="leading" /></template>

          <template #model><slot name="model" /></template>

          <template #actions>
            <IconButton
              :label="voiceState === 'recording' ? ai.stopVoiceInput : ai.voiceInput"
              size="sm"
              data-test-id="chat-voice-button"
              :disabled="isStreaming || voiceState === 'transcribing' || voiceState === 'polishing'"
              :class="
                voiceState === 'recording'
                  ? 'border border-red-500 text-red-500 hover:text-red-500'
                  : ''
              "
              @click="handleVoiceButton"
            >
              <icon-lucide-loader-circle
                v-if="voiceState === 'transcribing' || voiceState === 'polishing'"
                class="size-3.5 animate-spin"
              />
              <icon-lucide-square v-else-if="voiceState === 'recording'" class="size-3" />
              <icon-lucide-mic v-else class="size-3.5" />
            </IconButton>
            <IconButton
              :label="ai.providerSettings"
              size="sm"
              data-test-id="provider-settings-trigger"
              @click="emit('settings')"
            >
              <icon-lucide-settings class="size-3.5" />
            </IconButton>
            <IconButton
              v-if="isStreaming"
              :label="ai.stopGenerating"
              size="sm"
              data-test-id="chat-stop-button"
              class="border border-border"
              @click="emit('stop')"
            >
              <icon-lucide-square class="size-3" />
            </IconButton>
            <IconButton
              v-else
              :label="ai.sendMessage"
              size="sm"
              type="submit"
              data-test-id="chat-send-button"
              class="bg-accent text-white hover:bg-accent/90 hover:text-white"
              :disabled="!input.trim()"
            >
              <icon-lucide-send class="size-3.5" />
            </IconButton>
          </template>
        </InputGroup>
      </form>
    </div>
  </TooltipProvider>
</template>
