import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ArrowLeft, Globe, Laptop, RefreshCw } from 'lucide-react'
import type { SshCandidate, SshConnection, SshConnectionInput } from '@pi-meme/contracts/ssh-connections'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@pi-meme/ui/components/ui/dialog'
import { Input } from '@pi-meme/ui/components/ui/input'
import { cn } from '@pi-meme/ui/lib/utils'
import type { ServiceRegistry } from './service-ui'

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

export function SshConnectionDialog({
  ssh,
  profiles,
  connection,
  configureHost = false,
  onSaved,
  onClose,
}: {
  ssh: ServiceRegistry['ssh']
  profiles: SshConnection[]
  connection?: SshConnection
  configureHost?: boolean
  onSaved: () => Promise<void>
  onClose: () => void
}) {
  const [step, setStep] = useState<'discover' | 'form'>(connection ? 'form' : 'discover')
  const [candidates, setCandidates] = useState<SshCandidate[]>([])
  const [selection, setSelection] = useState<Set<string>>(() => new Set())
  const [added, setAdded] = useState<Set<string>>(() => new Set())
  const [candidateErrors, setCandidateErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const knownTargets = new Set([...profiles.map((profile) => profile.target), ...added])

  const discover = useCallback(async () => {
    const current = ++generation.current
    setLoading(true)
    setError('')
    try {
      const result = await ssh.discover()
      if (current !== generation.current) return
      setCandidates(result)
      const targets = new Set(result.map((candidate) => candidate.target))
      setSelection((previous) => new Set([...previous].filter((target) => targets.has(target))))
    } catch (cause) {
      if (current === generation.current) setError(message(cause))
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [ssh])

  useEffect(() => {
    if (!connection) void discover()
    return () => {
      generation.current++
    }
  }, [discover, connection])

  async function addSelected() {
    setSaving(true)
    setError('')
    const failed: Record<string, string> = {}
    const saved: string[] = []
    for (const target of selection) {
      if (knownTargets.has(target)) continue
      try {
        await ssh.save({ name: target, target, hostPort: 31415 })
        saved.push(target)
      } catch (cause) {
        failed[target] = message(cause)
      }
    }
    setAdded((previous) => new Set([...previous, ...saved]))
    setSelection(new Set(Object.keys(failed)))
    setCandidateErrors(failed)
    try {
      if (saved.length) await onSaved()
      if (!Object.keys(failed).length) onClose()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setSaving(false)
    }
  }

  const selectedCount = [...selection].filter((target) => !knownTargets.has(target)).length
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-w-xl gap-4">
        <div className="space-y-2 pr-6">
          <DialogTitle>{connection ? '编辑 SSH 连接' : '添加 SSH 连接'}</DialogTitle>
          <DialogDescription>
            {step === 'discover'
              ? '从入口 Host 的 ~/.ssh/config 选择连接。添加仅保存资料，不会自动连接。'
              : '远端需要先安装并运行 pi-meme Host。保存资料后，打开连接开关建立通道。'}
          </DialogDescription>
        </div>
        {step === 'discover' ? (
          <>
            <div className="max-h-[min(24rem,50vh)] space-y-1 overflow-y-auto rounded-xl border border-border p-2">
              {loading && candidates.length === 0 && (
                <p role="status" className="p-4 text-sm text-muted-foreground">
                  正在读取 SSH 配置…
                </p>
              )}
              {!loading && !candidates.length && !error && (
                <p className="p-4 text-sm text-muted-foreground">没有找到具体 SSH 别名，可以手动添加主机。</p>
              )}
              {candidates.map((candidate) => {
                const exists = knownTargets.has(candidate.target)
                return (
                  <div key={candidate.target} className="rounded-lg border-b border-border/60 last:border-0">
                    <label
                      className={cn(
                        'flex cursor-pointer items-center gap-3 px-2 py-3 text-sm hover:bg-secondary/60',
                        (exists || saving) && 'cursor-default opacity-60',
                      )}
                    >
                      <Laptop aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{candidate.target}</span>
                        <span className="block truncate text-xs text-muted-foreground" title={candidate.source}>
                          {candidate.source}
                        </span>
                      </span>
                      {exists && <span className="shrink-0 text-xs text-muted-foreground">已添加</span>}
                      <input
                        type="checkbox"
                        aria-label={`选择 ${candidate.target}`}
                        checked={exists || selection.has(candidate.target)}
                        disabled={exists || saving}
                        className="size-4 shrink-0 accent-[var(--primary)]"
                        onChange={(event) => {
                          const checked = event.target.checked
                          setSelection((previous) => {
                            const next = new Set(previous)
                            if (checked) next.add(candidate.target)
                            else next.delete(candidate.target)
                            return next
                          })
                        }}
                      />
                    </label>
                    {candidateErrors[candidate.target] && (
                      <p role="alert" className="px-2 pb-2 text-xs text-destructive">
                        {candidateErrors[candidate.target]}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
            {error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="刷新 SSH 配置"
                  disabled={loading || saving}
                  onClick={() => void discover()}
                >
                  <RefreshCw aria-hidden="true" className={cn('size-4', loading && 'animate-spin')} />
                </Button>
                <Button
                  variant="ghost"
                  disabled={saving}
                  onClick={() => {
                    generation.current++
                    setLoading(false)
                    setError('')
                    setStep('form')
                  }}
                >
                  手动添加
                </Button>
              </div>
              <Button disabled={!selectedCount || saving} onClick={() => void addSelected()}>
                {saving ? '添加中…' : `添加（${selectedCount}）`}
              </Button>
            </div>
          </>
        ) : (
          <SshConnectionForm
            connection={connection}
            configureHost={configureHost}
            saving={saving}
            error={error}
            onBack={
              connection
                ? undefined
                : () => {
                    setError('')
                    setStep('discover')
                    if (!candidates.length) void discover()
                  }
            }
            onCancel={onClose}
            onSave={async (input) => {
              setSaving(true)
              setError('')
              try {
                await ssh.save(input)
                await onSaved()
                onClose()
              } catch (cause) {
                setError(message(cause))
              } finally {
                setSaving(false)
              }
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function SshConnectionForm({
  connection,
  configureHost,
  saving,
  error,
  onBack,
  onCancel,
  onSave,
}: {
  connection?: SshConnection
  configureHost: boolean
  saving: boolean
  error: string
  onBack?: () => void
  onCancel: () => void
  onSave: (input: SshConnectionInput) => Promise<void>
}) {
  const formId = useId()
  const [name, setName] = useState(connection?.name ?? '')
  const [target, setTarget] = useState(connection?.target ?? '')
  const [port, setPort] = useState(connection?.port?.toString() ?? '')
  const [identityMode, setIdentityMode] = useState<'config' | 'file'>(connection?.identityFile ? 'file' : 'config')
  const [identityFile, setIdentityFile] = useState(connection?.identityFile ?? '')
  const [hostPort, setHostPort] = useState((connection?.hostPort ?? 31415).toString())
  const [token, setToken] = useState('')
  const [hostOpen, setHostOpen] = useState(configureHost)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const parametersLocked = Boolean(connection?.enabled)
  const fieldError = (field: string) =>
    errors[field] ? (
      <p id={`${formId}-${field}-error`} className="text-xs text-destructive">
        {errors[field]}
      </p>
    ) : null

  function submit() {
    const issues: Record<string, string> = {}
    if (!name.trim()) issues.name = '请填写显示名称'
    if (
      !target.trim() ||
      target.trim().startsWith('-') ||
      [...target.trim()].some((char) => /\s/.test(char) || char.charCodeAt(0) < 32) ||
      target.includes('://')
    )
      issues.target = '请填写主机名、IP 或 user@host，不要填写完整 SSH 命令'
    if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535))
      issues.port = 'SSH 端口必须是 1 到 65535 的整数，或留空使用 SSH 配置'
    if (!/^\d+$/.test(hostPort) || Number(hostPort) < 1 || Number(hostPort) > 65535)
      issues.hostPort = 'Host 端口必须是 1 到 65535 的整数'
    if (identityMode === 'file' && !identityFile.trim()) issues.identityFile = '请填写入口 Host 上的身份文件路径'
    setErrors(issues)
    if (issues.hostPort) setHostOpen(true)
    if (Object.keys(issues).length) return
    void onSave({
      id: connection?.id,
      name: name.trim(),
      target: target.trim(),
      port: port ? Number(port) : undefined,
      identityFile: identityMode === 'file' ? identityFile.trim() : undefined,
      hostPort: Number(hostPort),
      ...(token ? { token } : {}),
    })
  }

  return (
    <form
      className="min-h-0 space-y-4 overflow-y-auto"
      onSubmit={(event) => {
        event.preventDefault()
        if (!saving) submit()
      }}
      noValidate
    >
      <label className="block space-y-2 text-sm">
        显示名称
        <div className="relative">
          <Globe aria-hidden="true" className="absolute left-3 top-2.5 size-4 text-primary" />
          <Input
            aria-label="SSH 显示名称"
            autoFocus={!configureHost}
            className="pl-9"
            value={name}
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? `${formId}-name-error` : undefined}
          />
        </div>
        {fieldError('name')}
      </label>
      {parametersLocked && (
        <p className="rounded-lg bg-secondary/60 p-3 text-xs text-muted-foreground">
          连接保持启用时只能修改名称。修改主机、身份文件或 Host 配置前，请先关闭连接开关。
        </p>
      )}
      <fieldset disabled={saving || parametersLocked} className="space-y-4 disabled:opacity-60">
        <label className="block space-y-2 text-sm">
          主机名或 SSH 别名
          <Input
            aria-label="SSH 主机名"
            placeholder="host.com 或 user@host.com"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            aria-invalid={Boolean(errors.target)}
            aria-describedby={errors.target ? `${formId}-target-error` : undefined}
          />
          {fieldError('target')}
        </label>
        <label className="block space-y-2 text-sm">
          SSH 端口 <span className="text-muted-foreground">（可选）</span>
          <Input
            aria-label="SSH 端口"
            inputMode="numeric"
            placeholder="使用 SSH 配置，默认 22"
            value={port}
            onChange={(event) => setPort(event.target.value)}
            aria-invalid={Boolean(errors.port)}
            aria-describedby={errors.port ? `${formId}-port-error` : undefined}
          />
          {fieldError('port')}
        </label>
        <fieldset className="space-y-2">
          <legend className="sr-only">SSH 身份验证方式</legend>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-secondary/50 p-1 text-sm">
            {(
              [
                ['config', '使用 SSH 配置'],
                ['file', '指定身份文件'],
              ] as const
            ).map(([value, label]) => (
              <label
                key={value}
                className={cn(
                  'relative cursor-pointer rounded-md px-2 py-1.5 text-center text-muted-foreground',
                  identityMode === value && 'bg-secondary text-foreground',
                )}
              >
                <input
                  type="radio"
                  name={`${formId}-identity`}
                  value={value}
                  checked={identityMode === value}
                  onChange={() => setIdentityMode(value)}
                  className="peer sr-only"
                />
                <span className="rounded-sm peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                  {label}
                </span>
              </label>
            ))}
          </div>
          {identityMode === 'file' ? (
            <label className="block space-y-2 text-sm">
              身份文件路径
              <Input
                aria-label="SSH 身份文件路径"
                placeholder="~/.ssh/id_ed25519"
                value={identityFile}
                onChange={(event) => setIdentityFile(event.target.value)}
                aria-invalid={Boolean(errors.identityFile)}
                aria-describedby={errors.identityFile ? `${formId}-identityFile-error` : undefined}
              />
              {fieldError('identityFile')}
              <span className="block text-xs text-muted-foreground">填写入口 Host 上的路径，不会上传或复制私钥。</span>
            </label>
          ) : (
            <p className="text-xs text-muted-foreground">沿用入口 Host 的 SSH 配置与 agent，不保存 SSH 密码。</p>
          )}
        </fieldset>
        <details open={hostOpen} onToggle={(event) => setHostOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer text-sm">远端 Host</summary>
          <div className="space-y-4 pt-3">
            <label className="block space-y-2 text-sm">
              Host 端口
              <Input
                aria-label="远端 Host 端口"
                inputMode="numeric"
                value={hostPort}
                onChange={(event) => setHostPort(event.target.value)}
                aria-invalid={Boolean(errors.hostPort)}
                aria-describedby={errors.hostPort ? `${formId}-hostPort-error` : undefined}
              />
              {fieldError('hostPort')}
            </label>
            <label className="block space-y-2 text-sm">
              Host 访问令牌
              <Input
                aria-label="SSH Host 访问令牌"
                type="password"
                autoComplete="off"
                autoFocus={configureHost}
                placeholder={connection?.hasToken ? '已配置；留空保留原令牌' : '可先保存，连接前需要配置'}
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
              <span className="block text-xs text-muted-foreground">
                远端 Host 需要使用 token-required 认证模式。令牌只保存在入口 Host，不会回显。
              </span>
            </label>
          </div>
        </details>
      </fieldset>
      {!connection?.hasToken && !token && (
        <p className="text-xs text-muted-foreground">尚未配置 Host 令牌。可以保存资料，连接开关会引导你补全。</p>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2 pt-1">
        {onBack ? (
          <Button type="button" variant="ghost" disabled={saving} onClick={onBack}>
            <ArrowLeft aria-hidden="true" className="mr-1 size-4" />
            返回列表
          </Button>
        ) : (
          <span />
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>
            取消
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </form>
  )
}
