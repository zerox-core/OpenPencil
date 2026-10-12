<script setup lang="ts">
import { useDocumentWorkspace, useI18n } from '@open-pencil/vue'

import { computed, ref, watch } from 'vue'

import { createStorageWorkspaceSource } from '@/app/storage/workspace/source'
import {
  archivedDocuments,
  deleteArchivedLocalDocument,
  loadRecentFileThumbnail,
  restoreArchivedDocument,
  type RecentDocument,
  type RecentLocalDocument
} from '@/app/recent-files'
import DocumentEntry from '@/components/home/document/DocumentEntry.vue'
import AppConfirmationDialog from '@/components/ui/dialog/AppConfirmationDialog.vue'
import IconButton from '@/components/ui/button/IconButton.vue'

const { locale, files, common } = useI18n()

const workspace = useDocumentWorkspace<RecentDocument>({
  source: {
    async refresh() {
      return archivedDocuments.value
    },
    loadPreview(documentId) {
      const document = archivedDocuments.value.find((candidate) => candidate.id === documentId)
      if (!document) return Promise.resolve(null)
      if (document.kind === 'local') return loadRecentFileThumbnail(document.path)
      return createStorageWorkspaceSource(() => undefined).loadPreview(document.documentId)
    }
  },
  refreshOnFocus: false,
  refreshOnReconnect: false,
  previewConcurrency: 2
})

const documents = workspace.documents
const previewURL = workspace.previewURL
const vWorkspacePreview = workspace.previewDirective

watch(archivedDocuments, () => void workspace.invalidate())

function formattedDate(updatedAt: string): string {
  const date = new Date(updatedAt)
  if (date.getTime() === 0) return ''
  return date.toLocaleString(locale.value)
}

const deleteError = ref<string | null>(null)
const pendingDelete = ref<RecentLocalDocument | null>(null)
const deleting = ref(false)

const deleteDialogOpen = computed({
  get: () => pendingDelete.value !== null,
  set: (value: boolean) => {
    if (!value) pendingDelete.value = null
  }
})
const deleteDialogDescription = computed(() => {
  const document = pendingDelete.value
  if (!document) return ''
  return files.value.deleteArchivedFileDescription({ path: document.path })
})

function requestDelete(document: RecentDocument): void {
  if (document.kind !== 'local') return
  deleteError.value = null
  pendingDelete.value = document
}

async function confirmDelete(): Promise<void> {
  const document = pendingDelete.value
  if (!document) return
  deleting.value = true
  try {
    await deleteArchivedLocalDocument(document)
  } catch (error) {
    deleteError.value = files.value.deleteRecentFileFailed({
      name: document.name,
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    deleting.value = false
    pendingDelete.value = null
  }
}
</script>

<template>
  <section v-if="documents.length > 0" class="mt-7" data-test-id="archived-files-home">
    <div class="mb-3 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2">
      <div class="col-span-2 min-w-0 sm:col-span-1">
        <h2 class="text-base font-semibold">{{ files.archivedFiles }}</h2>
        <p class="mt-0.5 text-pretty text-xs text-muted">{{ files.archivedFilesDescription }}</p>
      </div>
    </div>

    <p v-if="deleteError" class="mb-4 text-xs text-danger" role="alert">{{ deleteError }}</p>

    <div class="grid grid-cols-1 gap-x-5 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
      <DocumentEntry
        v-for="document in documents"
        :key="document.id"
        v-workspace-preview="document.id"
        :name="document.name"
        :metadata="formattedDate(document.updatedAt)"
        :previewURL="previewURL(document.id)"
        @open="restoreArchivedDocument(document.id)"
      >
        <template #actions>
          <IconButton
            :label="files.restoreArchivedFile"
            class="size-10 sm:size-7"
            data-test-id="archived-file-restore"
            @click="restoreArchivedDocument(document.id)"
          >
            <icon-lucide-undo-2 class="size-3.5" />
          </IconButton>
          <IconButton
            v-if="document.kind === 'local'"
            :label="files.deleteRecentFile"
            class="size-10 sm:size-7"
            data-test-id="archived-file-delete"
            @click="requestDelete(document)"
          >
            <icon-lucide-trash-2 class="size-3.5" />
          </IconButton>
        </template>
      </DocumentEntry>
    </div>

    <AppConfirmationDialog
      v-model:open="deleteDialogOpen"
      tone="danger"
      :heading="pendingDelete ? files.deleteRecentFileTitle({ name: pendingDelete.name }) : ''"
      :description="deleteDialogDescription"
      :cancel-label="common.cancel"
      :confirm-label="files.deleteRecentFile"
      :confirm-loading="deleting"
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </section>
</template>
