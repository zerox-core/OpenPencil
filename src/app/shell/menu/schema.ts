import type { EditorCommandId } from '@open-pencil/vue'

export type AppMenuTarget = 'all' | 'browser' | 'native'

export type AppMenuIcon =
  | 'download'
  | 'eye'
  | 'file'
  | 'folder-open'
  | 'layers'
  | 'pencil'
  | 'redo'
  | 'save'
  | 'settings'
  | 'type'
  | 'undo'
  | 'zoom-in'
  | 'zoom-out'

export type AppMenuPaletteLabel =
  | 'exportSelectionAsPNG'
  | 'exportSelectionAsSVG'
  | 'exportSelectionAsPPTX'
  | 'exportSelectionAsFig'

export interface AppMenuPaletteMetadata {
  icon?: AppMenuIcon
  label?: AppMenuPaletteLabel
  description?: string
  keywords?: string[]
}

export type AppMenuHandler = 'editor' | 'shell'

export interface AppMenuActionItem {
  type?: 'item'
  id: string
  label: string
  shortcut?: string
  accelerator?: string
  command?: EditorCommandId
  checkbox?: boolean
  target?: AppMenuTarget
  handler?: AppMenuHandler
  palette?: AppMenuPaletteMetadata
  sub?: AppMenuEntry[]
}

export interface AppMenuSeparatorItem {
  type: 'separator'
  target?: AppMenuTarget
}

export type AppMenuEntry = AppMenuActionItem | AppMenuSeparatorItem

export interface AppMenuGroupSchema {
  label: string
  target?: AppMenuTarget
  paletteIcon?: AppMenuIcon
  items: AppMenuEntry[]
}

export const APP_MENU_SCHEMA = [
  {
    label: '文件',
    paletteIcon: 'file',
    items: [
      { id: 'new', label: '新建', shortcut: 'MOD+N' },
      { id: 'open', label: '打开…', shortcut: 'MOD+O' },
      { id: 'open-recent', label: '最近打开', target: 'native' },
      { id: 'open-storage-workspace', label: '打开存储工作区…', handler: 'shell' },
      { type: 'separator' },
      { id: 'save', label: '保存', shortcut: 'MOD+S' },
      { id: 'save-as', label: '另存为…', shortcut: 'MOD+SHIFT+S' },
      { type: 'separator' },
      {
        id: 'export-selection',
        label: '导出所选',
        palette: { icon: 'download' },
        shortcut: 'MOD+SHIFT+E',
        sub: [
          {
            id: 'export-png',
            label: 'PNG',
            palette: { icon: 'download', label: 'exportSelectionAsPNG' }
          },
          {
            id: 'export-svg',
            label: 'SVG',
            palette: { icon: 'download', label: 'exportSelectionAsSVG' }
          },
          {
            id: 'export-pptx',
            label: 'PPTX',
            palette: { icon: 'download', label: 'exportSelectionAsPPTX' }
          },
          {
            id: 'export-fig',
            label: '.fig',
            palette: { icon: 'download', label: 'exportSelectionAsFig' }
          }
        ]
      },
      { type: 'separator' },
      { id: 'autosave', label: '自动保存', checkbox: true },
      { id: 'close', label: '关闭标签页', shortcut: 'MOD+W' }
    ]
  },
  {
    label: '编辑',
    paletteIcon: 'pencil',
    items: [
      {
        id: 'edit.undo',
        label: '撤销',
        command: 'edit.undo'
      },
      {
        id: 'edit.redo',
        label: '重做',
        command: 'edit.redo'
      },
      { type: 'separator' },
      { id: 'copy', label: '复制', shortcut: 'MOD+C' },
      { id: 'cut', label: '剪切', shortcut: 'MOD+X' },
      { id: 'paste', label: '粘贴', shortcut: 'MOD+V' },
      { id: 'paste-to-replace', label: '粘贴并替换', shortcut: 'MOD+SHIFT+R' },
      {
        id: 'selection.duplicate',
        label: '创建副本',
        command: 'selection.duplicate'
      },
      {
        id: 'selection.delete',
        label: '删除',
        command: 'selection.delete'
      },
      { id: 'selection.rename', label: '重命名所选…', shortcut: 'MOD+R' },
      { type: 'separator' },
      {
        id: 'selection.selectAll',
        label: '全选',
        command: 'selection.selectAll'
      },
      {
        id: 'selection.selectInverse',
        label: '反选',
        command: 'selection.selectInverse'
      }
    ]
  },
  {
    label: '视图',
    paletteIcon: 'eye',
    items: [
      {
        id: 'view.zoom100',
        label: '缩放到 100%',
        command: 'view.zoom100'
      },
      {
        id: 'view.zoomFit',
        label: '缩放以适应',
        command: 'view.zoomFit'
      },
      {
        id: 'view.zoomSelection',
        label: '缩放至所选',
        command: 'view.zoomSelection'
      },
      { id: 'zoom-in', label: '放大', shortcut: 'MOD+=' },
      { id: 'zoom-out', label: '缩小', shortcut: 'MOD+-' },
      { type: 'separator' },
      { id: 'view-split-right', label: '向右拆分' },
      { id: 'view-split-down', label: '向下拆分' },
      { type: 'separator' },
      { id: 'view-rulers', label: '标尺', checkbox: true },
      { id: 'view-multiplayer-cursors', label: '多人光标', checkbox: true },
      { type: 'separator' },
      {
        id: 'theme',
        label: '主题',
        sub: [
          { id: 'theme-light', label: '浅色', checkbox: true, handler: 'shell' },
          { id: 'theme-dark', label: '深色', checkbox: true, handler: 'shell' },
          { id: 'theme-auto', label: '跟随系统', checkbox: true, handler: 'shell' }
        ]
      },
      { id: 'language', label: '语言', target: 'browser' },
      { type: 'separator' },
      {
        id: 'preferences',
        label: '偏好设置',
        sub: [
          {
            id: 'snap-geometry',
            label: '吸附到几何',
            checkbox: true,
            handler: 'shell'
          },
          {
            id: 'snap-objects',
            label: '吸附到对象',
            checkbox: true,
            handler: 'shell'
          },
          {
            id: 'snap-pixel-grid',
            label: '吸附到像素网格',
            checkbox: true,
            handler: 'shell'
          },
          { type: 'separator' },
          {
            id: 'settings',
            label: '设置…',
            shortcut: 'MOD+,',
            accelerator: 'CmdOrCtrl+,',
            handler: 'shell'
          }
        ]
      },
      { type: 'separator' },
      { id: 'toggle-ui', label: '显示/隐藏界面', shortcut: 'MOD+\\' },
      { type: 'separator' },
      { id: 'profiler', label: '性能分析器', checkbox: true, target: 'browser' },
      {
        id: 'dev-tools',
        label: '开发者工具',
        accelerator: 'CmdOrCtrl+Alt+I',
        target: 'native'
      }
    ]
  },
  {
    label: '对象',
    paletteIcon: 'layers',
    items: [
      {
        id: 'selection.group',
        label: '编组所选',
        command: 'selection.group'
      },
      {
        id: 'selection.frameSelection',
        label: '为所选建画框',
        command: 'selection.frameSelection'
      },
      {
        id: 'selection.ungroup',
        label: '取消编组',
        command: 'selection.ungroup'
      },
      { type: 'separator' },
      {
        id: 'selection.toggleMask',
        label: '用作蒙版',
        command: 'selection.toggleMask'
      },
      {
        id: 'selection.toggleVisibility',
        label: '显示/隐藏',
        command: 'selection.toggleVisibility'
      },
      {
        id: 'selection.toggleLock',
        label: '锁定/解锁',
        command: 'selection.toggleLock'
      },
      { type: 'separator' },
      {
        id: 'selection.flipHorizontal',
        label: '水平翻转',
        command: 'selection.flipHorizontal'
      },
      {
        id: 'selection.flipVertical',
        label: '垂直翻转',
        command: 'selection.flipVertical'
      },
      { type: 'separator' },
      {
        id: 'selection.booleanUnion',
        label: '联集',
        command: 'selection.booleanUnion'
      },
      {
        id: 'selection.booleanSubtract',
        label: '减去顶层',
        command: 'selection.booleanSubtract'
      },
      {
        id: 'selection.booleanIntersect',
        label: '交集',
        command: 'selection.booleanIntersect'
      },
      {
        id: 'selection.booleanExclude',
        label: '差集',
        command: 'selection.booleanExclude'
      },
      {
        id: 'selection.flatten',
        label: '拼合',
        command: 'selection.flatten'
      },
      {
        id: 'selection.outlineText',
        label: '文字转轮廓',
        command: 'selection.outlineText'
      },
      {
        id: 'selection.outlineStroke',
        label: '描边转轮廓',
        command: 'selection.outlineStroke'
      },
      { type: 'separator' },
      {
        id: 'selection.createComponent',
        label: '创建组件',
        command: 'selection.createComponent'
      },
      {
        id: 'selection.createComponentSet',
        label: '创建组件集',
        command: 'selection.createComponentSet'
      },
      {
        id: 'selection.createInstance',
        label: '创建实例',
        command: 'selection.createInstance'
      },
      {
        id: 'selection.goToMainComponent',
        label: '转到主组件',
        command: 'selection.goToMainComponent'
      },
      {
        id: 'selection.detachInstance',
        label: '分离实例',
        command: 'selection.detachInstance'
      },
      { type: 'separator' },
      {
        id: 'selection.moveToPage',
        label: '移动到页面',
        command: 'selection.moveToPage',
        target: 'browser'
      },
      {
        id: 'selection.bringForward',
        label: '上移一层',
        command: 'selection.bringForward'
      },
      {
        id: 'selection.bringToFront',
        label: '置于顶层',
        command: 'selection.bringToFront'
      },
      {
        id: 'selection.sendBackward',
        label: '下移一层',
        command: 'selection.sendBackward'
      },
      {
        id: 'selection.sendToBack',
        label: '置于底层',
        command: 'selection.sendToBack'
      }
    ]
  },
  {
    label: '文本',
    paletteIcon: 'type',
    items: [
      { id: 'text.bold', label: '加粗', shortcut: 'MOD+B' },
      { id: 'text.italic', label: '斜体', shortcut: 'MOD+I' },
      { id: 'text.underline', label: '下划线', shortcut: 'MOD+U' }
    ]
  },
  {
    label: '排列',
    paletteIcon: 'layers',
    items: [
      {
        id: 'selection.wrapInAutoLayout',
        label: '包裹为自动布局',
        command: 'selection.wrapInAutoLayout'
      },
      { type: 'separator' },
      { id: 'arrange.align-left', label: '左对齐', shortcut: 'ALT+A' },
      { id: 'arrange.align-center', label: '水平居中', shortcut: 'ALT+H' },
      { id: 'arrange.align-right', label: '右对齐', shortcut: 'ALT+D' },
      { type: 'separator' },
      { id: 'arrange.align-top', label: '顶对齐', shortcut: 'ALT+W' },
      { id: 'arrange.align-middle', label: '垂直居中', shortcut: 'ALT+V' },
      { id: 'arrange.align-bottom', label: '底对齐', shortcut: 'ALT+S' },
      { type: 'separator' },
      {
        id: 'selection.distributeHorizontal',
        label: '水平等间距分布',
        command: 'selection.distributeHorizontal'
      },
      {
        id: 'selection.distributeVertical',
        label: '垂直等间距分布',
        command: 'selection.distributeVertical'
      }
    ]
  }
] satisfies AppMenuGroupSchema[]

/**
 * Custom entries in the macOS application menu.
 *
 * Placement stays in Rust because the OS-predefined items (About, Services, Hide)
 * sit between them. Only the labels and accelerators are shared here.
 */
export const APP_MENU_APP_ITEMS = [
  { id: 'about', label: '关于 OpenPencil' },
  { id: 'check-updates', label: '检查更新…' },
  { id: 'quit', label: '退出 OpenPencil', shortcut: 'MOD+Q' }
] satisfies AppMenuActionItem[]
