import { generateText } from 'ai'
import { ref, type Ref } from 'vue'

import { useI18n } from '@open-pencil/vue'

import { createAIModelRuntime } from '@/app/ai/models'
import { resolveVoiceAsrKey, transcribeAudio, VoiceAsrError } from '@/app/ai/voice/asr'

export type VoiceState = 'idle' | 'recording' | 'transcribing' | 'polishing'

const isCJK = (ch: string) => /[ -鿿豈-﫿]/.test(ch)

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
  if (runtime?.kind !== 'direct') return null
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

export function useVoiceInput(target: Ref<string>, onDone?: () => void) {
  const { ai } = useI18n()
  const voiceState = ref<VoiceState>('idle')
  const voiceError = ref('')
  let mediaRecorder: MediaRecorder | null = null
  let mediaStream: MediaStream | null = null
  let recordedChunks: Blob[] = []
  let voiceBaseText = ''

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
    if (typeof MediaRecorder === 'undefined') {
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
    voiceBaseText = target.value
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
      target.value = joinTranscript(voiceBaseText, polished ?? transcript)
    } catch (error) {
      // 模型润色失败时保留原始转写文本
      console.warn('voice transcript polish failed', error)
      target.value = joinTranscript(voiceBaseText, transcript)
    }
    voiceState.value = 'idle'
    onDone?.()
  }

  function handleVoiceButton() {
    if (voiceState.value === 'recording') stopVoiceInput()
    else if (voiceState.value === 'idle') void startVoiceInput()
  }

  return { voiceState, voiceError, handleVoiceButton }
}
