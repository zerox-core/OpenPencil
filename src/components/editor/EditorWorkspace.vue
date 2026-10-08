<script setup lang="ts">
import { SplitterGroup, SplitterPanel, SplitterResizeHandle } from 'reka-ui'
import { tv } from 'tailwind-variants'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { formatShortcut, useI18n, useViewportKind } from '@open-pencil/vue'

import { useEditorStore } from '@/app/editor/active-store'
import { isMockPage } from '@/app/mock/pages'
import { appRuntimeConfig } from '@/app/runtime/config'
import { loadEditorLayout, saveEditorLayout } from '@/app/shell/layout-storage'
import { appMenuShortcut } from '@/app/shell/menu/shortcut'
import { resolvedAppTheme } from '@/app/shell/theme'
import { activeTab } from '@/app/tabs'
import BrandMark from '@/components/brand/BrandMark.vue'
import CanvasSplitRoot from '@/components/canvas/CanvasSplitRoot.vue'
import CollabPanel from '@/components/CollabPanel/CollabPanel.vue'
import EditorCanvas from '@/components/EditorCanvas.vue'
import LayersPanel from '@/components/LayersPanel.vue'
import MobileDrawer from '@/components/MobileDrawer.vue'
import MobileHud from '@/components/MobileHud/MobileHud.vue'
import MockPageWorkspace from '@/components/mock/MockPageWorkspace.vue'
import PropertiesPanel from '@/components/PropertiesPanel.vue'
import Toolbar from '@/components/Toolbar/Toolbar.vue'
import IconButton from '@/components/ui/button/IconButton.vue'
import splitterTheme from '@/theme/splitter'

const showChrome = appRuntimeConfig.showChrome
const store = useEditorStore()
const { editor, ai } = useI18n()
const { isMobile } = useViewportKind()
const initialEditorLayout = loadEditorLayout()
const horizontalSplitterStyles = tv(splitterTheme)({ direction: 'horizontal' })

const mockMode = computed(() => {
  void store.state.sceneVersion
  return isMockPage(store.graph.getNode(store.state.currentPageId))
})

const mockWorkspaceReady = ref(false)
const mockHotLoaded = ref(false)
let mockHotTimer: ReturnType<typeof setTimeout> | null = null

watch(
  mockMode,
  (isMock) => {
    if (mockHotTimer) {
      clearTimeout(mockHotTimer)
      mockHotTimer = null
    }
    if (isMock) {
      mockWorkspaceReady.value = false
      mockHotLoaded.value = false
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          mockWorkspaceReady.value = true
        })
      })
      mockHotTimer = setTimeout(() => {
        mockHotLoaded.value = true
      }, 900)
    } else {
      mockWorkspaceReady.value = false
      mockHotLoaded.value = false
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (mockHotTimer) clearTimeout(mockHotTimer)
})
</script>

<template>
  <SplitterGroup
    v-if="!isMobile && showChrome && store.state.showUI"
    :key="(activeTab?.id ?? '') + ':' + (mockMode ? 'mock' : 'design')"
    direction="horizontal"
    class="flex-1 overflow-hidden"
    @layout="saveEditorLayout"
  >
    <SplitterPanel
      id="layers"
      :default-size="initialEditorLayout[0]"
      :min-size="10"
      :max-size="30"
      class="flex"
    >
      <LayersPanel />
    </SplitterPanel>
    <SplitterResizeHandle
      data-test-id="left-splitter-handle"
      :class="horizontalSplitterStyles.handle()"
    >
      <div :class="horizontalSplitterStyles.divider()" />
    </SplitterResizeHandle>
    <SplitterPanel
      id="canvas"
      :default-size="mockMode ? undefined : initialEditorLayout[1]"
      :min-size="30"
      class="flex"
    >
      <div v-if="mockMode" class="relative flex min-w-0 flex-1">
        <MockPageWorkspace v-if="mockWorkspaceReady" />
        <Transition name="mock-hot-fade">
          <div
            v-if="!mockHotLoaded"
            class="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-[#141518]"
            data-test-id="mock-page-hot-loading"
          >
            <div
              class="mock-hot-logo flex size-10 items-center justify-center rounded-xl border border-white/10 bg-white/5"
            >
              <icon-lucide-layout-template class="size-5 text-accent" />
            </div>
            <div class="h-1 w-40 overflow-hidden rounded-full bg-white/5">
              <div class="mock-hot-bar h-full w-1/3 rounded-full bg-accent"></div>
            </div>
            <p class="text-xs text-muted">{{ ai.mockPageHotLoading }}</p>
          </div>
        </Transition>
      </div>
      <div v-else class="relative flex min-w-0 flex-1">
        <CanvasSplitRoot />
        <Toolbar />
      </div>
    </SplitterPanel>
    <template v-if="!mockMode">
      <SplitterResizeHandle :class="horizontalSplitterStyles.handle()">
        <div :class="horizontalSplitterStyles.divider()" />
      </SplitterResizeHandle>
      <SplitterPanel
        id="properties"
        :default-size="initialEditorLayout[2]"
        :min-size="10"
        :max-size="30"
        class="flex flex-col"
      >
        <div
          class="flex shrink-0 items-center justify-between border-b border-border px-1.5 py-1.5"
        >
          <CollabPanel />
        </div>
        <PropertiesPanel />
      </SplitterPanel>
    </template>
  </SplitterGroup>

  <div
    v-else-if="isMobile && showChrome && store.state.showUI"
    :key="'mobile-' + activeTab?.id"
    class="flex flex-1 overflow-hidden"
  >
    <div class="relative flex min-w-0 flex-1">
      <EditorCanvas />
      <MobileHud />
      <Toolbar />
    </div>
    <MobileDrawer />
  </div>

  <div
    v-else-if="showChrome"
    :key="'collapsed-' + activeTab?.id"
    class="flex flex-1 overflow-hidden"
  >
    <div class="relative flex min-w-0 flex-1">
      <EditorCanvas />
      <div
        v-if="!isMobile"
        class="absolute top-7 left-7 z-10 flex items-center gap-2 rounded-lg border border-border bg-panel px-2 py-1 shadow-sm"
      >
        <BrandMark variant="app-icon" :appearance="resolvedAppTheme" class="size-6" />
        <span data-test-id="editor-document-name" class="text-xs text-surface">{{
          store.state.documentName
        }}</span>
        <IconButton
          :label="editor.showUI({ shortcut: formatShortcut(appMenuShortcut('toggle-ui')) ?? '' })"
          data-test-id="editor-show-ui"
          class="ml-1"
          @click="store.state.showUI = true"
        >
          <icon-lucide-sidebar class="size-3.5" />
        </IconButton>
      </div>
    </div>
  </div>

  <div v-else :key="'bare-' + activeTab?.id" class="flex flex-1 overflow-hidden">
    <div class="relative flex min-w-0 flex-1">
      <EditorCanvas />
    </div>
  </div>
</template>

<style scoped>
.mock-hot-fade-leave-active {
  transition: opacity 0.35s ease;
}

.mock-hot-fade-leave-to {
  opacity: 0;
}

.mock-hot-logo {
  animation: mock-hot-pulse 1.6s ease-in-out infinite;
}

@keyframes mock-hot-pulse {
  0%,
  100% {
    opacity: 0.55;
    transform: scale(0.96);
  }

  50% {
    opacity: 1;
    transform: scale(1);
  }
}

.mock-hot-bar {
  animation: mock-hot-sweep 1.1s ease-in-out infinite;
}

@keyframes mock-hot-sweep {
  0% {
    transform: translateX(-110%);
  }

  100% {
    transform: translateX(330%);
  }
}
</style>
