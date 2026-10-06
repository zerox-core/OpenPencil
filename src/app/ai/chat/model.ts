import type { LanguageModel } from 'ai'

import { modelProviderAdapter } from '@/app/ai/providers/registry'
import type { ModelConfig } from '@/app/ai/providers/types'
import type { FetchFunction } from '@/app/http/types'
import { isTauri } from '@/app/tauri/env'
import { tauriFetch } from '@/app/tauri/http'

export type { ModelConfig } from '@/app/ai/providers/types'

export function resolveLanguageModelID(
  config: Pick<ModelConfig, 'providerID' | 'modelID' | 'customModelID'>
): string {
  if (
    config.providerID === 'openrouter' ||
    config.providerID === 'openai-compatible' ||
    config.providerID === 'anthropic-compatible'
  ) {
    return config.customModelID.trim() || config.modelID
  }
  return config.modelID
}

const AI_REQUEST_TIMEOUT_MS = 300000

function desktopFetch(): FetchFunction | undefined {
  if (!isTauri()) return undefined
  return (input, init) => tauriFetch(input, init, undefined, AI_REQUEST_TIMEOUT_MS)
}

export function createLanguageModel(config: ModelConfig): LanguageModel {
  return modelProviderAdapter(config.providerID).create(config, { fetch: desktopFetch() })
}
