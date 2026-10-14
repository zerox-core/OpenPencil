import { describe, expect, it } from 'bun:test'

import {
  createDefaultLtmLedger,
  formatLtmSummary,
  mergeLongTermMemory,
  MemoryCompressionEngine,
  offloadCodeFromText,
  ShortTermMemoryWindow
} from '@/app/mock/memory'

describe('Mock Memory: Long-Term Memory Ledger', () => {
  it('merges delta into base LTM ledger without losing existing data', () => {
    const base = createDefaultLtmLedger()
    base.persona_and_constraints.forbidden_redlines = ['禁止使用内联 style 标签']
    base.session_progress_ledger.pending_todo = ['实现商品列表', '对接结算接口']

    const patched = mergeLongTermMemory(base, {
      persona_and_constraints: {
        aesthetic: '科技感暗黑',
        forbidden_redlines: ['严禁大红大绿'],
        strict_requirements: [],
        user_habits: []
      },
      session_progress_ledger: {
        completed_milestones: ['实现商品列表'],
        in_progress: '正在编写结算模块',
        pending_todo: ['实现商品列表', '对接结算接口'],
        unresolved_debts: []
      }
    })

    // 人物雷点自动合并去重
    expect(patched.persona_and_constraints.forbidden_redlines).toContain('禁止使用内联 style 标签')
    expect(patched.persona_and_constraints.forbidden_redlines).toContain('严禁大红大绿')

    // 待办流转：已完成项自动从未完成 todo 中剔除
    expect(patched.session_progress_ledger.completed_milestones).toContain('实现商品列表')
    expect(patched.session_progress_ledger.pending_todo).not.toContain('实现商品列表')
    expect(patched.session_progress_ledger.pending_todo).toContain('对接结算接口')
  })

  it('formats compact LTM summary header correctly', () => {
    const ledger = createDefaultLtmLedger()
    ledger.project_architecture.design_tokens = { primary: '#3b82f6' }
    ledger.session_progress_ledger.in_progress = '登录弹窗'

    const summary = formatLtmSummary(ledger)
    expect(summary).toContain('## 长期状态与画像')
    expect(summary).toContain('primary:#3b82f6')
    expect(summary).toContain('登录弹窗')
  })
})

describe('Mock Memory: Short-Term Memory & Code Offloading', () => {
  it('offloads large code blocks into lightweight pointers', () => {
    const code = 'const x = 1;\n'.repeat(50) // 超过 600 bytes
    const message = `这是生成的代码：\n\`\`\`typescript\n${code}\`\`\`\n请检查`

    const { processedText, offloadedPointers } = offloadCodeFromText(message, 300)
    expect(offloadedPointers).toHaveLength(1)
    expect(processedText).toContain('[Code Pointer:')
    expect(processedText).toContain('(完整代码已转存 VFS)')
    expect(processedText).not.toContain(code)
  })

  it('slides window correctly according to maxTurns and tokens', () => {
    const window = new ShortTermMemoryWindow({ maxTurns: 3, maxTokens: 5000 })
    window.addMessage({ role: 'user', content: 'Turn 1' })
    window.addMessage({ role: 'assistant', content: 'Turn 2' })
    window.addMessage({ role: 'user', content: 'Turn 3' })
    window.addMessage({ role: 'assistant', content: 'Turn 4' })

    const messages = window.getMessages()
    expect(messages).toHaveLength(3)
    expect(messages[0].content).toBe('Turn 2')
    expect(messages[2].content).toBe('Turn 4')
  })
})

describe('Mock Memory: Dual-Watermark Engine', () => {
  it('correctly reports normal, soft, and hard watermark triggers', () => {
    const engine = new MemoryCompressionEngine({
      contextWindowLimit: 10000,
      softWatermarkRatio: 0.8,
      hardWatermarkRatio: 0.95
    })

    expect(engine.checkWatermark(5000)).toBe('normal')
    expect(engine.checkWatermark(8200)).toBe('soft')
    expect(engine.checkWatermark(9600)).toBe('hard')
  })
})
