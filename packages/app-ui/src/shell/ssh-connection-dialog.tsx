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
  onSaved,
  onClose,
}: {
  ssh: ServiceRegistry['ssh']
  profiles: SshConnection[]
  connection?: SshConnection
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
        await ssh.save({ name: target, target })
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
            {step === 'discover' ? '选择已保存的 SSH 配置，或手动填写连接信息。' : '修改 SSH 连接信息。'}
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
  saving,
  error,
  onBack,
  onCancel,
  onSave,
}: {
  connection?: SshConnection
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
  const [identityFile, setIdentityFile] = useState(connection?.identityFile ?? '')
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
    if (
      !target.trim() ||
      target.trim().startsWith('-') ||
      [...target.trim()].some((char) => /\s/.test(char) || char.charCodeAt(0) < 32) ||
      target.includes('://')
    )
      issues.target = '请填写主机名、IP 或 user@host，不要填写完整 SSH 命令'
    if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535))
      issues.port = 'SSH 端口必须是 1 到 65535 的整数，或留空使用 SSH 配置'
    setErrors(issues)
    if (Object.keys(issues).length) return
    void onSave({
      id: connection?.id,
      name: name.trim() || target.trim(),
      target: target.trim(),
      port: port ? Number(port) : undefined,
      identityFile: identityFile.trim() || undefined,
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
        显示名称 <span className="text-muted-foreground">（可选）</span>
        <div className="relative">
          <Globe aria-hidden="true" className="absolute left-3 top-2.5 size-4 text-primary" />
          <Input
            aria-label="SSH 显示名称"
            autoFocus
            className="pl-9"
            placeholder={target || '默认使用主机名或 SSH 别名'}
            value={name}
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      </label>
      {parametersLocked && (
        <p className="rounded-lg bg-secondary/60 p-3 text-xs text-muted-foreground">
          连接保持启用时只能修改名称。修改主机、SSH 端口或身份文件前，请先关闭连接开关。
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
        <label className="block space-y-2 text-sm">
          身份文件路径 <span className="text-muted-foreground">（可选）</span>
          <Input
            aria-label="SSH 身份文件路径"
            placeholder="~/.ssh/id_ed25519"
            value={identityFile}
            onChange={(event) => setIdentityFile(event.target.value)}
          />
          <span className="block text-xs text-muted-foreground">
            留空使用已有 SSH 配置。私钥路径位于发起连接的设备，不会上传或复制。
          </span>
        </label>
      </fieldset>
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
            {saving ? (connection ? '保存中…' : '添加中…') : connection ? '保存' : '添加'}
          </Button>
        </div>
      </div>
    </form>
  )
}
