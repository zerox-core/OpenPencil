/**
 * 三重自查网调度器与自查闭环引擎 (Triple Verification Engine)。
 * 严守【静态编译检查 ➔ 运行时控制台嗅探 ➔ 视觉排版评审】三道防线，
 * 并在检测到连续停滞时触发熔断保护，防止模型死锁。
 */

import { compileMockProject, pickMockTsEntry } from '@/app/mock/compiler'
import { composePreview } from '@/app/mock/project'
import {
  mockVisualReviewAvailable,
  runMockVisualReview
} from '@/app/mock/review'

import type { ConsoleSniffer } from './console-sniffer'

export type CritiqueStage =
  | 'static_compile'
  | 'runtime_console'
  | 'visual_review'
  | 'all_passed'

export interface CritiqueCheckResult {
  passed: boolean
  stage: CritiqueStage
  errors: string[]
  remediationPrompt?: string
  signature: string
}

export interface TripleVerificationOptions {
  files: Record<string, string>
  entry?: string
  width?: number
  height?: number
  sniffer?: ConsoleSniffer
  skipVisual?: boolean
  userPrompt?: string
  normsKind?: string | null
}

/**
 * 计算错误清单的唯一确定性签名（阶段 + 排序去重归一）。
 */
export function computeIssueSignature(stage: CritiqueStage, errors: readonly string[]): string {
  if (errors.length === 0) return `${stage}:clean`
  const normalized = errors
    .map((e) => e.trim())
    .filter(Boolean)
    .sort()
    .join('||')
  return `${stage}:${normalized}`
}

/**
 * 停滞熔断器：跟踪自查失败历史，若连续多轮错误签名完全一致，判为修复陷入死循环，强制熔断。
 */
export class StagnationCircuitBreaker {
  private lastSignature = ''
  private repeatCount = 0
  private readonly threshold: number

  public constructor(threshold = 2) {
    this.threshold = threshold
  }

  public record(signature: string): { stagnant: boolean; count: number } {
    if (!signature || signature.endsWith(':clean')) {
      this.reset()
      return { stagnant: false, count: 0 }
    }

    if (signature === this.lastSignature) {
      this.repeatCount += 1
    } else {
      this.lastSignature = signature
      this.repeatCount = 1
    }

    return {
      stagnant: this.repeatCount >= this.threshold,
      count: this.repeatCount
    }
  }

  public reset(): void {
    this.lastSignature = ''
    this.repeatCount = 0
  }
}

function checkHTMLBasicIntegrity(files: Record<string, string>, entry?: string): string[] {
  const errors: string[] = []
  const entryKey = entry ?? (Object.hasOwn(files, 'index.html') ? 'index.html' : Object.keys(files).find((f) => f.endsWith('.html')))
  if (!entryKey || !files[entryKey]) {
    errors.push('项目缺少有效的 HTML 入口文件 (如 index.html)')
    return errors
  }

  const content = files[entryKey]
  const scriptOpens = (content.match(/<script\b[^>]*>/gi) ?? []).length
  const scriptCloses = (content.match(/<\/script>/gi) ?? []).length
  if (scriptOpens !== scriptCloses) {
    errors.push(`HTML 中的 <script> 标签未正确闭合: 打开 ${scriptOpens} 个, 闭合 ${scriptCloses} 个`)
  }

  const styleOpens = (content.match(/<style\b[^>]*>/gi) ?? []).length
  const styleCloses = (content.match(/<\/style>/gi) ?? []).length
  if (styleOpens !== styleCloses) {
    errors.push(`HTML 中的 <style> 标签未正确闭合: 打开 ${styleOpens} 个, 闭合 ${styleCloses} 个`)
  }

  return errors
}

async function verifyStaticStage(
  files: Record<string, string>,
  entry?: string
): Promise<CritiqueCheckResult | null> {
  const tsEntry = entry && Object.hasOwn(files, entry) && /\.tsx?$/.test(entry)
    ? entry
    : pickMockTsEntry(files)

  if (tsEntry) {
    try {
      const compile = await compileMockProject(files, tsEntry)
      if (compile.errors.length > 0) {
        const signature = computeIssueSignature('static_compile', compile.errors)
        const remediation = [
          '## 静态编译自查未通过 (Static Compile Failed):',
          ...compile.errors.map((err, i) => `${i + 1}. ${err}`),
          '\n请检查虚拟文件系统中的相对路径导入、TS 类型与语法、以及模块导出。'
        ].join('\n')

        return {
          passed: false,
          stage: 'static_compile',
          errors: compile.errors,
          remediationPrompt: remediation,
          signature
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errors = [`Compiler exception: ${msg}`]
      return {
        passed: false,
        stage: 'static_compile',
        errors,
        remediationPrompt: `编译器异常：${msg}`,
        signature: computeIssueSignature('static_compile', errors)
      }
    }
  } else {
    const htmlErrors = checkHTMLBasicIntegrity(files, entry)
    if (htmlErrors.length > 0) {
      const signature = computeIssueSignature('static_compile', htmlErrors)
      const remediation = [
        '## 静态 HTML 语法自查未通过:',
        ...htmlErrors.map((err, i) => `${i + 1}. ${err}`),
        '\n请检查入口 HTML 文件与标签配平。'
      ].join('\n')

      return {
        passed: false,
        stage: 'static_compile',
        errors: htmlErrors,
        remediationPrompt: remediation,
        signature
      }
    }
  }

  return null
}

function verifyRuntimeStage(sniffer?: ConsoleSniffer): CritiqueCheckResult | null {
  if (!sniffer || !sniffer.hasErrors()) return null

  const snifferErrors = sniffer.getErrors().map((e) => `[${e.level}] ${e.message}`)
  const signature = computeIssueSignature('runtime_console', snifferErrors)
  return {
    passed: false,
    stage: 'runtime_console',
    errors: snifferErrors,
    remediationPrompt: sniffer.formatErrorReport(),
    signature
  }
}

async function verifyVisualStage(
  options: TripleVerificationOptions
): Promise<CritiqueCheckResult | null> {
  if (options.skipVisual) return null

  const canVisual = await mockVisualReviewAvailable()
  if (!canVisual) return null

  const html = composePreview(options.files, options.entry)
  if (!html) return null

  const width = options.width ?? 1200
  const height = options.height ?? 800

  const review = await runMockVisualReview({
    html,
    width,
    height,
    userPrompt: options.userPrompt ?? '',
    normsKind: options.normsKind ?? null
  })

  if (review.status === 'reviewed' && !review.verdict.ok && review.verdict.issues.length > 0) {
    const issues = review.verdict.issues
    const signature = computeIssueSignature('visual_review', issues)
    const remediation = [
      '## 视觉排版自查发现以下缺陷 (Visual Review Failed):',
      ...issues.map((iss, i) => `${i + 1}. ${iss}`),
      '\n请重点优化视觉排版、组件间距对齐、配色对比度或文字遮挡。'
    ].join('\n')

    return {
      passed: false,
      stage: 'visual_review',
      errors: issues,
      remediationPrompt: remediation,
      signature
    }
  }

  return null
}

/**
 * 完整执行三重自查网：
 * 1. 静态与编译检查 (Static / Compiler)
 * 2. 运行时控制台错误嗅探 (Console Sniffer)
 * 3. 视觉多模态排版评审 (Vision Review)
 */
export async function runTripleVerification(
  options: TripleVerificationOptions
): Promise<CritiqueCheckResult> {
  // 第 1 重：静态与编译检查
  const staticFailure = await verifyStaticStage(options.files, options.entry)
  if (staticFailure) return staticFailure

  // 第 2 重：运行时控制台错误嗅探
  const runtimeFailure = verifyRuntimeStage(options.sniffer)
  if (runtimeFailure) return runtimeFailure

  // 第 3 重：视觉排版自查
  const visualFailure = await verifyVisualStage(options)
  if (visualFailure) return visualFailure

  // 全部通过
  return {
    passed: true,
    stage: 'all_passed',
    errors: [],
    signature: computeIssueSignature('all_passed', [])
  }
}
