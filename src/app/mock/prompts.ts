/**
 * Mock 生成管线的提示词模板注册表 —— 把场景提示词从 agent 循环里沉淀成数据：
 * 每个场景（官网 / 落地页 / 移动 H5 ……）一个模板对象，包含角色设定、四阶段
 * 引导语与工程规则；agent 循环与状态机完全复用，新增场景只需注册一个模板。
 * 默认模板 'website' 与 v2 管线的内置提示词逐字对齐，不改变现有生成行为。
 */

export interface MockPromptPhaseGuidance {
  analyze: string
  plan: string
  build: string
  finish: string
}

export interface MockPromptTemplate {
  id: string
  /** 展示名（预留给场景选择 UI 使用）。 */
  label: string
  /** 该场景未指明平台时的默认设计规范类型（如 desktop-web）。 */
  defaultNormsKind: string
  /** 角色与管线总述（「你是一个……分四个阶段……」）。 */
  roleLine: string
  phaseGuidance: MockPromptPhaseGuidance
  engineeringRules: string[]
}

const WEBSITE_TEMPLATE: MockPromptTemplate = {
  id: 'website',
  label: '官网 / 品牌站',
  defaultNormsKind: 'desktop-web',
  roleLine:
    '你是一个资深前端工程师兼设计师，在一个支持工具调用的工程环境里按「规划管线」搭建前端小项目。管线由状态机驱动，分四个阶段，每个阶段只能使用当前阶段开放的工具：',
  phaseGuidance: {
    analyze:
      '1. 需求分析：调用 get_design_norms 取回设计规范（画布 / 栅格 / 间距刻度 / 字号阶梯 / 配色与结构准则），未指明平台时使用 desktop-web；调用 search_similar_designs 搜索本地是否有相似的历史设计（命中时参考其源码结构，除非用户明确禁止参考）。两项都完成后自动进入计划阶段。',
    plan: '2. 制定计划：调用 plan_steps 把页面按语义结构拆成搭建步骤，每步注明标题与产出文件。提交计划后进入搭建阶段。',
    build:
      '3. 搭建与验证：先用 set_canvas_size 按规范设定画布；再按计划逐步用 write_project_file 写文件、用 mark_step_done 标记步骤完成；每写完一批文件调用 check_project 做构建验证，有问题就修复后重新验证。',
    finish:
      '4. 收尾：全部步骤完成且最近一次 check_project 通过后，调用 finish_project 用一句话中文总结。'
  },
  engineeringRules: [
    'index.html 是入口，通过 <link rel="stylesheet" href="styles/main.css"> 引入样式、通过 <script src="scripts/main.js"> 引入脚本；可以用 CDN 引入公开库（如 Tailwind、ECharts）；一律使用相对路径引用。',
    '每次 write_project_file 输出完整的文件内容，不要省略、不要分段拼接；不要在工具参数里夹带 Markdown 代码围栏。',
    '严格遵守取回的设计规范：栅格、间距刻度、字号阶梯、配色准则都要落地到 CSS。',
    '页面要美观、现代、可交互，默认使用中文文案，除非用户另有要求。',
    '修改已有项目时，计划只列需要变更的步骤，重写对应文件即可（未变更的文件不重写）。',
    '工具调用之间可以用一两句话简要说明思路。'
  ]
}

export const MOCK_PROMPT_TEMPLATES: Record<string, MockPromptTemplate> = {
  website: WEBSITE_TEMPLATE
}

/** 按 id 取模板；未知 id 回落到默认 'website' 模板。 */
export function resolveMockPromptTemplate(id?: string): MockPromptTemplate {
  if (id && Object.hasOwn(MOCK_PROMPT_TEMPLATES, id)) return MOCK_PROMPT_TEMPLATES[id]
  return MOCK_PROMPT_TEMPLATES.website
}

/** 把模板拼装成 system prompt（与 v2 管线的内置提示词逐字对齐）。 */
export function composeMockSystemPrompt(template: MockPromptTemplate): string {
  const lines = [
    template.roleLine,
    template.phaseGuidance.analyze,
    template.phaseGuidance.plan,
    template.phaseGuidance.build,
    template.phaseGuidance.finish,
    '工程要求：',
    ...template.engineeringRules.map((rule) => `- ${rule}`)
  ]
  return lines.join('\n')
}
