/**
 * 运行时控制台错误嗅探器 (Console Error Sniffer)。
 * 在预览 iframe 内部注入轻量监控垫片，捕获未捕获异常、未处理 Promise 拒绝及 console.error，
 * 并通过 postMessage 上报宿主，作为三重自查防线的第 2 重。
 */

import { IS_BROWSER } from '@/constants'

export const MOCK_CONSOLE_ERROR_TYPE = '__mockConsoleErr'
const SNIFFER_MARK = '__openPencilConsoleSniffer'
const SCRIPT_CLOSE = '<\x2fscript>'

export interface MockConsoleErrorMessage {
  type: typeof MOCK_CONSOLE_ERROR_TYPE
  level: 'error' | 'unhandledrejection'
  message: string
  filename?: string
  lineno?: number
  colno?: number
  stack?: string
  timestamp: number
}

/**
 * 构建内联在预览 HTML 中的错误监控垫片脚本。
 */
export function buildConsoleSnifferScript(): string {
  const code = [
    '(function(){',
    'if(typeof window==="undefined"||window.parent===window)return;',
    `if(window.${SNIFFER_MARK})return;`,
    `window.${SNIFFER_MARK}=true;`,
    'function send(level,msg,file,line,col,stack){',
    'try{',
    `parent.postMessage({type:"${MOCK_CONSOLE_ERROR_TYPE}",level:level,message:String(msg||"Unknown runtime error"),filename:file||"",lineno:line||0,colno:col||0,stack:stack||"",timestamp:Date.now()},"*");`,
    '}catch(e){console.warn("[sniffer postMessage failed]",e);}',
    '}',
    'window.addEventListener("error",function(ev){',
    'send("error",ev.message,ev.filename,ev.lineno,ev.colno,ev.error?ev.error.stack:"");',
    '});',
    'window.addEventListener("unhandledrejection",function(ev){',
    'var reason=ev.reason;',
    'var msg=reason instanceof Error?reason.message:String(reason);',
    'var stack=reason instanceof Error?reason.stack:"";',
    'send("unhandledrejection",msg,"",0,0,stack);',
    '});',
    'var origErr=console.error;',
    'console.error=function(){',
    'origErr.apply(console,arguments);',
    'try{',
    'var args=Array.prototype.slice.call(arguments);',
    'var formatted=args.map(function(a){return typeof a==="object"?JSON.stringify(a):String(a);}).join(" ");',
    'send("error",formatted,"",0,0,"");',
    '}catch(ce){console.warn("[sniffer console.error failed]",ce);}',
    '};',
    '})();'
  ].join('')

  return `<script>/*${SNIFFER_MARK}*/${code}${SCRIPT_CLOSE}`
}

/**
 * 向合成后的预览 HTML 注入运行时监控垫片。
 */
export function injectConsoleSniffer(html: string): string {
  if (html.includes(SNIFFER_MARK)) return html
  const script = buildConsoleSnifferScript()
  const headMatch = /<head\b[^>]*>/i.exec(html)
  if (headMatch) {
    const insertPos = headMatch.index + headMatch[0].length
    return `${html.slice(0, insertPos)}${script}${html.slice(insertPos)}`
  }
  return script + html
}

/**
 * 宿主端控制台错误嗅探器：收集并聚合 iframe 上报的错误日志，提供诊断格式化与自查判定。
 */
export class ConsoleSniffer {
  private errors: MockConsoleErrorMessage[] = []
  private listener: ((event: MessageEvent) => void) | null = null
  private listening = false

  public start(): void {
    if (this.listening || !IS_BROWSER) return

    this.listener = (event: MessageEvent) => {
      const data = event.data as Partial<MockConsoleErrorMessage> | undefined
      if (!data || data.type !== MOCK_CONSOLE_ERROR_TYPE || typeof data.message !== 'string') {
        return
      }

      this.addError({
        level: data.level === 'unhandledrejection' ? 'unhandledrejection' : 'error',
        message: data.message,
        filename: data.filename,
        lineno: data.lineno,
        colno: data.colno,
        stack: data.stack
      })
    }

    window.addEventListener('message', this.listener)
    this.listening = true
  }

  public stop(): void {
    if (!this.listening || !this.listener || !IS_BROWSER) return
    window.removeEventListener('message', this.listener)
    this.listener = null
    this.listening = false
  }

  public addError(entry: Omit<MockConsoleErrorMessage, 'type' | 'timestamp'>): void {
    // 按错误消息和行号去重，防止循环动画或轮询高频抛错刷屏
    const isDuplicate = this.errors.some(
      (item) =>
        item.message === entry.message &&
        item.lineno === entry.lineno &&
        item.level === entry.level
    )
    if (isDuplicate) return

    this.errors.push({
      type: MOCK_CONSOLE_ERROR_TYPE,
      level: entry.level,
      message: entry.message,
      filename: entry.filename,
      lineno: entry.lineno,
      colno: entry.colno,
      stack: entry.stack,
      timestamp: Date.now()
    })
  }

  public getErrors(): readonly MockConsoleErrorMessage[] {
    return this.errors
  }

  public hasErrors(): boolean {
    return this.errors.length > 0
  }

  public clear(): void {
    this.errors = []
  }

  /**
   * 将捕获到的控制台错误格式化为模型可直接消费的反思自纠提示词。
   */
  public formatErrorReport(): string {
    if (this.errors.length === 0) return ''

    const lines: string[] = [
      `## 运行时控制台捕获到 ${this.errors.length} 个错误 (Runtime Console Errors):`
    ]

    for (let index = 0; index < this.errors.length; index++) {
      const err = this.errors[index]
      const loc = err.filename || err.lineno ? ` (at ${err.filename ?? 'unknown'}:${err.lineno ?? 0}:${err.colno ?? 0})` : ''
      lines.push(`${index + 1}. [${err.level}] ${err.message}${loc}`)
      if (err.stack) {
        const topStack = err.stack.split('\n').slice(0, 3).join('\n')
        lines.push(`   \`\`\`text\n   ${topStack.trim()}\n   \`\`\``)
      }
    }

    lines.push('\n请针对上述运行时崩溃定位问题，重点排查：未声明的全局变量、空指针属性访问、不存在的 DOM 节点或失败的异步调用。')
    return lines.join('\n')
  }
}

/**
 * 便捷工厂函数。
 */
export function createConsoleSniffer(): ConsoleSniffer {
  return new ConsoleSniffer()
}
