/**
 * TS 项目的应用内编译（esbuild-wasm）：
 * - 惰性初始化：首次编译时才加载 wasm（worker: false 主线程执行，单次百毫秒级）；
 * - 虚拟文件系统插件：相对导入从项目文件表解析（支持省略扩展名与目录 index），
 *   裸导入（npm 包名）改写成 https://esm.sh/ 外链，运行时由浏览器联网加载；
 * - 产物为单个 ESM bundle：预览内联进入口 HTML，check_project 用它做真实编译校验，
 *   取代纯文本括号配平。
 */

import * as esbuild from 'esbuild-wasm'
import esbuildWasmURL from 'esbuild-wasm/esbuild.wasm?url'

import { composePreview } from '@/app/mock/project'

export interface MockCompileResult {
  js: string | null
  errors: string[]
  warnings: string[]
}

let initPromise: Promise<void> | null = null

function ensureEsbuild(): Promise<void> {
  if (!initPromise) {
    const pending = esbuild.initialize({ wasmURL: esbuildWasmURL, worker: false })
    pending.catch(() => {
      // 初始化失败允许下次重试
      if (initPromise === pending) initPromise = null
    })
    initPromise = pending
  }
  return initPromise
}

/** 相对导入解析：以 importer 所在目录为基准，处理 ./  ../  与根路径 /。 */
function resolveRelative(importer: string, spec: string): string {
  const base = importer.includes('/') ? importer.slice(0, importer.lastIndexOf('/')) : ''
  const raw = spec.startsWith('/') ? spec.slice(1) : (base ? `${base}/${spec}` : spec)
  const parts: string[] = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

const EXT_CANDIDATES = ['', '.ts', '.tsx', '.js', '.jsx']

function lookupFile(
  files: Record<string, string>,
  path: string
): { path: string; content: string } | null {
  for (const ext of EXT_CANDIDATES) {
    const candidate = path + ext
    if (Object.hasOwn(files, candidate)) return { path: candidate, content: files[candidate] }
  }
  for (const ext of EXT_CANDIDATES.slice(1)) {
    const candidate = `${path}/index${ext}`
    if (Object.hasOwn(files, candidate)) return { path: candidate, content: files[candidate] }
  }
  return null
}

function loaderFor(path: string): esbuild.Loader {
  if (path.endsWith('.tsx')) return 'tsx'
  if (path.endsWith('.jsx')) return 'jsx'
  if (path.endsWith('.js')) return 'js'
  if (path.endsWith('.json')) return 'json'
  return 'ts'
}

/** 项目文件表 → esbuild 虚拟文件系统插件。 */
function vfsPlugin(files: Record<string, string>, entry: string): esbuild.Plugin {
  return {
    name: 'mock-vfs',
    setup(build) {
      // 显式 URL 导入原样保留（外部加载）
      build.onResolve({ filter: /^https?:\/\// }, (args) => ({ path: args.path, external: true }))
      // 相对 / 根路径导入 → 项目文件表（先注册，优先级高于裸导入规则）
      build.onResolve({ filter: /^[./]/ }, (args) => {
        // stdin 入口的 importer 是空串或 '<stdin>'（按 esbuild 版本而异），一律按入口文件解析
        const importerPath = args.importer === '' || args.importer === '<stdin>' || args.importer === entry ? entry : args.importer
        const resolved = resolveRelative(importerPath, args.path)
        const hit = lookupFile(files, resolved)
        if (!hit) return { path: resolved, namespace: 'vfs-missing' }
        return { path: hit.path, namespace: 'vfs' }
      })
      // 裸导入（npm 包名）→ esm.sh 外链
      build.onResolve({ filter: /^[^./]/ }, (args) => ({
        path: `https://esm.sh/${args.path}`,
        external: true
      }))
      build.onLoad({ filter: /.*/, namespace: 'vfs-missing' }, (args) => ({
        errors: [{ text: `文件不存在：${args.path}` }]
      }))
      // 不允许在 TS 里 import CSS（playbook 已约束）；兜底按空模块处理避免硬失败
      build.onLoad({ filter: /\.css$/, namespace: 'vfs' }, () => ({ contents: '', loader: 'js' }))
      build.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
        const hit = lookupFile(files, args.path)
        if (!hit) return { errors: [{ text: `文件不存在：${args.path}` }] }
        return { contents: hit.content, loader: loaderFor(hit.path) }
      })
    }
  }
}

/** 编译 TS 入口为单个 ESM bundle；失败返回结构化错误（不抛）。 */
export async function compileMockProject(
  files: Record<string, string>,
  entry: string
): Promise<MockCompileResult> {
  if (!Object.hasOwn(files, entry)) {
    return { js: null, errors: [`缺少 TS 入口文件：${entry}`], warnings: [] }
  }
  const entryContent = files[entry]
  try {
    await ensureEsbuild()
  } catch (error) {
    return { js: null, errors: [`esbuild 初始化失败：${String(error)}`], warnings: [] }
  }
  try {
    const result = await esbuild.build({
      stdin: {
        contents: entryContent,
        loader: loaderFor(entry),
        sourcefile: entry,
        resolveDir: '/'
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2020',
      jsx: 'automatic',
      plugins: [vfsPlugin(files, entry)],
      logLevel: 'silent'
    })
    const outputs = result.outputFiles as Array<{ text: string }> | undefined
    const output = outputs?.[0]
    const warnings = result.warnings.map((message) => message.text)
    if (!output) return { js: null, errors: ['编译未产出结果'], warnings }
    return { js: output.text, errors: [], warnings }
  } catch (error) {
    const failure = error as { errors?: Array<{ text: string }> }
    if (Array.isArray(failure.errors) && failure.errors.length > 0) {
      return { js: null, errors: failure.errors.map((message) => message.text), warnings: [] }
    }
    return { js: null, errors: [String(error)], warnings: [] }
  }
}

const TS_ENTRY_CANDIDATES = ['src/main.tsx', 'src/main.ts', 'scripts/main.ts']

/** 预览组装侧的 TS 入口探测（与 mock/kinds.ts 的推断共用候选顺序）。 */
export function pickMockTsEntry(files: Record<string, string>): string | null {
  for (const candidate of TS_ENTRY_CANDIDATES) {
    if (Object.hasOwn(files, candidate)) return candidate
  }
  const any = Object.keys(files).find((name) => /\.tsx?$/.test(name) && !name.endsWith('.d.ts'))
  return any ?? null
}

/**
 * 组装预览 HTML：含 TS 入口时先编译成 ESM bundle，再按原路径替换文件内容，
 * 复用 composePreview 的内联逻辑（<script type="module" src> 会保留 module 属性）。
 * 编译失败时退回未替换的组合（预览仍展示结构，错误由 check_project 呈报）。
 */
export async function composeMockProjectPreview(
  files: Record<string, string>,
  entry?: string
): Promise<string> {
  const tsEntry = pickMockTsEntry(files)
  if (!tsEntry) return composePreview(files, entry)
  const compiled = await compileMockProject(files, tsEntry)
  if (!compiled.js) return composePreview(files, entry)
  return composePreview({ ...files, [tsEntry]: compiled.js }, entry)
}
