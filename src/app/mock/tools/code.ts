import { tool } from 'ai'
import { valibotSchema } from '@ai-sdk/valibot'
import * as v from 'valibot'

import { normalizeProjectPath } from '@/app/mock/project'
import type { ToolExecutionContext } from './types'

/**
 * 在目标文本中执行精确且唯一的代码块替换。
 * 若 search 块不存在或出现多次，返回明确错误以保障安全性。
 */
export function applyPatchToString(
  source: string,
  search: string,
  replace: string
): { ok: true; content: string; occurrences: number } | { ok: false; error: string } {
  if (!search) {
    return { ok: false, error: '搜索替换的 search 目标代码块不能为空' }
  }

  // 尝试直接匹配
  let matchIndex = source.indexOf(search)
  let occurrences = 0

  if (matchIndex !== -1) {
    let pos = matchIndex
    while (pos !== -1) {
      occurrences++
      pos = source.indexOf(search, pos + search.length)
    }
  } else {
    // 换行符容错尝试（统一归一化为 LF 重新比对）
    const normSource = source.replace(/\r\n/g, '\n')
    const normSearch = search.replace(/\r\n/g, '\n')
    matchIndex = normSource.indexOf(normSearch)
    if (matchIndex !== -1) {
      let pos = matchIndex
      while (pos !== -1) {
        occurrences++
        pos = normSource.indexOf(normSearch, pos + normSearch.length)
      }
      if (occurrences === 1) {
        const patched = normSource.slice(0, matchIndex) + replace.replace(/\r\n/g, '\n') + normSource.slice(matchIndex + normSearch.length)
        return { ok: true, content: patched, occurrences: 1 }
      }
    }
  }

  if (occurrences === 0) {
    return { ok: false, error: '未在目标文件中找到与 search 完全一致的代码块，请确认读取的是最新代码' }
  }
  if (occurrences > 1) {
    return { ok: false, error: `search 代码块在文件中出现了 ${occurrences} 次，匹配不具备唯一性，请扩大前后上下文行以确保唯一匹配` }
  }

  const patched = source.slice(0, matchIndex) + replace + source.slice(matchIndex + search.length)
  return { ok: true, content: patched, occurrences: 1 }
}

export function createCodeTools(ctx: ToolExecutionContext) {
  return {
    fs_read_file: tool({
      description: '读取虚拟文件内容，支持分段行号读取以节约上下文 Tokens。',
      inputSchema: valibotSchema(
        v.object({
          path: v.pipe(v.string(), v.minLength(1)),
          lineStart: v.optional(v.pipe(v.number(), v.minValue(1))),
          lineEnd: v.optional(v.pipe(v.number(), v.minValue(1)))
        })
      ),
      execute: async ({ path, lineStart, lineEnd }) => {
        const normalized = normalizeProjectPath(path)
        const content = await ctx.readFile(normalized, { lineStart, lineEnd })
        if (content === null) {
          return { ok: false, error: `文件不存在：${normalized}` }
        }
        return { ok: true, path: normalized, content }
      }
    }),

    fs_write_file: tool({
      description: '全量写入新建或重写虚拟文件。若只需修改局部几行代码，请优先使用 fs_patch_file 以节约性能。',
      inputSchema: valibotSchema(
        v.object({
          path: v.pipe(v.string(), v.minLength(1)),
          content: v.string()
        })
      ),
      execute: async ({ path, content }) => {
        const normalized = normalizeProjectPath(path)
        const result = await ctx.writeFile(normalized, content)
        if (!result.ok) {
          return { ok: false, error: result.error ?? '写入文件失败' }
        }
        return { ok: true, path: normalized, bytes: content.length, version: result.version }
      }
    }),

    fs_patch_file: tool({
      description: '对虚拟文件执行精确代码块替换（Search & Replace），单点改动首选。仅重写改动部分，极大节省 Token 并杜绝整文件截断风险。',
      inputSchema: valibotSchema(
        v.object({
          path: v.pipe(v.string(), v.minLength(1)),
          search: v.pipe(v.string(), v.minLength(1)),
          replace: v.string(),
          expectedVersion: v.optional(v.number())
        })
      ),
      execute: async ({ path, search, replace, expectedVersion }) => {
        const normalized = normalizeProjectPath(path)
        const result = await ctx.patchFile(normalized, search, replace, expectedVersion)
        if (!result.ok) {
          return { ok: false, error: result.error ?? '局部补丁替换失败' }
        }
        return {
          ok: true,
          path: normalized,
          bytesChanged: result.bytesChanged,
          newVersion: result.newVersion
        }
      }
    }),

    fs_list_files: tool({
      description: '列出当前项目虚拟文件系统所有文件、行数与大小摘要。',
      inputSchema: valibotSchema(v.object({})),
      execute: async () => {
        const files = await ctx.listFiles()
        return { ok: true, files }
      }
    })
  }
}
