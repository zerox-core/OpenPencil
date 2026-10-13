import { tool } from 'ai'
import { valibotSchema } from '@ai-sdk/valibot'
import * as v from 'valibot'

import type { ToolExecutionContext } from './types'

export function createSearchTools(ctx: ToolExecutionContext) {
  return {
    search_codebase: tool({
      description: '在当前项目代码库中全文正则检索关键词（如查找某个 class 类名或变量名在哪些文件使用）。',
      inputSchema: valibotSchema(
        v.object({
          query: v.pipe(v.string(), v.minLength(1))
        })
      ),
      execute: async ({ query }) => {
        if (!ctx.searchCodebase) {
          return { ok: false, error: '搜索功能未配置' }
        }
        const matches = await ctx.searchCodebase(query)
        return { ok: true, query, total: matches.length, matches }
      }
    }),

    search_external_registry: tool({
      description: '统一检索外部资产数据库：设计规范(norms)、技能包(skills)、业务假数据(mock_presets)、跨窗口历史作品(artifacts)。仅返回轻量摘要卡片。',
      inputSchema: valibotSchema(
        v.object({
          type: v.picklist(['norms', 'skills', 'mock_presets', 'artifacts']),
          query: v.pipe(v.string(), v.minLength(1))
        })
      ),
      execute: async ({ type, query }) => {
        if (!ctx.searchExternalRegistry) {
          return { ok: false, error: '外部资产数据库接口未配置' }
        }
        const items = await ctx.searchExternalRegistry(type, query)
        return { ok: true, type, query, items }
      }
    }),

    fetch_external_asset: tool({
      description: '根据 ID 精确拉取特定外部资产详情（如具体 ECharts 图表代码示例、设计规范内容或跨画板借调的组件代码）。',
      inputSchema: valibotSchema(
        v.object({
          type: v.picklist(['norms', 'skills', 'mock_presets', 'artifacts']),
          id: v.pipe(v.string(), v.minLength(1))
        })
      ),
      execute: async ({ type, id }) => {
        if (!ctx.fetchExternalAsset) {
          return { ok: false, error: '外部资产获取接口未配置' }
        }
        const asset = await ctx.fetchExternalAsset(type, id)
        if (!asset) {
          return { ok: false, error: `未找到 ID 为 ${id} 的外部资产` }
        }
        return { ok: true, asset }
      }
    })
  }
}
