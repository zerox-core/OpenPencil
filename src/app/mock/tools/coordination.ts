import { tool } from 'ai'
import { valibotSchema } from '@ai-sdk/valibot'
import * as v from 'valibot'

import type { ToolExecutionContext } from './types'

export function createCoordinationTools(ctx: ToolExecutionContext) {
  return {
    ask_user: tool({
      description: '需求澄清与人机协同：当需求存在明显分歧、受众风格不确定时向用户提问。返回 Promise 异步挂起当前步等待答复，流不中断。',
      inputSchema: valibotSchema(
        v.object({
          questions: v.pipe(
            v.array(
              v.object({
                question: v.pipe(v.string(), v.minLength(1)),
                options: v.optional(v.array(v.pipe(v.string(), v.minLength(1))))
              })
            ),
            v.minLength(1),
            v.maxLength(3)
          )
        })
      ),
      execute: async ({ questions }) => {
        if (!ctx.askUser) {
          return { ok: false, error: '当前环境无法向用户提问，请按最佳合理假设继续并说明' }
        }
        const answer = await ctx.askUser(questions)
        return { ok: true, answer }
      }
    }),

    finish_task: tool({
      description: '三重自查（编译通过、无控制台报错、无确信视觉破损）全部达标后调用此工具宣布任务圆满完成，并输出简明的中文成果总结。',
      inputSchema: valibotSchema(
        v.object({
          summary: v.pipe(v.string(), v.minLength(1))
        })
      ),
      execute: async ({ summary }) => {
        if (ctx.finishTask) {
          await ctx.finishTask(summary)
        }
        return { ok: true, summary }
      }
    })
  }
}
