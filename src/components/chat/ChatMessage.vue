<script setup lang="ts">
import { refAutoReset, useClipboard } from '@vueuse/core'
import { isReasoningUIPart, isTextUIPart, isToolUIPart, getToolName } from 'ai'
import type { UIDataTypes, UIMessage, UIMessagePart, UITools } from 'ai'
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from 'reka-ui'
import { computed } from 'vue'

import { useI18n, vTestId, locale } from '@open-pencil/vue'

import { attachmentsForMessage } from '@/app/ai/attachment/presentation/store'
import type { AttachmentPresentation } from '@/app/ai/attachment/presentation/types'
import { reasoningDisplay } from '@/app/ai/chat/preferences'
import { visibleUserMessageText } from '@/app/ai/chat/presentation'
import AttachmentList from '@/components/chat/attachment/AttachmentList.vue'
import ChatMarkdown from '@/components/chat/ChatMarkdown.vue'
import ReasoningBlock from '@/components/chat/ReasoningBlock.vue'
import IconButton from '@/components/ui/button/IconButton.vue'
import { collapsibleContentMotion } from '@/theme/collapsible/collapsible'

import { classifyToolState } from './tool-state'

const {
  message,
  streaming = false,
  presentation
} = defineProps<{
  message: UIMessage
  streaming?: boolean
  presentation?: { text?: string; attachments?: AttachmentPresentation[] }
}>()
const { ai } = useI18n()
const markdownMode = computed(() => (streaming ? 'streaming' : 'static'))
const storedAttachments = attachmentsForMessage(message.id)
const attachments = computed(() => presentation?.attachments ?? storedAttachments.value)
const assistantText = computed(() =>
  message.parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join('')
)
const firstAssistantTextPartIndex = computed(() =>
  message.parts.findIndex((part) => isTextUIPart(part) && part.text.length > 0)
)
const copied = refAutoReset(false, 1500)
const { copy, isSupported: clipboardSupported } = useClipboard()

async function copyResponse(): Promise<void> {
  if (!assistantText.value || !clipboardSupported.value) return
  await copy(assistantText.value)
  copied.value = true
}

type ToolPart = Extract<UIMessagePart<UIDataTypes, UITools>, { toolCallId: string }>

const TOOL_NAME_ZH: Record<string, string> = {
  get_selection: '获取选区',
  select_nodes: '选择节点',
  render: '渲染',
  describe: '描述',
  viewport_get: '获取视口',
  viewport_set: '设置视口',
  viewport_zoom_to_fit: '视口缩放适应',
  get_jsx: '获取 JSX',
  diff_jsx: '对比 JSX',
  diff_show: '显示对比',
  diff_create: '创建对比',
  get_node: '获取节点',
  find_nodes: '查找节点',
  query_nodes: '查询节点',
  get_page_tree: '获取页面树',
  get_current_page: '获取当前页面',
  list_pages: '列出页面',
  create_page: '创建页面',
  switch_page: '切换页面',
  create_shape: '创建形状',
  create_vector: '创建矢量',
  create_component: '创建组件',
  create_instance: '创建实例',
  combine_as_variants: '合并为变体',
  clone_node: '克隆节点',
  update_node: '更新节点',
  delete_node: '删除节点',
  rename_node: '重命名节点',
  reparent_node: '移动节点',
  group_nodes: '编组节点',
  ungroup_node: '取消编组',
  flatten_nodes: '扁平化节点',
  arrange: '排列',
  set_layout: '设置布局',
  set_layout_child: '设置子布局',
  set_fill: '设置填充',
  set_image_fill: '设置图片填充',
  set_stroke: '设置描边',
  set_stroke_align: '设置描边对齐',
  set_effects: '设置效果',
  set_opacity: '设置不透明度',
  set_radius: '设置圆角',
  set_rotation: '设置旋转',
  set_blend: '设置混合模式',
  set_constraints: '设置约束',
  set_locked: '设置锁定',
  set_visible: '设置可见性',
  set_minmax: '设置尺寸范围',
  set_text: '设置文本',
  set_text_properties: '设置文本属性',
  set_text_resize: '设置文本缩放',
  set_font: '设置字体',
  set_font_range: '设置字体范围',
  list_fonts: '列出字体',
  list_available_fonts: '列出可用字体',
  get_font_status: '获取字体状态',
  create_variable: '创建变量',
  set_variable: '设置变量',
  get_variable: '获取变量',
  delete_variable: '删除变量',
  find_variables: '查找变量',
  list_variables: '列出变量',
  bind_variable: '绑定变量',
  unbind_variable: '解绑变量',
  create_collection: '创建集合',
  get_collection: '获取集合',
  list_collections: '列出集合',
  delete_collection: '删除集合',
  export_image: '导出图片',
  export_svg: '导出 SVG',
  export_pdf: '导出 PDF',
  import_svg: '导入 SVG',
  create_slice: '创建切片',
  insert_icon: '插入图标',
  fetch_icons: '获取图标',
  search_icons: '搜索图标',
  insert_library_component: '插入库组件',
  get_components: '获取组件',
  list_libraries: '列出组件库',
  boolean_union: '布尔联集',
  boolean_subtract: '布尔减去',
  boolean_intersect: '布尔交集',
  boolean_exclude: '布尔差集',
  path_set: '设置路径',
  path_move: '移动路径',
  path_scale: '缩放路径',
  analyze_colors: '分析颜色',
  analyze_typography: '分析字体排印',
  analyze_spacing: '分析间距',
  analyze_overlaps: '分析重叠',
  analyze_clusters: '分析聚类',
  design_to_tokens: '设计转令牌',
  design_to_component_map: '设计转组件映射',
  expose_instance_swap: '暴露实例交换',
  batch_update: '批量更新',
  calc: '计算',
  eval: '执行代码',
  stock_photo: '素材照片',
  pexels: 'Pexels 图库',
  unsplash: 'Unsplash 图库'
}

function toolDisplayName(part: ToolPart): string {
  const name = getToolName(part).replace(/^mcp__[^_]+__/, '')
  if (locale.get() === 'zh-CN') {
    const zh = TOOL_NAME_ZH[name]
    if (zh) return zh
  }
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function hasErrorOutput(part: ToolPart): boolean {
  return (
    part.state === 'output-available' &&
    typeof part.output === 'object' &&
    part.output !== null &&
    'error' in part.output
  )
}

function toolState(part: ToolPart): 'pending' | 'done' | 'error' {
  return classifyToolState({
    toolName: getToolName(part),
    state: part.state,
    output: part.output
  })
}

function partKey(part: UIMessagePart<UIDataTypes, UITools>, index: number): string {
  if ('toolCallId' in part) return part.toolCallId
  return `part-${index}`
}
</script>

<template>
  <div
    v-test-id="`chat-message-${message.role}`"
    :class="message.role === 'user' ? 'flex justify-end' : ''"
  >
    <div
      class="min-w-0 space-y-2 select-text"
      :class="message.role === 'user' ? 'max-w-[85%]' : ''"
    >
      <template v-if="message.role === 'assistant'">
        <template v-for="(part, i) in message.parts" :key="partKey(part, i)">
          <!-- Reasoning -->
          <ReasoningBlock
            v-if="isReasoningUIPart(part) && part.text"
            :text="part.text"
            :display="reasoningDisplay"
            :streaming="part.state === 'streaming'"
            :thinking-label="ai.thinking"
            :reasoning-label="ai.reasoning"
          />

          <!-- Tool call -->
          <div v-if="isToolUIPart(part)" class="rounded-lg border border-border bg-canvas p-2">
            <CollapsibleRoot>
              <CollapsibleTrigger
                class="flex w-full items-center gap-2 rounded px-1 py-0.5 hover:bg-hover"
              >
                <div
                  class="flex size-4 items-center justify-center rounded-full"
                  :class="{
                    'bg-accent/20 text-accent': toolState(part) === 'pending',
                    'bg-green-500/20 text-green-400': toolState(part) === 'done',
                    'bg-red-500/20 text-red-400': toolState(part) === 'error'
                  }"
                >
                  <icon-lucide-loader-circle
                    v-if="toolState(part) === 'pending'"
                    class="size-3 animate-spin motion-reduce:animate-none"
                  />
                  <icon-lucide-check v-else-if="toolState(part) === 'done'" class="size-3" />
                  <icon-lucide-triangle-alert v-else class="size-3" />
                </div>
                <span class="text-[11px] text-surface">
                  {{ toolDisplayName(part) }}
                </span>
                <span class="text-[10px] text-muted">
                  {{
                    toolState(part) === 'pending'
                      ? ai.toolRunning
                      : toolState(part) === 'done'
                        ? ai.toolFinished
                        : ai.toolError
                  }}
                </span>
                <icon-lucide-chevron-down
                  v-if="toolState(part) !== 'pending'"
                  class="ml-auto size-3 text-muted transition-transform [[data-state=open]>&]:rotate-180"
                />
              </CollapsibleTrigger>
              <CollapsibleContent
                v-if="toolState(part) !== 'pending'"
                :class="[collapsibleContentMotion, 'text-[10px]']"
              >
                <pre class="mt-1 overflow-x-auto rounded bg-input p-2 text-muted">{{
                  part.state === 'output-error' && part.errorText
                    ? part.errorText
                    : hasErrorOutput(part)
                      ? (part.output as { error: string }).error
                      : JSON.stringify(part.output, null, 2)
                }}</pre>
              </CollapsibleContent>
            </CollapsibleRoot>
          </div>

          <!-- Text -->
          <div
            v-else-if="isTextUIPart(part) && part.text"
            data-test-id="chat-text-bubble"
            class="group/response relative rounded-xl rounded-tl-md bg-hover px-3 py-2 text-xs leading-relaxed text-surface"
          >
            <ChatMarkdown :content="part.text" :mode="markdownMode" />
            <IconButton
              v-if="i === firstAssistantTextPartIndex && assistantText && clipboardSupported"
              :label="copied ? ai.responseCopied : ai.copyResponse"
              size="xs"
              data-slot="chat-copy-response"
              class="absolute right-1 bottom-1 opacity-0 focus-visible:opacity-100 group-hover/response:opacity-100"
              @click="copyResponse"
            >
              <icon-lucide-check v-if="copied" class="size-3 text-green-400" />
              <icon-lucide-copy v-else class="size-3" />
            </IconButton>
          </div>
        </template>
      </template>

      <!-- User message -->
      <template v-else-if="message.role === 'user'">
        <AttachmentList v-if="attachments.length" :attachments="attachments" />
        <div
          data-test-id="chat-text-bubble"
          class="rounded-xl rounded-br-md bg-accent px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-white"
        >
          {{
            presentation?.text ??
            visibleUserMessageText(
              message.id,
              message.parts
                .filter(isTextUIPart)
                .map((p) => p.text)
                .join('')
            )
          }}
        </div>
      </template>
    </div>
  </div>
</template>
