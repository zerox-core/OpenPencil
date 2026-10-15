import { describe, expect, it } from 'bun:test'

import { parseRouterVerdict } from '@/app/mock/router'

describe('Mock Router: Verdict Parser', () => {
  it('parses valid router JSON verdict correctly', () => {
    const raw = '{"track":"consult","targetFile":null,"confidence":0.95,"reason":"用户询问设计背景"}'
    const verdict = parseRouterVerdict(raw)
    expect(verdict.track).toBe('consult')
    expect(verdict.targetFile).toBeNull()
    expect(verdict.confidence).toBe(0.95)
    expect(verdict.reason).toBe('用户询问设计背景')
  })

  it('parses patch verdict with targetFile', () => {
    const raw = '一些前缀说明 {"track":"patch","targetFile":"styles/main.css","confidence":0.9,"reason":"修改主色调"} 一些后缀'
    const verdict = parseRouterVerdict(raw)
    expect(verdict.track).toBe('patch')
    expect(verdict.targetFile).toBe('styles/main.css')
    expect(verdict.confidence).toBe(0.9)
  })

  it('parses creative verdict correctly', () => {
    const raw = '{"track":"creative","targetFile":null,"confidence":0.98,"reason":"用户要求进行鹈鹕测试与SVG绘制"}'
    const verdict = parseRouterVerdict(raw)
    expect(verdict.track).toBe('creative')
    expect(verdict.targetFile).toBeNull()
    expect(verdict.confidence).toBe(0.98)
  })

  it('falls back to workflow on malformed JSON or unknown track', () => {
    const malformed = '我无法以 JSON 回答'
    const verdict = parseRouterVerdict(malformed)
    expect(verdict.track).toBe('workflow')
    expect(verdict.confidence).toBeLessThanOrEqual(0.5)

    const unknownTrack = '{"track":"super_fast"}'
    const verdict2 = parseRouterVerdict(unknownTrack)
    expect(verdict2.track).toBe('workflow')
  })
})
