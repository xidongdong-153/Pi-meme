import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, FolderOpen, RefreshCw, Upload } from 'lucide-react'
import type {
  AppearanceOverrides,
  AppearanceSettings,
  FontRole,
  FontStyle,
  InstalledFont,
  SettingsSnapshot,
  Theme,
} from '@pi-meme/contracts/settings'
import { Slider } from '@pi-meme/ui/components/ui/slider'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import { AppearanceGroup, AppearanceRow, Choice, ColorControl, FontControl, SizeControl } from './appearance-controls'
import {
  defaultAppearance,
  editingOverrides,
  fontStyles,
  migrateAppearance,
  resolveTheme,
  resolvedMode,
  selectAppearanceTheme,
  setOverrides,
  toggleSeparate,
} from '../shared/appearance'

const accents = [
  { value: '', label: '主题默认' },
  { value: '#3b82f6', label: '蓝' },
  { value: '#8b5cf6', label: '紫' },
  { value: '#22c55e', label: '绿' },
  { value: '#f97316', label: '橙' },
  { value: '#ef4444', label: '红' },
  { value: '#ec4899', label: '粉' },
  { value: 'custom', label: '自定义' },
]
const styleLabels = ['常规', '粗体', '斜体', '粗斜体']
export function ThemeSettings({
  snapshot,
  onAppearance,
  onPreview,
  onFlush,
  onOpenDirectory,
  onReload,
  onImport,
  onExport,
  loadFonts,
}: {
  snapshot: SettingsSnapshot
  onAppearance: (value: AppearanceSettings) => void
  onPreview: (mode: 'light' | 'dark' | null) => void
  onFlush: () => Promise<void>
  onOpenDirectory: () => void
  onReload: () => void
  onImport: () => void
  onExport: (theme: Theme) => void
  loadFonts: () => Promise<InstalledFont[]>
}) {
  const value = migrateAppearance(snapshot.settings, snapshot.themes)
  const [editing, setEditing] = useState<'light' | 'dark'>(() =>
    resolvedMode(value, window.matchMedia('(prefers-color-scheme: dark)').matches),
  )
  const [customAccent, setCustomAccent] = useState(false)
  const [fonts, setFonts] = useState<InstalledFont[]>([])
  const [fontLoading, setFontLoading] = useState(false)
  const [fontError, setFontError] = useState('')
  const loaded = useRef(false)
  const loading = useRef(false)
  const live = useRef(true)
  const callbacks = useRef({ onPreview, onFlush, loadFonts })
  callbacks.current = { onPreview, onFlush, loadFonts }
  const getFonts = useCallback(() => {
    if (loaded.current || loading.current) return
    loading.current = true
    setFontLoading(true)
    setFontError('')
    void callbacks.current
      .loadFonts()
      .then((next) => {
        if (live.current) {
          setFonts(next)
          loaded.current = true
        }
      })
      .catch((cause) => {
        if (live.current) setFontError(String(cause))
      })
      .finally(() => {
        loading.current = false
        if (live.current) setFontLoading(false)
      })
  }, [])
  useEffect(() => {
    live.current = true
    getFonts()
    return () => {
      live.current = false
      callbacks.current.onPreview(null)
      void callbacks.current.onFlush()
    }
  }, [getFonts])
  useEffect(() => {
    callbacks.current.onPreview(value.separate ? editing : null)
  }, [editing, value.separate])
  const mode = value.separate ? editing : resolvedMode(value, window.matchMedia('(prefers-color-scheme: dark)').matches)
  const overrides = editingOverrides(value, mode)
  const theme = resolveTheme(value, snapshot.themes, mode, false)
  const [resetting, setResetting] = useState(false)
  function change(patch: Partial<AppearanceSettings>) {
    onAppearance({ ...value, ...patch })
  }
  function override(patch: Partial<AppearanceOverrides>) {
    onAppearance(setOverrides(value, mode, { ...overrides, ...patch }))
  }
  function color(key: 'background' | 'text' | 'accent', next?: string) {
    const colors = { ...overrides.colors }
    if (next) colors[key] = next
    else delete colors[key]
    override({ colors })
  }
  function font(role: FontRole, next?: string) {
    const nextFonts = { ...overrides.fonts }
    const nextStyles = { ...overrides.fontStyles }
    if (next) nextFonts[role] = next
    else if (role === 'content') nextFonts.content = 'inherit'
    else delete nextFonts[role]
    if (next) {
      const styles = fonts.find((entry) => next.startsWith(JSON.stringify(entry.family)))?.styles
      nextStyles[role] = styles && !styles.includes('regular') ? styles[0] : 'regular'
    } else delete nextStyles[role]
    override({ fonts: nextFonts, fontStyles: nextStyles })
  }
  function fontControl(role: FontRole, label: string) {
    return (
      <FontControl
        label={label}
        value={
          role === 'content'
            ? (overrides.fonts?.content ?? snapshot.themes.find((entry) => entry.id === theme.id)?.fonts.content)
            : overrides.fonts?.[role]
        }
        fonts={fonts}
        loading={fontLoading}
        error={fontError}
        load={getFonts}
        onChange={(next) => font(role, next)}
        inherit={role === 'content'}
        code={role === 'code'}
      />
    )
  }
  function styleControl(role: FontRole, label: string) {
    const families = theme.fonts[role]?.split(',').map((family) => family.trim().replaceAll('"', '')) ?? []
    const system = families.includes('-apple-system') || families.includes('ui-monospace')
    const available = system
      ? fontStyles
      : (fonts.find((entry) => families.includes(entry.family))?.styles ?? ['regular'])
    const style =
      theme.fontStyles?.[role] ??
      (role === 'content' && theme.fonts.content === theme.fonts.ui ? theme.fontStyles?.ui : undefined) ??
      'regular'
    return (
      <span>
        <Choice
          label={label}
          value={style}
          options={fontStyles.map((entry, index) => ({
            value: entry,
            label: styleLabels[index],
            disabled: !available.includes(entry),
          }))}
          onChange={(next) => override({ fontStyles: { ...overrides.fontStyles, [role]: next as FontStyle } })}
        />
      </span>
    )
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">视觉风格</h3>
        {value.separate && (
          <div role="group" aria-label="编辑模式" className="flex gap-1">
            {(['light', 'dark'] as const).map((entry) => (
              <Button
                key={entry}
                variant={editing === entry ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={editing === entry}
                onClick={() => setEditing(entry)}
              >
                编辑{entry === 'light' ? '浅色' : '深色'}
              </Button>
            ))}
          </div>
        )}
      </div>
      <AppearanceGroup>
        <AppearanceRow label="模式">
          <div role="group" aria-label="外观模式" className="flex flex-wrap gap-3">
            {(['system', 'light', 'dark'] as const).map((entry) => (
              <Button
                key={entry}
                variant="outline"
                aria-label={`${entry === 'system' ? '系统' : entry === 'light' ? '浅色' : '深色'}模式`}
                aria-pressed={value.mode === entry}
                onClick={() => change({ mode: entry })}
                className={`h-auto flex-col gap-0 rounded-xl border-2 p-1.5 ${value.mode === entry ? 'border-primary' : 'border-border'}`}
              >
                <span
                  aria-hidden="true"
                  className="flex h-12 w-20 overflow-hidden rounded-md border border-border"
                  style={{
                    background:
                      entry === 'system'
                        ? 'linear-gradient(90deg,#faf9fc 50%,#18181a 50%)'
                        : entry === 'light'
                          ? '#faf9fc'
                          : '#18181a',
                  }}
                >
                  <span className="w-4 border-r border-gray-500/30" />
                  <span className="flex flex-1 flex-col gap-1 px-2 py-2">
                    <span className="h-1 w-9 rounded bg-primary" />
                    <span className="h-1 w-6 rounded bg-gray-500/50" />
                    <span className="h-1 w-8 rounded bg-gray-500/50" />
                    <span className="h-1 w-5 self-end rounded bg-primary" />
                  </span>
                </span>
                <span className="mt-1 block text-xs">
                  {entry === 'system' ? '系统' : entry === 'light' ? '浅色' : '深色'}
                </span>
              </Button>
            ))}
          </div>
        </AppearanceRow>
      </AppearanceGroup>
      <AppearanceGroup>
        <AppearanceRow label="主题">
          <Button variant="ghost" size="icon-sm" aria-label="导入主题" title="导入 JSON 主题" onClick={onImport}>
            <Upload className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="导出主题"
            title="导出颜色、字体和布局；背景图片随插件分发"
            onClick={() =>
              onExport({
                ...theme,
                plugin: undefined,
                background: undefined,
                id: `custom-${mode}`,
                name: `自定义${mode === 'light' ? '浅色' : '深色'}`,
              })
            }
          >
            <Download className="size-4" />
          </Button>
          <Select
            value={theme.id}
            onValueChange={(id) => {
              const next = snapshot.themes.find((entry) => entry.id === id)
              if (next) {
                setCustomAccent(false)
                onAppearance(selectAppearanceTheme(value, next))
              }
            }}
          >
            <SelectTrigger aria-label="外观主题" className="w-48 rounded-full h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {snapshot.themes
                .filter((entry) => entry.appearance === mode)
                .map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </AppearanceRow>
        <AppearanceRow label="强调色">
          <span className="size-4 rounded-full border border-border" style={{ background: theme.colors.accent }} />
          <Choice
            label="强调色"
            value={
              customAccent
                ? 'custom'
                : accents.some((entry) => entry.value === overrides.colors?.accent)
                  ? (overrides.colors?.accent ?? '')
                  : overrides.colors?.accent
                    ? 'custom'
                    : ''
            }
            options={accents}
            onChange={(next) => {
              setCustomAccent(next === 'custom')
              if (next !== 'custom') color('accent', next || undefined)
            }}
          />
          {(customAccent ||
            (overrides.colors?.accent && !accents.some((entry) => entry.value === overrides.colors?.accent))) && (
            <ColorControl
              label="强调色"
              value={theme.colors.accent}
              onChange={(next) => color('accent', next)}
              onReset={() => {
                color('accent')
                setCustomAccent(false)
              }}
            />
          )}
        </AppearanceRow>
        <AppearanceRow label="背景">
          <ColorControl
            label="背景"
            value={theme.colors.background}
            onChange={(next) => color('background', next)}
            onReset={() => color('background')}
          />
        </AppearanceRow>
        <AppearanceRow label="前景">
          <ColorControl
            label="前景"
            value={theme.colors.text}
            onChange={(next) => color('text', next)}
            onReset={() => color('text')}
          />
        </AppearanceRow>
        {theme.background && (
          <AppearanceRow label="主题背景图" description="图片来自已安装主题插件">
            {theme.background.url && (
              <img src={theme.background.url} alt={theme.name} className="h-16 w-24 rounded object-cover" />
            )}
            <label className="flex items-center gap-2 text-sm">
              透明度
              <Slider
                aria-label="背景图透明度"
                min={0}
                max={1}
                step={0.05}
                value={theme.background.opacity}
                onChange={(event) =>
                  override({ background: { ...overrides.background, opacity: Number(event.target.value) } })
                }
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              模糊
              <Slider
                aria-label="背景图模糊"
                min={0}
                max={32}
                value={theme.background.blur}
                onChange={(event) =>
                  override({ background: { ...overrides.background, blur: Number(event.target.value) } })
                }
              />
            </label>
          </AppearanceRow>
        )}
        <AppearanceRow label="间距与圆角">
          <label className="flex items-center gap-2 text-sm">
            间距
            <Slider
              aria-label="主题间距"
              min={0.5}
              max={2}
              step={0.1}
              value={theme.tokens?.spacing ?? 1}
              onChange={(event) => override({ tokens: { ...overrides.tokens, spacing: Number(event.target.value) } })}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            圆角
            <Slider
              aria-label="主题圆角"
              min={0}
              max={24}
              value={theme.tokens?.radius ?? 8}
              onChange={(event) => override({ tokens: { ...overrides.tokens, radius: Number(event.target.value) } })}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            面板透明度
            <Slider
              aria-label="面板透明度"
              min={0.4}
              max={1}
              step={0.05}
              value={theme.tokens?.surfaceOpacity ?? 1}
              onChange={(event) =>
                override({ tokens: { ...overrides.tokens, surfaceOpacity: Number(event.target.value) } })
              }
            />
          </label>
        </AppearanceRow>
        <AppearanceRow label="字体">{fontControl('ui', '界面字体')}</AppearanceRow>
      </AppearanceGroup>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onOpenDirectory}>
          <FolderOpen className="size-4" />
          打开主题目录
        </Button>
        <Button variant="outline" size="sm" onClick={onReload}>
          <RefreshCw className="size-4" />
          重新加载主题
        </Button>
      </div>
      <div className="space-y-5">
        <AppearanceGroup>
          <AppearanceRow label="界面字号" description="调整界面与聊天正文的基础字号">
            <SizeControl
              label="界面字号"
              value={value.uiSize}
              min={12}
              max={20}
              onChange={(uiSize) => change({ uiSize })}
            />
          </AppearanceRow>
          <AppearanceRow label="代码字体大小" description="调整代码、差异视图与扩展编辑器的字号">
            <SizeControl
              label="代码字体大小"
              value={value.codeSize}
              min={10}
              max={24}
              onChange={(codeSize) => change({ codeSize })}
            />
          </AppearanceRow>
        </AppearanceGroup>
        <AppearanceGroup>
          <AppearanceRow label="减少动态效果" description="减少动画效果，或跟随系统设置">
            <div role="group" aria-label="减少动态效果" className="flex gap-1">
              {(['system', 'on', 'off'] as const).map((entry, index) => (
                <Button
                  key={entry}
                  size="sm"
                  variant={value.reducedMotion === entry ? 'secondary' : 'ghost'}
                  aria-pressed={value.reducedMotion === entry}
                  onClick={() => change({ reducedMotion: entry })}
                >
                  {['系统', '开启', '关闭'][index]}
                </Button>
              ))}
            </div>
          </AppearanceRow>
          <AppearanceRow label="分别设置浅色和深色模式" description="分别选择主题、颜色和字体">
            <Switch
              label="分别设置浅色和深色模式"
              checked={value.separate}
              onChange={(separate) => {
                if (separate) setEditing(mode)
                onAppearance(toggleSeparate(value, mode, separate))
              }}
            />
          </AppearanceRow>
        </AppearanceGroup>
        <AppearanceGroup>
          <AppearanceRow label="界面字体样式">{styleControl('ui', '界面字体样式')}</AppearanceRow>
          <AppearanceRow label="内容字体">
            {fontControl('content', '内容字体')}
            {styleControl('content', '内容字体样式')}
          </AppearanceRow>
          <AppearanceRow label="代码字体">
            {fontControl('code', '代码字体')}
            {styleControl('code', '代码字体样式')}
          </AppearanceRow>
          <AppearanceRow label="半透明侧边栏">
            <Switch
              label="半透明侧边栏"
              checked={value.translucentSidebar}
              onChange={(translucentSidebar) => change({ translucentSidebar })}
            />
          </AppearanceRow>
          <AppearanceRow label="对比度" description="调整卡片、边框和辅助文字的层次">
            <Slider
              aria-label="对比度"
              min={0}
              max={100}
              step={1}
              value={value.contrast}
              onChange={(event) => change({ contrast: Number(event.target.value) })}
              className="w-40"
            />
            <output className="w-8 text-right text-sm">{value.contrast}</output>
          </AppearanceRow>
        </AppearanceGroup>
      </div>
      {resetting ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
          <span>恢复全部外观默认值？</span>
          <Button
            size="sm"
            onClick={() => {
              setResetting(false)
              setCustomAccent(false)
              onAppearance(defaultAppearance())
            }}
          >
            确认恢复
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setResetting(false)}>
            取消
          </Button>
        </div>
      ) : (
        <Button variant="ghost" size="sm" onClick={() => setResetting(true)}>
          恢复外观默认值
        </Button>
      )}
    </div>
  )
}
