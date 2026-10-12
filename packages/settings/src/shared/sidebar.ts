import type { SidebarPreferences, SidebarPreferencesPatch } from '@pi-meme/contracts/settings'

export function defaultSidebarPreferences(): SidebarPreferences {
  return {
    groupMode: 'projects',
    sortMode: 'recent',
    collapsed: { pinned: false, projects: false, recents: false },
    orders: {},
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseSidebarPreferencesPatch(value: unknown): SidebarPreferencesPatch {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !['groupMode', 'sortMode', 'collapsed', 'orders'].includes(key))
  )
    throw new Error('侧栏设置格式无效')
  if (value.groupMode !== undefined && value.groupMode !== 'projects' && value.groupMode !== 'merged')
    throw new Error('侧栏分组方式无效')
  if (value.sortMode !== undefined && value.sortMode !== 'recent' && value.sortMode !== 'manual')
    throw new Error('侧栏排序方式无效')
  if (
    value.collapsed !== undefined &&
    (!record(value.collapsed) ||
      Object.entries(value.collapsed).some(
        ([key, collapsed]) => !['pinned', 'projects', 'recents'].includes(key) || typeof collapsed !== 'boolean',
      ))
  )
    throw new Error('侧栏折叠设置无效')
  if (
    value.orders !== undefined &&
    (!record(value.orders) ||
      Object.entries(value.orders).some(
        ([key, entries]) =>
          !key ||
          ['__proto__', 'constructor', 'prototype'].includes(key) ||
          !Array.isArray(entries) ||
          entries.some((entry) => typeof entry !== 'string' || !entry) ||
          new Set(entries).size !== entries.length,
      ))
  )
    throw new Error('侧栏手动排序列表无效')
  return structuredClone(value) as SidebarPreferencesPatch
}

export function validateSidebarPreferences(value: unknown): asserts value is SidebarPreferences {
  const patch = parseSidebarPreferencesPatch(value)
  if (
    patch.groupMode === undefined ||
    patch.sortMode === undefined ||
    patch.orders === undefined ||
    !patch.collapsed ||
    ['pinned', 'projects', 'recents'].some(
      (key) => typeof patch.collapsed?.[key as keyof typeof patch.collapsed] !== 'boolean',
    )
  )
    throw new Error('侧栏设置字段不完整')
}
