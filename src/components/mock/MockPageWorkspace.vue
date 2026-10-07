<script setup lang="ts">
import { generateText } from 'ai'
import { useElementSize } from '@vueuse/core'
import { computed, nextTick, ref, watch } from 'vue'

import { useI18n } from '@open-pencil/vue'

import { createAIModelRuntime } from '@/app/ai/models'
import { useVoiceInput } from '@/app/ai/voice/use-voice-input'
import { saveExportedFile } from '@/app/document/export/files'
import { downloadBlob } from '@/app/document/io/browser'
import { useEditorStore } from '@/app/editor/active-store'
import { MOCK_PAGE_SIZES, ensureMockPage, getMockPageId, mockPageState } from '@/app/mock/pages'
import type { MockPageSizeKind } from '@/app/mock/pages'
import AppButton from '@/components/ui/button/AppButton.vue'
import IconButton from '@/components/ui/button/IconButton.vue'

const SYSTEM_PROMPT = [
  '你是一个资深前端工程师。根据用户的描述生成一个完整的、可直接在浏览器打开的单文件 HTML 页面。',
  'CSS 写在 style 标签内，JS 写在 script 标签内，可以通过 CDN 引入公开库（如 Tailwind、ECharts）。',
  '页面要美观、现代、可交互，默认使用中文文案，除非用户另有要求。',
  '输出的第一行必须是画布尺寸声明注释：<!-- page-size: 宽x高 -->。',
  '根据用户描述选择尺寸：桌面网页 1440x900、手机页面 390x844、平板页面 834x1194；',
  '用户明确给出尺寸时以用户为准；未指明时默认 1440x900，并按该尺寸设计布局。',
  '只输出 HTML 代码本身，不要任何解释，不要使用 Markdown 代码围栏。'
].join('')

const PAGE_SIZE_PATTERN = /<!--\s*page-size:\s*(\d+)\s*x\s*(\d+)\s*-->/i

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

const { voiceState, voiceError, handleVoiceButton } = useVoiceInput(prompt)

const hasPage = computed(() => (page.value?.html.length ?? 0) > 0)

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
  return state.width === MOCK_PAGE_SIZES[kind].width && state.height === MOCK_PAGE_SIZES[kind].height
}

function applySize(kind: MockPageSizeKind) {
  const state = page.value
  if (!state || generating.value) return
  state.width = MOCK_PAGE_SIZES[kind].width
  state.height = MOCK_PAGE_SIZES[kind].height
}

function extractHTML(text: string): string {
  let t = text.trim()
  const fence = t.match(/```(?:html)?\s*([\s\S]*?)```/i)
  if (fence) t = (fence[1] ?? '').trim()
  const lower = t.toLowerCase()
  const doctypeIdx = lower.indexOf('<!doctype')
  const htmlIdx = lower.indexOf('<html')
  const start = doctypeIdx !== -1 ? doctypeIdx : htmlIdx
  if (start > 0) t = t.slice(start)
  else if (start === -1 && !/<[a-z][\s\S]*>/i.test(t)) return ''
  return t
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
  try {
    const userContent = hasPage.value
      ? `这是当前页面的完整 HTML 代码：\n\n${state.html}\n\n请按以下要求修改这个页面，返回修改后的完整 HTML。\n${text}`
      : text
    const result = await generateText({
      model: runtime.model,
      system: SYSTEM_PROMPT,
      prompt: userContent,
      maxOutputTokens: 16000
    })
    const sizeMatch = result.text.match(PAGE_SIZE_PATTERN)
    const extracted = extractHTML(result.text)
    if (!extracted) {
      errorMsg.value = ai.value.htmlPageNoHtml
      state.messages.push({ role: 'assistant', text: ai.value.htmlPageNoHtml })
      return
    }
    if (sizeMatch) {
      state.width = clampSize(Number(sizeMatch[1]))
      state.height = clampSize(Number(sizeMatch[2]))
    }
    state.html = extracted
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

async function downloadHTML() {
  const state = page.value
  if (!state || !state.html || exporting.value) return
  exporting.value = true
  try {
    await saveExportedFile(
      new TextEncoder().encode(state.html),
      'page.html',
      'HTML',
      '.html',
      'text/html',
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
              :class="message.role === 'user' ? 'bg-accent text-white' : 'bg-surface/5 text-surface'"
              :data-test-id="
                message.role === 'user' ? 'mock-page-msg-user' : 'mock-page-msg-assistant'
              "
            >
              {{ message.text }}
            </div>
          </div>
          <div v-if="generating" class="mb-2 flex justify-start">
            <div class="rounded-lg bg-surface/5 px-3 py-2 text-xs text-muted">
              {{ ai.htmlPageGenerating }}
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
          <template v-else>{{ ai.htmlPageGenerating }}</template>
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
          />
          <IconButton
            :label="voiceState === 'recording' ? ai.stopVoiceInput : ai.voiceInput"
            size="sm"
            data-test-id="mock-page-voice-button"
            :disabled="generating || voiceState === 'transcribing' || voiceState === 'polishing'"
            :class="
              voiceState === 'recording' ? 'border border-red-500 text-red-500 hover:text-red-500' : ''
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
              view === 'preview' ? 'bg-white/10 font-semibold text-surface' : 'text-muted hover:text-surface'
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
              view === 'code' ? 'bg-white/10 font-semibold text-surface' : 'text-muted hover:text-surface'
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
          :class="isActiveSize(kind) ? 'bg-white/10 font-semibold text-surface' : 'text-muted hover:text-surface'"
          :data-test-id="'mock-page-size-' + kind"
          @click="applySize(kind)"
        >
          {{ sizeKindLabel(kind) }}
        </button>
        <span class="text-[10px] text-muted tabular-nums" data-test-id="mock-page-size-label">
          {{ page?.width ?? 0 }} × {{ page?.height ?? 0 }}
        </span>
        <div class="flex-1" />
        <AppButton
          size="xs"
          variant="outline"
          data-test-id="mock-page-download"
          :disabled="!hasPage || exporting"
          @click="downloadHTML"
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
                <span class="truncate">localhost:5173/page.html</span>
              </div>
            </div>
            <iframe
              v-if="hasPage"
              sandbox="allow-scripts"
              :srcdoc="page?.html ?? ''"
              title="mock-page-preview"
              class="min-h-0 flex-1 border-0 bg-white"
              data-test-id="mock-page-preview-frame"
            />
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
        <div v-else class="flex size-full flex-col p-3" data-test-id="mock-page-code">
          <div class="mb-2 shrink-0 text-[10px] text-muted" data-test-id="mock-page-code-hint">
            {{ ai.mockPageCodeReadonly }}
          </div>
          <pre
            class="min-h-0 flex-1 overflow-auto rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-surface/80"
            data-test-id="mock-page-code-view"
          >{{ page?.html ?? '' }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>
