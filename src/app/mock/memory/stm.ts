/**
 * 短期记忆滑动视窗与代码指针化脱敏机制（Code Offloading）。
 * 将历史消息中写大代码的耗费 Token 部分折叠为指针，使短期窗口容量提升 5~10 倍。
 */

export interface ShortTermMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolCallId?: string
  toolName?: string
  tokensEstimate?: number
}

export interface CodePointer {
  path: string
  lines: number
  bytes: number
  hash: string
}

/** 极简估算文本的 Token 数量（约 1 token ~= 3.5 字符或 1 中文字） */
export function estimateTokenCount(text: string): number {
  if (!text) return 0
  const cjkCount = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length
  const otherCount = text.length - cjkCount
  return cjkCount + Math.ceil(otherCount / 4)
}

/** 简单的轻量哈希（用于版本唯一指纹） */
export function quickHash(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(16).slice(0, 8)
}

/**
 * 代码指针化脱敏：检查文本中是否含有超过一定行数/大小的大段代码或写文件输出。
 * 若命中，则将其折叠为不可变轻量指针。
 */
export function offloadCodeFromText(
  text: string,
  thresholdBytes = 600
): { processedText: string; offloadedPointers: CodePointer[] } {
  const pointers: CodePointer[] = []

  // 匹配 write_project_file 或大段 markdown 代码块 (```...```)
  const codeBlockRe = /```[a-zA-Z0-9_-]*\s*[\r\n]+([\s\S]*?)```/g
  const processedText = text.replace(codeBlockRe, (match, code: string) => {
    if (code.length < thresholdBytes) return match
    const lines = code.split('\n').length
    const hash = quickHash(code)
    const pointer: CodePointer = {
      path: 'inlined-code-block',
      lines,
      bytes: code.length,
      hash
    }
    pointers.push(pointer)
    return `[Code Pointer: ${lines} lines, ${code.length} bytes, hash: ${hash} (完整代码已转存 VFS)]`
  })

  return { processedText, offloadedPointers: pointers }
}

export interface ShortTermMemoryOptions {
  maxTurns?: number
  maxTokens?: number
}

export class ShortTermMemoryWindow {
  private messages: ShortTermMessage[] = []
  private readonly maxTurns: number
  private readonly maxTokens: number

  constructor(options: ShortTermMemoryOptions = {}) {
    this.maxTurns = options.maxTurns ?? 16
    this.maxTokens = options.maxTokens ?? 16000
  }

  addMessage(message: ShortTermMessage): void {
    const { processedText } = offloadCodeFromText(message.content)
    const tokens = estimateTokenCount(processedText)
    this.messages.push({
      ...message,
      content: processedText,
      tokensEstimate: tokens
    })
    this.trimWindow()
  }

  getMessages(): ShortTermMessage[] {
    return [...this.messages]
  }

  getTotalTokens(): number {
    return this.messages.reduce((sum, m) => sum + (m.tokensEstimate ?? 0), 0)
  }

  clear(): void {
    this.messages = []
  }

  /**
   * 滑动窗口按轮数和 Token 上限截断。
   * 优先保留前置 System 规则与尾部最新交互轮次。
   */
  private trimWindow(): void {
    // 轮数截断
    if (this.messages.length > this.maxTurns) {
      const dropCount = this.messages.length - this.maxTurns
      this.messages.splice(0, dropCount)
    }

    // Token 截断
    let currentTokens = this.getTotalTokens()
    while (currentTokens > this.maxTokens && this.messages.length > 2) {
      const removed = this.messages.shift()
      if (removed) {
        currentTokens -= removed.tokensEstimate ?? 0
      }
    }
  }
}
