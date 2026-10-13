import { tool } from 'ai'
import { valibotSchema } from '@ai-sdk/valibot'
import * as v from 'valibot'

import type { ToolExecutionContext } from './types'

export function createReviewTools(ctx: ToolExecutionContext) {
  return {
    inspect_static_quality: tool({
      description: '静态确定性检查：校验入口文件存在性、相对引用链接完整性（防404）、CSS花括号闭合平衡等。',
      inputSchema: valibotSchema(v.object({})),
      execute: async () => {
        if (!ctx.inspectStaticQuality) {
          return { ok: true, issues: [] }
        }
        const result = await ctx.inspectStaticQuality()
        return result
      }
    }),

    inspect_visual_render: tool({
      description: '主动触发后台无脚本副本帧渲染并执行多模态 Vision 评审，排查文字溢出截断、重叠和布局崩塌。',
      inputSchema: valibotSchema(v.object({})),
      execute: async () => {
        if (!ctx.inspectVisualRender) {
          return { ok: true, issues: [] }
        }
        const result = await ctx.inspectVisualRender()
        return result
      }
    }),

    runtime_console_sniff: tool({
      description: '嗅探页面在预览 iframe 中执行时捕获到的控制台错误（未捕获异常、未处理 Promise 拒绝、类型错误）。',
      inputSchema: valibotSchema(v.object({})),
      execute: async () => {
        const errors = ctx.getConsoleErrors?.() ?? []
        return {
          ok: errors.length === 0,
          errors,
          message: errors.length === 0 ? '控制台未检测到运行时报错' : `检测到 ${errors.length} 个运行时错误，请排查修复`
        }
      }
    })
  }
}
