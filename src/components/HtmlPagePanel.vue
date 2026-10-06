<script setup lang="ts">
import { generateText } from 'ai'
import { computed, ref } from 'vue'

import { useI18n } from '@open-pencil/vue'

import { createAIModelRuntime } from '@/app/ai/models'
import { saveExportedFile } from '@/app/document/export/files'
import { downloadBlob } from '@/app/document/io/browser'
import AppButton from '@/components/ui/button/AppButton.vue'

const { ai } = useI18n()

const prompt = ref('')
const html = ref('')
const htmlDraft = ref('')
const view = ref<'preview' | 'code'>('preview')
const generating = ref(false)
const exporting = ref(false)
const errorMsg = ref('')

const hasPage = computed(() => html.value.length > 0)

function extractHTML(text: string): string {
  let t = text.trim()
  const fence = t.match(/```(?:html)?\s*([\s\S]*?)```/i)
  if (fence) t = (fence[1] ?? '').trim()
  const lower = t.toLowerCase()
  const doctypeIdx = lower.indexOf('<!doctype')
  const htmlIdx = lower.indexOf('<html')
  const start = doctypeIdx !== -1 ? doctypeIdx : htmlIdx
  if (start > 0) t = t.slice(start)
  else if (start === -1 && !/<[a-z][\s\S]*>/i.test(t)) return ''
  return t
}

async function generate() {
  const text = prompt.value.trim()
  if (!text || generating.value) return
  errorMsg.value = ''
  const runtime = await createAIModelRuntime('design')
  if (!runtime || runtime.kind !== 'direct') {
    errorMsg.value = ai.value.htmlPageNeedModel
    return
  }
  generating.value = true
  try {
    const userContent = hasPage.value
      ? `这是当前页面的完整 HTML 代码：\n\n${html.value}\n\n请按以下要求修改这个页面，并输出修改后的完整 HTML：\n${text}`
      : text
    const result = await generateText({
      model: runtime.model,
      system:
        '你是一名资深前端工程师。根据用户需求生成一个完整、可直接在浏览器打开的单文件 HTML 页面。要求：所有 CSS 写在 style 标签内、所有 JS 写在 script 标签内；可以通过 CDN 引入公共库（如 Tailwind、ECharts）；页面要美观、现代、可交互；默认使用中文文案，除非用户另有要求。只输出 HTML 代码本身，不要输出任何解释，不要使用 Markdown 代码围栏。',
      prompt: userContent,
      maxOutputTokens: 16000
    })
    const extracted = extractHTML(result.text)
    if (!extracted) {
      errorMsg.value = ai.value.htmlPageNoHtml
      return
    }
    html.value = extracted
    htmlDraft.value = extracted
    view.value = 'preview'
    prompt.value = ''
  } catch (error) {
    console.warn('html page generation failed', error)
    errorMsg.value = ai.value.htmlPageFailed
  } finally {
    generating.value = false
  }
}

function applyDraft() {
  html.value = htmlDraft.value
  view.value = 'preview'
}

async function exportHTML() {
  if (!html.value || exporting.value) return
  exporting.value = true
  try {
    await saveExportedFile(
      new TextEncoder().encode(html.value),
      'page.html',
      'HTML',
      '.html',
      'text/html',
      downloadBlob
    )
  } catch (error) {
    console.warn('html page export failed', error)
  } finally {
    exporting.value = false
  }
}

function handlePromptKeydown(event: KeyboardEvent) {
  if (event.code !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void generate()
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-test-id="html-page-panel">
    <div class="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
      <button
        type="button"
        data-test-id="html-page-preview-toggle"
        class="rounded px-2 py-1 text-[11px]"
        :class="view === 'preview' ? 'font-semibold text-surface' : 'text-muted hover:text-surface'"
        @click="view = 'preview'"
      >
        {{ ai.htmlPagePreview }}
      </button>
      <button
        type="button"
        data-test-id="html-page-code-toggle"
        class="rounded px-2 py-1 text-[11px]"
        :class="view === 'code' ? 'font-semibold text-surface' : 'text-muted hover:text-surface'"
        @click="view = 'code'"
      >
        {{ ai.htmlPageCode }}
      </button>
      <div class="flex-1" />
      <AppButton
        v-if="view === 'code' && hasPage"
        size="xs"
        variant="outline"
        data-test-id="html-page-apply"
        @click="applyDraft"
      >
        {{ ai.htmlPageApply }}
      </AppButton>
      <AppButton
        size="xs"
        variant="outline"
        data-test-id="html-page-export"
        :disabled="!hasPage || exporting"
        @click="exportHTML"
      >
        {{ ai.htmlPageExport }}
      </AppButton>
    </div>

    <div class="min-h-0 flex-1">
      <iframe
        v-if="view === 'preview' && hasPage"
        sandbox="allow-scripts"
        :srcdoc="html"
        title="html-page-preview"
        class="size-full border-0 bg-white"
        data-test-id="html-page-preview-frame"
      />
      <div
        v-else-if="view === 'preview'"
        class="flex size-full items-center justify-center p-6 text-center text-xs text-muted"
      >
        {{ ai.htmlPageEmpty }}
      </div>
      <textarea
        v-else
        v-model="htmlDraft"
        class="size-full resize-none bg-transparent p-3 font-mono text-[11px] leading-relaxed text-surface outline-none"
        spellcheck="false"
        data-test-id="html-page-code-editor"
      />
    </div>

    <div class="shrink-0 border-t border-border p-2.5">
      <div
        v-if="generating || errorMsg"
        class="px-1 pb-1.5 text-[11px] leading-tight"
        :class="errorMsg ? 'text-red-400' : 'text-muted'"
        data-test-id="html-page-status"
      >
        <template v-if="errorMsg">{{ errorMsg }}</template>
        <template v-else>{{ ai.htmlPageGenerating }}</template>
      </div>
      <div class="flex items-end gap-2">
        <textarea
          v-model="prompt"
          rows="2"
          :placeholder="hasPage ? ai.htmlPageModifyPlaceholder : ai.htmlPagePlaceholder"
          :disabled="generating"
          class="block min-h-12 w-full resize-none rounded border border-border bg-transparent px-3 py-2 text-xs leading-relaxed text-surface outline-none placeholder:text-muted disabled:opacity-60"
          data-test-id="html-page-prompt"
          @keydown="handlePromptKeydown"
        />
        <AppButton
          size="sm"
          data-test-id="html-page-generate"
          :disabled="generating || !prompt.trim()"
          @click="generate"
        >
          {{ ai.htmlPageGenerate }}
        </AppButton>
      </div>
    </div>
  </div>
</template>
