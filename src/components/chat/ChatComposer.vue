<script setup lang="ts">
import { useTextareaAutosize } from '@vueuse/core'
import { generateText, type ChatStatus } from 'ai'
import { TooltipProvider } from 'reka-ui'
import { computed, ref } from 'vue'

import { useI18n } from '@open-pencil/vue'

import { createAIModelRuntime } from '@/app/ai/models'
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

interface SpeechRecognitionResultLike {
  isFinal: boolean
  0: { transcript: string }
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: SpeechRecognitionResultLike[]
}
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as Record<string, unknown>
  const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  return typeof ctor === 'function' ? (ctor as SpeechRecognitionCtor) : null
}

const voiceState = ref<'idle' | 'listening' | 'polishing'>('idle')
const voiceError = ref('')
let recognition: SpeechRecognitionLike | null = null
let voiceBaseText = ''
let voiceFinalText = ''

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

function handleVoiceError(error: string) {
  if (error === 'aborted') return
  voiceError.value = `${ai.value.voiceRecognitionError}: ${error}`
}

function startVoiceInput() {
  voiceError.value = ''
  const Ctor = speechRecognitionCtor()
  if (!Ctor) {
    voiceError.value = ai.value.voiceUnavailable
    return
  }
  const rec = new Ctor()
  rec.lang = 'zh-CN'
  rec.interimResults = true
  rec.continuous = true
  voiceBaseText = input.value
  voiceFinalText = ''
  rec.onresult = (event) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i]
      if (res.isFinal) voiceFinalText += res[0].transcript
      else interim += res[0].transcript
    }
    input.value = joinTranscript(voiceBaseText, voiceFinalText + interim)
    triggerResize()
  }
  rec.onerror = (event) => {
    handleVoiceError(event.error)
    recognition = null
    voiceState.value = 'idle'
  }
  rec.onend = () => {
    if (voiceState.value === 'listening') void finishVoiceInput()
  }
  try {
    rec.start()
    recognition = rec
    voiceState.value = 'listening'
  } catch {
    voiceError.value = ai.value.voiceUnavailable
  }
}

function stopVoiceInput() {
  recognition?.stop()
}

async function finishVoiceInput() {
  const spoken = voiceFinalText.trim()
  recognition = null
  if (!spoken) {
    voiceState.value = 'idle'
    return
  }
  voiceState.value = 'polishing'
  try {
    const polished = await polishTranscript(spoken)
    if (polished) input.value = joinTranscript(voiceBaseText, polished)
  } catch {
    // 模型修正失败时保留原始识别文本
  }
  voiceState.value = 'idle'
  triggerResize()
}

function handleVoiceButton() {
  if (voiceState.value === 'listening') stopVoiceInput()
  else if (voiceState.value === 'idle') startVoiceInput()
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
        <template v-else-if="voiceState === 'listening'">{{ ai.voiceListening }}</template>
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
              :label="voiceState === 'listening' ? ai.stopVoiceInput : ai.voiceInput"
              size="sm"
              data-test-id="chat-voice-button"
              :disabled="isStreaming || voiceState === 'polishing'"
              :class="
                voiceState === 'listening'
                  ? 'border border-red-500 text-red-500 hover:text-red-500'
                  : ''
              "
              @click="handleVoiceButton"
            >
              <icon-lucide-loader-circle
                v-if="voiceState === 'polishing'"
                class="size-3.5 animate-spin"
              />
              <icon-lucide-square v-else-if="voiceState === 'listening'" class="size-3" />
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
