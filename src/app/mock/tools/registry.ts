import type { ToolExecutionContext } from './types'
import { createCodeTools } from './code'
import { createEnvTools } from './env'
import { createReviewTools } from './review'
import { createSearchTools } from './search'
import { createCoordinationTools } from './coordination'

export * from './types'
export { applyPatchToString } from './code'

/**
 * 5 大通用能力工具集（12 个通用核心原子工具）。
 */
export function createCoreAgentTools(ctx: ToolExecutionContext) {
  return {
    ...createCodeTools(ctx),
    ...createEnvTools(ctx),
    ...createReviewTools(ctx),
    ...createSearchTools(ctx),
    ...createCoordinationTools(ctx)
  }
}

/**
 * 注入请求头的极简 Tool Manifest 目录说明（每组一句话，总计几十个 Token）。
 */
export const CORE_TOOL_MANIFEST = {
  code: '虚拟文件读写与局部精准 Patch 补丁 (fs_read_file, fs_write_file, fs_patch_file, fs_list_files)',
  env: 'esbuild 内存编译、视口调整与运行时状态透视 (runtime_compile, runtime_set_canvas_size, runtime_inspect_state)',
  inspection: '静态语法检查、控制台错误嗅探与多模态视觉自查 (inspect_static_quality, inspect_visual_render, runtime_console_sniff)',
  search: '代码库全文检索与外部资产库检索 (search_codebase, search_external_registry, fetch_external_asset)',
  coordination: '向用户交互澄清与任务完成交付 (ask_user, finish_task)'
} as const
