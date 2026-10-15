import { reactive, ref, watch, type WatchStopHandle } from 'vue'

import type { PluginDataEntry, SceneNode } from '@open-pencil/scene-graph'

import {
  listMockPageStorageIds,
  migrateMockPagesStorage,
  readMockPageStorage,
  writeMockPageStorage
} from './storage'

export type AgentActionType = 'analyze' | 'read' | 'search' | 'write' | 'patch' | 'creative' | 'verify' | 'done'

export interface AgentActionStep {
  id: string
  type: AgentActionType
  title: string
  detail?: string
  status: 'running' | 'done' | 'error'
}

export interface MockChatMessage {
  role: 'user' | 'assistant' | 'system'
  text: string
  /** Full streamed narration from the generation round (collapsible in the bubble). */
  process?: string
  /** Model reasoning stream from the generation round, when the channel provides it. */
  reasoning?: string
  /** 现代 Agent 动态行为轨迹（类 Claude Code / Antigravity 紧凑卡片）。 */
  steps?: AgentActionStep[]
}

export interface MockPageState {
  html: string
  files: Record<string, string>
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

/**
 * Mock identity lives on the page node itself (pluginData), so it survives
 * recovery restore / save / load even though scene-graph node ids are
 * session-sequential and get re-minted on restore. The value is a stable
 * mockId that keys the local registry below.
 */
export const MOCK_PAGE_PLUGIN_ID = 'open-pencil'
export const MOCK_PAGE_PLUGIN_KEY = 'mock-page'

type MockPageRegistry = Record<string, MockPageState>

type PluginDataCarrier = Pick<SceneNode, 'pluginData'> | null | undefined

export function createMockId(): string {
  const c = globalThis.crypto
  if (typeof c.randomUUID === 'function') return c.randomUUID()
  const bytes = new Uint8Array(16)
  c.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function getMockPageId(node: PluginDataCarrier): string | null {
  if (!node || !Array.isArray(node.pluginData)) return null
  const entry = node.pluginData.find(
    (item) => item.pluginId === MOCK_PAGE_PLUGIN_ID && item.key === MOCK_PAGE_PLUGIN_KEY
  )
  return entry?.value ?? null
}

export function withMockPagePluginData(node: SceneNode, mockId: string): PluginDataEntry[] {
  const rest = node.pluginData.filter(
    (item) => !(item.pluginId === MOCK_PAGE_PLUGIN_ID && item.key === MOCK_PAGE_PLUGIN_KEY)
  )
  return [...rest, { pluginId: MOCK_PAGE_PLUGIN_ID, key: MOCK_PAGE_PLUGIN_KEY, value: mockId }]
}

function sanitizeMessages(value: unknown): MockChatMessage[] {
  if (!Array.isArray(value)) return []
  const messages: MockChatMessage[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const message = item as Partial<MockChatMessage>
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') continue
    if (typeof message.text !== 'string') continue
    const clean: MockChatMessage = { role: message.role, text: message.text }
    if (typeof message.process === 'string' && message.process) clean.process = message.process
    if (typeof message.reasoning === 'string' && message.reasoning) clean.reasoning = message.reasoning
    messages.push(clean)
  }
  return messages
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeFiles(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const files: Record<string, string> = {}
  for (const [path, content] of Object.entries(value)) {
    const name = path.trim()
    if (name && typeof content === 'string') files[name] = content
  }
  return files
}

function sanitizeState(value: unknown): MockPageState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as Partial<MockPageState>
  return {
    html: typeof state.html === 'string' ? state.html : '',
    files: sanitizeFiles(state.files),
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

function loadRegistry(): MockPageRegistry {
  migrateMockPagesStorage()
  const registry: MockPageRegistry = {}
  for (const mockId of listMockPageStorageIds()) {
    const state = sanitizeState(readMockPageStorage(mockId))
    if (state) registry[mockId] = state
  }
  return registry
}

const registry = reactive<MockPageRegistry>(loadRegistry())

/** 最近一次持久化写入失败时为 true；UI 据此向用户提示保存失败。 */
export const mockPagesPersistError = ref(false)

const stateWatchers = new Map<string, WatchStopHandle>()

function persistState(mockId: string, state: MockPageState): void {
  try {
    writeMockPageStorage(mockId, state)
    mockPagesPersistError.value = false
  } catch (error) {
    console.warn(`mock page persist failed: ${mockId}`, error)
    mockPagesPersistError.value = true
  }
}

/** 给单个 mock 页挂深度 watcher：该页任何变更（含流式追加的消息）立即持久化。 */
function watchState(mockId: string): void {
  if (stateWatchers.has(mockId)) return
  const state = registry[mockId]
  const stop = watch(
    state,
    (value) => persistState(mockId, value),
    { deep: true }
  )
  stateWatchers.set(mockId, stop)
}

for (const mockId of Object.keys(registry)) {
  watchState(mockId)
}

export function isMockPage(node: PluginDataCarrier): boolean {
  return getMockPageId(node) !== null
}

export function mockPageState(node: PluginDataCarrier): MockPageState | undefined {
  const mockId = getMockPageId(node)
  return mockId ? registry[mockId] : undefined
}

export function ensureMockPage(mockId: string): MockPageState {
  if (mockId in registry) return registry[mockId]
  const created: MockPageState = {
    html: '',
    files: {},
    width: MOCK_PAGE_SIZES.desktop.width,
    height: MOCK_PAGE_SIZES.desktop.height,
    messages: []
  }
  registry[mockId] = created
  watchState(mockId)
  persistState(mockId, created)
  return created
}

/** List all registered mock pages (used by similar-design search). */
export function listMockPages(): Array<{ id: string; state: MockPageState }> {
  return Object.entries(registry).map(([id, state]) => ({ id, state }))
}
