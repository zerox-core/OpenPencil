import { generateText, streamText, type LanguageModel } from 'ai'

import { buildReasoningProviderOptions } from '@/app/ai/chat/reasoning'
import type { AIProviderID } from '@open-pencil/core/constants'
import { applyPatchToString } from '@/app/mock/tools/code'
import {
  FAST_CONSULT_SYSTEM_PROMPT,
  FAST_CREATIVE_SYSTEM_PROMPT,
  FAST_PATCH_SYSTEM_PROMPT,
  ROUTER_SYSTEM_PROMPT
} from './prompts'
import { extractHTML } from '@/app/mock/project'

export type MockRouterTrack = 'consult' | 'patch' | 'creative' | 'workflow'

export interface MockRouterVerdict {
  track: MockRouterTrack
  targetFile?: string | null
  confidence: number
  reason: string
}

export function parseRouterVerdict(text: string): MockRouterVerdict {
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as {
        track?: unknown
        targetFile?: unknown
        confidence?: unknown
        reason?: unknown
      }
      const validTracks = ['consult', 'patch', 'creative', 'workflow']
      const track = typeof parsed.track === 'string' && validTracks.includes(parsed.track)
        ? (parsed.track as MockRouterTrack)
        : 'workflow'
      return {
        track,
        targetFile: typeof parsed.targetFile === 'string' ? parsed.targetFile : null,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
        reason: typeof parsed.reason === 'string' ? parsed.reason : ''
      }
    } catch (error) {
      console.warn('[MockRouter] JSON parse failed, falling back to workflow:', error)
    }
  }
  return { track: 'workflow', confidence: 0.5, reason: '未能解析分流结果，默认进入深度循环' }
}

/**
 * 极轻量意图分类器：单次耗时 <500ms，为高频操作开辟提前出口。
 */
export async function routeMockIntent(options: {
  model: LanguageModel
  providerID: AIProviderID
  reasoningEffort: string
  userPrompt: string
  hasProject: boolean
  fileList?: string[]
}): Promise<MockRouterVerdict> {
  const promptText = options.userPrompt.trim()

  // 1. 快速正则嗅探（零延迟分流）：
  if (/^(你好|hi|hello|在吗|你是谁|介绍一下|你能做什么|怎么用)/i.test(promptText)) {
    return { track: 'consult', confidence: 1.0, reason: '用户日常问候与咨询' }
  }

  // 经典基准测试（如著名的“鹈鹕骑自行车测试”）、SVG/Canvas 纯图形动效
  if (/(鹈鹕|pelican|自行车|bicycle|svg|canvas|粒子|物理模拟|时钟|动效|小游戏|着色器|shader)/i.test(promptText)) {
    return { track: 'creative', confidence: 0.95, reason: '识别为创意视觉/基准测试/图形动效快轨' }
  }

  const prompt = [
    `用户当前需求：${options.userPrompt}`,
    options.fileList && options.fileList.length > 0
      ? `当前项目文件：${options.fileList.join(', ')}`
      : '当前无已有项目文件'
  ].join('\n')

  try {
    const result = await generateText({
      model: options.model,
      system: ROUTER_SYSTEM_PROMPT,
      prompt,
      maxOutputTokens: 100,
      providerOptions: buildReasoningProviderOptions(options.providerID, options.reasoningEffort)
    })
    return parseRouterVerdict(result.text)
  } catch (error) {
    console.warn('[MockRouter] 分流判断异常，降级进入 workflow:', error)
    return { track: 'workflow', confidence: 0.5, reason: '分流异常降级' }
  }
}

/**
 * 出口 B：局部补丁快轨执行器（单文件微调，3秒内退出）。
 */
export async function executeFastPatch(options: {
  model: LanguageModel
  providerID: AIProviderID
  reasoningEffort: string
  userPrompt: string
  targetFile: string
  fileContent: string
}): Promise<
  | { ok: true; patchedContent: string; summary: string }
  | { ok: false; escalateToWorkflow: boolean; error: string }
> {
  const prompt = [
    `目标文件：${options.targetFile}`,
    `当前文件内容：\n\`\`\`\n${options.fileContent}\n\`\`\``,
    `用户的修改要求：${options.userPrompt}`
  ].join('\n')

  try {
    const result = await generateText({
      model: options.model,
      system: FAST_PATCH_SYSTEM_PROMPT,
      prompt,
      maxOutputTokens: 1200,
      providerOptions: buildReasoningProviderOptions(options.providerID, options.reasoningEffort)
    })

    const match = result.text.match(/\{[\s\S]*\}/)
    if (!match) {
      return { ok: false, escalateToWorkflow: true, error: '未产出合法的 Search & Replace 补丁，自动升轨' }
    }

    const patchPayload = JSON.parse(match[0]) as { search?: string; replace?: string; summary?: string }
    if (!patchPayload.search || patchPayload.replace === undefined) {
      return { ok: false, escalateToWorkflow: true, error: '补丁缺少 search 或 replace 块，自动升轨' }
    }

    const applied = applyPatchToString(options.fileContent, patchPayload.search, patchPayload.replace)
    if (!applied.ok) {
      // 如果 patch 无法唯一匹配，自动平滑升轨到深度循环，不给用户报错
      return { ok: false, escalateToWorkflow: true, error: `局部补丁未匹配成功（${applied.error}），自动平滑升轨` }
    }

    return {
      ok: true,
      patchedContent: applied.content,
      summary: patchPayload.summary ?? '完成单点局部修改'
    }
  } catch (error) {
    return { ok: false, escalateToWorkflow: true, error: `FastPatch 执行失败: ${String(error)}，平滑升轨` }
  }
}

/**
 * 出口 A：项目感知型咨询快轨（挂载 LTM 决策与 STM 语境，0写工具直接流式输出）。
 */
export function executeFastConsultStream(options: {
  model: LanguageModel
  providerID: AIProviderID
  reasoningEffort: string
  userPrompt: string
  decisionLedger?: string[]
  recentMessages?: Array<{ role: 'user' | 'assistant'; text: string }>
  vfsSummary?: string
}) {
  const contextParts: string[] = []

  if (options.decisionLedger && options.decisionLedger.length > 0) {
    contextParts.push(`【历史架构与设计决策记录】:\n${options.decisionLedger.map((d) => `- ${d}`).join('\n')}`)
  }
  if (options.vfsSummary) {
    contextParts.push(`【当前工程代码结构】:\n${options.vfsSummary}`)
  }

  const prompt = [
    contextParts.join('\n\n'),
    `用户问题：${options.userPrompt}`
  ].filter(Boolean).join('\n\n')

  return streamText({
    model: options.model,
    system: FAST_CONSULT_SYSTEM_PROMPT,
    prompt,
    providerOptions: buildReasoningProviderOptions(options.providerID, options.reasoningEffort)
  })
}

export function executeCreativeTrackStream(options: {
  model: LanguageModel
  providerID: AIProviderID
  reasoningEffort: string
  userPrompt: string
}) {
  return streamText({
    model: options.model,
    system: FAST_CREATIVE_SYSTEM_PROMPT,
    prompt: `用户需求：${options.userPrompt}\n请以高水准的代码艺术与生动动效直接输出完整的单文件 HTML 代码（含内联样式与脚本，用代码块包裹）。`,
    providerOptions: buildReasoningProviderOptions(options.providerID, options.reasoningEffort)
  })
}

export interface FastTrackDispatchOptions {
  model: LanguageModel
  providerID: AIProviderID
  reasoningEffort: string
  userPrompt: string
  hasProject: boolean
  fileList: string[]
  files: Record<string, string>
  entryFile: string
  onTextDelta: (chunk: string) => void
}

export interface FastTrackDispatchResult {
  handled: boolean
  track: MockRouterTrack
  assistantMessage?: string
  patchedFiles?: Record<string, string>
}

async function dispatchConsultTrack(options: FastTrackDispatchOptions): Promise<FastTrackDispatchResult> {
  let fullText = ''
  try {
    const consultStream = executeFastConsultStream({
      model: options.model,
      providerID: options.providerID,
      reasoningEffort: options.reasoningEffort,
      userPrompt: options.userPrompt,
      vfsSummary: options.fileList.length > 0 ? options.fileList.join(', ') : undefined
    })
    for await (const chunk of consultStream.textStream) {
      fullText += chunk
      options.onTextDelta(chunk)
    }
    return { handled: true, track: 'consult', assistantMessage: fullText }
  } catch (error) {
    console.warn('[MockRouter] Consult track stream failed:', error)
    return {
      handled: true,
      track: 'consult',
      assistantMessage: fullText || '抱歉，当前模型流式服务断开或未输出内容。请检查模型配置与网络连通性。'
    }
  }
}

async function dispatchPatchTrack(
  options: FastTrackDispatchOptions,
  verdict: MockRouterVerdict
): Promise<FastTrackDispatchResult | null> {
  if (!options.hasProject) return null
  const target = verdict.targetFile && Object.hasOwn(options.files, verdict.targetFile)
    ? verdict.targetFile
    : options.entryFile
  const currentCode = options.files[target]
  if (!currentCode) return null

  const patchRes = await executeFastPatch({
    model: options.model,
    providerID: options.providerID,
    reasoningEffort: options.reasoningEffort,
    userPrompt: options.userPrompt,
    targetFile: target,
    fileContent: currentCode
  })

  if (!patchRes.ok) return null
  return {
    handled: true,
    track: 'patch',
    assistantMessage: patchRes.summary,
    patchedFiles: { ...options.files, [target]: patchRes.patchedContent }
  }
}

async function dispatchCreativeTrack(options: FastTrackDispatchOptions): Promise<FastTrackDispatchResult | null> {
  let fullText = ''
  try {
    const creativeStream = executeCreativeTrackStream({
      model: options.model,
      providerID: options.providerID,
      reasoningEffort: options.reasoningEffort,
      userPrompt: options.userPrompt
    })
    for await (const chunk of creativeStream.textStream) {
      fullText += chunk
      options.onTextDelta(chunk)
    }
    const html = extractHTML(fullText)
    if (!html.trim()) return null
    return {
      handled: true,
      track: 'creative',
      assistantMessage: '为您直接生成了专属创意视觉与交互成果！中央呈现主舞台与交互控制器。',
      patchedFiles: { 'index.html': html }
    }
  } catch (error) {
    console.warn('[MockRouter] Creative track stream failed:', error)
    return null
  }
}

/**
 * 尝试执行快轨拦截与调度。如果成功命中出口 A、B 或 C 则直接交付，否则交回主循环。
 */
export async function tryFastTrackDispatch(
  options: FastTrackDispatchOptions
): Promise<FastTrackDispatchResult> {
  const verdict = await routeMockIntent({
    model: options.model,
    providerID: options.providerID,
    reasoningEffort: options.reasoningEffort,
    userPrompt: options.userPrompt,
    hasProject: options.hasProject,
    fileList: options.fileList
  })

  // 出口 A：问候闲聊与设计咨询快轨
  if (verdict.track === 'consult') {
    return dispatchConsultTrack(options)
  }

  // 出口 B：单点局部微调快轨
  if (verdict.track === 'patch') {
    const patchResult = await dispatchPatchTrack(options, verdict)
    if (patchResult) return patchResult
  }

  // 出口 C：创意视觉、图形动效与基准测试快轨
  if (verdict.track === 'creative') {
    const creativeResult = await dispatchCreativeTrack(options)
    if (creativeResult) return creativeResult
  }

  return {
    handled: false,
    track: 'workflow'
  }
}

