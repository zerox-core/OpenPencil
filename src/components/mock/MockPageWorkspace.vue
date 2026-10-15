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
import { runMockAgent, type MockAgentResult, type MockClarificationQuestion } from '@/app/mock/agent'
import { tryFastTrackDispatch } from '@/app/mock/router'
import type { MockPipelineSnapshot } from '@/app/mock/pipeline'
import {
  MOCK_PAGE_SIZES,
  ensureMockPage,
  getMockPageId,
  mockPageState,
  mockPagesPersistError,
  type MockChatMessage,
  type MockPageSizeKind,
  type MockPageState
} from '@/app/mock/pages'
import {
  clampProjectSize,
  extractHTML,
  normalizeProjectPath,
  parseProjectFiles
} from '@/app/mock/project'
import { composeMockProjectPreview } from '@/app/mock/compiler'
import { mockVisualReviewAvailable, runMockVisualReviewLoop } from '@/app/mock/review'
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
const generatedChars = ref(0)
const selectedFile = ref('')
const reasoningText = ref('')
const reasoningOpen = ref(true)
const elapsedMs = ref(0)
const fullscreen = ref(false)
const activity = ref<AgentActivity[]>([])
/** 流式工具输入的 toolCallId → 活动条索引（并行工具调用时各更新各的条目）。 */
const toolActivityIdx = new Map<string, number>()
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

const chatWidth = ref(440)
const chatViewMode = ref<'split' | 'chat_only' | 'preview_only'>('split')
const messageQueue = ref<string[]>([])
const isDraggingSplitter = ref(false)

let dragStartX = 0
let dragStartW = 0

function startSplitterDrag(e: MouseEvent) {
  isDraggingSplitter.value = true
  dragStartX = e.clientX
  dragStartW = chatWidth.value
}

useEventListener('mousemove', (ev: MouseEvent) => {
  if (!isDraggingSplitter.value) return
  const delta = ev.clientX - dragStartX
  const newW = Math.max(320, Math.min(window.innerWidth - 360, dragStartW + delta))
  chatWidth.value = newW
})

useEventListener('mouseup', () => {
  if (isDraggingSplitter.value) {
    isDraggingSplitter.value = false
  }
})

function removeQueuedMessage(index: number) {
  messageQueue.value.splice(index, 1)
}

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

/** 澄清问答（ask_user 挂起式）：模型提问后 UI 挂卡片等用户回答，提交后 resolve 回 agent 循环。 */
interface ClarificationState {
  questions: MockClarificationQuestion[]
  /** 点选的选项（每题至多一个，再点一次取消）。 */
  answers: string[]
  /** 自由输入；与点选互斥——输入即取消点选，点选即清空输入。 */
  custom: string[]
  resolve: (answer: string) => void
}

const clarification = ref<ClarificationState | null>(null)

function selectClarifyOption(qi: number, opt: string): void {
  const pending = clarification.value
  if (!pending) return
  pending.answers[qi] = pending.answers[qi] === opt ? '' : opt
  if (pending.answers[qi]) pending.custom[qi] = ''
}

function answerClarification(): void {
  const pending = clarification.value
  if (!pending) return
  const lines = pending.questions.map((q, i) => {
    const answer = (pending.custom[i] ?? '').trim() || (pending.answers[i] ?? '').trim()
    return `${i + 1}. ${q.question}\n   回答：${answer || '（未作答，按你的最佳判断）'}`
  })
  // 澄清问答落进会话消息：切页重挂后这轮问答仍在，模型也看得到完整上下文
  const state = page.value
  if (state) {
    state.messages.push({ role: 'user', text: lines.join('\n') })
  }
  clarification.value = null
  // 新一轮开始：清掉上一轮的状态文本占位，让会话只跟当前真实进度；计时从冻结值继续
  streamedText.value = ''
  resumeTimer()
  pending.resolve(lines.join('\n'))
}

function submitClarificationFreeText(userText: string): void {
  const pending = clarification.value
  if (!pending) return
  const trimmed = userText.trim()
  const reply = trimmed || '（用户跳过了选择，请根据最佳判断自主设计，或若用户希望交流则以对话探讨）'
  const state = page.value
  if (state) {
    state.messages.push({ role: 'user', text: reply })
  }
  clarification.value = null
  prompt.value = ''
  streamedText.value = ''
  resumeTimer()
  pending.resolve(reply)
}

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

/** 预览组装（带编译）：TS 项目经 esbuild-wasm 编译后内联；序号防竞态——旧结果不覆盖新写入。 */
let previewComposeSeq = 0

function schedulePreviewCompose(files: Record<string, string>, entry?: string): void {
  const seq = ++previewComposeSeq
  void composeMockProjectPreview(files, entry)
    .then((composed) => {
      if (seq !== previewComposeSeq || !composed) return null
      const state = page.value
      if (state) state.html = composed
      return null
    })
    .catch((error) => console.warn('mock preview compose failed', error))
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
let generateStartedAt = 0

function stopTimer(): void {
  if (generateTimer !== undefined) {
    clearInterval(generateTimer)
    generateTimer = undefined
  }
}

function startTimer(): void {
  stopTimer()
  generateTimer = setInterval(() => {
    elapsedMs.value = performance.now() - generateStartedAt
  }, 100)
}

/** ask_user 挂起期间冻结计时：停下不走字；用户提交回答后从冻结值继续走。 */
function pauseTimer(): void {
  stopTimer()
}

function resumeTimer(): void {
  generateStartedAt = performance.now() - elapsedMs.value
  startTimer()
}

/**
 * 视觉自查循环（画板「测试验证 → 反馈到 AI」）：生成完成后交给
 * runMockVisualReviewLoop —— 截图给独立 Vision 模型自查，发现问题回灌修复、
 * 修复后复检，直到收敛 / 停滞 / 达到轮次上限（详见 review.ts）。
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
  const result = await runMockVisualReviewLoop({
    html: () => state.html,
    width: state.width,
    height: state.height,
    userPrompt: userText,
    normsKind: firstRound.pipeline.normsKind,
    applyFix: async (issues) => {
      const fixPrompt = [
        '视觉自查发现以下问题，请修复：',
        ...issues.map((issue) => `- ${issue}`),
        '',
        `原始需求：${userText}`
      ].join('\n')
      await runAgentRound(fixPrompt)
    },
    hooks: {
      reviewStart: () => pushActivity(ai.value.mockPageStepReview),
      reviewDone: (ok) => finishActivity(ok),
      fixStart: () => pushActivity(ai.value.mockPageReviewFix),
      fixDone: (ok) => finishActivity(ok)
    }
  })
  if (result.stopReason === 'skipped') return null
  if (result.stopReason === 'converged') {
    return result.fixRounds === 0
      ? '视觉自查通过，未发现明显视觉问题'
      : `视觉自查经 ${result.fixRounds} 轮自动修复后复检通过`
  }
  const remaining = result.remainingIssues.length
  if (result.stopReason === 'stagnated') {
    return `视觉自查剩余 ${remaining} 个问题连续两轮未改善，已停止自动修复（共修复 ${result.fixRounds} 轮），可继续追加要求`
  }
  if (result.stopReason === 'max-rounds') {
    return `视觉自查已达 ${result.fixRounds} 轮修复上限，仍剩 ${remaining} 个问题，可继续追加要求`
  }
  return `视觉自查发现问题，第 ${result.fixRounds} 轮自动修复未完成，可继续追加要求`
}

function recordAssistantSuccessMessage(
  state: MockPageState,
  result: MockAgentResult,
  reviewNote: string | null,
  streamed: string,
  reasoning: string,
  doneLabel: string,
  limitLabel: string
): void {
  const note = reviewNote ? `${result.summary}\n${reviewNote}` : result.summary || doneLabel
  state.messages.push({
    role: 'assistant',
    text: note,
    process: streamed || undefined,
    reasoning: reasoning || undefined
  })
  if (result.reachedStepLimit) {
    state.messages.push({ role: 'system', text: limitLabel })
  }
}

interface ParsedAgentError {
  title: string
  detail: string
  rawMessage: string
}

const AGENT_ERROR_PATTERNS: Array<{
  pattern: RegExp
  title: string
  detail: string
}> = [
  {
    pattern: /429|rate\s*limit|quota|exceeded/i,
    title: 'API 请求频率或配额超限 (429 Rate Limit)',
    detail: '模型服务商并发请求超限或额度不足。建议稍候片刻重试，或在设置中检查模型密钥与额度。'
  },
  {
    pattern: /401|unauthorized|invalid\s*api\s*key|invalid_key/i,
    title: 'API 认证失败 (401 Unauthorized)',
    detail: '模型 API Key 无效或已过期。请前往“设置 → AI 模型”重新配置有效密钥。'
  },
  {
    pattern: /503|502|504|service\s*unavailable|bad\s*gateway/i,
    title: '上游模型服务不可用 (503/502)',
    detail: '模型服务商上游服务暂时过载或宕机，建议稍后重试或切换备用模型服务。'
  },
  {
    pattern: /timeout|abort|network|fetch\s*failed/i,
    title: '网络连接超时或中断 (Network Timeout)',
    detail: '与 AI 模型的网络连接不稳定或响应超时，请检查网络/代理设置。'
  },
  {
    pattern: /context|token\s*limit|maximum\s*context/i,
    title: '上下文长度超限 (Context Limit)',
    detail: '当前工程文件规模超过了模型单轮上下文窗口。建议拆分为小模块或启动新会话。'
  }
]

function parseAgentError(error: unknown): ParsedAgentError {
  const msg = error instanceof Error ? error.message : String(error ?? '')
  for (const item of AGENT_ERROR_PATTERNS) {
    if (item.pattern.test(msg)) {
      return { title: item.title, detail: item.detail, rawMessage: msg }
    }
  }
  return {
    title: '页面生成中断或执行异常',
    detail: msg ? `原因：${msg.slice(0, 160)}` : '生成过程出现非预期异常，请检查模型状态。',
    rawMessage: msg
  }
}

function recordAssistantErrorMessage(
  state: MockPageState,
  streamed: string,
  reasoning: string,
  parsed: ParsedAgentError
): void {
  const text = [
    `**${parsed.title}**`,
    '',
    parsed.detail,
    parsed.rawMessage ? `\n\`\`\`text\n${parsed.rawMessage}\n\`\`\`` : ''
  ].join('\n')
  state.messages.push({
    role: 'assistant',
    text,
    process: streamed || undefined,
    reasoning: reasoning || undefined
  })
}

async function applyFallbackUnwrittenFiles(
  state: MockPageState,
  result: MockAgentResult
): Promise<{ ok: boolean; dialogOnly?: boolean }> {
  if (result.filesWritten > 0) return { ok: true }
  const parsedFiles = parseProjectFiles(result.fullText)
  if (Object.keys(parsedFiles).length > 0) {
    const composed = await composeMockProjectPreview(parsedFiles)
    if (!composed) return { ok: false }
    state.files = parsedFiles
    state.html = composed
    return { ok: true }
  }

  const single = extractHTML(result.fullText)
  if (single) {
    state.files = {}
    state.html = single
    return { ok: true }
  }

  if (result.fullText.trim()) {
    return { ok: false, dialogOnly: true }
  }

  return { ok: false }
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
  generatedChars.value = 0
  reasoningText.value = ''
  activity.value = []
  toolActivityIdx.clear()
  contentStarted = false
  lastPhase = 'analyze'
  planSteps.value = []
  elapsedMs.value = 0
  generateStartedAt = performance.now()
  startTimer()
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
          schedulePreviewCompose(state.files)
        },
        askUser: (questions) =>
          new Promise<string>((resolve) => {
            pauseTimer()
            clarification.value = {
              questions,
              answers: questions.map(() => ''),
              custom: questions.map(() => ''),
              resolve
            }
          })
      },
      onUpdate: {
        onTextDelta: (chunk) => {
          noteContentStarted()
          streamedText.value += chunk
          generatedChars.value += chunk.length
        },
        onReasoningDelta: (chunk) => {
          noteContentStarted()
          reasoningText.value += chunk
        },
        onToolInputStart: (id, name) => {
          noteContentStarted()
          finishActivity(true)
          pushActivity(name)
          toolActivityIdx.set(id, activity.value.length - 1)
        },
        onToolInputDelta: (id, name, totalBytes, deltaBytes) => {
          generatedChars.value += deltaBytes
          const idx = toolActivityIdx.get(id)
          const entry = idx === undefined ? undefined : activity.value[idx]
          if (entry && !entry.done && name.length > 0) {
            entry.label = `${name} · ${(totalBytes / 1024).toFixed(1)} KB`
          }
        },
        onToolStart: (name, label) => {
          noteContentStarted()
          // 参数流阶段已推过同名活动：只升级标签，避免重复条目（并行调用时按名字从后往前找）
          const pending = [...activity.value]
            .reverse()
            .find((a) => !a.done && a.label.startsWith(name))
          if (pending) {
            pending.label = label
          } else {
            finishActivity(true)
            pushActivity(label)
          }
        },
        onToolDone: (_name, _label, ok) => finishActivity(ok),
        onPipelineChange: (snapshot) => {
          planSteps.value = snapshot.plan.map((step) => ({ ...step }))
          if (snapshot.phase !== lastPhase) {
            lastPhase = snapshot.phase
            if (snapshot.phase === 'plan') pushActivity(ai.value.mockPageStepPlan)
            else if (snapshot.phase === 'skeleton') pushActivity(ai.value.mockPagePhaseSkeleton)
            else if (snapshot.phase === 'refine') pushActivity(ai.value.mockPagePhaseRefine)
          }
        }
      }
    })
  try {
    const fastRes = await tryFastTrackDispatch({
      model: runtime.model,
      providerID: runtime.role.connection.providerID,
      reasoningEffort: runtime.role.profile.reasoningEffort ?? '',
      userPrompt: text,
      hasProject: hasPage.value,
      fileList: fileList.value,
      files: state.files,
      entryFile: entryFile.value,
      onTextDelta: (chunk) => {
        noteContentStarted()
        streamedText.value += chunk
        generatedChars.value += chunk.length
      }
    })

    if (fastRes.handled) {
      finishActivity(true)
      if (fastRes.patchedFiles) {
        state.files = fastRes.patchedFiles
        schedulePreviewCompose(state.files)
      }
      state.messages.push({
        role: 'assistant',
        text: fastRes.assistantMessage || streamedText.value
      })
      return
    }

    const result = await runAgentRound(text)
    const fallback = await applyFallbackUnwrittenFiles(state, result)
    if (!fallback.ok) {
      if (fallback.dialogOnly) {
        state.messages.push({ role: 'assistant', text: result.fullText.trim() })
        return
      }
      errorMsg.value = ai.value.htmlPageNoHtml
      state.messages.push({ role: 'assistant', text: ai.value.htmlPageNoHtml })
      return
    }
    finishActivity(true)
    pushActivity(ai.value.mockPageStepReview)
    const reviewNote = await reviewGeneratedPage(state, text, result, runAgentRound)
    finishActivity(true)
    pushActivity(ai.value.mockPageStepFinish)
    finishActivity(true)
    recordAssistantSuccessMessage(
      state,
      result,
      reviewNote,
      streamedText.value,
      reasoningText.value,
      ai.value.mockPageAssistantDone,
      ai.value.mockPageStepLimitReached
    )
  } catch (error) {
    console.warn('mock page generation failed', error)
    finishActivity(false)
    const parsed = parseAgentError(error)
    errorMsg.value = parsed.title
    recordAssistantErrorMessage(
      state,
      streamedText.value,
      reasoningText.value,
      parsed
    )
  } finally {
    stopTimer()
    generating.value = false
    if (messageQueue.value.length > 0) {
      const nextPrompt = messageQueue.value.shift()
      if (nextPrompt) {
        prompt.value = nextPrompt
        setTimeout(() => {
          void generate()
        }, 80)
      }
    }
  }
}

function messageBubbleClass(role: MockChatMessage['role']): string {
  if (role === 'user') return 'bg-accent text-white'
  if (role === 'system') {
    return 'border border-dashed border-amber-500/50 bg-amber-500/10 text-amber-300'
  }
  return 'bg-surface/5 text-surface'
}

function messageTestId(role: MockChatMessage['role']): string {
  if (role === 'user') return 'mock-page-msg-user'
  if (role === 'system') return 'mock-page-msg-system'
  return 'mock-page-msg-assistant'
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
  if (!page.value) return
  const target = normalizeProjectPath(data.__openPencilMockNav)
  const files = projectFiles.value
  if (!Object.hasOwn(files, target)) return
  schedulePreviewCompose(files, target)
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

function handleSendAction() {
  const text = prompt.value.trim()
  if (!text) return
  if (clarification.value) {
    submitClarificationFreeText(text)
    return
  }
  if (generating.value) {
    messageQueue.value.push(text)
    prompt.value = ''
    return
  }
  void generate()
}

function handlePromptKeydown(event: KeyboardEvent) {
  if (event.code !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  handleSendAction()
}
</script>

<template>
  <div class="flex min-w-0 flex-1 relative overflow-hidden" data-test-id="mock-page-workspace">
    <div
      v-show="chatViewMode !== 'preview_only'"
      class="flex shrink-0 flex-col border-r border-border bg-panel relative"
      :style="{
        width: chatViewMode === 'chat_only' ? '100%' : `${chatWidth}px`,
        flex: chatViewMode === 'chat_only' ? '1 1 0%' : 'none'
      }"
    >
      <div class="flex h-10 shrink-0 items-center justify-between border-b border-border/60 px-3 bg-panel/70">
        <div class="flex items-center gap-1.5 text-xs font-semibold text-surface">
          <icon-lucide-sparkles class="size-3.5 text-accent" />
          <span>AI 设计工坊</span>
        </div>
        <div class="flex items-center rounded-md bg-surface/5 p-0.5 border border-border/40 text-[11px]">
          <button
            type="button"
            class="rounded px-2 py-0.5 transition-colors"
            :class="chatViewMode === 'chat_only' ? 'bg-accent text-white font-medium shadow-xs' : 'text-surface/70 hover:text-surface'"
            title="纯会话专注模式（宽屏排版）"
            @click="chatViewMode = 'chat_only'"
          >
            纯会话
          </button>
          <button
            type="button"
            class="rounded px-2 py-0.5 transition-colors"
            :class="chatViewMode === 'split' ? 'bg-accent text-white font-medium shadow-xs' : 'text-surface/70 hover:text-surface'"
            title="双栏分栏对照"
            @click="chatViewMode = 'split'"
          >
            分栏
          </button>
          <button
            type="button"
            class="rounded px-2 py-0.5 transition-colors"
            :class="chatViewMode === 'preview_only' ? 'bg-accent text-white font-medium shadow-xs' : 'text-surface/70 hover:text-surface'"
            title="仅看画布预览"
            @click="chatViewMode = 'preview_only'"
          >
            预览
          </button>
        </div>
      </div>
      <div
        ref="messagesRef"
        class="min-h-0 flex-1 overflow-y-auto p-3"
        data-test-id="mock-page-messages"
      >
        <div :class="chatViewMode === 'chat_only' ? 'max-w-4xl mx-auto' : 'w-full'">
          <div
            v-if="mockPagesPersistError"
            class="mb-2 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-red-400"
            data-test-id="mock-page-persist-error"
          >
            {{ ai.mockPagePersistError }}
          </div>
          <div
            v-if="!page || page.messages.length === 0"
            class="flex h-full min-h-60 flex-col items-center justify-center gap-2 text-center"
          >
            <icon-lucide-sparkles class="size-6 text-accent/60" />
            <p class="text-xs font-medium text-surface">{{ ai.mockPageEmptyTitle }}</p>
            <p class="max-w-72 text-[11px] leading-relaxed text-surface/70">
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
              :class="messageBubbleClass(message.role)"
              :data-test-id="messageTestId(message.role)"
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
                <summary class="cursor-pointer text-[10px] font-semibold text-surface/80 hover:text-surface transition-colors">
                  {{ ai.mockPageReasoning }}
                </summary>
                <pre
                  class="mt-1 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-surface/90"
                  >{{ message.reasoning }}</pre
                >
              </details>
              <details
                v-if="message.role === 'assistant' && message.process"
                class="mt-1"
                data-test-id="mock-page-msg-process"
              >
                <summary class="cursor-pointer text-[10px] font-semibold text-surface/80 hover:text-surface transition-colors">
                  {{ ai.mockPageProcess }}
                </summary>
                <pre
                  class="mt-1 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-surface/90"
                  >{{ message.process }}</pre
                >
              </details>
            </div>
          </div>
          <div
            v-for="(queuedItem, qIdx) in messageQueue"
            :key="'queue-' + qIdx"
            class="mb-2 flex justify-end"
          >
            <div class="flex items-center gap-2 max-w-[85%] rounded-lg border border-dashed border-accent/50 bg-accent/15 px-3 py-1.5 text-xs text-accent">
              <icon-lucide-clock class="size-3.5 animate-pulse shrink-0" />
              <span class="truncate">排队等待执行：{{ queuedItem }}</span>
              <button
                type="button"
                class="ml-1 text-[11px] text-surface/60 hover:text-red-400 transition-colors shrink-0"
                title="取消此排队消息"
                @click="removeQueuedMessage(qIdx)"
              >
                ✕
              </button>
            </div>
          </div>
          <div v-if="generating" class="mb-2 flex justify-start">
            <div
              class="max-w-[85%] rounded-lg bg-surface/5 px-3 py-2 text-xs leading-relaxed"
              data-test-id="mock-page-generating"
            >
              <div class="mb-1 flex items-center gap-2 text-muted">
                <span class="mock-breathe inline-block size-1.5 rounded-full bg-accent"></span>
                <span>{{
                  clarification
                    ? ai.mockPageWaitingAnswer
                    : (activity.length === 0 ? '思考中...' : ai.htmlPageGenerating)
                }}</span>
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
              <div v-if="reasoningText" class="mt-1" data-test-id="mock-page-live-reasoning">
                <button
                  type="button"
                  class="flex items-center gap-1.5 text-[10px] text-muted"
                  data-test-id="mock-page-live-reasoning-toggle"
                  @click="reasoningOpen = !reasoningOpen"
                >
                  <icon-lucide-brain class="size-3" />
                  <span>{{ ai.mockPageThinking }}</span>
                  <span>{{ reasoningOpen ? '−' : '+' }}</span>
                </button>
                <pre
                  v-if="reasoningOpen"
                  ref="reasoningPreRef"
                  class="mt-1 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted/90"
                  data-test-id="mock-page-live-reasoning-text"
                  >{{ reasoningText }}<span class="mock-caret"></span
                ></pre>
              </div>
              <div
                v-if="clarification"
                class="mt-2.5 space-y-2.5 rounded-lg border border-border/50 bg-panel/90 p-3 text-xs"
                data-test-id="mock-page-clarification"
              >
                <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between text-[11px] pb-1 border-b border-border/20">
                  <div class="flex items-center gap-1.5 font-medium text-accent min-w-0 pr-2">
                    <icon-lucide-sparkles class="size-3.5 shrink-0" />
                    <span class="truncate">{{ ai.mockPageClarifyTitle }}</span>
                  </div>
                  <button
                    type="button"
                    class="text-[10px] text-surface/70 hover:text-accent transition-colors underline-offset-2 hover:underline self-end sm:self-auto shrink-0 whitespace-nowrap"
                    @click="submitClarificationFreeText('')"
                  >
                    跳过选择（AI自主决定）
                  </button>
                </div>
                <div
                  v-for="(q, qi) in clarification.questions"
                  :key="qi"
                  class="space-y-1.5"
                  :data-test-id="'mock-page-clarify-q-' + qi"
                >
                  <div class="text-[11px] font-medium text-surface">
                    {{ qi + 1 }}. {{ q.question }}
                  </div>
                  <div
                    v-if="q.options && q.options.length > 0"
                    class="flex flex-wrap gap-1.5"
                  >
                    <button
                      v-for="opt in q.options"
                      :key="opt"
                      type="button"
                      class="flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] transition-all"
                      :class="
                        clarification.answers[qi] === opt
                          ? 'border-accent bg-accent/20 text-accent font-medium shadow-sm'
                          : 'border-border/60 bg-surface/5 text-muted hover:border-accent/40 hover:text-surface'
                      "
                      :data-test-id="'mock-page-clarify-opt-' + qi"
                      @click="selectClarifyOption(qi, opt)"
                    >
                      <icon-lucide-check
                        v-if="clarification.answers[qi] === opt"
                        class="size-3"
                      />
                      {{ opt }}
                    </button>
                  </div>
                </div>
                <div class="flex items-center justify-between gap-2 pt-1.5 border-t border-border/30">
                  <span class="text-[10px] text-surface/75">可点上方选项，或直接在底部自由回复</span>
                  <AppButton
                    size="xs"
                    data-test-id="mock-page-clarify-submit"
                    class="shrink-0"
                    @click="answerClarification"
                  >
                    {{ ai.mockPageClarifySubmit }}
                  </AppButton>
                </div>
              </div>
              <pre
                v-if="streamedText || activeStepLabel"
                class="mt-1 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-surface/90"
                data-test-id="mock-page-build-status"
                >{{ streamedText || activeStepLabel }}<span class="mock-caret"></span
              ></pre>
            </div>
          </div>
        </template>
        </div>
      </div>
      <div class="shrink-0 border-t border-border p-2.5 bg-panel/80">
        <div :class="chatViewMode === 'chat_only' ? 'max-w-4xl mx-auto' : 'w-full'">
          <div
            v-if="generating || errorMsg || voiceState !== 'idle' || voiceError"
            class="px-1 pb-1.5 text-[11px] leading-tight"
            :class="errorMsg || voiceError ? 'text-red-400' : 'text-surface/70'"
            data-test-id="mock-page-status"
          >
            <template v-if="voiceError">{{ voiceError }}</template>
            <template v-else-if="errorMsg">{{ errorMsg }}</template>
            <template v-else-if="voiceState === 'recording'">{{ ai.voiceListening }}</template>
            <template v-else-if="voiceState === 'transcribing'">{{ ai.voiceTranscribing }}</template>
            <template v-else-if="voiceState === 'polishing'">{{ ai.voicePolishing }}</template>
            <template v-else
              >{{ clarification ? ai.mockPageWaitingAnswer : (activity.length === 0 ? '思考中...' : ai.htmlPageGenerating) }} ·
              {{ elapsedLabel }} · {{ generatedChars }}</template
            >
          </div>
          <div class="flex items-end gap-2">
            <textarea
              v-model="prompt"
              rows="2"
              :placeholder="
                clarification
                  ? '直接输入回答（例如：“我们来一句一句聊”），回车即可发送...'
                  : generating
                    ? 'AI 正在执行中... 输入内容并回车即可排队追加指令'
                    : hasPage
                      ? ai.htmlPageModifyPlaceholder
                      : ai.htmlPagePlaceholder
              "
              class="block min-h-12 w-full resize-none rounded border border-border bg-transparent px-3 py-2 text-xs leading-relaxed text-surface outline-none placeholder:text-surface/40 focus:border-accent/60"
              data-test-id="mock-page-prompt"
              @keydown="handlePromptKeydown"
            ></textarea>
            <IconButton
              :label="voiceState === 'recording' ? ai.stopVoiceInput : ai.voiceInput"
              size="sm"
              data-test-id="mock-page-voice-button"
              :disabled="voiceState === 'transcribing' || voiceState === 'polishing'"
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
              :disabled="!prompt.trim()"
              @click="handleSendAction"
            >
              {{ clarification ? '发送' : (generating ? '排队发送' : ai.htmlPageGenerate) }}
            </AppButton>
          </div>
        </div>
      </div>
    </div>

    <!-- 可拖拽分隔条 -->
    <div
      v-if="chatViewMode === 'split'"
      class="w-1.5 shrink-0 cursor-col-resize hover:bg-accent/40 active:bg-accent transition-colors z-20 -ml-0.5 flex items-center justify-center group select-none"
      title="拖拽调节宽度"
      @mousedown="startSplitterDrag"
    >
      <div class="w-0.5 h-6 rounded-full bg-border group-hover:bg-accent/80 transition-colors"></div>
    </div>

    <div
      v-show="chatViewMode !== 'chat_only'"
      class="flex min-w-0 flex-col bg-[#141518]"
      :class="fullscreen ? 'fixed inset-0 z-50' : 'flex-1'"
    >
      <div class="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 px-3">
        <button
          v-if="chatViewMode === 'preview_only'"
          type="button"
          class="rounded px-2 py-0.5 text-[11px] bg-accent/20 text-accent hover:bg-accent/30 font-medium transition-colors mr-1"
          @click="chatViewMode = 'split'"
        >
          ← 展开会话
        </button>
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
