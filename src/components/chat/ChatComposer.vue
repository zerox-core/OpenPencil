<script setup lang="ts">
import { useTextareaAutosize } from '@vueuse/core'
import { type ChatStatus } from 'ai'
import { TooltipProvider } from 'reka-ui'
import { computed, ref } from 'vue'

import { useI18n } from '@open-pencil/vue'

import { useVoiceInput } from '@/app/ai/voice/use-voice-input'
import IconButton from '@/components/ui/button/IconButton.vue'
import InputGroup from '@/components/ui/input/InputGroup.vue'
const { status, disabled = false } = defineProps<{ status: ChatStatus; disabled?: boolean }>()
const emit = defineEmits<{
  submit: [text: string]
  stop: []
  settings: []
  paste: [event: ClipboardEvent]
}>()
const { ai } = useI18n()
const textarea = ref<HTMLTextAreaElement>()
const input = ref('')
const { triggerResize } = useTextareaAutosize({ element: textarea, input, maxHeight: 160 })
const { voiceState, voiceError, handleVoiceButton } = useVoiceInput(input, triggerResize)
const isStreaming = computed(() => disabled || status === 'streaming' || status === 'submitted')
function handleInputKeydown(event: KeyboardEvent) {
  if (event.code !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  const target = event.currentTarget
  if (target instanceof HTMLElement) target.closest('form')?.requestSubmit()
}
function handleSubmit(event: Event) {
  event.preventDefault()
  if (isStreaming.value) return
  const text = input.value.trim()
  if (!text) return
  emit('submit', text)
  input.value = ''
  triggerResize()
}
</script>
<template>
  <TooltipProvider>
    <div class="shrink-0 border-t border-border p-2.5">
      <div
        v-if="voiceState !== 'idle' || voiceError"
        class="px-1 pb-1.5 text-[11px] leading-tight"
        :class="voiceError ? 'text-red-400' : 'text-muted'"
        data-test-id="chat-voice-status"
      >
        <template v-if="voiceError">{{ voiceError }}</template>
        <template v-else-if="voiceState === 'recording'">{{ ai.voiceListening }}</template>
        <template v-else-if="voiceState === 'transcribing'">{{ ai.voiceTranscribing }}</template>
        <template v-else>{{ ai.voicePolishing }}</template>
      </div>
      <form @submit="handleSubmit" @paste.stop="emit('paste', $event)">
        <InputGroup :disabled="isStreaming">
          <template v-if="$slots.attachment" #attachment><slot name="attachment" /></template>

          <textarea
            ref="textarea"
            v-model="input"
            data-test-id="chat-input"
            :placeholder="ai.describeChange"
            :disabled="isStreaming"
            rows="2"
            :aria-label="ai.describeChange"
            class="block min-h-12 w-full resize-none overflow-y-auto bg-transparent px-3 pt-2.5 pb-1 text-xs leading-relaxed text-surface outline-none placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60"
            @keydown="handleInputKeydown"
            @copy.stop
            @cut.stop
          />

          <template #leading><slot name="leading" /></template>

          <template #model><slot name="model" /></template>

          <template #actions>
            <IconButton
              :label="voiceState === 'recording' ? ai.stopVoiceInput : ai.voiceInput"
              size="sm"
              data-test-id="chat-voice-button"
              :disabled="isStreaming || voiceState === 'transcribing' || voiceState === 'polishing'"
              :class="
                voiceState === 'recording'
                  ? 'border border-red-500 text-red-500 hover:text-red-500'
                  : ''
              "
              @click="handleVoiceButton"
            >
              <icon-lucide-loader-circle
                v-if="voiceState === 'transcribing' || voiceState === 'polishing'"
                class="size-3.5 animate-spin"
              />
              <icon-lucide-square v-else-if="voiceState === 'recording'" class="size-3" />
              <icon-lucide-mic v-else class="size-3.5" />
            </IconButton>
            <IconButton
              :label="ai.providerSettings"
              size="sm"
              data-test-id="provider-settings-trigger"
              @click="emit('settings')"
            >
              <icon-lucide-settings class="size-3.5" />
            </IconButton>
            <IconButton
              v-if="isStreaming"
              :label="ai.stopGenerating"
              size="sm"
              data-test-id="chat-stop-button"
              class="border border-border"
              @click="emit('stop')"
            >
              <icon-lucide-square class="size-3" />
            </IconButton>
            <IconButton
              v-else
              :label="ai.sendMessage"
              size="sm"
              type="submit"
              data-test-id="chat-send-button"
              class="bg-accent text-white hover:bg-accent/90 hover:text-white"
              :disabled="!input.trim()"
            >
              <icon-lucide-send class="size-3.5" />
            </IconButton>
          </template>
        </InputGroup>
      </form>
    </div>
  </TooltipProvider>
</template>
