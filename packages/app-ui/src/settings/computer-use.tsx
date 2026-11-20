import { useEffect, useState } from 'react'
import { Monitor } from 'lucide-react'
import { desktopComputer, type ComputerState } from '@pi-meme/contracts/computer-use'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Switch } from '@pi-meme/ui/components/ui/switch'

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

export function ComputerSettings({ hostId, onTry }: { hostId?: string; onTry: () => void }) {
  const { computer, state, error, act } = useComputerState()
  if (!computer) return <p>电脑操控可在 Apple 芯片的 macOS 桌面客户端使用。</p>
  if (!state) return <p role="status">{error || '正在读取本机设置…'}</p>
  const grants = state.grants.filter((item) => item.hostId === hostId)
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
        <label>允许使用本机应用</label>
        <Switch label="允许使用本机应用" checked={state.enabled} onChange={(value) => act(computer.enable(value))} />
      </div>
      <section className="space-y-2">
        <h3 className="font-medium">系统权限</h3>
        <div className="flex items-center gap-2">
          <span className="flex-1">辅助功能</span>
          <span>{state.accessibility ? '已允许' : '未允许'}</span>
          <Button size="sm" variant="outline" onClick={() => act(computer.permission('accessibility'))}>
            系统设置
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex-1">屏幕录制</span>
          <span>{state.screenRecording === 'granted' ? '已允许' : '截图需要授权'}</span>
          <Button size="sm" variant="outline" onClick={() => act(computer.permission('screen'))}>
            系统设置
          </Button>
        </div>
      </section>
      <section className="space-y-2">
        <h3 className="font-medium">当前服务始终允许的应用</h3>
        {grants.length === 0 && <p className="text-muted-foreground">首次使用应用时询问。</p>}
        {grants.map((item) => (
          <div key={item.appId} className="flex items-center justify-between">
            <span>{item.name}</span>
            <Button size="sm" variant="outline" onClick={() => act(computer.revoke(item.hostId, item.appId))}>
              恢复询问
            </Button>
          </div>
        ))}
      </section>
      <Button size="sm" disabled={!state.enabled} onClick={onTry}>
        立即试用
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
