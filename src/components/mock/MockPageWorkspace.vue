<script setup lang="ts">
import { useElementSize, useEventListener } from '@vueuse/core'
import { strToU8, zipSync } from 'fflate'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import { useI18n } from '@open-pencil/vue'

import {
  aiModelSettings,
  createAIModelRuntime,
  designModelProfiles,
  setModelRoleAssignment,
  type AIModelProfileId
} from '@/app/ai/models'
import { useVoiceInput } from '@/app/ai/voice/use-voice-input'
import { saveExportedFile } from '@/app/document/export/files'
import { downloadBlob } from '@/app/document/io/browser'
import { useEditorStore } from '@/app/editor/active-store'
import { runMockAgent } from '@/app/mock/agent'
import { MOCK_PAGE_SIZES, ensureMockPage, getMockPageId, mockPageState } from '@/app/mock/pages'
import {
  clampProjectSize,
  composePreview,
  extractHTML,
  parseProjectFiles
} from '@/app/mock/project'
import type { MockPageSizeKind } from '@/app/mock/pages'
import { IS_TAURI } from '@/constants'
import AppButton from '@/components/ui/button/AppButton.vue'
import IconButton from '@/components/ui/button/IconButton.vue'

const SIZE_KINDS: MockPageSizeKind[] = ['desktop', 'tablet', 'phone']
const MAX_ACTIVITY_EVENTS = 8

interface AgentActivity {
  id: number
  label: string
  done: boolean
}

const { ai } = useI18n()
const store = useEditorStore()

const pageNode = computed(() => {
  void store.state.sceneVersion
  return store.graph.getNode(store.state.currentPageId)
})
const page = computed(() => mockPageState(pageNode.value))

watch(
  () => getMockPageId(pageNode.value),
  (mockId) => {
    if (mockId) ensureMockPage(mockId)
  },
  { immediate: true }
)

const prompt = ref('')
const view = ref<'preview' | 'code'>('preview')
const generating = ref(false)
const exporting = ref(false)
const errorMsg = ref('')
const streamedText = ref('')
const selectedFile = ref('')
const reasoningText = ref('')
const reasoningOpen = ref(true)
const elapsedMs = ref(0)
const fullscreen = ref(false)
const activity = ref<AgentActivity[]>([])
const shareURL = ref('')
const sharePort = ref(0)
const sharing = ref(false)
const shareCopied = ref(false)
const shareBusy = ref(false)

const { voiceState, voiceError, handleVoiceButton } = useVoiceInput(prompt)

const hasPage = computed(() => (page.value?.html.length ?? 0) > 0)

const projectFiles = computed<Record<string, string>>(() => {
  const state = page.value
  if (!state) return {}
  const names = Object.keys(state.files)
  if (names.length > 0) return state.files
  return state.html ? { 'page.html': state.html } : {}
})

const fileList = computed<string[]>(() => Object.keys(projectFiles.value))

const entryFile = computed<string>(() =>
  fileList.value.includes('index.html') ? 'index.html' : (fileList.value[0] ?? 'page.html')
)

const activeFileContent = computed<string>(() => projectFiles.value[selectedFile.value] ?? '')

watch(
  fileList,
  (names) => {
    if (!names.includes(selectedFile.value)) selectedFile.value = names[0] ?? ''
  },
  { immediate: true }
)

const currentSource = computed<string>(() => {
  const state = page.value
  if (!state) return ''
  const names = Object.keys(state.files)
  if (names.length > 0) {
    return names.map((path) => `<!-- file: ${path} -->\n${state.files[path] ?? ''}`).join('\n\n')
  }
  return state.html
})

const stageRef = ref<HTMLElement | null>(null)
const { width: stageWidth, height: stageHeight } = useElementSize(stageRef)

const frameScale = computed(() => {
  const state = page.value
  if (!state) return 1
  const availWidth = stageWidth.value - 48
  const availHeight = stageHeight.value - 80
  if (availWidth <= 0 || availHeight <= 0) return 1
  return Math.min(1, availWidth / state.width, availHeight / state.height)
})

const frameStyle = computed<Record<string, string>>((): Record<string, string> => {
  const state = page.value
  if (!state) return {}
  const scale = frameScale.value
  return {
    width: `${state.width * scale}px`,
    height: `${state.height * scale}px`
  }
})

const innerStyle = computed<Record<string, string>>((): Record<string, string> => {
  const state = page.value
  if (!state) return {}
  return {
    width: `${state.width}px`,
    height: `${state.height}px`,
    transform: `scale(${frameScale.value})`,
    transformOrigin: 'top left'
  }
})

const elapsedLabel = computed<string>(() => {
  const seconds = elapsedMs.value / 1000
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60)
    return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
  }
  return `${seconds.toFixed(1)}s`
})

const activityLabel = computed<string>(() => {
  const events = activity.value
  if (events.length === 0) return ''
  const last = events[events.length - 1]
  if (!last) return ''
  return last.done ? `${last.label} ✓` : `${last.label} …`
})

const messagesRef = ref<HTMLElement | null>(null)
watch(
  () => page.value?.messages.length,
  async () => {
    await nextTick()
    const el = messagesRef.value
    if (el) el.scrollTop = el.scrollHeight
  }
)

let activitySeq = 0

function pushActivity(label: string): void {
  activity.value.push({ id: ++activitySeq, label, done: false })
  if (activity.value.length > MAX_ACTIVITY_EVENTS) {
    activity.value.splice(0, activity.value.length - MAX_ACTIVITY_EVENTS)
  }
}

function finishActivity(ok: boolean): void {
  for (let index = activity.value.length - 1; index >= 0; index--) {
    const event = activity.value[index]
    if (event && !event.done) {
      event.done = true
      if (!ok) event.label = `${event.label} ✗`
      break
    }
  }
}

function sizeKindLabel(kind: MockPageSizeKind): string {
  if (kind === 'tablet') return ai.value.mockPageSizeTablet
  if (kind === 'phone') return ai.value.mockPageSizePhone
  return ai.value.mockPageSizeDesktop
}

function isActiveSize(kind: MockPageSizeKind): boolean {
  const state = page.value
  if (!state) return false
  return (
    state.width === MOCK_PAGE_SIZES[kind].width && state.height === MOCK_PAGE_SIZES[kind].height
  )
}

function applySize(kind: MockPageSizeKind) {
  const state = page.value
  if (!state || generating.value) return
  state.width = MOCK_PAGE_SIZES[kind].width
  state.height = MOCK_PAGE_SIZES[kind].height
}

function handleModelChange(event: Event) {
  const profileId = (event.target as HTMLSelectElement).value as AIModelProfileId
  setModelRoleAssignment('design', profileId)
}

let generateTimer: ReturnType<typeof setInterval> | undefined

function stopTimer(): void {
  if (generateTimer !== undefined) {
    clearInterval(generateTimer)
    generateTimer = undefined
  }
}

async function generate() {
  const state = page.value
  const text = prompt.value.trim()
  if (!state || !text || generating.value) return
  errorMsg.value = ''
  const runtime = await createAIModelRuntime('design')
  if (!runtime || runtime.kind !== 'direct') {
    errorMsg.value = ai.value.htmlPageNeedModel
    return
  }
  generating.value = true
  state.messages.push({ role: 'user', text })
  prompt.value = ''
  streamedText.value = ''
  reasoningText.value = ''
  activity.value = []
  elapsedMs.value = 0
  const startedAt = performance.now()
  stopTimer()
  generateTimer = setInterval(() => {
    elapsedMs.value = performance.now() - startedAt
  }, 100)
  const pendingFiles: Record<string, string> = { ...state.files }
  try {
    const result = await runMockAgent({
      model: runtime.model,
      providerID: runtime.role.connection.providerID,
      reasoningEffort: runtime.role.profile.reasoningEffort ?? '',
      prompt: text,
      hasProject: hasPage.value,
      currentSource: currentSource.value,
      handlers: {
        setCanvasSize: (width, height) => {
          state.width = clampProjectSize(width)
          state.height = clampProjectSize(height)
        },
        writeProjectFile: (path, content) => {
          pendingFiles[path] = content
          state.files = { ...pendingFiles }
          const composed = composePreview(state.files)
          if (composed) state.html = composed
        }
      },
      onUpdate: {
        onTextDelta: (chunk) => {
          streamedText.value += chunk
        },
        onReasoningDelta: (chunk) => {
          reasoningText.value += chunk
        },
        onToolStart: (_name, label) => pushActivity(label),
        onToolDone: (_name, _label, ok) => finishActivity(ok)
      }
    })
    if (result.filesWritten === 0) {
      const parsedFiles = parseProjectFiles(result.fullText)
      if (Object.keys(parsedFiles).length > 0) {
        const composed = composePreview(parsedFiles)
        if (!composed) {
          errorMsg.value = ai.value.htmlPageNoHtml
          state.messages.push({ role: 'assistant', text: ai.value.htmlPageNoHtml })
          return
        }
        state.files = parsedFiles
        state.html = composed
      } else {
        const single = extractHTML(result.fullText)
        if (!single) {
          errorMsg.value = ai.value.htmlPageNoHtml
          state.messages.push({ role: 'assistant', text: ai.value.htmlPageNoHtml })
          return
        }
        state.files = {}
        state.html = single
      }
    }
    view.value = 'preview'
    state.messages.push({
      role: 'assistant',
      text: result.summary || ai.value.mockPageAssistantDone
    })
  } catch (error) {
    console.warn('mock page generation failed', error)
    errorMsg.value = ai.value.htmlPageFailed
    state.messages.push({ role: 'assistant', text: ai.value.htmlPageFailed })
  } finally {
    stopTimer()
    generating.value = false
  }
}

async function downloadProject() {
  const state = page.value
  if (!state || !state.html || exporting.value) return
  exporting.value = true
  try {
    const entries: Record<string, Uint8Array> = {}
    for (const [path, content] of Object.entries(projectFiles.value)) {
      entries[path] = strToU8(content)
    }
    await saveExportedFile(
      zipSync(entries),
      'mock-project.zip',
      'ZIP',
      '.zip',
      'application/zip',
      downloadBlob
    )
  } catch (error) {
    console.warn('mock page export failed', error)
  } finally {
    exporting.value = false
  }
}

async function startShare() {
  const state = page.value
  if (!state?.html || shareBusy.value) return
  if (!IS_TAURI) {
    errorMsg.value = ai.value.mockPageShareDesktopOnly
    return
  }
  shareBusy.value = true
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const files = [
      { path: 'index.html', content: state.html },
      ...Object.entries(projectFiles.value).map(([path, content]) => ({ path, content }))
    ]
    const info = await invoke<{ url: string; port: number }>('mock_share_publish', {
      files,
      entry: 'index.html'
    })
    shareURL.value = info.url
    sharePort.value = info.port
    sharing.value = true
    shareCopied.value = false
  } catch (error) {
    console.warn('mock page share failed', error)
    errorMsg.value = ai.value.mockPageShareFailed
  } finally {
    shareBusy.value = false
  }
}

async function stopShare() {
  shareBusy.value = true
  try {
    if (IS_TAURI) {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('mock_share_stop')
    }
  } catch (error) {
    console.warn('mock page share stop failed', error)
  } finally {
    sharing.value = false
    shareURL.value = ''
    sharePort.value = 0
    shareBusy.value = false
  }
}

async function copyShareURL() {
  if (!shareURL.value) return
  try {
    await navigator.clipboard.writeText(shareURL.value)
    shareCopied.value = true
    setTimeout(() => {
      shareCopied.value = false
    }, 2000)
  } catch (error) {
    console.warn('copy share url failed', error)
  }
}

function toggleFullscreen() {
  fullscreen.value = !fullscreen.value
}

function handleWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && fullscreen.value) fullscreen.value = false
}

useEventListener(window, 'keydown', handleWindowKeydown)

onBeforeUnmount(() => {
  stopTimer()
  if (sharing.value && IS_TAURI) {
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('mock_share_stop')
      } catch (error) {
        console.warn('mock page share stop on unmount failed', error)
      }
    })()
  }
})

function handlePromptKeydown(event: KeyboardEvent) {
  if (event.code !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void generate()
}
</script>

<template>
  <div class="flex min-w-0 flex-1" data-test-id="mock-page-workspace">
    <div class="flex w-[340px] shrink-0 flex-col border-r border-border bg-panel">
      <div
        ref="messagesRef"
        class="min-h-0 flex-1 overflow-y-auto p-3"
        data-test-id="mock-page-messages"
      >
        <div
          v-if="!page || page.messages.length === 0"
          class="flex h-full flex-col items-center justify-center gap-2 text-center"
        >
          <icon-lucide-sparkles class="size-6 text-muted/50" />
          <p class="text-xs text-muted">{{ ai.mockPageEmptyTitle }}</p>
          <p class="max-w-60 text-[10px] leading-relaxed text-muted/60">
            {{ ai.mockPageEmptyHint }}
          </p>
        </div>
        <template v-else>
          <div
            v-for="(message, index) in page.messages"
            :key="index"
            class="mb-2 flex"
            :class="message.role === 'user' ? 'justify-end' : 'justify-start'"
          >
            <div
              class="max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap"
              :class="
                message.role === 'user' ? 'bg-accent text-white' : 'bg-surface/5 text-surface'
              "
              :data-test-id="
                message.role === 'user' ? 'mock-page-msg-user' : 'mock-page-msg-assistant'
              "
            >
              {{ message.text }}
            </div>
          </div>
          <div v-if="generating" class="mb-2 flex justify-start">
            <div
              class="flex items-center gap-2 rounded-lg bg-surface/5 px-3 py-2 text-xs text-muted"
              data-test-id="mock-page-generating"
            >
              <span class="mock-breathe inline-block size-1.5 rounded-full bg-accent"></span>
              <span>{{ ai.htmlPageGenerating }}</span>
              <span class="tabular-nums" data-test-id="mock-page-elapsed">{{ elapsedLabel }}</span>
            </div>
          </div>
        </template>
      </div>
      <div class="shrink-0 border-t border-border p-2.5">
        <div
          v-if="generating || errorMsg || voiceState !== 'idle' || voiceError"
          class="px-1 pb-1.5 text-[11px] leading-tight"
          :class="errorMsg || voiceError ? 'text-red-400' : 'text-muted'"
          data-test-id="mock-page-status"
        >
          <template v-if="voiceError">{{ voiceError }}</template>
          <template v-else-if="errorMsg">{{ errorMsg }}</template>
          <template v-else-if="voiceState === 'recording'">{{ ai.voiceListening }}</template>
          <template v-else-if="voiceState === 'transcribing'">{{ ai.voiceTranscribing }}</template>
          <template v-else-if="voiceState === 'polishing'">{{ ai.voicePolishing }}</template>
          <template v-else
            >{{ ai.htmlPageGenerating }} · {{ elapsedLabel }} ·
            {{ streamedText.length }}</template
          >
        </div>
        <div class="flex items-end gap-2">
          <textarea
            v-model="prompt"
            rows="2"
            :placeholder="hasPage ? ai.htmlPageModifyPlaceholder : ai.htmlPagePlaceholder"
            :disabled="generating"
            class="block min-h-12 w-full resize-none rounded border border-border bg-transparent px-3 py-2 text-xs leading-relaxed text-surface outline-none placeholder:text-muted disabled:opacity-60"
            data-test-id="mock-page-prompt"
            @keydown="handlePromptKeydown"
          ></textarea>
          <IconButton
            :label="voiceState === 'recording' ? ai.stopVoiceInput : ai.voiceInput"
            size="sm"
            data-test-id="mock-page-voice-button"
            :disabled="generating || voiceState === 'transcribing' || voiceState === 'polishing'"
            :class="
              voiceState === 'recording'
                ? 'border border-red-500 text-red-500 hover:text-red-500'
                : ''
            "
            @click="handleVoiceButton"
          >
            <icon-lucide-loader-circle
              v-if="voiceState === 'transcribing' || voiceState === 'polishing'"
              class="size-3.5 animate-spin"
            />
            <icon-lucide-square v-else-if="voiceState === 'recording'" class="size-3" />
            <icon-lucide-mic v-else class="size-3.5" />
          </IconButton>
          <AppButton
            size="sm"
            data-test-id="mock-page-generate"
            :disabled="generating || !prompt.trim()"
            @click="generate"
          >
            {{ ai.htmlPageGenerate }}
          </AppButton>
        </div>
      </div>
    </div>

    <div
      class="flex min-w-0 flex-col bg-[#141518]"
      :class="fullscreen ? 'fixed inset-0 z-50' : 'flex-1'"
    >
      <div class="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 px-3">
        <div class="flex rounded bg-black/30 p-0.5">
          <button
            type="button"
            data-test-id="mock-page-preview-toggle"
            class="rounded px-2.5 py-1 text-[10px]"
            :class="
              view === 'preview'
                ? 'bg-white/10 font-semibold text-surface'
                : 'text-muted hover:text-surface'
            "
            @click="view = 'preview'"
          >
            {{ ai.htmlPagePreview }}
          </button>
          <button
            type="button"
            data-test-id="mock-page-code-toggle"
            class="rounded px-2.5 py-1 text-[10px]"
            :class="
              view === 'code'
                ? 'bg-white/10 font-semibold text-surface'
                : 'text-muted hover:text-surface'
            "
            @click="view = 'code'"
          >
            {{ ai.htmlPageCode }}
          </button>
        </div>
        <div class="mx-1 h-4 w-px bg-white/10" />
        <button
          v-for="kind in SIZE_KINDS"
          :key="kind"
          type="button"
          class="rounded px-2 py-1 text-[10px]"
          :class="
            isActiveSize(kind)
              ? 'bg-white/10 font-semibold text-surface'
              : 'text-muted hover:text-surface'
          "
          :data-test-id="'mock-page-size-' + kind"
          @click="applySize(kind)"
        >
          {{ sizeKindLabel(kind) }}
        </button>
        <span class="text-[10px] text-muted tabular-nums" data-test-id="mock-page-size-label">
          {{ page?.width ?? 0 }} × {{ page?.height ?? 0 }}
        </span>
        <div class="flex-1" />
        <template v-if="sharing">
          <span
            class="max-w-44 truncate font-mono text-[10px] text-muted"
            :title="shareURL"
            data-test-id="mock-page-share-url"
          >
            {{ shareURL }}
          </span>
          <IconButton
            :label="shareCopied ? ai.mockPageShareCopied : ai.mockPageShareLink"
            size="sm"
            data-test-id="mock-page-share-copy"
            @click="copyShareURL"
          >
            <icon-lucide-check v-if="shareCopied" class="size-3 text-green-400" />
            <icon-lucide-copy v-else class="size-3" />
          </IconButton>
          <AppButton
            size="xs"
            variant="outline"
            data-test-id="mock-page-share-stop"
            :disabled="shareBusy"
            @click="stopShare"
          >
            {{ ai.mockPageShareStop }}
          </AppButton>
        </template>
        <AppButton
          v-else
          size="xs"
          variant="outline"
          data-test-id="mock-page-share"
          :disabled="!hasPage || shareBusy"
          @click="startShare"
        >
          {{ ai.mockPageShare }}
        </AppButton>
        <IconButton
          :label="fullscreen ? ai.mockPageExitFullscreen : ai.mockPageFullscreen"
          size="sm"
          data-test-id="mock-page-fullscreen-toggle"
          @click="toggleFullscreen"
        >
          <icon-lucide-minimize-2 v-if="fullscreen" class="size-3.5" />
          <icon-lucide-maximize-2 v-else class="size-3.5" />
        </IconButton>
        <select
          :value="aiModelSettings.assignments.design"
          :disabled="generating"
          :title="ai.mockPageModel"
          class="h-6 max-w-32 rounded border border-white/10 bg-transparent px-1 text-[10px] text-surface outline-none disabled:opacity-50"
          data-test-id="mock-page-model-select"
          @change="handleModelChange"
        >
          <option v-for="profile in designModelProfiles()" :key="profile.id" :value="profile.id">
            {{ profile.name }}
          </option>
        </select>
        <AppButton
          size="xs"
          variant="outline"
          data-test-id="mock-page-download"
          :disabled="!hasPage || exporting"
          @click="downloadProject"
        >
          {{ ai.mockPageDownload }}
        </AppButton>
      </div>

      <div
        ref="stageRef"
        class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        data-test-id="mock-page-stage"
      >
        <div v-if="view === 'preview'" :style="frameStyle" class="relative shrink-0">
          <div
            :style="innerStyle"
            class="absolute top-0 left-0 flex flex-col overflow-hidden rounded-lg shadow-[0_8px_30px_rgb(0_0_0/0.5)]"
            :class="hasPage ? 'border border-white/10' : 'border border-dashed border-white/15'"
          >
            <div
              class="flex h-8 shrink-0 items-center gap-1.5 border-b border-white/10 bg-[#1e2025] px-3"
            >
              <span class="size-2.5 rounded-full bg-[#ff5f57]/80" />
              <span class="size-2.5 rounded-full bg-[#febc2e]/80" />
              <span class="size-2.5 rounded-full bg-[#28c840]/80" />
              <div
                class="ml-2 flex h-5 min-w-0 flex-1 items-center gap-1 rounded bg-black/30 px-2 text-[10px] text-muted"
              >
                <icon-lucide-globe class="size-3 shrink-0" />
                <span class="truncate">localhost:5173/{{ entryFile }}</span>
              </div>
            </div>
            <iframe
              v-if="hasPage"
              sandbox="allow-scripts"
              :srcdoc="page?.html ?? ''"
              title="mock-page-preview"
              class="min-h-0 flex-1 border-0 bg-white"
              data-test-id="mock-page-preview-frame"
            ></iframe>
            <div
              v-else
              class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
              data-test-id="mock-page-empty"
            >
              <icon-lucide-globe class="size-8 text-muted/50" />
              <p class="text-xs text-muted">{{ ai.mockPageEmptyTitle }}</p>
              <p class="max-w-64 text-[10px] leading-relaxed text-muted/60">
                {{ ai.mockPageEmptyHint }}
              </p>
            </div>
          </div>
        </div>
        <div v-else class="flex min-h-0 size-full gap-2 p-3" data-test-id="mock-page-code">
          <div
            v-if="!generating && fileList.length > 0"
            class="max-h-full w-44 shrink-0 overflow-y-auto rounded-lg border border-white/10 bg-black/30 p-1.5"
            data-test-id="mock-page-file-list"
          >
            <button
              v-for="path in fileList"
              :key="path"
              type="button"
              class="mb-0.5 flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left font-mono text-[10px]"
              :class="
                path === selectedFile ? 'bg-white/10 text-surface' : 'text-muted hover:text-surface'
              "
              data-test-id="mock-page-file-item"
              :data-path="path"
              @click="selectedFile = path"
            >
              <icon-lucide-file class="size-3 shrink-0" />
              <span class="truncate">{{ path }}</span>
            </button>
          </div>
          <div class="flex min-h-0 min-w-0 flex-1 flex-col">
            <div class="mb-2 shrink-0 text-[10px] text-muted" data-test-id="mock-page-code-hint">
              {{ generating ? ai.htmlPageGenerating : ai.mockPageCodeReadonly }}
            </div>
            <pre
              class="min-h-0 flex-1 overflow-auto rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-surface/80"
              data-test-id="mock-page-code-view"
              >{{ generating ? streamedText : activeFileContent }}</pre>
          </div>
        </div>
        <div
          v-if="generating"
          class="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center gap-2 px-4"
          data-test-id="mock-page-gen-overlay"
        >
          <div
            class="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-accent/40 bg-[#1a1c20]/95 px-4 py-1.5 shadow-lg"
            data-test-id="mock-page-gen-pill"
          >
            <span class="mock-breathe inline-block size-2 rounded-full bg-accent"></span>
            <span class="text-xs text-surface">{{ ai.htmlPageGenerating }}</span>
            <span class="text-[10px] text-muted tabular-nums" data-test-id="mock-page-elapsed">{{
              elapsedLabel
            }}</span>
            <span class="h-3 w-px bg-white/10"></span>
            <span
              class="max-w-56 truncate text-[10px] text-muted"
              data-test-id="mock-page-activity"
              >{{ activityLabel }}</span
            >
          </div>
          <div
            v-if="reasoningText"
            class="pointer-events-auto w-full max-w-md overflow-hidden rounded-lg border border-white/10 bg-[#1a1c20]/95 shadow-lg"
            data-test-id="mock-page-reasoning"
          >
            <button
              type="button"
              class="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[10px] text-muted"
              data-test-id="mock-page-reasoning-toggle"
              @click="reasoningOpen = !reasoningOpen"
            >
              <icon-lucide-brain class="size-3" />
              <span>{{ ai.mockPageThinking }}</span>
              <span class="ml-auto">{{ reasoningOpen ? '−' : '+' }}</span>
            </button>
            <pre
              v-if="reasoningOpen"
              class="max-h-40 overflow-y-auto border-t border-white/10 px-3 py-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted/90"
              data-test-id="mock-page-reasoning-text"
              >{{ reasoningText }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mock-breathe {
  animation: mock-breathe 1.6s ease-in-out infinite;
}

@keyframes mock-breathe {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.8);
  }
  50% {
    opacity: 1;
    transform: scale(1.35);
  }
}
</style>
