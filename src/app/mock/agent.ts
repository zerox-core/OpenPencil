import { stepCountIs, streamText, tool } from 'ai'
import { valibotSchema } from '@ai-sdk/valibot'
import * as v from 'valibot'

import { buildReasoningProviderOptions } from '@/app/ai/chat/reasoning'
import type { AIProviderID } from '@open-pencil/core/constants'
import { normalizeProjectPath } from '@/app/mock/project'
import { getMockDesignNorms, MOCK_NORMS_KINDS } from '@/app/mock/norms'
import {
  advancePipeline,
  createMockPipeline,
  declareProjectKind,
  finishBlockReason,
  markStepDone,
  PHASE_TOOLS,
  phaseStatusHint,
  pipelineSnapshot,
  recordVerification,
  submitPlan,
  submitSkeletonBlockReason,
  writePolicyError
} from '@/app/mock/pipeline'
import type { MockPipelineSnapshot, MockPipelineState } from '@/app/mock/pipeline'
import { MOCK_PROJECT_KINDS, mockTsEntry } from '@/app/mock/kinds'
import { compileMockProject } from '@/app/mock/compiler'
import { searchSimilarMockDesigns } from '@/app/mock/similar'
import { composeMockSystemPrompt, resolveMockPromptTemplate } from '@/app/mock/prompts'
import type { LanguageModel } from 'ai'

/**
 * Mock 页面的 agentic 生成循环（五阶段规划管线版）：
 * 画板流程落成显式状态机 —— 需求分析（取规范 + 搜相似 + declare_project_kind
 * 选项目形态）→ 制定计划（plan_steps，计划是数据不是聊天文本，提交时做确定性
 * 校验）→ 布局骨架（index.html 语义结构 + styles/base.css 设计令牌，submit_skeleton
 * 门禁）→ 视觉精修 ⇄ 验证（写文件 / 标记步骤 / check_project，TS 项目做 esbuild
 * 真实编译检查）→ 收尾（finish_project 受状态机门禁约束）。
 * 工具按阶段动态暴露（prepareStep + activeTools），模型在当前阶段只能看到
 * 当前阶段的工具；每一步通过 prepareStep instructions 把管线状态注入模型。
 */

/** ask_user 工具的单个澄清问题：question 必填，options 为可选项（2~4 个）。 */
export interface MockClarificationQuestion {
  question: string
  options?: string[]
}

export interface MockAgentHandlers {
  setCanvasSize(width: number, height: number): void
  writeProjectFile(path: string, content: string): void
  /**
   * 需求澄清反向通道（挂起式）：模型经 ask_user 工具发起提问，本 handler 返回的
   * Promise 由 UI 在用户回答后 resolve——循环挂起等待但流不中断、管线状态保留，
   * 回答作为工具结果直接进入当前对话（上下文连续，无需 messages 历史）。
   * 未提供时 ask_user 降级返回提示，让模型按最佳判断继续。
   */
  askUser?(questions: MockClarificationQuestion[]): Promise<string>
}

export interface MockAgentUpdate {
  onTextDelta?(text: string): void
  onReasoningDelta?(text: string): void
  /** 工具输入（参数）开始流式生成——参数尚未生成完即通知，给 UI 提前可见性。id 为 toolCallId。 */
  onToolInputStart?(id: string, name: string): void
  /** 工具输入流增量：totalBytes 为该工具参数已累计字节数，deltaBytes 为本次增量。id 为 toolCallId（delta 不携带 toolName，按 id 对应）。 */
  onToolInputDelta?(id: string, name: string, totalBytes: number, deltaBytes: number): void
  onToolStart?(name: string, label: string): void
  onToolDone?(name: string, label: string, ok: boolean): void
  onPipelineChange?(snapshot: MockPipelineSnapshot): void
}

export interface MockAgentResult {
  fullText: string
  summary: string
  filesWritten: number
  /** 收尾时的管线快照（阶段 / 规范类型 / 计划），供视觉自查等下游环节使用。 */
  pipeline: MockPipelineSnapshot
  /** 本轮未走到 finish_project 即正常终止（步数上限或模型停笔）。true 时 UI 提示用户发送「继续」。 */
  reachedStepLimit: boolean
}

export const MOCK_AGENT_MAX_STEPS = 200

// 场景提示词已沉淀为可配置模板（mock/prompts.ts），按 options.promptTemplateId 解析，默认 website。

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function textValue(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number') return String(value)
  return '?'
}

export function describeToolCall(name: string, input: unknown): string {
  if (!isRecord(input)) return name
  if (name === 'ask_user' && Array.isArray(input.questions)) {
    return `${name} · ${input.questions.length} 问`
  }
  if (name === 'write_project_file') return `${name} · ${textValue(input.path)}`
  if (name === 'set_canvas_size') {
    return `${name} · ${textValue(input.width)}×${textValue(input.height)}`
  }
  if (name === 'get_design_norms') {
    const kind = typeof input.kind === 'string' ? input.kind : 'desktop-web'
    return `${name} · ${kind}`
  }
  if (name === 'search_similar_designs') {
    const query = textValue(input.query)
    return `${name} · ${query.length > 24 ? `${query.slice(0, 24)}…` : query}`
  }
  if (name === 'plan_steps' && Array.isArray(input.steps)) {
    return `${name} · ${input.steps.length} 步`
  }
  if (name === 'declare_project_kind') return `${name} · ${textValue(input.kind)}`
  if (name === 'mark_step_done') return `${name} · ${textValue(input.stepId)}`
  return name
}

function clampSize(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(2560, Math.max(320, Math.round(value)))
}

const COMMENT_RE = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g
const STRING_RE = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/gs

function countChar(text: string, ch: string): number {
  return text.split(ch).length - 1
}

/**
 * check_project 的确定性构建校验：
 * 阻塞项（不通过则不能收尾）：缺 index.html / 空文件 / html 骨架缺失 /
 * 相对引用解析不到 / CSS 花括号不配平。
 * 提示项（不阻塞）：JS 括号配平（剥离注释与字符串后粗查，可能误报）。
 */
function checkProject(files: Record<string, string>): { ok: boolean; issues: string[] } {
  const blocking: string[] = []
  const warnings: string[] = []
  const entry = files['index.html']
  if (!entry) {
    blocking.push('缺少入口文件 index.html')
  } else {
    if (!entry.trim()) blocking.push('index.html 内容为空')
    if (!/<html[\s>]/i.test(entry)) blocking.push('index.html 缺少 <html> 骨架')
    const refRe = /(?:href|src)="([^"]+)"/g
    let match: RegExpExecArray | null
    while ((match = refRe.exec(entry)) !== null) {
      const ref = match[1]
      if (/^(https?:|data:|mailto:|tel:|#|\/)/i.test(ref)) continue
      const clean = ref.split('#')[0].split('?')[0].trim()
      if (!clean) continue
      if (!(clean in files)) blocking.push(`index.html 引用了不存在的文件：${clean}`)
    }
  }
  for (const [path, content] of Object.entries(files)) {
    if (!content.trim()) blocking.push(`${path} 内容为空`)
    if (path.endsWith('.css')) {
      const open = countChar(content, '{')
      const close = countChar(content, '}')
      if (open !== close) blocking.push(`${path} 花括号不配平（{ 有 ${open} 个，} 有 ${close} 个）`)
    }
    if (path.endsWith('.js')) {
      const stripped = content.replace(COMMENT_RE, '').replace(STRING_RE, '""')
      for (const [left, right, label] of [
        ['{', '}', '花括号'],
        ['(', ')', '圆括号'],
        ['[', ']', '方括号']
      ] as const) {
        const a = countChar(stripped, left)
        const b = countChar(stripped, right)
        if (a !== b) warnings.push(`${path} 可能存在${label}不配平（${left} 有 ${a} 个，${right} 有 ${b} 个）`)
      }
    }
  }
  return { ok: blocking.length === 0, issues: [...blocking, ...warnings] }
}

/**
 * check_project 的完整校验：静态检查之上，按项目类型做 esbuild-wasm 真实编译。
 * 编译失败属于阻塞项（TS 语法错误不能收尾）；编译产物的告警不阻塞。
 */
async function checkProjectWithCompile(
  state: MockPipelineState,
  files: Record<string, string>
): Promise<{ ok: boolean; issues: string[] }> {
  const result = checkProject(files)
  const spec = state.projectKind === null ? null : MOCK_PROJECT_KINDS[state.projectKind]
  if (!spec || !spec.needsCompile) return result
  const entry = mockTsEntry(files, spec)
  if (!entry) {
    return {
      ok: result.ok,
      issues: [...result.issues, `提示：还没有 TS 入口文件（${spec.tsEntries.join(' 或 ')}），暂未做编译检查`]
    }
  }
  const compiled = await compileMockProject(files, entry)
  const issues = [...result.issues]
  if (compiled.js !== null) {
    for (const message of compiled.errors) issues.push(`编译警告（${entry}）：${message}`)
  } else {
    for (const message of compiled.errors) issues.unshift(`编译失败（${entry}）：${message}`)
  }
  return { ok: result.ok && compiled.js !== null, issues }
}

interface MockStreamPart {
  type: string
  text?: string
  id?: string
  delta?: unknown
  toolName?: string
  input?: unknown
  output?: unknown
}

/** 工具事件转发：生成活动标签并回报开始 / 结束。 */
function forwardToolEvent(part: MockStreamPart, onUpdate: MockAgentUpdate | undefined): void {
  const name = part.toolName ?? ''
  const label = describeToolCall(name, part.input)
  if (part.type === 'tool-call') {
    onUpdate?.onToolStart?.(name, label)
    return
  }
  const ok = !isRecord(part.output) || part.output.error === undefined
  onUpdate?.onToolDone?.(name, label, ok)
}

/** 工具输入（参数）流转发：参数尚未生成完就给 UI 进度可见性（按工具累计字节数）。 */
function forwardToolInputEvent(
  part: MockStreamPart,
  inputBytes: Map<string, number>,
  inputNames: Map<string, string>,
  encoder: TextEncoder,
  onUpdate: MockAgentUpdate | undefined
): void {
  if (part.type === 'tool-input-start') {
    const name = typeof part.toolName === 'string' ? part.toolName : ''
    if (name.length === 0) return
    const id = part.id ?? name
    inputBytes.set(id, 0)
    inputNames.set(id, name)
    onUpdate?.onToolInputStart?.(id, name)
    return
  }
  if (part.type !== 'tool-input-delta') return
  const key = typeof part.id === 'string' ? part.id : (part.toolName ?? '')
  const delta = typeof part.delta === 'string' ? part.delta : ''
  if (key.length === 0 || delta.length === 0) return
  const deltaBytes = encoder.encode(delta).length
  const total = (inputBytes.get(key) ?? 0) + deltaBytes
  inputBytes.set(key, total)
  // tool-input-delta 不携带 toolName：按 toolCallId 从 input-start 的登记里取回
  onUpdate?.onToolInputDelta?.(key, inputNames.get(key) ?? '', total, deltaBytes)
}

/** 消费 agent 流：把文本 / 推理 / 工具事件转发给 onUpdate，并回报管线快照。 */
async function consumeMockStream(
  stream: { fullStream: AsyncIterable<MockStreamPart> },
  state: MockPipelineState,
  onUpdate: MockAgentUpdate | undefined
): Promise<string> {
  let fullText = ''
  const encoder = new TextEncoder()
  const inputBytes = new Map<string, number>()
  const inputNames = new Map<string, string>()
  for await (const part of stream.fullStream) {
    if (part.type === 'text-delta' && typeof part.text === 'string') {
      fullText += part.text
      onUpdate?.onTextDelta?.(part.text)
    } else if (part.type === 'reasoning-delta' && typeof part.text === 'string') {
      onUpdate?.onReasoningDelta?.(part.text)
    } else if (part.type === 'tool-input-start' || part.type === 'tool-input-delta') {
      forwardToolInputEvent(part, inputBytes, inputNames, encoder, onUpdate)
    } else if (
      typeof part.toolName === 'string' &&
      (part.type === 'tool-call' || part.type === 'tool-result')
    ) {
      forwardToolEvent(part, onUpdate)
      if (part.type === 'tool-result') onUpdate?.onPipelineChange?.(pipelineSnapshot(state))
    }
  }
  return fullText
}

export async function runMockAgent(options: {
  model: LanguageModel
  providerID: AIProviderID
  reasoningEffort: string
  prompt: string
  hasProject: boolean
  currentSource: string
  /** 修改已有项目时传入当前文件集，供 check_project 校验全量工程。 */
  initialFiles?: Record<string, string>
  /** 当前 mock 页 id，相似设计搜索时排除自身。 */
  mockId?: string
  /** 场景提示词模板 id（默认 'website'）。 */
  promptTemplateId?: string
  maxSteps?: number
  handlers: MockAgentHandlers
  onUpdate?: MockAgentUpdate
}): Promise<MockAgentResult> {
  let filesWritten = 0
  let finishSummary = ''
  const state = createMockPipeline()
  const localFiles: Record<string, string> = { ...options.initialFiles }
  const systemPrompt = composeMockSystemPrompt(resolveMockPromptTemplate(options.promptTemplateId))

  const tools = {
    ask_user: tool({
      description:
        '需求澄清：当用户需求模糊、存在多个明显不同的合理方向，或有影响整体方向的关键抉择（目标受众 / 风格取向 / 核心板块 / 平台形态等）时，先向用户提问再继续。一次最多 3 个问题，每题可附 2~4 个选项供快速点选。需求已经足够具体时不要使用——不为确认而确认。',
      inputSchema: valibotSchema(
        v.object({
          questions: v.pipe(
            v.array(
              v.object({
                question: v.pipe(v.string(), v.minLength(1)),
                options: v.optional(v.array(v.pipe(v.string(), v.minLength(1))))
              })
            ),
            v.minLength(1),
            v.maxLength(3)
          )
        })
      ),
      execute: async ({ questions }) => {
        if (!options.handlers.askUser) {
          return {
            ok: false,
            error: '当前环境无法向用户提问：按你的最佳判断继续，并在收尾总结里说明所做的关键假设'
          }
        }
        const answer = await options.handlers.askUser(questions)
        return { ok: true, answer }
      }
    }),
    get_design_norms: tool({
      description:
        '取回目标平台的设计规范（画布尺寸 / 栅格 / 间距刻度 / 字号阶梯 / 圆角刻度 / 配色准则 / 结构准则）。规划与搭建都必须以它为准。',
      inputSchema: valibotSchema(
        v.object({
          kind: v.optional(v.picklist(MOCK_NORMS_KINDS))
        })
      ),
      execute: async ({ kind }) => {
        const norms = getMockDesignNorms(kind)
        state.normsKind = norms.kind
        advancePipeline(state)
        return norms
      }
    }),
    search_similar_designs: tool({
      description:
        '在本地历史 mock 项目里搜索与当前需求相似的设计，返回其需求描述与结构摘要（板块与标题），供参考信息架构；不包含可复用的源码。',
      inputSchema: valibotSchema(
        v.object({
          query: v.pipe(v.string(), v.minLength(1))
        })
      ),
      execute: async ({ query }) => {
        const matches = searchSimilarMockDesigns(query, { excludeId: options.mockId ?? null })
        state.similarChecked = true
        state.similarMatches = matches.length
        advancePipeline(state)
        return { matches }
      }
    }),
    declare_project_kind: tool({
      description:
        '声明本次项目的形态：html（纯静态页）/ ts-static（TypeScript 增强静态页，浏览器内编译）/ spa（框架单页应用，依赖经 esm.sh CDN 加载）。按需求选：展示型页面选 html；有交互逻辑选 ts-static；多视图重交互选 spa。声明后各阶段的文件策略与必需文件随之确定。',
      inputSchema: valibotSchema(
        v.object({
          kind: v.picklist(['html', 'ts-static', 'spa'])
        })
      ),
      execute: async ({ kind }) => {
        const spec = declareProjectKind(state, kind)
        return { ok: true, kind: spec.id, label: spec.label, summary: spec.summary, playbook: spec.playbook }
      }
    }),
    plan_steps: tool({
      description:
        '提交计划：把页面按语义结构拆成 2~8 步，每步注明标题与产出文件（从零生成需覆盖项目类型的必需文件）。从零生成提交后进入布局骨架阶段；修改已有项目提交后直接进入视觉精修阶段，之后用 mark_step_done 逐步标记完成。',
      inputSchema: valibotSchema(
        v.object({
          steps: v.array(
            v.object({
              id: v.optional(v.string()),
              title: v.pipe(v.string(), v.minLength(1)),
              files: v.optional(v.array(v.string()))
            })
          )
        })
      ),
      execute: async ({ steps }) => {
        const result = submitPlan(state, steps, { fresh: !options.hasProject })
        if (!result.ok) return { ok: false, error: result.error }
        return { ok: true, steps: result.plan }
      }
    }),
    set_canvas_size: tool({
      description:
        '设置画布（页面）尺寸。以 get_design_norms 返回的画布为准；用户明确给出尺寸时以用户为准。',
      inputSchema: valibotSchema(
        v.object({
          width: v.pipe(v.number(), v.minValue(120), v.maxValue(2560)),
          height: v.pipe(v.number(), v.minValue(120), v.maxValue(2560))
        })
      ),
      execute: async ({ width, height }) => {
        const w = clampSize(width)
        const h = clampSize(height)
        options.handlers.setCanvasSize(w, h)
        return { ok: true, width: w, height: h }
      }
    }),
    write_project_file: tool({
      description:
        '把一个文件完整写入当前项目并立即生效（右侧预览会热更新）。能写哪些文件由当前阶段与项目类型决定：布局骨架阶段只写 index.html 与 styles/base.css；视觉精修阶段按形态写 styles/main.css、scripts/main.js（或 scripts/main.ts、src/*.ts(x)）等。',
      inputSchema: valibotSchema(
        v.object({
          path: v.pipe(v.string(), v.minLength(1)),
          content: v.string()
        })
      ),
      execute: async ({ path, content }) => {
        const normalized = normalizeProjectPath(path)
        if (!normalized) return { ok: false, error: 'invalid path' }
        const policyError = writePolicyError(state, normalized)
        if (policyError) return { ok: false, error: policyError }
        options.handlers.writeProjectFile(normalized, content)
        localFiles[normalized] = content
        filesWritten++
        return { ok: true, path: normalized, bytes: content.length }
      }
    }),
    submit_skeleton: tool({
      description:
        '提交布局骨架：index.html 语义结构（真实文案、无内联样式）与 styles/base.css 设计令牌都写完后调用，通过门禁（语义板块 ≥2）后进入视觉精修阶段。',
      inputSchema: valibotSchema(v.object({})),
      execute: async () => {
        const blocked = submitSkeletonBlockReason(state, localFiles)
        if (blocked) return { ok: false, error: blocked }
        state.phase = 'refine'
        return { ok: true }
      }
    }),
    mark_step_done: tool({
      description: '把计划中的某一步标记为完成（对应该步的文件写完后调用）。',
      inputSchema: valibotSchema(
        v.object({
          stepId: v.pipe(v.string(), v.minLength(1))
        })
      ),
      execute: async ({ stepId }) => {
        const step = markStepDone(state, stepId)
        if (!step) return { ok: false, error: `计划中没有步骤 ${stepId}` }
        return { ok: true, step }
      }
    }),
    check_project: tool({
      description:
        '对当前项目做构建验证：入口文件存在、相对引用可解析、文件非空、CSS/JS 基本配平；ts-static / spa 项目还会用 esbuild 做真实编译检查（语法错误会阻塞收尾）。收尾前必须通过；修复问题后要重新验证。',
      inputSchema: valibotSchema(v.object({})),
      execute: async () => {
        const result = await checkProjectWithCompile(state, localFiles)
        recordVerification(state, result, filesWritten)
        return result
      }
    }),
    finish_project: tool({
      description:
        '全部步骤完成、项目类型的必需文件齐备且最近一次 check_project 通过后调用，用一句话中文总结你做了什么。',
      inputSchema: valibotSchema(v.object({ summary: v.string() })),
      execute: async ({ summary }) => {
        const blocked = finishBlockReason(state, filesWritten, localFiles)
        if (blocked) return { ok: false, error: blocked }
        state.phase = 'done'
        finishSummary = summary
        return { ok: true, summary }
      }
    })
  }

  const userContent = options.hasProject
    ? `这是当前项目的完整源代码：\n\n${options.currentSource}\n\n请按以下要求修改这个项目。\n${options.prompt}`
    : options.prompt

  const stream = streamText({
    model: options.model,
    system: systemPrompt,
    prompt: userContent,
    tools,
    stopWhen: stepCountIs(options.maxSteps ?? MOCK_AGENT_MAX_STEPS),
    providerOptions: buildReasoningProviderOptions(options.providerID, options.reasoningEffort),
    prepareStep: () => ({
      activeTools: PHASE_TOOLS[state.phase] as (keyof typeof tools)[],
      instructions: `${systemPrompt}\n\n${phaseStatusHint(state, filesWritten)}`
    })
  })

  const fullText = await consumeMockStream(stream, state, options.onUpdate)

  return {
    fullText,
    summary: finishSummary || fullText.trim(),
    filesWritten,
    pipeline: pipelineSnapshot(state),
    reachedStepLimit: state.phase !== 'done'
  }
}
