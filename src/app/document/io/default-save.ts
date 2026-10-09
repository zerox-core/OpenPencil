import { isTauri } from '@/app/tauri/env'

/**
 * Default-save for freshly created documents: a new document is written to a
 * stable location under the user's document folder right away, so it survives
 * without an explicit save. Save-as still lets the user pick any other path.
 */

const DEFAULT_DIR_NAME = 'OpenPencil'
const UNTITLED_BASE_NAME = '未命名'
const MAX_NAME_ATTEMPTS = 10_000

/** Paths handed out in this session, so rapid consecutive creations cannot collide. */
const reservedPaths = new Set<string>()

type NewDocumentSaveTarget = {
  setPlannedFilePath: (path: string) => void
  saveFigFile: () => Promise<boolean>
}

async function defaultProjectDirectory(): Promise<string> {
  const { documentDir, join } = await import('@tauri-apps/api/path')
  return join(await documentDir(), DEFAULT_DIR_NAME)
}

/**
 * Picks `未命名.fig`, then `未命名 (n).fig`. Probes with readFile instead of
 * exists: the fs capability grants read-file everywhere but exists only for a
 * few config paths.
 */
async function pickUniqueFigPath(dir: string): Promise<string> {
  const { join } = await import('@tauri-apps/api/path')
  const { readFile } = await import('@tauri-apps/plugin-fs')
  for (let n = 0; n < MAX_NAME_ATTEMPTS; n++) {
    const name = n === 0 ? `${UNTITLED_BASE_NAME}.fig` : `${UNTITLED_BASE_NAME} (${n}).fig`
    const path = await join(dir, name)
    if (reservedPaths.has(path)) continue
    try {
      await readFile(path)
      continue
    } catch (probeError) {
      // Not found — the name is free. Debug-level log so the catch is not silent.
      console.debug('[Default save] Name probe:', probeError)
    }
    reservedPaths.add(path)
    return path
  }
  throw new Error('No free file name left in the default project directory')
}

/**
 * Persists a brand-new document into the default project directory. Best-effort:
 * failures are logged and the document simply stays unsaved, as before.
 */
export async function persistNewDocumentToDefaultDir(
  store: NewDocumentSaveTarget
): Promise<string | null> {
  if (!isTauri()) return null
  try {
    const { mkdir } = await import('@tauri-apps/plugin-fs')
    const dir = await defaultProjectDirectory()
    await mkdir(dir, { recursive: true })
    const path = await pickUniqueFigPath(dir)
    store.setPlannedFilePath(path)
    const saved = await store.saveFigFile()
    if (!saved) {
      reservedPaths.delete(path)
      return null
    }
    return path
  } catch (error) {
    console.warn('[Default save] Failed to persist the new document:', error)
    return null
  }
}
