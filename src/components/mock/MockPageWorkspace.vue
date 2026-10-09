<script setup lang="ts">
import { useElementSize, useEventListener, useLocalStorage, watchDebounced } from '@vueuse/core'
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
import { runMockAgent, type MockAgentResult } from '@/app/mock/agent'
import type { MockPipelineSnapshot } from '@/app/mock/pipeline'
import {
  MOCK_PAGE_SIZES,
  ensureMockPage,
  getMockPageId,
  mockPageState,
  type MockPageSizeKind,
  type MockPageState
} from '@/app/mock/pages'
import {
  clampProjectSize,
  composePreview,
  extractHTML,
  normalizeProjectPath,
  parseProjectFiles
} from '@/app/mock/project'
import { mockVisualReviewAvailable, runMockVisualReview } from '@/app/mock/review'
import { IS_TAURI } from '@/constants'
import ChatMarkdown from '@/components/chat/ChatMarkdown.vue'
import AppButton from '@/components/ui/button/AppButton.vue'
import IconButton from '@/components/ui/button/IconButton.vue'

const SIZE_KINDS: MockPageSizeKind[] = ['desktop', 'tablet', 'phone']

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

const viewMode = useLocalStorage<'device' | 'flat'>('open-pencil:mock-page-view-mode', 'device')
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
const planSteps = ref<MockPipelineSnapshot['plan']>([])
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

const reasoningPreRef = ref<HTMLElement | null>(null)

watch(
  () => reasoningText.value.length,
  () => {
    void nextTick(() => {
      const el = reasoningPreRef.value
      if (el) el.scrollTop = el.scrollHeight
    })
  }
)

const activeStepLabel = computed<string>(() => {
  for (let index = activity.value.length - 1; index >= 0; index--) {
    const event = activity.value[index]
    if (event && !event.done) return event.label
  }
  return ''
})

const messagesRef = ref<HTMLElement | null>(null)

async function scrollConversationToBottom(): Promise<void> {
  await nextTick()
  const el = messagesRef.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(
  () => page.value?.messages.length,
  () => void scrollConversationToBottom()
)
watch(
  () =>
    activity.value.length +
    planSteps.value.filter((step) => step.status === 'done').length * 100,
  () => void scrollConversationToBottom()
)
watchDebounced(
  () => streamedText.value.length,
  () => void scrollConversationToBottom(),
  { debounce: 250 }
)

let activitySeq = 0

function pushActivity(label: string): void {
  activity.value.push({ id: ++activitySeq, label, done: false })
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

let contentStarted = false
let lastPhase = ''

function noteContentStarted(): void {
  if (contentStarted) return
  contentStarted = true
  finishActivity(true)
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

/**
 * 视觉自查循环（画板「测试验证 → 反馈到 AI」）：生成完成后截图交给独立
 * Vision 模型自查静态视觉问题；发现确信问题时带着问题清单再跑一轮修复（上限一轮）。
 * 未配置 Vision 模型时整段静默跳过，返回 null。
 */
async function reviewGeneratedPage(
  state: MockPageState,
  userText: string,
  firstRound: MockAgentResult,
  runAgentRound: (roundPrompt: string) => Promise<MockAgentResult>
): Promise<string | null> {
  if (!state.html) return null
  if (!(await mockVisualReviewAvailable())) return null
  pushActivity(ai.value.mockPageStepReview)
  const review = await runMockVisualReview({
    html: state.html,
    width: state.width,
    height: state.height,
    userPrompt: userText,
    normsKind: firstRound.pipeline.normsKind
  })
  finishActivity(true)
  if (review.status !== 'reviewed') return null
  if (review.verdict.ok) return '视觉自查通过，未发现明显视觉问题'
  pushActivity(ai.value.mockPageReviewFix)
  try {
    const fixPrompt = [
      '视觉自查发现以下问题，请修复：',
      ...review.verdict.issues.map((issue) => `- ${issue}`),
      '',
      `原始需求：${userText}`
    ].join('\n')
    await runAgentRound(fixPrompt)
    finishActivity(true)
    return `视觉自查发现 ${review.verdict.issues.length} 个问题，已自动修复一轮`
  } catch (error) {
    console.warn('mock review fix round failed', error)
    finishActivity(false)
    return `视觉自查发现 ${review.verdict.issues.length} 个问题，自动修复未完成，可继续追加要求`
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
  contentStarted = false
  lastPhase = 'analyze'
  planSteps.value = []
  pushActivity(ai.value.mockPageStepUnderstand)
  elapsedMs.value = 0
  const startedAt = performance.now()
  stopTimer()
  generateTimer = setInterval(() => {
    elapsedMs.value = performance.now() - startedAt
  }, 100)
  const pendingFiles: Record<string, string> = { ...state.files }
  const runAgentRound = (roundPrompt: string): Promise<MockAgentResult> =>
    runMockAgent({
      model: runtime.model,
      providerID: runtime.role.connection.providerID,
      reasoningEffort: runtime.role.profile.reasoningEffort ?? '',
      prompt: roundPrompt,
      hasProject: hasPage.value,
      currentSource: currentSource.value,
      initialFiles: { ...state.files },
      mockId: getMockPageId(pageNode.value) ?? undefined,
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
          noteContentStarted()
          streamedText.value += chunk
        },
        onReasoningDelta: (chunk) => {
          noteContentStarted()
          reasoningText.value += chunk
        },
        onToolStart: (_name, label) => {
          noteContentStarted()
          finishActivity(true)
          pushActivity(label)
        },
        onToolDone: (_name, _label, ok) => finishActivity(ok),
        onPipelineChange: (snapshot) => {
          planSteps.value = snapshot.plan.map((step) => ({ ...step }))
          if (snapshot.phase !== lastPhase) {
            lastPhase = snapshot.phase
            if (snapshot.phase === 'plan') pushActivity(ai.value.mockPageStepPlan)
            else if (snapshot.phase === 'build') pushActivity(ai.value.mockPagePhaseBuild)
          }
        }
      }
    })
  try {
    const result = await runAgentRound(text)
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
        if (single) {
          state.files = {}
          state.html = single
        } else if (result.fullText.trim()) {
          // 模型这一轮选择用对话回答而不是写文件：按正常回答展示，不判定为失败
          state.messages.push({ role: 'assistant', text: result.fullText.trim() })
          return
        } else {
          errorMsg.value = ai.value.htmlPageNoHtml
          state.messages.push({ role: 'assistant', text: ai.value.htmlPageNoHtml })
          return
        }
      }
    }
    view.value = 'preview'
    const reviewNote = await reviewGeneratedPage(state, text, result, runAgentRound)
    finishActivity(true)
    pushActivity(ai.value.mockPageStepFinish)
    finishActivity(true)
    state.messages.push({
      role: 'assistant',
      text: reviewNote
        ? `${result.summary}\n${reviewNote}`
        : result.summary || ai.value.mockPageAssistantDone,
      process: streamedText.value || undefined,
      reasoning: reasoningText.value || undefined
    })
  } catch (error) {
    console.warn('mock page generation failed', error)
    finishActivity(false)
    errorMsg.value = ai.value.htmlPageFailed
    state.messages.push({
      role: 'assistant',
      text: ai.value.htmlPageFailed,
      process: streamedText.value || undefined,
      reasoning: reasoningText.value || undefined
    })
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

/** 预览 iframe 里点击项目内 .html 链接时切换预览页（见 mock/project.ts 的运行时注入）。 */
function handleMockFrameMessage(event: MessageEvent): void {
  const data = event.data as { __openPencilMockNav?: unknown } | null
  if (!data || typeof data.__openPencilMockNav !== 'string') return
  if (generating.value) return
  const state = page.value
  if (!state) return
  const target = normalizeProjectPath(data.__openPencilMockNav)
  const files = projectFiles.value
  if (!Object.hasOwn(files, target)) return
  const composed = composePreview(files, target)
  if (composed) state.html = composed
}

useEventListener(window, 'message', handleMockFrameMessage)

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
              class="max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed"
              :class="
                message.role === 'user' ? 'bg-accent text-white' : 'bg-surface/5 text-surface'
              "
              :data-test-id="
                message.role === 'user' ? 'mock-page-msg-user' : 'mock-page-msg-assistant'
              "
            >
              <span v-if="message.role === 'user'" class="whitespace-pre-wrap">{{
                message.text
              }}</span>
              <ChatMarkdown v-else :content="message.text" mode="static" />
              <details
                v-if="message.role === 'assistant' && message.reasoning"
                class="mt-1"
                data-test-id="mock-page-msg-reasoning"
              >
                <summary class="cursor-pointer text-[10px] font-semibold text-muted">
                  {{ ai.mockPageReasoning }}
                </summary>
                <pre
                  class="mt-1 max-h-40 overflow-y-auto font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted/90"
                  >{{ message.reasoning }}</pre
                >
              </details>
              <details
                v-if="message.role === 'assistant' && message.process"
                class="mt-1"
                data-test-id="mock-page-msg-process"
              >
                <summary class="cursor-pointer text-[10px] font-semibold text-muted">
                  {{ ai.mockPageProcess }}
                </summary>
                <pre
                  class="mt-1 max-h-40 overflow-y-auto font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted/90"
                  >{{ message.process }}</pre
                >
              </details>
            </div>
          </div>
          <div v-if="generating" class="mb-2 flex justify-start">
            <div
              class="max-w-[85%] rounded-lg bg-surface/5 px-3 py-2 text-xs leading-relaxed"
              data-test-id="mock-page-generating"
            >
              <div class="mb-1 flex items-center gap-2 text-muted">
                <span class="mock-breathe inline-block size-1.5 rounded-full bg-accent"></span>
                <span>{{ ai.htmlPageGenerating }}</span>
                <span class="tabular-nums" data-test-id="mock-page-elapsed">{{
                  elapsedLabel
                }}</span>
              </div>
              <div v-if="planSteps.length > 0" class="mb-1" data-test-id="mock-page-plan">
                <div class="mb-1 text-[10px] font-semibold text-muted">
                  {{ ai.mockPagePlanTitle }}
                </div>
                <div
                  v-for="(step, index) in planSteps"
                  :key="index"
                  class="flex items-center gap-2 py-0.5 text-[11px]"
                  :class="step.status === 'done' ? 'text-muted' : 'text-surface'"
                  data-test-id="mock-page-plan-step"
                  :data-status="step.status"
                >
                  <icon-lucide-check
                    v-if="step.status === 'done'"
                    class="size-3 shrink-0 text-accent"
                  />
                  <span
                    v-else
                    class="mock-breathe inline-block size-1.5 shrink-0 rounded-full bg-accent"
                  ></span>
                  <span class="truncate">{{ step.title }}</span>
                </div>
              </div>
              <div data-test-id="mock-page-build-steps">
                <div
                  v-for="event in activity"
                  :key="event.id"
                  class="flex items-center gap-2 py-0.5 text-[11px]"
                  :class="event.done ? 'text-muted' : 'text-surface'"
                  data-test-id="mock-page-build-step"
                  :data-step-id="event.id"
                  :data-status="event.done ? 'done' : 'active'"
                >
                  <icon-lucide-check v-if="event.done" class="size-3 shrink-0 text-accent" />
                  <span
                    v-else
                    class="mock-breathe inline-block size-1.5 shrink-0 rounded-full bg-accent"
                  ></span>
                  <span class="truncate">{{ event.label }}</span>
                </div>
              </div>
              <pre
                v-if="streamedText || activeStepLabel"
                class="mt-1 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted/90"
                data-test-id="mock-page-build-status"
                >{{ streamedText || activeStepLabel }}<span class="mock-caret"></span
              ></pre>
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
        <template v-if="viewMode === 'device'">
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
        </template>
        <button
          type="button"
          class="rounded px-2 py-1 text-[10px]"
          :class="
            viewMode === 'device' ? 'bg-white/10 font-semibold text-surface' : 'text-muted hover:text-surface'
          "
          :title="ai.mockPageViewDevice"
          data-test-id="mock-page-view-device"
          @click="viewMode = 'device'"
        >
          <icon-lucide-monitor class="size-3" />
        </button>
        <button
          type="button"
          class="rounded px-2 py-1 text-[10px]"
          :class="
            viewMode === 'flat' ? 'bg-white/10 font-semibold text-surface' : 'text-muted hover:text-surface'
          "
          :title="ai.mockPageViewFlat"
          data-test-id="mock-page-view-flat"
          @click="viewMode = 'flat'"
        >
          <icon-lucide-scan class="size-3" />
        </button>
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
        <div
          v-if="view === 'preview' && viewMode === 'flat'"
          class="relative size-full"
          data-test-id="mock-page-flat-stage"
        >
          <iframe
            v-if="hasPage"
            sandbox="allow-scripts allow-popups allow-modals"
            :srcdoc="page?.html ?? ''"
            title="mock-page-preview"
            class="size-full border-0 bg-white"
            data-test-id="mock-page-preview-flat-frame"
          ></iframe>
          <div
            v-else
            class="flex size-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-white/15 bg-black/20 p-6 text-center"
            data-test-id="mock-page-empty"
          >
            <icon-lucide-globe class="size-8 text-muted/50" />
            <p class="text-xs text-muted">{{ ai.mockPageEmptyTitle }}</p>
            <p class="max-w-64 text-[10px] leading-relaxed text-muted/60">
              {{ ai.mockPageEmptyHint }}
            </p>
          </div>
        </div>
        <div v-else-if="view === 'preview'" :style="frameStyle" class="relative shrink-0">
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
              sandbox="allow-scripts allow-popups allow-modals"
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
              ref="reasoningPreRef"
              class="max-h-40 overflow-y-auto border-t border-white/10 px-3 py-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted/90"
              data-test-id="mock-page-reasoning-text"
              >{{ reasoningText }}<span v-if="generating" class="mock-caret"></span
            ></pre>
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


.mock-caret {
  display: inline-block;
  width: 7px;
  height: 0.95em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: currentColor;
  animation: mock-caret-blink 1.1s steps(1) infinite;
}

@keyframes mock-caret-blink {
  0%,
  55% {
    opacity: 1;
  }
  56%,
  100% {
    opacity: 0;
  }
}
</style>
