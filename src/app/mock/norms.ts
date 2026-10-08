/**
 * Mock 页面设计规范注册表 —— 规划管线的「规范前置」载体：
 * 模型必须先调用 get_design_norms 取回规范（画布 / 栅格 / 间距刻度 /
 * 字号阶梯 / 配色与结构准则），再进入计划与搭建，而不是靠提示词自觉。
 */

export interface MockDesignNorms {
  kind: string
  canvas: { width: number; height: number }
  grid: { columns: number; gutter: number; margin: number }
  spacingScale: number[]
  typeScale: Record<string, number>
  radiusScale: number[]
  colorGuidance: string[]
  structureGuidance: string[]
}

const DESKTOP_WEB: MockDesignNorms = {
  kind: 'desktop-web',
  canvas: { width: 1440, height: 900 },
  grid: { columns: 12, gutter: 24, margin: 80 },
  spacingScale: [4, 8, 12, 16, 24, 32, 48, 64, 96, 128],
  typeScale: { display: 56, h1: 44, h2: 34, h3: 26, lead: 20, body: 16, small: 13 },
  radiusScale: [4, 8, 12, 16, 24],
  colorGuidance: [
    '主色 1 个 + 中性色阶梯（页面背景 / 卡片表面 / 边框 / 正文 / 次要文字），点缀色至多 1 个',
    '正文与背景对比度不低于 4.5:1，默认浅色背景深色文字',
    '避免无目的的渐变与多色堆砌，品牌色优先'
  ],
  structureGuidance: [
    '官网典型语义结构：导航栏 → Hero → 特性/卖点 → 案例或社会证明 → 定价或 CTA → 页脚',
    '每个板块一个语义化 <section>，板块间距取间距刻度大档位（64 / 96 / 128）',
    '内容最大宽度约 1200px 居中，按 12 列栅格排布'
  ]
}

const MOBILE_WEB: MockDesignNorms = {
  kind: 'mobile-web',
  canvas: { width: 390, height: 844 },
  grid: { columns: 4, gutter: 16, margin: 20 },
  spacingScale: [4, 8, 12, 16, 24, 32, 48, 64],
  typeScale: { display: 36, h1: 30, h2: 26, h3: 22, lead: 17, body: 15, small: 12 },
  radiusScale: [4, 8, 12, 16, 24],
  colorGuidance: [
    '主色 1 个 + 中性色阶梯，点缀色至多 1 个',
    '正文与背景对比度不低于 4.5:1',
    '触屏可点区域不小于 44px'
  ],
  structureGuidance: [
    '移动端单列纵向流：导航（可折叠）→ Hero → 卖点 → 证明 → CTA → 页脚',
    '板块间距取 48 / 64 档，左右边距 20px',
    '重要 CTA 在首屏内出现'
  ]
}

const TABLET_WEB: MockDesignNorms = {
  kind: 'tablet-web',
  canvas: { width: 834, height: 1194 },
  grid: { columns: 8, gutter: 20, margin: 40 },
  spacingScale: [4, 8, 12, 16, 24, 32, 48, 64, 96],
  typeScale: { display: 44, h1: 36, h2: 30, h3: 24, lead: 18, body: 16, small: 13 },
  radiusScale: [4, 8, 12, 16, 24],
  colorGuidance: [
    '主色 1 个 + 中性色阶梯，点缀色至多 1 个',
    '正文与背景对比度不低于 4.5:1'
  ],
  structureGuidance: [
    '平板可按 8 列栅格做双栏布局，语义结构同桌面官网',
    '板块间距取 64 / 96 档'
  ]
}

export const MOCK_NORMS_KINDS = ['desktop-web', 'mobile-web', 'tablet-web'] as const

export function getMockDesignNorms(kind?: string): MockDesignNorms {
  if (kind === 'mobile-web') return MOBILE_WEB
  if (kind === 'tablet-web') return TABLET_WEB
  return DESKTOP_WEB
}
