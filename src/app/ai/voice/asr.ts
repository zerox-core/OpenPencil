import { computed, ref } from 'vue'

import { appCredentialServices } from '@/app/settings/credentials/app'
import { initializeCredentialMigration } from '@/app/settings/credentials/migration'
import { credentialRef } from '@/app/settings/credentials/reference'
import type { CredentialStatus } from '@/app/settings/credentials/types'
import { appPreferences } from '@/app/settings/preferences/store'

export const VOICE_ASR_CREDENTIAL = credentialRef('siliconflow', 'api-key')

export const voiceAsrBaseURL = computed({
  get: () => appPreferences.value.voice.baseUrl,
  set: (baseURL: string) => {
    appPreferences.value = {
      ...appPreferences.value,
      voice: { ...appPreferences.value.voice, baseUrl: baseURL.trim() }
    }
  }
})

export const voiceAsrModel = computed({
  get: () => appPreferences.value.voice.model,
  set: (model: string) => {
    appPreferences.value = {
      ...appPreferences.value,
      voice: { ...appPreferences.value.voice, model: model.trim() }
    }
  }
})

export const voiceAsrKeyStatus = ref<CredentialStatus>('missing')

export async function refreshVoiceAsrKeyStatus(): Promise<void> {
  voiceAsrKeyStatus.value = await appCredentialServices.manager.status(VOICE_ASR_CREDENTIAL)
}

export async function setVoiceAsrKey(key: string): Promise<void> {
  await initializeCredentialMigration()
  const value = key.trim()
  if (value) await appCredentialServices.manager.set(VOICE_ASR_CREDENTIAL, value)
  else await appCredentialServices.manager.clear(VOICE_ASR_CREDENTIAL)
  await refreshVoiceAsrKeyStatus()
}

export async function resolveVoiceAsrKey(): Promise<string | null> {
  await initializeCredentialMigration()
  return appCredentialServices.resolver.resolve(VOICE_ASR_CREDENTIAL)
}

export type VoiceAsrErrorCode = 'missing-key' | 'empty-result' | 'http-error'

export class VoiceAsrError extends Error {
  readonly code: VoiceAsrErrorCode
  readonly httpStatus: number | null

  constructor(code: VoiceAsrErrorCode, httpStatus: number | null = null) {
    super(code === 'http-error' ? `ASR request failed: HTTP ${httpStatus ?? 'unknown'}` : code)
    this.name = 'VoiceAsrError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

interface TranscriptionResponse {
  text?: unknown
}

export async function transcribeAudio(blob: Blob): Promise<string> {
  const key = await resolveVoiceAsrKey()
  if (!key) throw new VoiceAsrError('missing-key')

  const form = new FormData()
  form.append('model', voiceAsrModel.value)
  form.append('file', blob, 'voice.webm')

  const baseURL = voiceAsrBaseURL.value.replace(/\/+$/, '')
  const response = await fetch(`${baseURL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form
  })
  if (!response.ok) throw new VoiceAsrError('http-error', response.status)

  const data = (await response.json()) as TranscriptionResponse
  const text = typeof data.text === 'string' ? data.text.trim() : ''
  if (!text) throw new VoiceAsrError('empty-result')
  return text
}
