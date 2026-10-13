import { tool } from 'ai'
import { valibotSchema } from '@ai-sdk/valibot'
import * as v from 'valibot'

import { clampProjectSize } from '@/app/mock/project'
import type { ToolExecutionContext } from './types'

export function createEnvTools(ctx: ToolExecutionContext) {
  return {
    runtime_compile: tool({
      description: '触发内存 esbuild-wasm 打包，返回编译错误与警告。无需磁盘，快速验证语法和类型。',
      inputSchema: valibotSchema(
        v.object({
          entry: v.optional(v.string())
        })
      ),
      execute: async ({ entry }) => {
        if (!ctx.compileProject) {
          return { ok: true, message: '当前技术形态无需编译打包' }
        }
        const result = await ctx.compileProject(entry)
        return result
      }
    }),

    runtime_set_canvas_size: tool({
      description: '动态设置画布与预览视口物理分辨率（如移动端 375×812，桌面端 1440×900）。',
      inputSchema: valibotSchema(
        v.object({
          width: v.pipe(v.number(), v.minValue(120), v.maxValue(2560)),
          height: v.pipe(v.number(), v.minValue(120), v.maxValue(2560))
        })
      ),
      execute: async ({ width, height }) => {
        const w = clampProjectSize(width)
        const h = clampProjectSize(height)
        ctx.setCanvasSize?.(w, h)
        return { ok: true, width: w, height: h }
      }
    }),

    runtime_inspect_state: tool({
      description: '获取当前运行时技术形态、当前视口尺寸、依赖项与运行时全局信息。',
      inputSchema: valibotSchema(v.object({})),
      execute: async () => {
        const state = ctx.inspectState?.() ?? {}
        return { ok: true, state }
      }
    })
  }
}
