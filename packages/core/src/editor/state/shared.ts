import { DEFAULT_SNAPPING_PREFERENCES } from '#core/editor/preferences'
import type { EditorSharedState } from '#core/editor/types'

export function createDefaultEditorSharedState(): EditorSharedState {
  return {
    activeTool: 'SELECT',
    snappingPreferences: { ...DEFAULT_SNAPPING_PREFERENCES },
    remoteCursors: [],
    documentName: '未命名',
    rulerTheme: undefined,
    sceneVersion: 0
  }
}
