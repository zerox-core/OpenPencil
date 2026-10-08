import { stepCountIs, streamText, tool } from 'ai'
import { valibotSchema } from '@ai-sdk/valibot'
import * as v from 'valibot'

import { buildReasoningProviderOptions } from '@/app/ai/chat/reasoning'
import type { AIProviderID } from '@open-pencil/core/constants'
import { normalizeProjectPath } from '@/app/mock/project'
import type { LanguageModel } from 'ai'

/**
 * Mock 页面的 agentic 生成循环：模型自主决策调用工具
 * （set_canvas_size / write_project_file / finish_project），
 * 每个文件落盘即热更新右侧预览，而不是等整段文本输出完再解析。
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
}

export interface MockAgentResult {
  fullText: string
  summary: string
  filesWritten: number
}

export const MOCK_AGENT_MAX_STEPS = 12

const SYSTEM_PROMPT = [
  '你是一个资深前端工程师，正在一个支持工具调用的工程环境里搭建前端小项目。',
  '你有三个工具可用：',
  '- set_canvas_size：设置画布尺寸。桌面网页 1440x900、手机页面 390x844、平板页面 834x1194；用户明确给出尺寸时以用户为准。',
  '- write_project_file：写入一个项目文件。必须先写 index.html（入口），样式放 styles/main.css，交互脚本放 scripts/main.js，内容较多时可按需增加文件（如 styles/theme.css、scripts/utils.js），一律使用相对路径引用。',
  '- finish_project：所有文件写完后调用，用一句话中文总结你做了什么。',
  '工作流程：先根据用户需求确定画布尺寸并调用 set_canvas_size；然后逐个调用 write_project_file 输出每个文件的完整内容；最后调用 finish_project。',
  '文件内容要求：index.html 通过 <link rel="stylesheet" href="styles/main.css"> 引入样式、通过 <script src="scripts/main.js"> 引入脚本；可以用 CDN 引入公开库（如 Tailwind、ECharts）。',
  '每个工具调用输出完整的文件内容，不要省略、不要分段拼接。页面要美观、现代、可交互，默认使用中文文案，除非用户另有要求。',
  '修改已有项目时，重写所有需要变更的文件（未变更的文件可不重写）。',
  '工具调用之间可以用一两句话简要说明你的思路；不要在工具调用里夹带 Markdown 代码围栏。'
].join('\n')

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
  return name
}

function clampSize(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(2560, Math.max(320, Math.round(value)))
}

export async function runMockAgent(options: {
  model: LanguageModel
  providerID: AIProviderID
  reasoningEffort: string
  prompt: string
  hasProject: boolean
  currentSource: string
  maxSteps?: number
  handlers: MockAgentHandlers
  onUpdate?: MockAgentUpdate
}): Promise<MockAgentResult> {
  let filesWritten = 0
  let finishSummary = ''

  const tools = {
    set_canvas_size: tool({
      description:
        '设置画布（页面）尺寸。桌面网页 1440x900、手机页面 390x844、平板页面 834x1194；用户明确给出尺寸时以用户为准。',
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
        filesWritten++
        return { ok: true, path: normalized, bytes: content.length }
      }
    }),
    finish_project: tool({
      description: '所有项目文件都写完后调用，用一句话中文总结你做了什么。',
      inputSchema: valibotSchema(v.object({ summary: v.string() })),
      execute: async ({ summary }) => {
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
    system: SYSTEM_PROMPT,
    prompt: userContent,
    tools,
    stopWhen: stepCountIs(options.maxSteps ?? MOCK_AGENT_MAX_STEPS),
    maxOutputTokens: 16000,
    providerOptions: buildReasoningProviderOptions(options.providerID, options.reasoningEffort)
  })

  let fullText = ''
  for await (const part of stream.fullStream) {
    if (part.type === 'text-delta') {
      fullText += part.text
      options.onUpdate?.onTextDelta?.(part.text)
    } else if (part.type === 'reasoning-delta') {
      options.onUpdate?.onReasoningDelta?.(part.text)
    } else if (part.type === 'tool-call') {
      const label = describeToolCall(part.toolName, part.input)
      options.onUpdate?.onToolStart?.(part.toolName, label)
    } else if (part.type === 'tool-result') {
      const label = describeToolCall(part.toolName, part.input)
      const ok = !isRecord(part.output) || part.output.error === undefined
      options.onUpdate?.onToolDone?.(part.toolName, label, ok)
    }
  }

  return {
    fullText,
    summary: fullText.trim() || finishSummary,
    filesWritten
  }
}
