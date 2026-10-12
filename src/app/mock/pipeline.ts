/**
 * Mock 页面生成管线 —— 画板流程的显式状态机（五阶段版）：
 *   需求分析（取设计规范 + 搜相似设计 + 声明项目类型）
 *   → 制定计划（按语义结构拆步骤，提交时做确定性校验）
 *   → 布局骨架（index.html 语义结构 + styles/base.css 设计令牌，submit_skeleton 门禁）
 *   → 视觉精修 ⇄ 验证循环（样式 / 动效 / 脚本 / check_project）
 *   → 收尾（finish 受状态机门禁约束，含项目类型必需文件检查）。
 * 工具按阶段动态暴露（PHASE_TOOLS）；文件写入策略与必需文件挂在项目类型
 * 注册表上（kinds.ts），管线对 html / ts-static / spa 三种形态一视同仁。
 */

import { MOCK_PROJECT_KINDS, matchAnyPattern } from '@/app/mock/kinds'
import type { MockProjectKind, MockProjectKindSpec } from '@/app/mock/kinds'

export type MockPipelinePhase = 'analyze' | 'plan' | 'skeleton' | 'refine' | 'done'

export interface MockPlanStep {
  id: string
  title: string
  files: string[]
  status: 'pending' | 'done'
}

export interface MockVerification {
  ok: boolean
  issues: string[]
  /** 本次验证时已写入的文件数，用于判断「最后一次写入后是否重新验证过」。 */
  atFiles: number
}

export interface MockPipelineState {
  phase: MockPipelinePhase
  normsKind: string | null
  similarChecked: boolean
  similarMatches: number
  projectKind: MockProjectKind | null
  plan: MockPlanStep[]
  verifications: MockVerification[]
}

export interface MockPipelineSnapshot {
  phase: MockPipelinePhase
  normsKind: string | null
  similarChecked: boolean
  projectKind: MockProjectKind | null
  plan: Array<{ title: string; status: 'pending' | 'done' }>
}

export function createMockPipeline(): MockPipelineState {
  return {
    phase: 'analyze',
    normsKind: null,
    similarChecked: false,
    similarMatches: 0,
    projectKind: null,
    plan: [],
    verifications: []
  }
}

/** 各阶段对模型暴露的工具集（按阶段动态暴露，省 token 且强制走流程）。 */
export const PHASE_TOOLS: Record<MockPipelinePhase, string[]> = {
  analyze: ['get_design_norms', 'search_similar_designs', 'declare_project_kind'],
  plan: ['plan_steps', 'get_design_norms', 'search_similar_designs'],
  skeleton: ['set_canvas_size', 'write_project_file', 'check_project', 'submit_skeleton'],
  refine: ['set_canvas_size', 'write_project_file', 'mark_step_done', 'check_project', 'finish_project'],
  done: []
}

/** 分析阶段的三个前置（规范 / 相似 / 项目类型）都完成后自动进入计划阶段。 */
export function advancePipeline(state: MockPipelineState): void {
  if (
    state.phase === 'analyze' &&
    state.normsKind !== null &&
    state.similarChecked &&
    state.projectKind !== null
  ) {
    state.phase = 'plan'
  }
}

/** declare_project_kind 的落点：登记项目类型并尝试推进阶段，返回对应形态说明。 */
export function declareProjectKind(state: MockPipelineState, kind: MockProjectKind): MockProjectKindSpec {
  state.projectKind = kind
  advancePipeline(state)
  return MOCK_PROJECT_KINDS[kind]
}

export type SubmitPlanResult = { ok: true; plan: MockPlanStep[] } | { ok: false; error: string }

function collectPlanFiles(steps: Array<{ files?: string[] }>): Set<string> {
  const all = new Set<string>()
  for (const step of steps) {
    for (const file of step.files ?? []) all.add(file)
  }
  return all
}

/** plan_steps 的确定性校验：步数 / 标题 / 从零生成时必需文件覆盖。 */
function planValidationError(
  steps: Array<{ title?: string; files?: string[] }>,
  state: MockPipelineState,
  fresh: boolean
): string | null {
  if (steps.length === 0) return '计划为空：至少提交 2 个步骤'
  if (steps.length > 8) return `计划步骤过多（${steps.length} 个）：合并到 2~8 步`
  if (fresh && steps.length < 2) return '从零生成的计划至少需要 2 个步骤（布局骨架 + 视觉精修）'
  const titles = steps.map((step) => (step.title ?? '').trim())
  if (titles.some((title) => title.length === 0)) return '存在标题为空的计划步骤'
  const seen = new Set<string>()
  for (const title of titles) {
    if (seen.has(title)) return `计划步骤标题重复：「${title}」`
    seen.add(title)
  }
  if (!fresh || state.projectKind === null) return null
  const spec = MOCK_PROJECT_KINDS[state.projectKind]
  const allFiles = collectPlanFiles(steps)
  const missing = spec.requiredFiles.filter((pattern) => ![...allFiles].some((file) => pattern.test(file)))
  if (missing.length > 0) {
    return `计划未覆盖项目类型「${spec.label}」的必需文件（${spec.requiredText}），把缺失文件补进对应步骤的 files`
  }
  return null
}

export function submitPlan(
  state: MockPipelineState,
  steps: Array<{ id?: string; title: string; files?: string[] }>,
  options?: { fresh?: boolean }
): SubmitPlanResult {
  const fresh = options?.fresh ?? true
  const error = planValidationError(steps, state, fresh)
  if (error) return { ok: false, error }
  state.plan = steps.map((step, index) => ({
    id: step.id?.trim() || `step-${index + 1}`,
    title: step.title,
    files: Array.isArray(step.files) ? step.files : [],
    status: 'pending'
  }))
  // 从零生成：先骨架后精修；修改已有项目：跳过骨架直接精修。
  state.phase = fresh ? 'skeleton' : 'refine'
  return { ok: true, plan: state.plan }
}

export function markStepDone(state: MockPipelineState, stepId: string): MockPlanStep | null {
  const step = state.plan.find((item) => item.id === stepId)
  if (!step) return null
  step.status = 'done'
  return step
}

export function recordVerification(
  state: MockPipelineState,
  result: { ok: boolean; issues: string[] },
  filesWritten: number
): void {
  state.verifications.push({ ok: result.ok, issues: result.issues, atFiles: filesWritten })
}

/** write_project_file 的文件策略门禁：按「阶段 × 项目类型」校验路径，返回阻止原因或 null。 */
export function writePolicyError(state: MockPipelineState, path: string): string | null {
  if (state.phase !== 'skeleton' && state.phase !== 'refine') return null
  const spec = state.projectKind === null ? null : MOCK_PROJECT_KINDS[state.projectKind]
  if (!spec) return '还没有声明项目类型：先在需求分析阶段调用 declare_project_kind'
  const normalized = path.replace(/^\/+/, '')
  if (state.phase === 'skeleton') {
    if (matchAnyPattern(normalized, spec.skeletonAllow)) return null
    return `布局骨架阶段只能写这些文件：${spec.skeletonAllowText}`
  }
  if (matchAnyPattern(normalized, spec.refineAllow)) return null
  return `视觉精修阶段只能写这些文件：${spec.refineAllowText}`
}

/** submit_skeleton 的门禁：必需骨架文件齐、语义板块 ≥2、不含内联样式。 */
export function submitSkeletonBlockReason(
  state: MockPipelineState,
  files: Record<string, string>
): string | null {
  const spec = state.projectKind === null ? null : MOCK_PROJECT_KINDS[state.projectKind]
  if (!spec) return '还没有声明项目类型：先调用 declare_project_kind'
  const missing = spec.skeletonRequired.filter((pattern) => !Object.keys(files).some((file) => pattern.test(file)))
  if (missing.length > 0) return `骨架文件不齐：需要 ${spec.skeletonRequiredText}`
  const entry = files['index.html'] ?? ''
  if (!entry.trim()) return 'index.html 为空：先写完整的语义结构骨架（含真实文案）'
  const sectionCount = (entry.match(/<(?:header|nav|main|section|article|aside|footer)\b/gi) ?? []).length
  if (sectionCount < 2) {
    return 'index.html 语义板块不足：骨架至少包含 2 个语义标签（header / nav / main / section / article / aside / footer）'
  }
  if (/<style\b/i.test(entry)) {
    return '布局骨架阶段不写内联样式：index.html 只放语义结构与真实文案，样式放 styles/base.css'
  }
  return null
}

/** finish_project 的状态机门禁：返回阻止原因（中文），可以收尾时返回 null。 */
export function finishBlockReason(
  state: MockPipelineState,
  filesWritten: number,
  files?: Record<string, string>
): string | null {
  if (filesWritten === 0) return '还没有写入任何项目文件，先按视觉精修阶段写文件'
  if (files) {
    const spec = state.projectKind === null ? null : MOCK_PROJECT_KINDS[state.projectKind]
    if (spec) {
      const missing = spec.requiredFiles.filter((pattern) => !Object.keys(files).some((file) => pattern.test(file)))
      if (missing.length > 0) {
        return `项目类型「${spec.label}」的必需文件缺失（${spec.requiredText}），先补齐再收尾`
      }
    }
  }
  const openSteps = state.plan.filter((step) => step.status !== 'done')
  if (openSteps.length > 0) {
    return `计划步骤还未完成：${openSteps.map((step) => `${step.id} ${step.title}`).join('、')}（完成对应文件后调用 mark_step_done）`
  }
  const lastVerify = state.verifications.at(-1)
  if (!lastVerify) return '收尾前先调用 check_project 做一次构建验证'
  if (!lastVerify.ok) {
    return `最近一次 check_project 未通过：${lastVerify.issues.join('；')}，修复后重新验证`
  }
  if (lastVerify.atFiles < filesWritten) {
    return '最近一次验证之后又写入了新文件，需要再跑一次 check_project'
  }
  return null
}

export function pipelineSnapshot(state: MockPipelineState): MockPipelineSnapshot {
  return {
    phase: state.phase,
    normsKind: state.normsKind,
    similarChecked: state.similarChecked,
    projectKind: state.projectKind,
    plan: state.plan.map((step) => ({ title: step.title, status: step.status }))
  }
}

const PHASE_LABELS: Record<MockPipelinePhase, string> = {
  analyze: '需求分析',
  plan: '制定计划',
  skeleton: '布局骨架',
  refine: '视觉精修',
  done: '收尾'
}

/** 每一步注入给模型的管线状态提示 —— 状态机直接对模型说话。 */
export function phaseStatusHint(state: MockPipelineState, filesWritten: number): string {
  const lines: string[] = [`【管线状态】当前阶段：${PHASE_LABELS[state.phase]}`]
  if (state.phase === 'analyze') {
    lines.push(`- 设计规范：${state.normsKind ? `已取（${state.normsKind}）` : '未取，先调用 get_design_norms'}`)
    lines.push(
      `- 相似设计：${state.similarChecked ? `已搜（${state.similarMatches} 个匹配）` : '未搜，调用 search_similar_designs'}`
    )
    lines.push(
      `- 项目类型：${state.projectKind ? `已选（${MOCK_PROJECT_KINDS[state.projectKind].label}）` : '未选，调用 declare_project_kind（html 静态页 / ts-static TS 增强静态页 / spa 框架单页应用）'}`
    )
    lines.push('- 三项都完成后进入制定计划阶段')
  } else if (state.phase === 'plan') {
    lines.push('- 调用 plan_steps 把页面按语义结构拆成 2~8 步（每步注明产出文件；从零生成需覆盖项目类型的必需文件）')
    lines.push('- 从零生成的计划提交后进入布局骨架阶段；修改已有项目的计划提交后直接进入视觉精修阶段')
  } else if (state.phase === 'skeleton') {
    lines.push('- 本阶段只写布局骨架：index.html 完整语义结构（真实文案，不加内联样式）+ styles/base.css 设计令牌与布局基座')
    lines.push(`- 已写入 ${filesWritten} 个文件；骨架完成后调用 submit_skeleton（门禁：index.html 语义板块 ≥2）进入视觉精修阶段`)
  } else if (state.phase === 'refine') {
    const done = state.plan.filter((step) => step.status === 'done').length
    lines.push(`- 计划进度：${done}/${state.plan.length} 步完成；已写入 ${filesWritten} 个文件`)
    const lastVerify = state.verifications.at(-1)
    lines.push(
      `- 构建验证：${lastVerify ? (lastVerify.ok ? '最近一次通过' : `最近一次未通过：${lastVerify.issues.join('；')}`) : '尚未验证，收尾前必须调用 check_project'}`
    )
    lines.push('- 全部步骤完成且验证通过后调用 finish_project 收尾')
  }
  return lines.join('\n')
}
