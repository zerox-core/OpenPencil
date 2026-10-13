import { describe, expect, it } from 'bun:test'

import { applyPatchToString, createCoreAgentTools } from '@/app/mock/tools/registry'
import type { ToolExecutionContext } from '@/app/mock/tools/types'

describe('Mock Core Tools: Code Patching', () => {
  it('applies a single unique patch successfully', () => {
    const original = `
function render() {
  const color = '#ff0000'
  return color
}
`.trim()

    const result = applyPatchToString(original, "const color = '#ff0000'", "const color = '#0000ff'")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.content).toContain("const color = '#0000ff'")
      expect(result.content).not.toContain("const color = '#ff0000'")
    }
  })

  it('rejects search target when it does not exist', () => {
    const original = 'const a = 1'
    const result = applyPatchToString(original, 'const b = 2', 'const b = 3')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('未在目标文件中找到')
    }
  })

  it('rejects patch when search block appears more than once', () => {
    const original = `
const a = 1
const b = 2
const a = 1
`.trim()
    const result = applyPatchToString(original, 'const a = 1', 'const a = 99')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('匹配不具备唯一性')
    }
  })

  it('tolerates CRLF and LF differences', () => {
    const original = 'first line\r\nsecond line\r\nthird line'
    const search = 'second line\nthird line'
    const replace = 'second line\nupdated third line'
    const result = applyPatchToString(original, search, replace)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.content).toContain('updated third line')
    }
  })
})

describe('Mock Core Tools: Factory & Schemas', () => {
  it('instantiates all 12 core tools with execution context', () => {
    const mockCtx: ToolExecutionContext = {
      readFile: async () => 'sample code',
      writeFile: async () => ({ ok: true, version: 1 }),
      patchFile: async () => ({ ok: true, path: 'main.ts', newVersion: 2 }),
      listFiles: async () => [{ path: 'index.html', size: 100, lines: 10, version: 1 }]
    }

    const tools = createCoreAgentTools(mockCtx)
    expect(Object.keys(tools)).toHaveLength(15)
    expect(tools.fs_read_file).toBeDefined()
    expect(tools.fs_write_file).toBeDefined()
    expect(tools.fs_patch_file).toBeDefined()
    expect(tools.fs_list_files).toBeDefined()
    expect(tools.runtime_compile).toBeDefined()
    expect(tools.runtime_set_canvas_size).toBeDefined()
    expect(tools.runtime_inspect_state).toBeDefined()
    expect(tools.inspect_static_quality).toBeDefined()
    expect(tools.inspect_visual_render).toBeDefined()
    expect(tools.runtime_console_sniff).toBeDefined()
    expect(tools.search_codebase).toBeDefined()
    expect(tools.search_external_registry).toBeDefined()
    expect(tools.fetch_external_asset).toBeDefined()
    expect(tools.ask_user).toBeDefined()
    expect(tools.finish_task).toBeDefined()
  })
})
