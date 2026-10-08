/**
 * Mock 页面生成管线 —— 画板流程的显式状态机：
 *   需求分析（取设计规范 + 搜相似设计）
 *   → 制定计划（按语义结构拆步骤，计划是数据不是聊天文本）
 *   → 搭建 ⇄ 验证循环（写文件 / 标记步骤 / 构建验证）
 *   → 收尾（finish 受状态机门禁约束）。
 * 每个阶段的输入输出都是这里的结构化状态；工具按阶段动态暴露（PHASE_TOOLS），
 * 模型在当前阶段只能看到当前阶段的工具。
 */

export type MockPipelinePhase = 'analyze' | 'plan' | 'build' | 'done'

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
  plan: MockPlanStep[]
  verifications: MockVerification[]
}

export interface MockPipelineSnapshot {
  phase: MockPipelinePhase
  normsKind: string | null
  similarChecked: boolean
  plan: Array<{ title: string; status: 'pending' | 'done' }>
}

export function createMockPipeline(): MockPipelineState {
  return {
    phase: 'analyze',
    normsKind: null,
    similarChecked: false,
    similarMatches: 0,
    plan: [],
    verifications: []
  }
}

/** 各阶段对模型暴露的工具集（按阶段动态暴露，省 token 且强制走流程）。 */
export const PHASE_TOOLS: Record<MockPipelinePhase, string[]> = {
  analyze: ['get_design_norms', 'search_similar_designs'],
  plan: ['plan_steps', 'get_design_norms', 'search_similar_designs'],
  build: ['set_canvas_size', 'write_project_file', 'mark_step_done', 'check_project', 'finish_project'],
  done: []
}

/** 分析阶段的两个前置都完成后自动进入计划阶段。 */
export function advancePipeline(state: MockPipelineState): void {
  if (state.phase === 'analyze' && state.normsKind !== null && state.similarChecked) {
    state.phase = 'plan'
  }
}

export function submitPlan(
  state: MockPipelineState,
  steps: Array<{ id?: string; title: string; files?: string[] }>
): MockPlanStep[] {
  state.plan = steps.map((step, index) => ({
    id: step.id?.trim() || `step-${index + 1}`,
    title: step.title,
    files: Array.isArray(step.files) ? step.files : [],
    status: 'pending'
  }))
  state.phase = 'build'
  return state.plan
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

/** finish_project 的状态机门禁：返回阻止原因（中文），可以收尾时返回 null。 */
export function finishBlockReason(state: MockPipelineState, filesWritten: number): string | null {
  if (filesWritten === 0) return '还没有写入任何项目文件，先按搭建阶段写文件'
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
    plan: state.plan.map((step) => ({ title: step.title, status: step.status }))
  }
}

const PHASE_LABELS: Record<MockPipelinePhase, string> = {
  analyze: '需求分析',
  plan: '制定计划',
  build: '搭建与验证',
  done: '收尾'
}

/** 每一步注入给模型的管线状态提示 —— 状态机直接对模型说话。 */
export function phaseStatusHint(state: MockPipelineState, filesWritten: number): string {
  const lines: string[] = [`【管线状态】当前阶段：${PHASE_LABELS[state.phase]}`]
  if (state.phase === 'analyze') {
    lines.push(`- 设计规范：${state.normsKind ? `已取（${state.normsKind}）` : '未取，先调用 get_design_norms'}`)
    lines.push(`- 相似设计：${state.similarChecked ? `已搜（${state.similarMatches} 个匹配）` : '未搜，调用 search_similar_designs'}`)
    lines.push('- 两项都完成后进入制定计划阶段')
  } else if (state.phase === 'plan') {
    lines.push('- 调用 plan_steps 把页面按语义结构拆成搭建步骤（每步注明产出文件），提交后进入搭建阶段')
  } else if (state.phase === 'build') {
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
