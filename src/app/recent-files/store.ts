import { useLocalStorage } from '@vueuse/core'
import { computed } from 'vue'

import type { StorageProviderID } from '@/app/integrations/storage'

import { clearRecentFileThumbnails, removeRecentFileThumbnail } from './thumbnails'

const MAX_RECENT_DOCUMENTS = 10
const RECENT_DOCUMENTS_STORAGE_KEY = 'open-pencil:recent-documents'
const ARCHIVED_DOCUMENTS_STORAGE_KEY = 'open-pencil:archived-documents'

export interface RecentLocalDocument {
  id: string
  kind: 'local'
  path: string
  name: string
  updatedAt: string
}

export interface RecentStorageDocument {
  id: string
  kind: 'storage'
  providerId: StorageProviderID
  documentId: string
  name: string
  updatedAt: string
}

export type RecentDocument = RecentLocalDocument | RecentStorageDocument

export const recentDocuments = useLocalStorage<RecentDocument[]>(RECENT_DOCUMENTS_STORAGE_KEY, [])

export const archivedDocuments = useLocalStorage<RecentDocument[]>(
  ARCHIVED_DOCUMENTS_STORAGE_KEY,
  []
)

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function localDocumentId(path: string): string {
  return `local:${path}`
}

function storageDocumentId(providerId: StorageProviderID, documentId: string): string {
  return `storage:${providerId}:${documentId}`
}

function normalizedRecentDocuments(): RecentDocument[] {
  return recentDocuments.value.slice(0, MAX_RECENT_DOCUMENTS)
}

export const recentFiles = computed<RecentDocument[]>(normalizedRecentDocuments)

export const recentLocalFilePaths = computed<string[]>(() =>
  normalizedRecentDocuments().flatMap((document) =>
    document.kind === 'local' ? [document.path] : []
  )
)

function remember(document: RecentDocument): void {
  recentDocuments.value = [
    document,
    ...normalizedRecentDocuments().filter((recent) => recent.id !== document.id)
  ].slice(0, MAX_RECENT_DOCUMENTS)
}

export function rememberRecentFile(path: string): void {
  remember({
    id: localDocumentId(path),
    kind: 'local',
    path,
    name: fileName(path),
    updatedAt: new Date().toISOString()
  })
}

export function rememberRecentStorageDocument(
  providerId: StorageProviderID,
  documentId: string,
  name: string
): void {
  remember({
    id: storageDocumentId(providerId, documentId),
    kind: 'storage',
    providerId,
    documentId,
    name,
    updatedAt: new Date().toISOString()
  })
}

export function forgetRecentDocument(id: string): void {
  recentDocuments.value = normalizedRecentDocuments().filter((document) => document.id !== id)
}

export function forgetRecentFile(path: string): void {
  forgetRecentDocument(localDocumentId(path))
}

export function forgetArchivedDocument(id: string): void {
  archivedDocuments.value = archivedDocuments.value.filter((document) => document.id !== id)
}

/** Archive: move the list entry into the archived area — the local file stays on disk. */
export function archiveRecentDocument(id: string): void {
  const document = normalizedRecentDocuments().find((candidate) => candidate.id === id)
  if (!document) return
  archivedDocuments.value = [document, ...archivedDocuments.value]
  forgetRecentDocument(id)
}

/** Restore: move an archived entry back to the recent list. */
export function restoreArchivedDocument(id: string): void {
  const document = archivedDocuments.value.find((candidate) => candidate.id === id)
  if (!document) return
  remember(document)
  forgetArchivedDocument(id)
}

/**
 * Deletes a recent local document for real: drops the cached cover, removes the
 * .fig from disk, then drops the list entry. A file already gone from disk still
 * loses its entry — the intent is to get rid of it either way.
 */
async function removeLocalFileFromDisk(path: string): Promise<void> {
  await removeRecentFileThumbnail(path)
  const { remove } = await import("@tauri-apps/plugin-fs")
  try {
    await remove(path)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/not found|os error 2|cannot find/i.test(message)) throw error
  }
}

export async function deleteRecentLocalDocument(document: RecentLocalDocument): Promise<void> {
  await removeLocalFileFromDisk(document.path)
  forgetRecentDocument(document.id)
}

export async function deleteArchivedLocalDocument(document: RecentLocalDocument): Promise<void> {
  await removeLocalFileFromDisk(document.path)
  forgetArchivedDocument(document.id)
}

export async function clearRecentFiles(): Promise<void> {
  recentDocuments.value = []
  await clearRecentFileThumbnails()
}

export function recentLocalFileAt(index: number): string | null {
  return recentLocalFilePaths.value[index] ?? null
}
