import { useEffect, useState } from 'react'
import { AppWindow, Monitor } from 'lucide-react'
import { desktopComputer, type ComputerState } from '@pi-meme/contracts/computer-use'
import { SettingsCard, SettingsGroup, SettingsRow, settingsControlClassName } from '@pi-meme/ui/components/settings'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import { cn } from '@pi-meme/ui/lib/utils'

const actions: Record<string, string> = {
  'computer.windows': '查看窗口',
  'computer.snapshot': '读取窗口控件',
  'computer.screenshot': '截取窗口',
  'computer.launch': '打开应用',
  'computer.click': '点击控件',
  'computer.setValue': '填写控件',
  'computer.press': '发送按键',
}
function useComputerState() {
  const computer = desktopComputer()
  const [state, setState] = useState<ComputerState>()
  const [error, setError] = useState('')
  useEffect(() => {
    if (!computer) return
    let revision = 0
    function refresh() {
      const epoch = ++revision
      void computer?.state().then(
        (value) => {
          if (epoch === revision) setState(value)
        },
        (cause) => {
          if (epoch === revision) setError(String(cause))
        },
      )
    }
    const remove = computer.onChange(refresh)
    window.addEventListener('focus', refresh)
    refresh()
    return () => {
      revision++
      remove()
      window.removeEventListener('focus', refresh)
    }
  }, [computer])
  function act(work: Promise<void>) {
    setError('')
    void work.catch((cause) => setError(String(cause)))
  }
  return { computer, state, error, act }
}

export function ComputerActivity({
  hostId,
  sessionId,
  remoteHost,
}: {
  hostId?: string
  sessionId?: string
  remoteHost?: string
}) {
  const { computer, state, error, act } = useComputerState()
  const active = state?.active
  if (!computer || !active || active.hostId !== hostId || active.sessionId !== sessionId) return null
  const id = state.pendingId
  return (
    <section aria-label="电脑操控" className="mb-2 rounded-xl border bg-card px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Monitor className="size-4 text-muted-foreground" />
        <strong className="font-medium">{id ? `允许查看和操作「${active.app}」？` : `电脑 · ${active.app}`}</strong>
        <span className="text-xs text-muted-foreground">{actions[active.operation]}</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => act(computer.stop(active.executionId))}>
          停止电脑操作
        </Button>
      </div>
      {id && (
        <>
          <p className="my-2 text-xs text-muted-foreground">
            操作这台 Mac 上的应用。
            {remoteHost ? `窗口内容会发送到「${remoteHost}」并进入当前对话。` : '读取的窗口内容会进入当前对话。'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => act(computer.respond(id, 'once'))}>
              仅本轮允许
            </Button>
            <Button size="sm" variant="outline" onClick={() => act(computer.respond(id, 'always'))}>
              始终允许
            </Button>
            <Button size="sm" variant="ghost" onClick={() => act(computer.respond(id, 'deny'))}>
              拒绝
            </Button>
          </div>
        </>
      )}
      {!state.accessibility && (
        <Button size="sm" variant="outline" onClick={() => act(computer.permission('accessibility'))}>
          开启辅助功能
        </Button>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}

function PermissionStatusBadge({ granted, pendingLabel = '未允许' }: { granted: boolean; pendingLabel?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium',
        granted
          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
      )}
    >
      {granted ? '已允许' : pendingLabel}
    </span>
  )
}

export function ComputerSettings({ hostId, onTry }: { hostId?: string; onTry: () => void }) {
  const { computer, state, error, act } = useComputerState()
  if (!computer) {
    return (
      <SettingsCard>
        <SettingsRow className="justify-start gap-2.5 text-muted-foreground">
          <Monitor className="size-4 shrink-0" />
          <span>电脑操控仅支持 Apple 芯片的 macOS 桌面客户端。</span>
        </SettingsRow>
      </SettingsCard>
    )
  }
  if (!state) {
    return (
      <SettingsCard>
        <SettingsRow role="status" className="text-muted-foreground">
          {error || '正在读取本机设置…'}
        </SettingsRow>
      </SettingsCard>
    )
  }
  const grants = state.grants.filter((item) => item.hostId === hostId)
  const screenGranted = state.screenRecording === 'granted'

  return (
    <div className="space-y-6">
      <SettingsGroup title="通用">
        <SettingsCard>
          <SettingsRow className="flex-nowrap">
            <div className="min-w-0">
              <p className="font-medium">允许使用本机应用</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                开启后，Agent 可在普通任务与完全权限下通过 @电脑 查看窗口并操作本机应用。
              </p>
            </div>
            <Switch
              label="允许使用本机应用"
              checked={state.enabled}
              onChange={(value) => act(computer.enable(value))}
            />
          </SettingsRow>
          <SettingsRow className="flex-nowrap">
            <div className="min-w-0">
              <p className="font-medium">快速体验</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                新建对话并预填 @电脑，尝试读取应用窗口或执行界面操作。
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className={settingsControlClassName}
              disabled={!state.enabled}
              onClick={onTry}
            >
              立即试用
            </Button>
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title="macOS 系统权限">
        <SettingsCard>
          <SettingsRow className="flex-nowrap">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">辅助功能</span>
                <PermissionStatusBadge granted={state.accessibility} />
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                用于读取应用窗口控件结构，并执行点击、填写与按键操作。
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className={settingsControlClassName}
              onClick={() => act(computer.permission('accessibility'))}
            >
              {state.accessibility ? '系统设置' : '前往授权'}
            </Button>
          </SettingsRow>
          <SettingsRow className="flex-nowrap">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">屏幕录制</span>
                <PermissionStatusBadge granted={screenGranted} pendingLabel="截图需授权" />
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                仅在需要截取应用窗口画面时使用。
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className={settingsControlClassName}
              onClick={() => act(computer.permission('screen'))}
            >
              {screenGranted ? '系统设置' : '前往授权'}
            </Button>
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title="已授权应用">
        <SettingsCard>
          {grants.length === 0 ? (
            <SettingsRow className="text-muted-foreground">
              暂无始终允许的应用。首次使用应用时将在对话上方询问你的确认。
            </SettingsRow>
          ) : (
            grants.map((item) => (
              <SettingsRow key={item.appId} className="flex-nowrap">
                <div className="flex min-w-0 items-center gap-2.5">
                  <AppWindow className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{item.name}</p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">{item.appId}</p>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className={settingsControlClassName}
                  onClick={() => act(computer.revoke(item.hostId, item.appId))}
                >
                  恢复询问
                </Button>
              </SettingsRow>
            ))
          )}
        </SettingsCard>
      </SettingsGroup>

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  )
}
