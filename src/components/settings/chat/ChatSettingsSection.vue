<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { useI18n } from '@open-pencil/vue'

import { maxAgentSteps, reasoningDisplay } from '@/app/ai/chat/preferences'
import { AGENT_STEP_LIMIT_MIN, AGENT_STEP_LIMIT_MAX } from '@/app/ai/chat/step-limit'
import {
  refreshVoiceAsrKeyStatus,
  setVoiceAsrKey,
  voiceAsrBaseURL,
  voiceAsrKeyStatus,
  voiceAsrModel
} from '@/app/ai/voice/asr'
import { openToolAccessSettings } from '@/app/automation/tool-access/settings/use'
import SettingsGroup from '@/components/settings/layout/SettingsGroup.vue'
import SettingsRow from '@/components/settings/layout/SettingsRow.vue'
import SettingsSection from '@/components/settings/layout/SettingsSection.vue'
import AppButton from '@/components/ui/button/AppButton.vue'
import AppInput from '@/components/ui/input/AppInput.vue'
import PresetNumberField from '@/components/ui/input/PresetNumberField.vue'
import AppSelect from '@/components/ui/select/AppSelect.vue'

const { ai, settings } = useI18n()
const stepPresets = [25, 50, 100, 200]
const voiceKeyInput = ref('')
const voiceKeySaving = ref(false)

onMounted(() => {
  void refreshVoiceAsrKeyStatus()
})

async function saveVoiceKey() {
  voiceKeySaving.value = true
  try {
    await setVoiceAsrKey(voiceKeyInput.value)
    voiceKeyInput.value = ''
  } finally {
    voiceKeySaving.value = false
  }
}
const limitMessage = computed(() =>
  ai.value.maxAgentStepsRange({ min: AGENT_STEP_LIMIT_MIN, max: AGENT_STEP_LIMIT_MAX })
)
const options = computed(() => [
  { value: 'collapsed' as const, label: ai.value.reasoningCollapsed },
  { value: 'while-thinking' as const, label: ai.value.reasoningWhileThinking },
  { value: 'expanded' as const, label: ai.value.reasoningExpanded }
])
</script>

<template>
  <SettingsSection>
    <template #title>{{ ai.chatSettings }}</template>
    <SettingsGroup>
      <SettingsRow :label="ai.reasoningDisplay" class="max-sm:flex-col max-sm:items-stretch">
        <AppSelect
          v-model="reasoningDisplay"
          :label="ai.reasoningDisplay"
          :options="options"
          :ui="{ trigger: 'w-full sm:w-52' }"
        />
      </SettingsRow>
      <SettingsRow
        :label="ai.maxAgentSteps"
        :description="ai.maxAgentStepsHint"
        class="max-sm:flex-col max-sm:items-stretch"
      >
        <PresetNumberField
          v-model:number="maxAgentSteps"
          :presets="stepPresets"
          :min="AGENT_STEP_LIMIT_MIN"
          :max="AGENT_STEP_LIMIT_MAX"
          :label="ai.maxAgentSteps"
          :custom-label="ai.maxAgentStepsCustom"
          :range-message="limitMessage"
        />
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup>
      <SettingsRow :label="ai.voiceAsrSettings" :description="ai.voiceAsrSettingsHint" />
      <SettingsRow :label="ai.voiceAsrBaseUrl" class="max-sm:flex-col max-sm:items-stretch">
        <AppInput
          v-model="voiceAsrBaseURL"
          :aria-label="ai.voiceAsrBaseUrl"
          class="w-full sm:w-72"
        />
      </SettingsRow>
      <SettingsRow :label="ai.voiceAsrModel" class="max-sm:flex-col max-sm:items-stretch">
        <AppInput v-model="voiceAsrModel" :aria-label="ai.voiceAsrModel" class="w-full sm:w-72" />
      </SettingsRow>
      <SettingsRow
        :label="ai.voiceAsrApiKey"
        :description="
          voiceAsrKeyStatus === 'configured' ? ai.voiceAsrKeyConfigured : ai.voiceAsrKeyNotConfigured
        "
        class="max-sm:flex-col max-sm:items-stretch"
      >
        <div class="flex w-full items-center gap-2 sm:w-auto">
          <AppInput
            v-model="voiceKeyInput"
            type="password"
            :aria-label="ai.voiceAsrApiKey"
            class="w-full sm:w-56"
          />
          <AppButton size="xs" variant="outline" :disabled="voiceKeySaving" @click="saveVoiceKey">
            {{ ai.voiceAsrSaveKey }}
          </AppButton>
        </div>
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup>
      <SettingsRow :label="settings.toolAccess">
        <AppButton size="xs" variant="outline" @click="openToolAccessSettings('ai')">{{
          settings.toolAccess
        }}</AppButton>
      </SettingsRow>
    </SettingsGroup>
  </SettingsSection>
</template>
