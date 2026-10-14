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

const PREVIEW_RUNTIME_MARK = '__openPencilPreviewRuntime'

/**
 * 预览运行时脚本，注入到合成后的预览 HTML：
 * 1. localStorage / sessionStorage 兜底 —— 预览 iframe 是不透明源，直接访问会抛
 *    SecurityError，这里替换成内存实现，游戏存分等逻辑不再报错；
 * 2. 多页跳转拦截 —— srcdoc 预览里相对链接解析不到真实文件，点击项目内 .html
 *    链接改为 postMessage 通知宿主切换预览页；顶层窗口（分享服务打开）不拦截。
 */
function buildPreviewRuntime(files: Record<string, string>): string {
  const pages = Object.keys(files)
    .filter((name) => name.toLowerCase().endsWith('.html'))
    .map((name) => normalizeProjectPath(name))
  const script = [
    `(function(){if(window.parent===window)return;`,
    `try{window.localStorage.getItem('_runtime_probe')}catch(err){`,
    `var mem={};var shim={getItem:function(k){return Object.prototype.hasOwnProperty.call(mem,k)?mem[k]:null},`,
    `setItem:function(k,v){mem[k]=String(v)},removeItem:function(k){delete mem[k]},`,
    `clear:function(){mem={}},key:function(i){var ks=Object.keys(mem);return i<ks.length?ks[i]:null}};`,
    `try{Object.defineProperty(window,'localStorage',{value:shim,configurable:true})}catch(e1){}`,
    `try{Object.defineProperty(window,'sessionStorage',{value:shim,configurable:true})}catch(e2){}}`,
    `function showToast(msg){`,
    `var id='__op_runtime_toast';var el=document.getElementById(id);`,
    `if(!el){el=document.createElement('div');el.id=id;`,
    `el.style.cssText='position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#0f172af0;color:#f8fafc;padding:7px 15px;border-radius:20px;font-size:12px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;box-shadow:0 6px 20px #0000004d;border:1px solid #ffffff26;z-index:2147483647;pointer-events:none;transition:opacity 0.2s,transform 0.2s;opacity:0;';`,
    `document.body.appendChild(el);}`,
    `el.textContent=msg;el.style.opacity='1';el.style.transform='translateX(-50%) translateY(0)';`,
    `clearTimeout(el.__timer);el.__timer=setTimeout(function(){el.style.opacity='0';el.style.transform='translateX(-50%) translateY(-6px)';},2200);`,
    `}`,
    `var pages=${JSON.stringify(pages)};`,
    `document.addEventListener('click',function(ev){`,
    `var t=ev.target;while(t&&t.tagName!=='A')t=t.parentElement;if(!t)return;`,
    `var href=(t.getAttribute('href')||'').trim();if(!href)return;`,
    `if(/^javascript:/i.test(href))return;`,
    `if(href==='#'){ev.preventDefault();return;}`,
    `if(href.charAt(0)==='#'){ev.preventDefault();try{var el=document.querySelector(href);if(el)el.scrollIntoView({behavior:'smooth',block:'start'});}catch(e){}return;}`,
    `if(/^(https?:|\\/\\/)/i.test(href)){ev.preventDefault();showToast('原型预览已拦截外链跳转');return;}`,
    `if(/^(mailto:|tel:|data:)/i.test(href))return;`,
    `var path=href.split('#')[0].split('?')[0].replace(/^[./]+/,'');`,
    `if(pages.indexOf(path)!==-1){ev.preventDefault();parent.postMessage({__openPencilMockNav:path},'*');return;}`,
    `ev.preventDefault();showToast('页面【'+(path||href)+'】尚未创建，原型请在单页内实现交互');`,
    `},true);`,
    `document.addEventListener('submit',function(ev){`,
    `var form=ev.target;if(!form||form.tagName!=='FORM')return;`,
    `var action=(form.getAttribute('action')||'').trim();`,
    `if(!action||action==='#'||!/^(https?:|\\/\\/)/i.test(action)){ev.preventDefault();showToast('表单已在本地提交（原型演示）');}`,
    `},true);`,
    `})();`
  ].join('')
  return `<script>/*${PREVIEW_RUNTIME_MARK}*/${script}${SCRIPT_CLOSE}`
}

function injectPreviewRuntime(html: string, files: Record<string, string>): string {
  if (html.includes(PREVIEW_RUNTIME_MARK)) return html
  const script = buildPreviewRuntime(files)
  const head = /<head\b[^>]*>/i.exec(html)
  if (head) {
    return `${html.slice(0, head.index + head[0].length)}${script}${html.slice(head.index + head[0].length)}`
  }
  return script + html
}

export function composePreview(files: Record<string, string>, entry?: string): string {
  let html: string
  const entryKey = entry === undefined ? '' : normalizeProjectPath(entry)
  if (entryKey !== '' && Object.hasOwn(files, entryKey)) {
    html = files[entryKey]
  } else if (Object.hasOwn(files, 'index.html')) {
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
      // esbuild 产物是 ESM bundle（含 import 语句），内联时必须保留 type="module"。
      const typeAttr = /type=["']module["']/i.test(tag) ? ' type="module"' : ''
      return `<script${typeAttr}>\n${files[key]}\n${SCRIPT_CLOSE}`
    }
  )
  return injectPreviewRuntime(html, files)
}

export function clampProjectSize(value: number): number {
  return Math.min(2560, Math.max(320, Math.round(value)))
}
