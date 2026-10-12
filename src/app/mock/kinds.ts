/**
 * Mock 生成管线的项目类型注册表 —— harness 定位是「前端场景 agent」：
 * 产物不限于静态 HTML，模型按需求在三种形态间自动选型（declare_project_kind）。
 * 每种形态挂自己的文件策略（骨架 / 精修阶段分别允许写什么）、必需文件与
 * TS 入口候选；状态机与 check_project 都按这里的数据执行，新增形态只改这张表。
 */

export type MockProjectKind = 'html' | 'ts-static' | 'spa'

export interface MockProjectKindSpec {
  id: MockProjectKind
  label: string
  /** 给模型看的选型依据（一句话）。 */
  summary: string
  /** 骨架阶段允许写入的文件（正则，对规范化路径测试）。 */
  skeletonAllow: RegExp[]
  skeletonAllowText: string
  /** 骨架阶段必须产出的文件。 */
  skeletonRequired: RegExp[]
  skeletonRequiredText: string
  /** 精修阶段允许写入的文件。 */
  refineAllow: RegExp[]
  refineAllowText: string
  /** 收尾前必须存在的文件。 */
  requiredFiles: RegExp[]
  requiredText: string
  /** 是否需要 TS 编译（esbuild-wasm，见 mock/compiler.ts）。 */
  needsCompile: boolean
  /** TS 入口候选（按序探测，兜底任意 .ts/.tsx）。 */
  tsEntries: string[]
  /** declare_project_kind 之后返回给模型的落地规则。 */
  playbook: string
}

const BASE_STYLE_RE = /^styles\/(base|tokens)\.css$/
const SKELETON_ALLOW = [/^index\.html$/, BASE_STYLE_RE]
const SKELETON_ALLOW_TEXT = 'index.html 与 styles/base.css（或 styles/tokens.css）'
const SKELETON_REQUIRED = [/^index\.html$/]

export const MOCK_PROJECT_KINDS: Record<MockProjectKind, MockProjectKindSpec> = {
  html: {
    id: 'html',
    label: '静态页面（HTML/CSS/JS）',
    summary: '纯静态页面：展示型官网 / 落地页 / 移动 H5，逻辑简单、零依赖。大多数需求选它。',
    skeletonAllow: SKELETON_ALLOW,
    skeletonAllowText: SKELETON_ALLOW_TEXT,
    skeletonRequired: SKELETON_REQUIRED,
    skeletonRequiredText: 'index.html',
    refineAllow: [/\.(html|css|js|svg|json|md)$/],
    refineAllowText: '.html / .css / .js / .svg / .json / .md 文件（需要 TS 请改用 ts-static 或 spa 形态）',
    requiredFiles: [/^index\.html$/],
    requiredText: 'index.html',
    needsCompile: false,
    tsEntries: [],
    playbook:
      '落地规则：index.html 为入口；样式写 styles/base.css（设计令牌与布局基座，骨架阶段）与 styles/main.css（视觉精修）；交互脚本写 scripts/main.js；可加 pages/*.html 多页。一律相对路径引用；公开库可用 CDN <script src="https://…"> 引入。'
  },
  'ts-static': {
    id: 'ts-static',
    label: 'TS 增强静态页',
    summary: '静态页面骨架 + TypeScript 交互逻辑：交互复杂、需要类型安全或多文件逻辑组织时用。',
    skeletonAllow: SKELETON_ALLOW,
    skeletonAllowText: SKELETON_ALLOW_TEXT,
    skeletonRequired: SKELETON_REQUIRED,
    skeletonRequiredText: 'index.html',
    refineAllow: [/\.(html|css|js|ts|svg|json|md)$/],
    refineAllowText: '.html / .css / .js / .ts / .svg / .json / .md 文件',
    requiredFiles: [/^index\.html$/, /^scripts\/.+\.ts$/],
    requiredText: 'index.html 与 scripts/ 下的 .ts 入口（如 scripts/main.ts）',
    needsCompile: true,
    tsEntries: ['scripts/main.ts'],
    playbook:
      '落地规则：index.html 为入口，用 <script type="module" src="scripts/main.ts"></script> 引入脚本；逻辑写 scripts/main.ts（可再拆 scripts/*.ts 互相 import）。TS 由应用内 esbuild-wasm 编译后预览与验证；npm 依赖直接 import 包名（编译时自动转 https://esm.sh/ 外链，运行时联网加载）；不要在 TS 里 import CSS，样式一律走 styles/*.css 的 <link>。'
  },
  spa: {
    id: 'spa',
    label: '框架单页应用（SPA）',
    summary: '框架驱动的单页应用：需要 vue / react 等组件框架、视图状态复杂时用。依赖经 esm.sh 加载，需联网。',
    skeletonAllow: SKELETON_ALLOW,
    skeletonAllowText: SKELETON_ALLOW_TEXT,
    skeletonRequired: SKELETON_REQUIRED,
    skeletonRequiredText: 'index.html',
    refineAllow: [/\.(html|css|js|jsx|ts|tsx|svg|json|md)$/],
    refineAllowText: '.html / .css / .js(x) / .ts(x) / .svg / .json / .md 文件',
    requiredFiles: [/^index\.html$/, /^src\/main\.tsx?$/],
    requiredText: 'index.html 与 src/main.ts（或 src/main.tsx）',
    needsCompile: true,
    tsEntries: ['src/main.tsx', 'src/main.ts'],
    playbook:
      '落地规则：index.html 只放挂载点（如 <div id="app"></div>）与 <script type="module" src="src/main.ts"></script>；应用代码写 src/main.ts(x) 与 src/*.ts(x)。框架依赖（vue / react 等）直接 import 包名，运行时经 https://esm.sh/ 加载（需联网）；样式仍走 styles/*.css 的 <link>；不要在 TS 里 import CSS。'
  }
}

/** 路径命中任一正则。 */
export function matchAnyPattern(path: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(path))
}

/** 按形态探测 TS 入口：先看候选路径，再兜底任意 .ts/.tsx（排除声明文件）。 */
export function mockTsEntry(
  files: Record<string, string>,
  spec: MockProjectKindSpec
): string | null {
  for (const candidate of spec.tsEntries) {
    if (Object.hasOwn(files, candidate)) return candidate
  }
  const any = Object.keys(files).find((name) => /\.tsx?$/.test(name) && !name.endsWith('.d.ts'))
  return any ?? null
}

/** 预览侧的轻量形态推断（文件集 → 形态），只用于组装预览，不约束状态机。 */
export function inferMockKindFromFiles(files: Record<string, string>): MockProjectKind {
  if (Object.hasOwn(files, 'src/main.tsx') || Object.hasOwn(files, 'src/main.ts')) return 'spa'
  const hasTs = Object.keys(files).some((name) => /\.tsx?$/.test(name) && !name.endsWith('.d.ts'))
  return hasTs ? 'ts-static' : 'html'
}
