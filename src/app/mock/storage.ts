/**
 * Mock 页状态持久化 —— 按 mockId 分 key 写 localStorage：每个页面一个
 * `open-pencil:mock-page:<mockId>` 键，单页变更只写该页自己的键，避免整表
 * 序列化的写放大；旧版整表键 `open-pencil:mock-pages:v2` 在启动时一次性迁移拆分。
 */

const MOCK_PAGES_LEGACY_KEY = 'open-pencil:mock-pages:v2'
const MOCK_PAGE_STORAGE_PREFIX = 'open-pencil:mock-page:'

function isRegistryRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRawJSON(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw)
  } catch (error) {
    console.warn(`mock page storage read failed: ${key}`, error)
    return null
  }
}

function writeRawJSON(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value))
}

/** 读取单个 mock 页的持久化状态；自身键缺失时回退旧版整表键。 */
export function readMockPageStorage(mockId: string): unknown {
  if (!mockId) return null
  const own = readRawJSON(MOCK_PAGE_STORAGE_PREFIX + mockId)
  if (own && typeof own === 'object') return own
  const legacy = readRawJSON(MOCK_PAGES_LEGACY_KEY)
  if (isRegistryRecord(legacy)) {
    const entry = legacy[mockId]
    if (entry && typeof entry === 'object') return entry
  }
  return null
}

/** 持久化单个 mock 页状态；写失败时抛错，由调用方负责提示。 */
export function writeMockPageStorage(mockId: string, value: unknown): void {
  localStorage.setItem(MOCK_PAGE_STORAGE_PREFIX + mockId, JSON.stringify(value))
}

/** 列出所有已持久化的 mockId（含只存在于旧版整表键里的）。 */
export function listMockPageStorageIds(): string[] {
  const ids = new Set<string>()
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(MOCK_PAGE_STORAGE_PREFIX)) {
        const id = key.slice(MOCK_PAGE_STORAGE_PREFIX.length)
        if (id) ids.add(id)
      }
    }
  } catch (error) {
    console.warn('mock page storage enumeration failed', error)
  }
  const legacy = readRawJSON(MOCK_PAGES_LEGACY_KEY)
  if (isRegistryRecord(legacy)) {
    for (const id of Object.keys(legacy)) {
      if (id) ids.add(id)
    }
  }
  return [...ids]
}

/** 一次性迁移：旧版整表键拆成 per-id 键；全部写成功才删除旧键，失败保留待下次。 */
export function migrateMockPagesStorage(): void {
  const legacy = readRawJSON(MOCK_PAGES_LEGACY_KEY)
  if (!isRegistryRecord(legacy)) return
  try {
    for (const [mockId, value] of Object.entries(legacy)) {
      if (!mockId || !value || typeof value !== 'object') continue
      const existing = readRawJSON(MOCK_PAGE_STORAGE_PREFIX + mockId)
      if (existing && typeof existing === 'object') continue
      writeRawJSON(MOCK_PAGE_STORAGE_PREFIX + mockId, value)
    }
    localStorage.removeItem(MOCK_PAGES_LEGACY_KEY)
  } catch (error) {
    console.warn('mock page legacy storage migration skipped', error)
  }
}
