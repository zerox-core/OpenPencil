/**
 * Mock 项目的视觉自查循环 —— 画板「测试验证 → 反馈到 AI」的落地：
 * 生成完成后用隐藏渲染副本帧截取页面快照（html2canvas-pro，支持 oklch 等
 * 现代 CSS 色值），交给独立的 Vision 模型按设计目标自查静态视觉问题；
 * 发现问题则带着问题清单回灌修复、修复后重新截图复检——循环直到收敛
 * （无确信问题）、停滞（两轮问题清单完全相同）或达到修复轮次上限为止。
 *
 * 截图走「渲染副本帧」而不是直接读预览 iframe：预览帧 sandbox="allow-scripts"
 * 是隔离源，父页面读不到 contentDocument；副本帧反向配置
 * sandbox="allow-same-origin"（无 allow-scripts）——父页面可读 DOM 供截图，
 * 生成代码与 CDN 脚本不会执行，截图是纯 CSS 渲染（JS 动态构建的内容不在
 * 截图里，自查提示词已注明这一局限）。
 */

import { generateText } from 'ai'

import { buildReasoningProviderOptions } from '@/app/ai/chat/reasoning'
import { createAIModelRuntime } from '@/app/ai/models'

export const MOCK_REVIEW_MAX_EDGE = 1280
const MOCK_REVIEW_MAX_OUTPUT_TOKENS = 800
const CAPTURE_LOAD_TIMEOUT_MS = 8000

export interface MockVisualReview {
  ok: boolean
  issues: string[]
}

export type MockVisualReviewOutcome =
  | { status: 'skipped' }
  | { status: 'reviewed'; verdict: MockVisualReview }

/** Vision 模型是否已配置且可直接调用（决定要不要展示视觉自查环节）。 */
export async function mockVisualReviewAvailable(): Promise<boolean> {
  try {
    const runtime = await createAIModelRuntime('vision')
    return runtime?.kind === 'direct'
  } catch {
    return false
  }
}

function clampDimension(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 900
  return Math.min(2560, Math.max(320, Math.round(value)))
}

/** 用隐藏副本帧渲染页面并截取 PNG 快照；失败返回 null。 */
export async function captureMockPreviewShot(
  html: string,
  width: number,
  height: number,
  maxEdge = MOCK_REVIEW_MAX_EDGE
): Promise<Uint8Array | null> {
  if (!html) return null
  const frame = document.createElement('iframe')
  const w = clampDimension(width)
  const h = clampDimension(height)
  frame.setAttribute('sandbox', 'allow-same-origin')
  frame.setAttribute('srcdoc', html)
  frame.title = 'mock-review-capture'
  Object.assign(frame.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: `${w}px`,
    height: `${h}px`,
    border: '0',
    background: '#ffffff'
  })
  document.body.appendChild(frame)
  try {
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, CAPTURE_LOAD_TIMEOUT_MS)
      frame.addEventListener(
        'load',
        () => {
          window.clearTimeout(timer)
          resolve()
        },
        { once: true }
      )
    })
    const doc = frame.contentDocument
    if (!doc) return null
    const { default: html2canvas } = await import('html2canvas-pro')
    const scale = Math.min(1, maxEdge / Math.max(w, h))
    const canvas = await html2canvas(doc.body, {
      backgroundColor: '#ffffff',
      logging: false,
      scale,
      useCORS: true,
      width: w,
      height: h,
      windowWidth: w,
      windowHeight: h
    })
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png')
    })
    if (!blob) return null
    return new Uint8Array(await blob.arrayBuffer())
  } catch (error) {
    console.warn('mock preview capture failed', error)
    return null
  } finally {
    frame.remove()
  }
}

/** 从 Vision 模型回复里解析 JSON 判定；解析失败按「无确信问题」处理，避免误触发修复轮。 */
function parseReviewVerdict(text: string): MockVisualReview {
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { ok?: unknown; issues?: unknown }
      const issues = Array.isArray(parsed.issues)
        ? parsed.issues.filter(
            (issue): issue is string => typeof issue === 'string' && issue.trim().length > 0
          )
        : []
      return { ok: issues.length === 0 && parsed.ok !== false, issues }
    } catch (error) {
      // JSON 解析失败按「无确信问题」处理，避免误触发修复轮
      console.warn('mock visual review verdict parse failed', error)
    }
  }
  return { ok: true, issues: [] }
}

/** 截图 → Vision 模型自查。没配置 Vision 模型 / 截图或调用失败 → skipped。 */
export async function runMockVisualReview(request: {
  html: string
  width: number
  height: number
  userPrompt: string
  normsKind: string | null
}): Promise<MockVisualReviewOutcome> {
  const runtime = await createAIModelRuntime('vision').catch(() => null)
  if (runtime?.kind !== 'direct') return { status: 'skipped' }
  const image = await captureMockPreviewShot(request.html, request.width, request.height)
  if (!image) return { status: 'skipped' }
  const prompt = [
    `设计目标：${request.userPrompt}`,
    `设计规范类型：${request.normsKind ?? 'desktop-web'}`,
    '这是刚生成的前端页面在完整视口的渲染截图（截图不含 JS 动态渲染的部分）。',
    '请自查确信的静态视觉问题：布局破碎、文字溢出或截断、明显错误的对齐与间距、对比度不足、元素重叠、异常大片空白。',
    '只报告你确信的问题，没有问题就不要硬找。',
    '只输出 JSON：{"ok": true|false, "issues": ["问题1", "问题2"]}'
  ].join('\n')
  try {
    const result = await generateText({
      model: runtime.model,
      maxOutputTokens: Math.min(runtime.role.profile.maxOutputTokens, MOCK_REVIEW_MAX_OUTPUT_TOKENS),
      providerOptions: buildReasoningProviderOptions(
        runtime.role.connection.providerID,
        runtime.role.profile.reasoningEffort ?? ''
      ),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'file', mediaType: 'image/png', data: image }
          ]
        }
      ]
    })
    return { status: 'reviewed', verdict: parseReviewVerdict(result.text) }
  } catch (error) {
    console.warn('mock visual review failed', error)
    return { status: 'skipped' }
  }
}

/** 自查循环默认修复轮次上限（参考常见 harness 的目标式循环：达标或到顶即停）。 */
export const MOCK_REVIEW_MAX_FIX_ROUNDS = 3

export type MockVisualReviewLoopStop = 'converged' | 'max-rounds' | 'stagnated' | 'fix-failed' | 'skipped'

export interface MockVisualReviewLoopResult {
  /** 实际完成的修复轮数。 */
  fixRounds: number
  stopReason: MockVisualReviewLoopStop
  /** 停止时仍确认存在的问题（converged / skipped 时为空）。 */
  remainingIssues: string[]
}

export interface MockVisualReviewLoopHooks {
  reviewStart?: () => void
  reviewDone?: (ok: boolean) => void
  fixStart?: (round: number) => void
  fixDone?: (ok: boolean) => void
}

/** 问题清单签名（修剪 + 排序归一）：两轮完全相同说明模型修不动，用于停滞检测提前停。 */
export function mockReviewIssuesSignature(issues: string[]): string {
  return issues
    .map((issue) => issue.trim())
    .filter(Boolean)
    .sort()
    .join('\n')
}

/**
 * 视觉自查外循环（参考常见 harness 的 verification loop 设计）：
 * - 目标式停止：复检无确信问题即收敛；
 * - 修复后必复检：每轮修复完重新截图交给 Vision 模型复核，不盲信修复；
 * - 停滞检测：问题清单与上轮完全相同则提前停，避免空烧轮次；
 * - 轮次上限：默认 3 轮，到顶如实上报剩余问题，不假装修好。
 * html 用 getter 传入——每轮修复后页面内容会变，复检必须拿最新渲染。
 */
export async function runMockVisualReviewLoop(request: {
  html: () => string | null
  width: number
  height: number
  userPrompt: string
  normsKind: string | null
  maxFixRounds?: number
  applyFix: (issues: string[]) => Promise<void>
  hooks?: MockVisualReviewLoopHooks
}): Promise<MockVisualReviewLoopResult> {
  const maxFixRounds = Math.max(0, Math.round(request.maxFixRounds ?? MOCK_REVIEW_MAX_FIX_ROUNDS))
  const hooks = request.hooks ?? {}
  let fixRounds = 0
  let previousSignature = ''
  for (;;) {
    const html = request.html()
    if (!html) return { fixRounds, stopReason: 'skipped', remainingIssues: [] }
    hooks.reviewStart?.()
    const review = await runMockVisualReview({
      html,
      width: request.width,
      height: request.height,
      userPrompt: request.userPrompt,
      normsKind: request.normsKind
    })
    if (review.status !== 'reviewed') {
      hooks.reviewDone?.(false)
      return { fixRounds, stopReason: 'skipped', remainingIssues: [] }
    }
    hooks.reviewDone?.(true)
    if (review.verdict.ok) {
      return { fixRounds, stopReason: 'converged', remainingIssues: [] }
    }
    const signature = mockReviewIssuesSignature(review.verdict.issues)
    if (signature === previousSignature) {
      return { fixRounds, stopReason: 'stagnated', remainingIssues: review.verdict.issues }
    }
    if (fixRounds >= maxFixRounds) {
      return { fixRounds, stopReason: 'max-rounds', remainingIssues: review.verdict.issues }
    }
    previousSignature = signature
    fixRounds += 1
    hooks.fixStart?.(fixRounds)
    try {
      await request.applyFix(review.verdict.issues)
      hooks.fixDone?.(true)
    } catch (error) {
      console.warn('mock review fix round failed', error)
      hooks.fixDone?.(false)
      return { fixRounds, stopReason: 'fix-failed', remainingIssues: review.verdict.issues }
    }
  }
}
