/**
 * 长期记忆结构化账本模型与状态覆写引擎。
 * 杜绝传统自然语言摘要的“传话筒失真”，采用结构化键值表做状态合并。
 */

export interface PersonaConstraints {
  aesthetic: string
  forbidden_redlines: string[]
  strict_requirements: string[]
  user_habits: string[]
}

export interface ProjectArchitecture {
  project_kind: 'html' | 'ts-static' | 'spa'
  entry_point: string
  design_tokens: Record<string, string>
  file_responsibilities: Record<string, string>
  decision_log: string[]
}

export interface SessionProgressLedger {
  completed_milestones: string[]
  in_progress: string
  pending_todo: string[]
  unresolved_debts: string[]
}

export interface LongTermMemoryLedger {
  persona_and_constraints: PersonaConstraints
  project_architecture: ProjectArchitecture
  session_progress_ledger: SessionProgressLedger
}

export function createDefaultLtmLedger(): LongTermMemoryLedger {
  return {
    persona_and_constraints: {
      aesthetic: '现代简洁风格，层级清晰，间距呼吸感良好',
      forbidden_redlines: ['禁止使用内联 style 标签', '禁止使用无意义 Lorem Ipsum 占位'],
      strict_requirements: ['必须使用中文回答与注释', '单文件行数需保持紧凑规范'],
      user_habits: ['有架构分歧先澄清提问', '代码修改优先采用精准补丁']
    },
    project_architecture: {
      project_kind: 'html',
      entry_point: 'index.html',
      design_tokens: {},
      file_responsibilities: {},
      decision_log: []
    },
    session_progress_ledger: {
      completed_milestones: [],
      in_progress: '',
      pending_todo: [],
      unresolved_debts: []
    }
  }
}

/** 数组去重合并辅助函数 */
function mergeUniqueArrays(base: string[], additions?: string[]): string[] {
  if (!additions || additions.length === 0) return [...base]
  const set = new Set(base)
  for (const item of additions) {
    const trimmed = item.trim()
    if (trimmed) set.add(trimmed)
  }
  return [...set]
}

function mergePersonaConstraints(
  base: PersonaConstraints,
  patch?: Partial<PersonaConstraints>
): PersonaConstraints {
  return {
    aesthetic: patch?.aesthetic || base.aesthetic,
    forbidden_redlines: mergeUniqueArrays(base.forbidden_redlines, patch?.forbidden_redlines),
    strict_requirements: mergeUniqueArrays(base.strict_requirements, patch?.strict_requirements),
    user_habits: mergeUniqueArrays(base.user_habits, patch?.user_habits)
  }
}

function mergeProjectArchitecture(
  base: ProjectArchitecture,
  patch?: Partial<ProjectArchitecture>
): ProjectArchitecture {
  return {
    project_kind: patch?.project_kind ?? base.project_kind,
    entry_point: patch?.entry_point ?? base.entry_point,
    design_tokens: {
      ...base.design_tokens,
      ...patch?.design_tokens
    },
    file_responsibilities: {
      ...base.file_responsibilities,
      ...patch?.file_responsibilities
    },
    decision_log: mergeUniqueArrays(base.decision_log, patch?.decision_log)
  }
}

function mergeSessionProgress(
  base: SessionProgressLedger,
  patch?: Partial<SessionProgressLedger>
): SessionProgressLedger {
  const merged: SessionProgressLedger = {
    completed_milestones: mergeUniqueArrays(
      base.completed_milestones,
      patch?.completed_milestones
    ),
    in_progress: patch?.in_progress !== undefined ? patch.in_progress : base.in_progress,
    pending_todo: patch?.pending_todo ? [...patch.pending_todo] : [...base.pending_todo],
    unresolved_debts: mergeUniqueArrays(base.unresolved_debts, patch?.unresolved_debts)
  }

  // 待办流转：若某项已被记录为已完成，则从未完成 todo 中剔除
  if (merged.completed_milestones.length > 0) {
    const completedSet = new Set(merged.completed_milestones)
    merged.pending_todo = merged.pending_todo.filter((todo) => !completedSet.has(todo))
  }

  return merged
}

/**
 * 结构化状态覆写：将增量蒸馏得到的状态合并入长期记忆账本。
 */
export function mergeLongTermMemory(
  base: LongTermMemoryLedger,
  patch: Partial<LongTermMemoryLedger>
): LongTermMemoryLedger {
  return {
    persona_and_constraints: mergePersonaConstraints(
      base.persona_and_constraints,
      patch.persona_and_constraints
    ),
    project_architecture: mergeProjectArchitecture(
      base.project_architecture,
      patch.project_architecture
    ),
    session_progress_ledger: mergeSessionProgress(
      base.session_progress_ledger,
      patch.session_progress_ledger
    )
  }
}

/**
 * 格式化为注入请求头的极简长期记忆摘要（~150 Tokens）。
 */
export function formatLtmSummary(ledger: LongTermMemoryLedger): string {
  const lines: string[] = ['## 长期状态与画像 (LTM Summary)']

  // 人物层
  const persona = ledger.persona_and_constraints
  lines.push(`- 风格与习惯: ${persona.aesthetic}; ${persona.user_habits.slice(0, 2).join('; ')}`)
  if (persona.forbidden_redlines.length > 0) {
    lines.push(`- 严令雷点: ${persona.forbidden_redlines.join('; ')}`)
  }

  // 架构层
  const arch = ledger.project_architecture
  const tokens = Object.entries(arch.design_tokens)
    .map(([k, v]) => `${k}:${v}`)
    .slice(0, 4)
    .join(' ')
  lines.push(`- 架构决策: ${arch.project_kind} (入口: ${arch.entry_point})${tokens ? ` [Tokens: ${tokens}]` : ''}`)

  // 进度层
  const prog = ledger.session_progress_ledger
  const done = prog.completed_milestones.slice(-2).join('、')
  const pending = prog.pending_todo.slice(0, 3).join('、')
  lines.push(`- 任务账本: [已完成] ${done || '无'} | [进行中] ${prog.in_progress || '推进中'} | [待办] ${pending || '无'}`)

  return lines.join('\n')
}
