<script setup lang="ts">
import { useElementSize } from '@vueuse/core'
import { streamText } from 'ai'
import { strToU8, zipSync } from 'fflate'
import { computed, nextTick, ref, watch } from 'vue'

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
import { MOCK_PAGE_SIZES, ensureMockPage, getMockPageId, mockPageState } from '@/app/mock/pages'
import type { MockPageSizeKind } from '@/app/mock/pages'
import AppButton from '@/components/ui/button/AppButton.vue'
import IconButton from '@/components/ui/button/IconButton.vue'

const SYSTEM_PROMPT = [
  '你是一个资深前端工程师。根据用户的描述生成一个完整的前端小项目，由多个文件组成，保持正常的工作目录结构。',
  '必须包含 index.html 作为入口；样式放 styles/main.css，交互脚本放 scripts/main.js；内容较多时可按需增加文件（如 styles/theme.css、scripts/utils.js），一律使用相对路径引用。',
  'CSS 通过 <link rel="stylesheet" href="styles/main.css"> 引入；JS 通过 <script src="scripts/main.js"> 标签引入；也可以通过 CDN 引入公开库（如 Tailwind、ECharts）。',
  '每个文件的内容之前必须有一行独立的文件标记注释，格式如下（标记独占一行，路径不加引号）：',
  '<!-- file: index.html -->',
  '<!-- file: styles/main.css -->',
  '<!-- file: scripts/main.js -->',
  '输出的第一行必须是画布尺寸声明注释：<!-- page-size: 宽x高 -->，之后按顺序输出每个文件。',
  '根据用户描述选择尺寸：桌面网页 1440x900、手机页面 390x844、平板页面 834x1194；',
  '用户明确给出尺寸时以用户为准；未指明时默认 1440x900，并按该尺寸设计布局。',
  '页面要美观、现代、可交互，默认使用中文文案，除非用户另有要求。',
  '只输出文件内容本身，不要任何解释，不要使用 Markdown 代码围栏。'
].join('\n')

const PAGE_SIZE_PATTERN = /<!--\s*page-size:\s*(\d+)\s*x\s*(\d+)\s*-->/i
const FILE_MARKER_PATTERN = /<!--\s*file:\s*([^>\r\n]+?)\s*-->/g
const SCRIPT_CLOSE = '<\x2fscript>'

const SIZE_KINDS: MockPageSizeKind[] = ['desktop', 'tablet', 'phone']

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

const messagesRef = ref<HTMLElement | null>(null)
watch(
  () => page.value?.messages.length,
  async () => {
    await nextTick()
    const el = messagesRef.value
    if (el) el.scrollTop = el.scrollHeight
  }
)

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

function projectPath(target: string): string {
  return target.trim().replace(/^\.?\//, '')
}

function stripFences(text: string): string {
  let t = text.trim()
  const fence = t.match(/```(?:html)?\s*([\s\S]*?)```/i)
  if (fence) t = (fence[1] ?? '').trim()
  return t
}

function extractHTML(text: string): string {
  const t = stripFences(text)
  const lower = t.toLowerCase()
  const doctypeIdx = lower.indexOf('<!doctype')
  const htmlIdx = lower.indexOf('<html')
  const start = doctypeIdx !== -1 ? doctypeIdx : htmlIdx
  if (start > 0) return t.slice(start)
  if (start === -1 && !/<[a-z][\s\S]*>/i.test(t)) return ''
  return t
}

function parseProjectFiles(text: string): Record<string, string> {
  const files: Record<string, string> = {}
  const source = stripFences(text)
  const markers = [...source.matchAll(FILE_MARKER_PATTERN)]
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index]
    if (!marker || marker.index === undefined) continue
    const path = projectPath(marker[1] ?? '')
    if (!path) continue
    const start = marker.index + marker[0].length
    const next = markers[index + 1]
    const end = next && next.index !== undefined ? next.index : source.length
    const content = source.slice(start, end).trim()
    if (content) files[path] = content
  }
  return files
}

function composePreview(files: Record<string, string>): string {
  let html = files['index.html']
  if (html === undefined) {
    const fallback = Object.keys(files).find((name) => name.endsWith('.html'))
    html = fallback === undefined ? '' : (files[fallback] ?? '')
  }
  if (!html) return ''
  html = html.replace(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi, (tag, href: string) => {
    const css = files[projectPath(href)]
    return css === undefined ? tag : `<style>\n${css}\n</style>`
  })
  html = html.replace(
    /<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
    (tag, src: string) => {
      const js = files[projectPath(src)]
      return js === undefined ? tag : `<script>\n${js}\n${SCRIPT_CLOSE}`
    }
  )
  return html
}

function clampSize(value: number): number {
  return Math.min(2560, Math.max(320, Math.round(value)))
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
  view.value = 'code'
  try {
    const userContent = hasPage.value
      ? `这是当前项目的完整源代码：\n\n${currentSource.value}\n\n请按以下要求修改这个项目，按原格式返回修改后的全部文件。\n${text}`
      : text
    const stream = streamText({
      model: runtime.model,
      system: SYSTEM_PROMPT,
      prompt: userContent,
      maxOutputTokens: 16000
    })
    let accumulated = ''
    for await (const chunk of stream.textStream) {
      accumulated += chunk
      streamedText.value = accumulated
    }
    const sizeMatch = accumulated.match(PAGE_SIZE_PATTERN)
    const parsedFiles = parseProjectFiles(accumulated)
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
      const single = extractHTML(accumulated)
      if (!single) {
        errorMsg.value = ai.value.htmlPageNoHtml
        state.messages.push({ role: 'assistant', text: ai.value.htmlPageNoHtml })
        return
      }
      state.files = {}
      state.html = single
    }
    if (sizeMatch) {
      state.width = clampSize(Number(sizeMatch[1]))
      state.height = clampSize(Number(sizeMatch[2]))
    }
    view.value = 'preview'
    state.messages.push({ role: 'assistant', text: ai.value.mockPageAssistantDone })
  } catch (error) {
    console.warn('mock page generation failed', error)
    errorMsg.value = ai.value.htmlPageFailed
    state.messages.push({ role: 'assistant', text: ai.value.htmlPageFailed })
  } finally {
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
              class="rounded-lg bg-surface/5 px-3 py-2 text-xs text-muted"
              data-test-id="mock-page-generating"
            >
              {{ ai.htmlPageGenerating }} · {{ streamedText.length }}
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
          <template v-else>{{ ai.htmlPageGenerating }} · {{ streamedText.length }}</template>
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

    <div class="flex min-w-0 flex-1 flex-col bg-[#141518]">
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
        class="flex min-h-0 flex-1 items-center justify-center overflow-hidden"
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
      </div>
    </div>
  </div>
</template>
