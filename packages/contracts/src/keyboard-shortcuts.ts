export const SHORTCUT_IDS = [
  'newChat',
  'searchSessions',
  'openSettings',
  'openShortcutHelp',
  'focusComposer',
  'toggleSidebar',
  'toggleTools',
  'pauseTask',
  'togglePlanMode',
  'openModelPicker',
  'openFiles',
  'openTerminal',
] as const

export type ShortcutId = (typeof SHORTCUT_IDS)[number]

export type ShortcutPlatform = 'darwin' | 'win32' | 'linux'
export type ShortcutEnvironment = 'desktop' | 'web'

export type ShortcutGroup = 'chat' | 'navigation' | 'workspace' | 'editing'

export type ShortcutPreferences = {
  version: 1
  overrides: Partial<Record<ShortcutId, string | null>>
}

export type ShortcutDefinition = {
  id: ShortcutId
  group: ShortcutGroup
  defaultBinding: string
  webDefaultBinding?: string
}

export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  { id: 'newChat', group: 'chat', defaultBinding: 'Mod+N', webDefaultBinding: 'Mod+Alt+N' },
  { id: 'searchSessions', group: 'navigation', defaultBinding: 'Mod+K' },
  { id: 'openSettings', group: 'navigation', defaultBinding: 'Mod+Comma' },
  { id: 'openShortcutHelp', group: 'navigation', defaultBinding: 'Mod+Slash' },
  { id: 'focusComposer', group: 'chat', defaultBinding: 'Mod+Shift+L' },
  { id: 'toggleSidebar', group: 'workspace', defaultBinding: 'Mod+B' },
  { id: 'toggleTools', group: 'workspace', defaultBinding: 'Mod+J', webDefaultBinding: 'Mod+Alt+Shift+J' },
  { id: 'pauseTask', group: 'chat', defaultBinding: 'Mod+Period' },
  { id: 'togglePlanMode', group: 'chat', defaultBinding: 'Mod+Alt+P' },
  { id: 'openModelPicker', group: 'chat', defaultBinding: 'Mod+Alt+Shift+M' },
  { id: 'openFiles', group: 'workspace', defaultBinding: 'Mod+Shift+E' },
  { id: 'openTerminal', group: 'workspace', defaultBinding: 'Mod+Alt+T' },
] as const

export const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const
const MODIFIERS = new Set<string>(MODIFIER_ORDER)

const NAMED_KEYS: Record<string, string> = {
  comma: 'Comma',
  ',': 'Comma',
  period: 'Period',
  '.': 'Period',
  slash: 'Slash',
  '/': 'Slash',
  backslash: 'Backslash',
  '\\': 'Backslash',
  bracketleft: 'BracketLeft',
  '[': 'BracketLeft',
  bracketright: 'BracketRight',
  ']': 'BracketRight',
  semicolon: 'Semicolon',
  ';': 'Semicolon',
  quote: 'Quote',
  "'": 'Quote',
  backquote: 'Backquote',
  '`': 'Backquote',
  minus: 'Minus',
  '-': 'Minus',
  equal: 'Equal',
  '=': 'Equal',
  space: 'Space',
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
}

export type KeyboardEventLike = {
  key: string
  code?: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

export function defaultKeybinding(shortcut: ShortcutDefinition, environment: ShortcutEnvironment = 'desktop'): string {
  return environment === 'web' && shortcut.webDefaultBinding ? shortcut.webDefaultBinding : shortcut.defaultBinding
}

export function normalizeKey(key: string): string | null {
  const trimmed = key.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (lower in NAMED_KEYS) return NAMED_KEYS[lower]
  if (/^[a-z0-9]$/i.test(trimmed)) return trimmed.toUpperCase()
  if (/^f(?:[1-9]|1[0-2])$/i.test(trimmed)) return trimmed.toUpperCase()
  return null
}

export function normalizeKeybinding(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parts = value
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const keyPart = parts.at(-1) ?? ''
  const key = normalizeKey(keyPart)
  if (!key) return null
  const modifierParts = parts.slice(0, -1)
  const modifiers = new Set<string>()
  for (const mod of modifierParts) {
    const formatted = mod.charAt(0).toUpperCase() + mod.slice(1).toLowerCase()
    const canon = formatted === 'Meta' || formatted === 'Cmd' || formatted === 'Command' ? 'Mod' : formatted
    if (!MODIFIERS.has(canon)) return null
    modifiers.add(canon)
  }
  return [...MODIFIER_ORDER.filter((m) => modifiers.has(m)), key].join('+')
}

export function isAllowedKeybinding(binding: string): boolean {
  const normalized = normalizeKeybinding(binding)
  if (!normalized) return false
  const parts = normalized.split('+')
  return parts.length > 1
}

export function isReservedKeybinding(
  binding: string,
  platform: ShortcutPlatform,
  environment: ShortcutEnvironment = 'desktop',
): boolean {
  const normalized = normalizeKeybinding(binding)
  if (!normalized) return false

  const common = new Set(['Mod+A', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+Z', 'Mod+Shift+Z', 'Mod+S', 'Mod+Enter'])

  if (common.has(normalized)) return true

  if (platform === 'darwin') {
    if (['Mod+Q', 'Mod+H', 'Mod+W', 'Mod+M'].includes(normalized)) return true
  } else {
    if (['Alt+F4', 'Mod+W', 'Mod+Y'].includes(normalized)) return true
  }

  if (environment === 'web') {
    if (
      [
        'Mod+T',
        'Mod+Shift+T',
        'Mod+W',
        'Mod+Shift+W',
        'Mod+N',
        'Mod+Shift+N',
        'Mod+R',
        'Mod+Shift+R',
        'Mod+P',
        'Mod+O',
      ].includes(normalized)
    ) {
      return true
    }
  }

  return false
}

export function resolveKeybinding(
  shortcut: ShortcutDefinition,
  overrides: Partial<Record<ShortcutId, string | null>> | undefined,
  environment: ShortcutEnvironment = 'desktop',
): string | null {
  if (overrides && Object.hasOwn(overrides, shortcut.id)) {
    const override = overrides[shortcut.id]
    if (override === null) return null
    const normalized = normalizeKeybinding(override)
    if (normalized) return normalized
  }
  return defaultKeybinding(shortcut, environment)
}

function codeToKey(code: string | undefined, key: string): string {
  if (code) {
    if (code.startsWith('Key') && code.length === 4) return code.slice(3)
    if (code.startsWith('Digit') && code.length === 6) return code.slice(5)
    if (code in NAMED_KEYS) return NAMED_KEYS[code]
    const lower = code.toLowerCase()
    if (lower in NAMED_KEYS) return NAMED_KEYS[lower]
  }
  const normalized = normalizeKey(key)
  return normalized ?? key
}

export function keybindingFromEvent(event: KeyboardEventLike, platform: ShortcutPlatform): string | null {
  const key = codeToKey(event.code, event.key)
  const normalizedKey = normalizeKey(key)
  if (!normalizedKey) return null

  // If the pressed key itself is a modifier, return null
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return null

  const modifiers: string[] = []
  if (platform === 'darwin') {
    if (event.metaKey) modifiers.push('Mod')
    if (event.ctrlKey) modifiers.push('Ctrl')
  } else {
    if (event.ctrlKey) modifiers.push('Mod')
    if (event.metaKey) modifiers.push('Ctrl')
  }
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')

  if (modifiers.length === 0) return null
  return normalizeKeybinding([...modifiers, normalizedKey].join('+'))
}

export function keybindingMatchesEvent(
  binding: string | null | undefined,
  event: KeyboardEventLike,
  platform: ShortcutPlatform,
): boolean {
  const normalized = normalizeKeybinding(binding)
  if (!normalized) return false
  const eventBinding = keybindingFromEvent(event, platform)
  if (!eventBinding) return false
  return normalized === eventBinding
}

export function keybindingsConflict(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeKeybinding(left)
  const normalizedRight = normalizeKeybinding(right)
  if (!normalizedLeft || !normalizedRight) return false
  return normalizedLeft === normalizedRight
}

export function keybindingDisplayParts(binding: string | null | undefined, platform: ShortcutPlatform): string[] {
  const normalized = normalizeKeybinding(binding)
  if (!normalized) return []
  const parts = normalized.split('+')
  const key = parts.at(-1) ?? ''
  const modifiers = parts.slice(0, -1)

  const formattedMods = modifiers.map((mod) => {
    if (mod === 'Mod') return platform === 'darwin' ? '⌘' : 'Ctrl'
    if (mod === 'Ctrl') return platform === 'darwin' ? '⌃' : 'Ctrl'
    if (mod === 'Alt') return platform === 'darwin' ? '⌥' : 'Alt'
    if (mod === 'Shift') return platform === 'darwin' ? '⇧' : 'Shift'
    return mod
  })

  let displayKey = key
  if (key === 'Comma') displayKey = ','
  else if (key === 'Period') displayKey = '.'
  else if (key === 'Slash') displayKey = '/'
  else if (key === 'Backslash') displayKey = '\\'
  else if (key === 'BracketLeft') displayKey = '['
  else if (key === 'BracketRight') displayKey = ']'
  else if (key === 'Semicolon') displayKey = ';'
  else if (key === 'Quote') displayKey = "'"
  else if (key === 'Backquote') displayKey = '`'
  else if (key === 'Minus') displayKey = '-'
  else if (key === 'Equal') displayKey = '='

  return [...formattedMods, displayKey]
}

export function formatKeybindingDisplay(binding: string | null | undefined, platform: ShortcutPlatform): string {
  const parts = keybindingDisplayParts(binding, platform)
  if (parts.length === 0) return ''
  return platform === 'darwin' ? parts.join('') : parts.join('+')
}
