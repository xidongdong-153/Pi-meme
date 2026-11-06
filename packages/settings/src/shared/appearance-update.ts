import type {
  AppearanceOperation,
  AppearancePatch,
  AppearanceSettings,
  AppearanceUpdate,
  Theme,
} from '@pi-meme/contracts/settings'
import { defaultAppearance, selectAppearanceTheme, toggleSeparate, validateAppearance } from './appearance'

const scalarKeys = ['mode', 'uiSize', 'codeSize', 'reducedMotion', 'translucentSidebar', 'contrast'] as const
const scopes = ['shared', 'light', 'dark'] as const
const groups = {
  colors: ['background', 'text', 'accent'],
  fonts: ['ui', 'content', 'code'],
  fontStyles: ['ui', 'content', 'code'],
  tokens: ['spacing', 'radius', 'surfaceOpacity'],
  background: ['opacity', 'blur'],
} as const
const revisionKeys = ['mode', 'lightThemeId', 'darkThemeId', 'separate', ...scalarKeys.slice(1)] as const

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('外观修改包含未知字段')
}
function validatePatch(value: unknown): asserts value is AppearancePatch {
  if (!record(value)) throw new Error('外观补丁无效')
  keys(value, [...scalarKeys, ...scopes])
  for (const key of scalarKeys)
    if (key in value && (value[key] === null || value[key] === undefined)) throw new Error('外观基础字段不能删除')
  for (const scope of scopes) {
    if (!(scope in value)) continue
    const overrides = value[scope]
    if (!record(overrides)) throw new Error('外观覆盖补丁必须是对象')
    keys(overrides, Object.keys(groups))
    for (const [group, allowed] of Object.entries(groups)) {
      if (!(group in overrides)) continue
      const entries = overrides[group]
      if (!record(entries)) throw new Error('外观分组补丁必须是对象')
      keys(entries, allowed)
      if (Object.values(entries).some((entry) => entry === undefined || (entry !== null && typeof entry === 'object')))
        throw new Error('外观补丁叶子值无效')
    }
  }
}
export function validateAppearanceOperation(value: unknown): asserts value is AppearanceOperation {
  if (!record(value)) throw new Error('外观操作无效')
  switch (value.type) {
    case 'patch':
      keys(value, ['type', 'patch'])
      validatePatch(value.patch)
      break
    case 'select-theme':
      keys(value, ['type', 'themeId'])
      if (typeof value.themeId !== 'string' || !value.themeId.trim()) throw new Error('主题 ID 无效')
      break
    case 'separate':
      keys(value, ['type', 'separate', 'mode'])
      if (typeof value.separate !== 'boolean' || (value.mode !== 'light' && value.mode !== 'dark'))
        throw new Error('分模式操作无效')
      break
    case 'reset':
      keys(value, ['type'])
      break
    default:
      throw new Error('外观操作无效；请更新客户端后重新读取设置')
  }
}
export function validateAppearanceUpdate(value: unknown): asserts value is AppearanceUpdate {
  if (!record(value)) throw new Error('外观保存必须携带修订与操作；请更新客户端')
  if (typeof value.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedRevision))
    throw new Error('外观保存缺少有效修订；请更新客户端后重新读取设置')
  keys(value, ['expectedRevision', 'operation'])
  validateAppearanceOperation(value.operation)
}

function applyPatch(value: AppearanceSettings, patch: AppearancePatch): AppearanceSettings {
  const next = structuredClone(value)
  const target = next as unknown as Record<string, unknown>
  for (const key of scalarKeys) if (key in patch) target[key] = patch[key]
  for (const scope of scopes) {
    const updates = patch[scope]
    if (!updates) continue
    const overrides = { ...next[scope] } as Record<string, Record<string, unknown>>
    let touched = false
    for (const group of Object.keys(groups) as (keyof typeof groups)[]) {
      const entries = updates[group]
      if (!entries || !Object.keys(entries).length) continue
      touched = true
      const merged = { ...overrides[group] }
      for (const [key, entry] of Object.entries(entries)) {
        if (entry === null) delete merged[key]
        else merged[key] = entry
      }
      if (Object.keys(merged).length) overrides[group] = merged
      else delete overrides[group]
    }
    if (touched) target[scope] = overrides
  }
  return next
}
export function applyAppearanceOperation(
  value: AppearanceSettings,
  operation: AppearanceOperation,
  themes: Theme[],
): AppearanceSettings {
  validateAppearanceOperation(operation)
  let next: AppearanceSettings
  switch (operation.type) {
    case 'patch':
      next = applyPatch(value, operation.patch)
      break
    case 'select-theme': {
      const theme = themes.find((entry) => entry.id === operation.themeId)
      if (!theme) throw new Error('主题不存在，请重新加载主题列表')
      next = selectAppearanceTheme(value, theme)
      break
    }
    case 'separate':
      next = value.separate === operation.separate ? value : toggleSeparate(value, operation.mode, operation.separate)
      break
    case 'reset':
      next = defaultAppearance()
      break
  }
  validateAppearance(next)
  return next
}

function at(value: unknown, path: string): unknown {
  let current = value
  for (const key of path.split('.')) {
    if (!record(current)) return undefined
    current = current[key]
  }
  return current
}
function allPaths(): string[] {
  return [
    ...new Set(revisionKeys),
    ...scopes.flatMap((scope) =>
      Object.entries(groups).flatMap(([group, entries]) => entries.map((key) => `${scope}.${group}.${key}`)),
    ),
  ]
}
/** 固定字段顺序；空覆盖对象和未设置的可选覆盖拥有相同内容修订。 */
export function canonicalAppearance(value: AppearanceSettings): string {
  return JSON.stringify(allPaths().flatMap((path) => (at(value, path) === undefined ? [] : [[path, at(value, path)]])))
}
export function changedAppearancePaths(before: AppearanceSettings, after: AppearanceSettings): string[] {
  return allPaths().filter((path) => at(before, path) !== at(after, path))
}
export function diffAppearance(before: AppearanceSettings, after: AppearanceSettings): AppearancePatch {
  if (
    before.separate !== after.separate ||
    before.lightThemeId !== after.lightThemeId ||
    before.darkThemeId !== after.darkThemeId
  )
    throw new Error('主题、分模式和重置必须使用明确的外观操作')
  const patch: Record<string, unknown> = {}
  for (const key of scalarKeys) if (before[key] !== after[key]) patch[key] = after[key]
  for (const scope of scopes) {
    const overrides: Record<string, unknown> = {}
    for (const [group, entries] of Object.entries(groups)) {
      const changes: Record<string, unknown> = {}
      for (const key of entries) {
        const path = `${scope}.${group}.${key}`
        if (at(before, path) !== at(after, path)) changes[key] = at(after, path) ?? null
      }
      if (Object.keys(changes).length) overrides[group] = changes
    }
    if (Object.keys(overrides).length) patch[scope] = overrides
  }
  return patch as AppearancePatch
}
export function appearanceOperationPaths(operation: AppearanceOperation): string[] {
  if (operation.type === 'reset') return allPaths()
  if (operation.type === 'select-theme') return ['lightThemeId', 'darkThemeId', 'separate', ...scopes]
  if (operation.type === 'separate') return ['separate', ...scopes]
  const paths: string[] = scopes.some((scope) => operation.patch[scope] !== undefined) ? ['separate'] : []
  for (const key of scalarKeys) if (key in operation.patch) paths.push(key)
  for (const scope of scopes)
    for (const [group, entries] of Object.entries(operation.patch[scope] ?? {}))
      for (const key of Object.keys(entries)) {
        paths.push(`${scope}.${group}.${key}`)
        if (group === 'fonts' || group === 'fontStyles')
          paths.push(`${scope}.${group === 'fonts' ? 'fontStyles' : 'fonts'}.${key}`)
      }
  return [...new Set(paths)]
}
export function canRebaseAppearanceOperation(
  operation: AppearanceOperation,
  before: AppearanceSettings,
  latest: AppearanceSettings,
): boolean {
  return appearanceOperationPaths(operation).every((path) => {
    if (scopes.includes(path as (typeof scopes)[number])) {
      const scope = path as (typeof scopes)[number]
      const sample = defaultAppearance()
      return (
        canonicalAppearance({ ...sample, shared: before[scope] ?? {} }) ===
        canonicalAppearance({ ...sample, shared: latest[scope] ?? {} })
      )
    }
    return at(before, path) === at(latest, path)
  })
}
