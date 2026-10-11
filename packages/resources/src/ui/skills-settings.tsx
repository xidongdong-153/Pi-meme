import { useState } from 'react'
import { ArrowLeft, BookOpen, Check, RefreshCw, Search } from 'lucide-react'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { cn } from '@pi-meme/ui/lib/utils'

const scopes = { builtin: '内置', user: 'Host', project: '项目', temporary: '临时' }

export function SkillsSettings({
  commands,
  ready,
  loading,
  onRefresh,
}: {
  commands: PiSlashCommand[]
  ready: boolean
  loading: boolean
  onRefresh: () => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'all' | keyof typeof scopes>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const skills = commands.filter((command) => command.source === 'skill')
  const filtered = skills.filter(
    (skill) =>
      (scope === 'all' || (skill.builtin ? 'builtin' : skill.sourceInfo.scope) === scope) &&
      `${skill.name} ${skill.displayName ?? ''} ${skill.shortDescription ?? ''} ${skill.description ?? ''}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  )
  const current = skills.find((skill) => `${skill.name}:${skill.sourceInfo.path}` === selected)

  async function refresh() {
    setRefreshing(true)
    setError('')
    try {
      await onRefresh()
    } catch (cause) {
      setError(`无法刷新技能：${String(cause)}`)
    } finally {
      setRefreshing(false)
    }
  }

  if (!ready || loading)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {ready ? '正在加载技能…' : '尚未连接 Pi。返回聊天并选择项目后，可查看可用技能。'}
      </p>
    )

  if (current)
    return (
      <section aria-label="技能详情" className="space-y-6 select-text">
        <Button variant="ghost" onClick={() => setSelected(null)}>
          <ArrowLeft />
          返回技能
        </Button>
        <div className="flex items-center gap-4">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-secondary text-primary">
            <BookOpen className="size-7" />
          </span>
          <div className="min-w-0">
            <h3 className="break-words text-xl font-semibold">
              {current.displayName ?? current.name.replace(/^skill:/, '')}
            </h3>
            <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Check className="size-3.5" />
              已加载 · {scopes[current.builtin ? 'builtin' : current.sourceInfo.scope]}
            </p>
          </div>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm leading-7 text-muted-foreground">
          {current.description || '暂无说明'}
        </p>
        <div className="rounded-2xl border border-border bg-card p-5">
          <h4 className="text-xs text-muted-foreground">文件路径</h4>
          <p className="mt-2 break-all font-mono text-xs leading-6">{current.sourceInfo.path}</p>
        </div>
      </section>
    )

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="搜索技能"
            placeholder="搜索技能"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="rounded-full pl-9"
          />
        </div>
        <Button variant="ghost" size="icon" aria-label="刷新技能" disabled={refreshing} onClick={() => void refresh()}>
          <RefreshCw className={cn(refreshing && 'animate-spin')} />
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap gap-1" aria-label="技能来源">
          {(['all', 'builtin', 'user', 'project', 'temporary'] as const).map((value) => (
            <Button
              key={value}
              variant={scope === value ? 'secondary' : 'ghost'}
              className="rounded-full"
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
            >
              {value === 'all' ? '全部' : scopes[value]}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{filtered.length} 个技能</p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <ul
        aria-label="已加载技能"
        className="grid grid-cols-1 gap-x-8 gap-y-2 border-t border-border pt-4 lg:grid-cols-2"
      >
        {filtered.map((skill) => (
          <li key={`${skill.name}:${skill.sourceInfo.path}`}>
            <button
              type="button"
              aria-label={`查看技能：${skill.displayName ?? skill.name.replace(/^skill:/, '')}`}
              onClick={() => setSelected(`${skill.name}:${skill.sourceInfo.path}`)}
              className="flex min-h-24 w-full items-center gap-4 rounded-2xl p-3 text-left transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-card text-primary">
                <BookOpen className="size-6" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {skill.displayName ?? skill.name.replace(/^skill:/, '')}
                </span>
                <span className="mt-1 line-clamp-2 break-words text-sm leading-6 text-muted-foreground">
                  {skill.shortDescription || skill.description || '暂无说明'}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {scopes[skill.builtin ? 'builtin' : skill.sourceInfo.scope]}
                </span>
              </span>
              <Check aria-label="已加载" className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
      {!filtered.length && (
        <p role="status" className="py-10 text-center text-sm text-muted-foreground">
          {skills.length ? '没有匹配的技能。' : '当前项目没有已加载的技能。'}
        </p>
      )}
    </div>
  )
}
