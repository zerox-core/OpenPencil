/**
 * 双水位线无感自适应压缩引擎。
 * 与接入模型窗口动态同步：80% 软水位触发静默后台蒸馏，95% 硬水位触发强制同步截断保护。
 */

import { generateText, type LanguageModel } from 'ai'

import { buildReasoningProviderOptions } from '@/app/ai/chat/reasoning'
import type { AIProviderID } from '@open-pencil/core/constants'
import {
  mergeLongTermMemory,
  type LongTermMemoryLedger
} from './ltm'
import type { ShortTermMessage } from './stm'

export const DISTILL_PROMPT = `你是一个高级架构师。请从以下即将滑出上下文窗口的历史交互对话中，提炼出不可遗忘的长期记忆增量。

请提炼为严格 JSON：
{
  "persona_and_constraints": {
    "aesthetic": "用户的审美新要求（无则保持空串）",
    "forbidden_redlines": ["用户新提出的明确雷点禁忌"],
    "strict_requirements": ["新增的技术硬性约束"],
    "user_habits": ["新增的用户习惯"]
  },
  "project_architecture": {
    "design_tokens": {"新确定的主色等规范": "对应值"},
    "decision_log": ["本次交互中做出的重要技术或架构决策与原因"]
  },
  "session_progress_ledger": {
    "completed_milestones": ["新完成的关键功能或模块"],
    "in_progress": "当前正在推进的任务名称",
    "pending_todo": ["下一步仍需完成的任务"],
    "unresolved_debts": ["发现但尚未解决的技术缺陷或样式瑕疵"]
  }
}
只输出紧凑的 JSON，严禁输出任何额外 markdown 或废话。`.trim()

export interface CompressionOptions {
  model?: LanguageModel
  providerID?: AIProviderID
  reasoningEffort?: string
  contextWindowLimit?: number // 接入模型的最大窗口（如 64000）
  softWatermarkRatio?: number // 默认 0.8
  hardWatermarkRatio?: number // 默认 0.95
}

export class MemoryCompressionEngine {
  private readonly contextLimit: number
  private readonly softWatermark: number
  private readonly hardWatermark: number
  private isCompressing = false

  constructor(private readonly options: CompressionOptions = {}) {
    this.contextLimit = options.contextWindowLimit ?? 64000
    this.softWatermark = (options.softWatermarkRatio ?? 0.8) * this.contextLimit
    this.hardWatermark = (options.hardWatermarkRatio ?? 0.95) * this.contextLimit
  }

  /**
   * 检查当前 Token 是否触碰水位线。
   */
  checkWatermark(currentTokens: number): 'normal' | 'soft' | 'hard' {
    if (currentTokens >= this.hardWatermark) return 'hard'
    if (currentTokens >= this.softWatermark) return 'soft'
    return 'normal'
  }

  /**
   * 软水位触发：后台静默信息蒸馏（不阻塞主会话）。
   */
  async distillAndMergeAsync(
    ledger: LongTermMemoryLedger,
    expiringMessages: ShortTermMessage[]
  ): Promise<LongTermMemoryLedger> {
    if (this.isCompressing || expiringMessages.length === 0) return ledger
    if (!this.options.model) return ledger

    this.isCompressing = true
    try {
      const conversationText = expiringMessages
        .map((m) => `[${m.role}]: ${m.content}`)
        .join('\n')

      const result = await generateText({
        model: this.options.model,
        system: DISTILL_PROMPT,
        prompt: `即将归档的对话记录：\n${conversationText}`,
        maxOutputTokens: 600,
        providerOptions: buildReasoningProviderOptions(
          this.options.providerID ?? 'openai',
          this.options.reasoningEffort ?? ''
        )
      })

      const match = result.text.match(/\{[\s\S]*\}/)
      if (match) {
        try {
          const patch = JSON.parse(match[0]) as Partial<LongTermMemoryLedger>
          return mergeLongTermMemory(ledger, patch)
        } catch (parseError) {
          console.warn('[MemoryCompression] 蒸馏结果 JSON 解析异常:', parseError)
        }
      }
    } catch (error) {
      console.warn('[MemoryCompression] 后台记忆蒸馏失败:', error)
    } finally {
      this.isCompressing = false
    }

    return ledger
  }
}
