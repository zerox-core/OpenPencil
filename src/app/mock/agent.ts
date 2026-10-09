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
  finishBlockReason,
  markStepDone,
  PHASE_TOOLS,
  phaseStatusHint,
  pipelineSnapshot,
  recordVerification,
  submitPlan
} from '@/app/mock/pipeline'
import type { MockPipelineSnapshot, MockPipelineState } from '@/app/mock/pipeline'
import { searchSimilarMockDesigns } from '@/app/mock/similar'
import { composeMockSystemPrompt, resolveMockPromptTemplate } from '@/app/mock/prompts'
import type { LanguageModel } from 'ai'

/**
 * Mock 页面的 agentic 生成循环（v2 规划管线版）：
 * 画板流程落成显式状态机 —— 需求分析（取规范 + 搜相似）→ 制定计划（plan_steps，
 * 计划是数据不是聊天文本）→ 搭建 ⇄ 验证（写文件 / 标记步骤 / check_project）
 * → 收尾（finish_project 受状态机门禁约束）。
 * 工具按阶段动态暴露（prepareStep + activeTools），模型在当前阶段只能看到
 * 当前阶段的工具；每一步通过 prepareStep instructions 把管线状态注入模型。
 */

export interface MockAgentHandlers {
  setCanvasSize(width: number, height: number): void
  writeProjectFile(path: string, content: string): void
}

export interface MockAgentUpdate {
  onTextDelta?(text: string): void
  onReasoningDelta?(text: string): void
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
}

export const MOCK_AGENT_MAX_STEPS = 48

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

interface MockStreamPart {
  type: string
  text?: string
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

/** 消费 agent 流：把文本 / 推理 / 工具事件转发给 onUpdate，并回报管线快照。 */
async function consumeMockStream(
  stream: { fullStream: AsyncIterable<MockStreamPart> },
  state: MockPipelineState,
  onUpdate: MockAgentUpdate | undefined
): Promise<string> {
  let fullText = ''
  for await (const part of stream.fullStream) {
    if (part.type === 'text-delta' && typeof part.text === 'string') {
      fullText += part.text
      onUpdate?.onTextDelta?.(part.text)
    } else if (part.type === 'reasoning-delta' && typeof part.text === 'string') {
      onUpdate?.onReasoningDelta?.(part.text)
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
        '在本地历史 mock 项目里搜索与当前需求相似的设计，返回其需求描述与 index.html 源码摘录，供参考结构与技术选型。',
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
    plan_steps: tool({
      description:
        '提交搭建计划：把页面按语义结构拆成有序步骤，每步注明标题与产出文件。提交后进入搭建阶段，之后用 mark_step_done 逐步标记完成。',
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
        const plan = submitPlan(state, steps)
        return { ok: true, steps: plan }
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
        '把一个文件完整写入当前项目并立即生效（右侧预览会热更新）。index.html 是入口文件；样式放 styles/main.css；交互脚本放 scripts/main.js。',
      inputSchema: valibotSchema(
        v.object({
          path: v.pipe(v.string(), v.minLength(1)),
          content: v.string()
        })
      ),
      execute: async ({ path, content }) => {
        const normalized = normalizeProjectPath(path)
        if (!normalized) return { ok: false, error: 'invalid path' }
        options.handlers.writeProjectFile(normalized, content)
        localFiles[normalized] = content
        filesWritten++
        return { ok: true, path: normalized, bytes: content.length }
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
        '对当前项目做构建验证：入口文件存在、相对引用可解析、文件非空、CSS/JS 基本配平。收尾前必须通过；修复问题后要重新验证。',
      inputSchema: valibotSchema(v.object({})),
      execute: async () => {
        const result = checkProject(localFiles)
        recordVerification(state, result, filesWritten)
        return result
      }
    }),
    finish_project: tool({
      description: '全部步骤完成且最近一次 check_project 通过后调用，用一句话中文总结你做了什么。',
      inputSchema: valibotSchema(v.object({ summary: v.string() })),
      execute: async ({ summary }) => {
        const blocked = finishBlockReason(state, filesWritten)
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
    maxOutputTokens: 32768,
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
    pipeline: pipelineSnapshot(state)
  }
}
