/**
 * Mock 页面项目的文本解析与预览组装工具。
 */

const FILE_MARKER_PATTERN = /<!--\s*file:\s*([^>\r\n]+?)\s*-->/g
const SCRIPT_CLOSE = '<\x2fscript>'

export function normalizeProjectPath(target: string): string {
  return target
    .trim()
    .replace(/^\.?\//, '')
    .replace(/\\/g, '/')
}

export function stripFences(text: string): string {
  let t = text.trim()
  const fence = t.match(/```(?:html)?\s*([\s\S]*?)```/i)
  if (fence) t = (fence[1] ?? '').trim()
  return t
}

export function extractHTML(text: string): string {
  const t = stripFences(text)
  const lower = t.toLowerCase()
  const doctypeIdx = lower.indexOf('<!doctype')
  const htmlIdx = lower.indexOf('<html')
  const start = doctypeIdx !== -1 ? doctypeIdx : htmlIdx
  if (start > 0) return t.slice(start)
  if (start === -1 && !/<[a-z][\s\S]*>/i.test(t)) return ''
  return t
}

export function parseProjectFiles(text: string): Record<string, string> {
  const files: Record<string, string> = {}
  const source = stripFences(text)
  const markers = [...source.matchAll(FILE_MARKER_PATTERN)]
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index]
    const path = normalizeProjectPath(marker[1] ?? '')
    if (!path) continue
    const start = marker.index + marker[0].length
    const next = index + 1 < markers.length ? markers[index + 1] : undefined
    const end = next === undefined ? source.length : next.index
    const content = source.slice(start, end).trim()
    if (content) files[path] = content
  }
  return files
}

export function composePreview(files: Record<string, string>): string {
  let html: string
  if (Object.hasOwn(files, 'index.html')) {
    html = files['index.html']
  } else {
    const fallback = Object.keys(files).find((name) => name.endsWith('.html'))
    html = fallback === undefined ? '' : files[fallback]
  }
  if (!html) return ''
  html = html.replace(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi, (tag, href: string) => {
    const key = normalizeProjectPath(href)
    if (!Object.hasOwn(files, key)) return tag
    return `<style>\n${files[key]}\n</style>`
  })
  html = html.replace(
    /<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
    (tag, src: string) => {
      const key = normalizeProjectPath(src)
      if (!Object.hasOwn(files, key)) return tag
      return `<script>\n${files[key]}\n${SCRIPT_CLOSE}`
    }
  )
  return html
}

export function clampProjectSize(value: number): number {
  return Math.min(2560, Math.max(320, Math.round(value)))
}
