/**
 * 相似设计搜索 —— 画板「搜索 → 是否有相似设计 → 参考设计素材源码」的落地：
 * 在本地 mock 页面注册表里按需求关键词检索历史项目，
 * 命中则把源码摘录返回给模型参考（是否参考、是否被用户需求禁止由模型按画板分支判断）。
 */

import { listMockPages } from './pages'

export interface MockSimilarDesign {
  id: string
  /** 首个用户需求消息（截断），作为这条历史设计的标题。 */
  title: string
  files: string[]
  size: { width: number; height: number }
  score: number
  /** index.html 源码摘录，供模型参考结构设计。 */
  excerpt: string
}

const SPLIT_RE = /[\s,，。.、/\\:：;；!！?？"'“”()（）[\]{}<>《》_-]+/

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(SPLIT_RE)
    .filter((term) => term.length >= 2)
}

export function searchSimilarMockDesigns(
  query: string,
  options: { excludeId?: string | null; limit?: number } = {}
): MockSimilarDesign[] {
  const terms = queryTerms(query)
  const results: MockSimilarDesign[] = []
  for (const { id, state } of listMockPages()) {
    if (options.excludeId && id === options.excludeId) continue
    const promptText = state.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.text)
      .join('\n')
    const haystack = `${promptText}\n${Object.keys(state.files).join('\n')}`.toLowerCase()
    let score = 0
    for (const term of terms) {
      if (haystack.includes(term)) score += term.length >= 4 ? 2 : 1
    }
    if (score === 0) continue
    const entrySource = state.files['index.html'] ?? state.html
    results.push({
      id,
      title: (promptText.split('\n')[0] ?? '').slice(0, 60) || id.slice(0, 8),
      files: Object.keys(state.files),
      size: { width: state.width, height: state.height },
      score,
      excerpt: entrySource.slice(0, 800)
    })
  }
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, options.limit ?? 3)
}
