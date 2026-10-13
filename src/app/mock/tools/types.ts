/**
 * Agent 通用原子工具集的类型定义与接口契约。
 */

export interface VirtualFileMeta {
  path: string
  content: string
  version: number
  updatedAt: number
}

export interface VirtualFileSystem {
  files: Record<string, string>
  versions?: Record<string, number>
}

export interface PatchFileResult {
  ok: boolean
  path: string
  bytesChanged?: number
  newVersion?: number
  error?: string
}

export interface ExternalAssetItem {
  id: string
  type: 'norms' | 'skills' | 'mock_presets' | 'artifacts'
  title: string
  description: string
  tags?: string[]
  content?: string
}

export interface ToolExecutionContext {
  // 1. 代码文件读写能力
  readFile(path: string, options?: { lineStart?: number; lineEnd?: number }): Promise<string | null>
  writeFile(path: string, content: string): Promise<{ ok: boolean; version: number; error?: string }>
  patchFile(path: string, search: string, replace: string, expectedVersion?: number): Promise<PatchFileResult>
  listFiles(): Promise<Array<{ path: string; size: number; lines: number; version: number }>>

  // 2. 运行时与环境能力
  compileProject?(entry?: string): Promise<{ ok: boolean; errors: string[]; warnings: string[] }>
  setCanvasSize?(width: number, height: number): void
  inspectState?(): Record<string, unknown>

  // 3. 审查能力
  inspectStaticQuality?(): Promise<{ ok: boolean; issues: string[] }>
  inspectVisualRender?(): Promise<{ ok: boolean; issues: string[] }>
  getConsoleErrors?(): string[]

  // 4. 搜索与外部资产能力
  searchCodebase?(query: string): Promise<Array<{ path: string; line: number; text: string }>>
  searchExternalRegistry?(type: string, query: string): Promise<ExternalAssetItem[]>
  fetchExternalAsset?(type: string, id: string): Promise<ExternalAssetItem | null>

  // 5. 协调与交互能力
  askUser?(questions: Array<{ question: string; options?: string[] }>): Promise<string>
  finishTask?(summary: string): Promise<void>
}
