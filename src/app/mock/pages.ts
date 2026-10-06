import { reactive, watch } from 'vue'

import { readMockPagesStorage, writeMockPagesStorage } from './storage'

export interface MockChatMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface MockPageState {
  html: string
  width: number
  height: number
  messages: MockChatMessage[]
}

export const MOCK_PAGE_SIZES = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1194 },
  phone: { width: 390, height: 844 }
} as const

export type MockPageSizeKind = keyof typeof MOCK_PAGE_SIZES

type MockPageRegistry = Record<string, MockPageState>

function sanitizeMessages(value: unknown): MockChatMessage[] {
  if (!Array.isArray(value)) return []
  const messages: MockChatMessage[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const message = item as Partial<MockChatMessage>
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (typeof message.text !== 'string') continue
    messages.push({ role: message.role, text: message.text })
  }
  return messages
}

function loadRegistry(): MockPageRegistry {
  const parsed = readMockPagesStorage()
  if (!parsed || typeof parsed !== 'object') return {}
  const registry: MockPageRegistry = {}
  for (const [pageId, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object') continue
    const state = value as Partial<MockPageState>
    registry[pageId] = {
      html: typeof state.html === 'string' ? state.html : '',
      width:
        typeof state.width === 'number' && state.width > 0
          ? state.width
          : MOCK_PAGE_SIZES.desktop.width,
      height:
        typeof state.height === 'number' && state.height > 0
          ? state.height
          : MOCK_PAGE_SIZES.desktop.height,
      messages: sanitizeMessages(state.messages)
    }
  }
  return registry
}

const registry = reactive<MockPageRegistry>(loadRegistry())

watch(
  registry,
  (value) => {
    try {
      writeMockPagesStorage(value)
    } catch (error) {
      console.warn('mock page registry persist failed', error)
    }
  },
  { deep: true }
)

export function isMockPage(pageId: string | null | undefined): boolean {
  return !!pageId && pageId in registry
}

export function mockPageState(pageId: string | null | undefined): MockPageState | undefined {
  return pageId ? registry[pageId] : undefined
}

export function ensureMockPage(pageId: string): MockPageState {
  if (pageId in registry) return registry[pageId]
  const created: MockPageState = {
    html: '',
    width: MOCK_PAGE_SIZES.desktop.width,
    height: MOCK_PAGE_SIZES.desktop.height,
    messages: []
  }
  registry[pageId] = created
  return created
}
