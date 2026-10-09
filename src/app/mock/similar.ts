/**
 * 相似设计检索 —— 本地稀疏向量版（TF-IDF + 余弦相似度）：
 * 把每个历史 mock 页面的「需求文本 + 文件名 + 入口源码正文」编码成 TF-IDF 向量，
 * 查询语句在同一向量空间编码后按余弦相似度排序，取代此前的关键词计数打分。
 * 中文按字符二元组、英文按词（简单去复数）分词；零依赖零网络。
 */

import { listMockPages } from './pages'

export interface MockSimilarDesign {
  id: string
  /** 首个用户需求消息（截断），作为这条历史设计的标题。 */
  title: string
  files: string[]
  size: { width: number; height: number }
  /** 查询向量与该页面向量的余弦相似度（0~1）。 */
  score: number
  /** index.html 源码摘录，供模型参考结构设计。 */
  excerpt: string
}

/** 相似度下限：低于它的历史设计视为不相关，不返回。 */
const MIN_SIMILARITY = 0.05

const CJK_RE = /[\u4e00-\u9fff]/
const WORD_RE = /[a-z0-9]/

/** 分词：CJK 连续段切成二元组，英文/数字连续段按词（简单去复数）。 */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()
  let word = ''
  let cjk = ''
  const flushWord = () => {
    if (word.length >= 2) {
      tokens.push(word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)
    }
    word = ''
  }
  const flushCjk = () => {
    if (cjk.length >= 2) {
      for (let index = 0; index < cjk.length - 1; index++) tokens.push(cjk.slice(index, index + 2))
    } else if (cjk.length === 1) {
      tokens.push(cjk)
    }
    cjk = ''
  }
  for (const ch of lower) {
    if (CJK_RE.test(ch)) {
      flushWord()
      cjk += ch
    } else if (WORD_RE.test(ch)) {
      flushCjk()
      word += ch
    } else {
      flushWord()
      flushCjk()
    }
  }
  flushWord()
  flushCjk()
  return tokens
}

/** 剥掉脚本 / 样式 / 标签，取入口源码里的可见文本参与向量。 */
function htmlText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
}

function termCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

/** TF-IDF + 余弦相似度：查询与候选文档同场编码，idf 平滑避免除零。 */
function rankBySimilarity(query: string, documents: string[]): number[] {
  const queryTokens = termCounts(tokenize(query))
  const docTokens = documents.map((doc) => termCounts(tokenize(doc)))
  const corpus = [queryTokens, ...docTokens]
  const docFreq = new Map<string, number>()
  for (const counts of corpus) {
    for (const term of counts.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
  }
  const idf = (term: string) => Math.log((corpus.length + 1) / ((docFreq.get(term) ?? 0) + 1)) + 1
  const vectorOf = (counts: Map<string, number>) => {
    const size = [...counts.values()].reduce((sum, count) => sum + count, 0) || 1
    const vector = new Map<string, number>()
    for (const [term, count] of counts) vector.set(term, (count / size) * idf(term))
    return vector
  }
  const queryVector = vectorOf(queryTokens)
  const queryNorm = Math.sqrt([...queryVector.values()].reduce((sum, weight) => sum + weight * weight, 0))
  if (queryNorm === 0) return docTokens.map(() => 0)
  return docTokens.map((tokens) => {
    const vector = vectorOf(tokens)
    let dot = 0
    let norm = 0
    for (const [term, weight] of vector) {
      norm += weight * weight
      const queryWeight = queryVector.get(term)
      if (queryWeight !== undefined) dot += weight * queryWeight
    }
    if (norm === 0) return 0
    return dot / (Math.sqrt(norm) * queryNorm)
  })
}

export function searchSimilarMockDesigns(
  query: string,
  options: { excludeId?: string | null; limit?: number } = {}
): MockSimilarDesign[] {
  const candidates = listMockPages().filter(({ id }) => !(options.excludeId && id === options.excludeId))
  const promptTextOf = (messages: Array<{ role: string; text: string }>) =>
    messages
      .filter((message) => message.role === 'user')
      .map((message) => message.text)
      .join('\n')
  const documents = candidates.map(({ state }) => {
    const entrySource = state.files['index.html'] ?? state.html
    return [promptTextOf(state.messages), Object.keys(state.files).join(' '), htmlText(entrySource)].join('\n')
  })
  const similarities = rankBySimilarity(query, documents)
  const results: MockSimilarDesign[] = []
  for (let index = 0; index < candidates.length; index++) {
    const score = similarities[index]
    if (score < MIN_SIMILARITY) continue
    const { id, state } = candidates[index]
    const promptText = promptTextOf(state.messages)
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
