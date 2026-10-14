import { describe, expect, it } from 'bun:test'

import {
  buildConsoleSnifferScript,
  computeIssueSignature,
  createConsoleSniffer,
  injectConsoleSniffer,
  runTripleVerification,
  StagnationCircuitBreaker
} from '@/app/mock/engine'

describe('Mock Engine: Console Sniffer', () => {
  it('generates non-empty sniffer script with marker', () => {
    const script = buildConsoleSnifferScript()
    expect(script).toContain('__openPencilConsoleSniffer')
    expect(script).toContain('__mockConsoleErr')
    expect(script.startsWith('<script>')).toBe(true)
    expect(script.endsWith('</script>')).toBe(true)
  })

  it('injects sniffer into HTML <head> properly without duplication', () => {
    const htmlWithHead = '<!DOCTYPE html><html><head><title>Test</title></head><body>Hello</body></html>'
    const injected = injectConsoleSniffer(htmlWithHead)
    expect(injected).toContain('<head><script>/*__openPencilConsoleSniffer*/')
    expect(injected).toContain('<title>Test</title>')

    // 不重复注入
    const injectedAgain = injectConsoleSniffer(injected)
    expect(injectedAgain).toBe(injected)
  })

  it('collects, deduplicates, and formats console runtime errors', () => {
    const sniffer = createConsoleSniffer()
    expect(sniffer.hasErrors()).toBe(false)

    sniffer.addError({
      level: 'error',
      message: 'Uncaught ReferenceError: foo is not defined',
      filename: 'index.ts',
      lineno: 42,
      colno: 10,
      stack: 'ReferenceError: foo is not defined\n  at index.ts:42:10'
    })

    // 重复添加相同消息与行号应被去重
    sniffer.addError({
      level: 'error',
      message: 'Uncaught ReferenceError: foo is not defined',
      filename: 'index.ts',
      lineno: 42,
      colno: 10
    })

    expect(sniffer.hasErrors()).toBe(true)
    expect(sniffer.getErrors().length).toBe(1)

    const report = sniffer.formatErrorReport()
    expect(report).toContain('运行时控制台捕获到 1 个错误')
    expect(report).toContain('foo is not defined')
    expect(report).toContain('index.ts:42:10')

    sniffer.clear()
    expect(sniffer.hasErrors()).toBe(false)
    expect(sniffer.getErrors().length).toBe(0)
  })
})

describe('Mock Engine: Issue Signatures & Stagnation Circuit Breaker', () => {
  it('computes deterministic sorted signature', () => {
    const sig1 = computeIssueSignature('static_compile', ['Error B', 'Error A'])
    const sig2 = computeIssueSignature('static_compile', ['Error A', 'Error B'])
    expect(sig1).toBe(sig2)
    expect(sig1).toBe('static_compile:Error A||Error B')

    const cleanSig = computeIssueSignature('all_passed', [])
    expect(cleanSig).toBe('all_passed:clean')
  })

  it('triggers circuit breaker when identical errors repeat up to threshold', () => {
    const breaker = new StagnationCircuitBreaker(2)

    const res1 = breaker.record('static_compile:Error A')
    expect(res1.stagnant).toBe(false)
    expect(res1.count).toBe(1)

    // 第二轮相同错误 -> 触发停滞熔断
    const res2 = breaker.record('static_compile:Error A')
    expect(res2.stagnant).toBe(true)
    expect(res2.count).toBe(2)

    // clean 签名重置
    breaker.record('all_passed:clean')
    const res3 = breaker.record('static_compile:Error B')
    expect(res3.stagnant).toBe(false)
    expect(res3.count).toBe(1)
  })
})

describe('Mock Engine: Triple Verification Pipeline', () => {
  it('intercepts runtime error in Stage 2 when console sniffer caught exceptions', async () => {
    const sniffer = createConsoleSniffer()
    sniffer.addError({
      level: 'unhandledrejection',
      message: 'NetworkError: Failed to fetch API',
      lineno: 10
    })

    const files: Record<string, string> = {
      'index.html': '<!DOCTYPE html><html><body><h1>Hello</h1></body></html>'
    }

    const result = await runTripleVerification({
      files,
      sniffer,
      skipVisual: true
    })

    expect(result.passed).toBe(false)
    expect(result.stage).toBe('runtime_console')
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toContain('Failed to fetch API')
  })

  it('intercepts unclosed script tag in Stage 1 static check', async () => {
    const files: Record<string, string> = {
      'index.html': '<!DOCTYPE html><html><head><script>const a = 1;</head><body>Bad</body></html>'
    }

    const result = await runTripleVerification({
      files,
      skipVisual: true
    })

    expect(result.passed).toBe(false)
    expect(result.stage).toBe('static_compile')
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toContain('<script>')
  })

  it('passes all stages when static and runtime are completely clean', async () => {
    const sniffer = createConsoleSniffer()
    const files: Record<string, string> = {
      'index.html': '<!DOCTYPE html><html><body><h1>Clean Page</h1></body></html>'
    }

    const result = await runTripleVerification({
      files,
      sniffer,
      skipVisual: true
    })

    expect(result.passed).toBe(true)
    expect(result.stage).toBe('all_passed')
    expect(result.errors.length).toBe(0)
    expect(result.signature).toBe('all_passed:clean')
  })
})
