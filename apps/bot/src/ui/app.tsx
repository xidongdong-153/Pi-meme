import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Bot, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { cn } from './utils'
import { useBotNavigation } from './navigation'
import { useListDrawer } from './list-drawer'
import { getSnapshot, request, RequestError } from '../client/api'
import type { Snapshot, TaskLive } from '../shared/types'
import { Button, ErrorText, Field, Form, Input } from './common'
import { Chats } from './chats'
import { ModelOnboarding } from './model-settings'

const SettingsDialog = lazy(() => import('./settings-dialog').then((module) => ({ default: module.SettingsDialog })))
const pages = ['chats']
export function App() {
  const [auth, setAuth] = useState<{ initialized: boolean; authenticated: boolean }>()
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [error, setError] = useState<unknown>()
  const [online, setOnline] = useState(true)
  const { location, navigateTo } = useBotNavigation(pages)
  const [settingsTab, setSettingsTab] = useState<string>()
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia('(max-width: 640px)').matches)
  const [desktopListOpen, setDesktopListOpen] = useState(() => localStorage.getItem('bots.layout.v1') !== 'closed')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const listOpen = isNarrow ? !location.id || drawerOpen : desktopListOpen
  const listToggle = useRef<HTMLButtonElement>(null)
  const contentFrame = useRef<HTMLElement>(null)
  useListDrawer(isNarrow && drawerOpen, 'chats', 'Bot 与群组', contentFrame, listToggle)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)')
    const resize = () => {
      setIsNarrow(media.matches)
      setDrawerOpen(false)
    }
    const close = () => setDrawerOpen(false)
    media.addEventListener('change', resize)
    window.addEventListener('bots:close-list', close)
    return () => {
      media.removeEventListener('change', resize)
      window.removeEventListener('bots:close-list', close)
    }
  }, [])
  useEffect(() => {
    if (!isNarrow || !drawerOpen) return
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !event.isComposing &&
        event.keyCode !== 229 &&
        !document.querySelector('[data-bot-modal]')
      )
        setDrawerOpen(false)
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [isNarrow, drawerOpen])
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const preference = snapshot?.settings.theme ?? localStorage.getItem('bots.theme.v1')
      if (snapshot?.settings.theme) localStorage.setItem('bots.theme.v1', snapshot.settings.theme)
      document.documentElement.dataset.theme =
        preference === 'light' || preference === 'dark' ? preference : media.matches ? 'dark' : 'light'
    }
    apply()
    media.addEventListener('change', apply)
    window.addEventListener('bots:theme', apply)
    window.addEventListener('storage', apply)
    return () => {
      media.removeEventListener('change', apply)
      window.removeEventListener('bots:theme', apply)
      window.removeEventListener('storage', apply)
    }
  }, [snapshot?.settings.theme])
  const initialCursor = useRef('')
  const refreshRef = useRef<Promise<void> | null>(null)
  const refreshQueued = useRef(false)
  const refresh = useCallback((): Promise<void> => {
    refreshQueued.current = true
    if (refreshRef.current) return refreshRef.current
    const pending = (async () => {
      do {
        refreshQueued.current = false
        const data = await getSnapshot()
        initialCursor.current = data.cursor
        setSnapshot(data)
        setOnline(true)
        setError(undefined)
      } while (refreshQueued.current)
    })()
      .catch((cause) => {
        setError(cause)
        setOnline(false)
        if (cause instanceof RequestError && cause.status === 401) setAuth({ initialized: true, authenticated: false })
        throw cause
      })
      .finally(() => {
        refreshRef.current = null
      })
    refreshRef.current = pending
    return pending
  }, [])
  useEffect(() => {
    void request<{ initialized: boolean; authenticated: boolean }>('/api/auth/status').then(setAuth).catch(setError)
  }, [])
  useEffect(() => {
    if (auth?.authenticated) void refresh().catch(() => {})
  }, [auth?.authenticated, refresh])
  const hasSnapshot = Boolean(snapshot)
  useEffect(() => {
    if (!auth?.authenticated || !hasSnapshot) return
    let events: EventSource
    let cancelled = false
    let reconnect: ReturnType<typeof setTimeout> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    function update() {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined
          void refresh().catch(() => {})
        }, 120)
    }
    function connect() {
      if (cancelled) return
      events = new EventSource(`/api/v1/events?after=${encodeURIComponent(initialCursor.current)}`)
      events.onopen = () => {
        setOnline(true)
        update()
      }
      events.onmessage = update
      events.addEventListener('change', update)
      events.addEventListener('resync', update)
      events.addEventListener('live', (event) => {
        try {
          const live: unknown = JSON.parse((event as MessageEvent<string>).data)
          if (Array.isArray(live))
            window.dispatchEvent(new CustomEvent<TaskLive[]>('bots:live', { detail: live as TaskLive[] }))
        } catch {
          update()
        }
      })
      events.addEventListener('unauthenticated', () => {
        events.close()
        setAuth({ initialized: true, authenticated: false })
      })
      events.onerror = () => {
        events.close()
        setOnline(false)
        reconnect = setTimeout(() => {
          void refresh()
            .catch(() => {})
            .finally(connect)
        }, 2000)
      }
    }
    connect()
    const focus = () => {
      void refresh().catch(() => {})
    }
    window.addEventListener('focus', focus)
    const poll = setInterval(update, 15000)
    return () => {
      cancelled = true
      events.close()
      clearTimeout(reconnect)
      clearTimeout(timer)
      clearInterval(poll)
      window.removeEventListener('focus', focus)
    }
  }, [auth?.authenticated, hasSnapshot, refresh])
  useEffect(() => {
    document.documentElement.dataset.reducedMotion = String(snapshot?.settings.reducedMotion ?? false)
  }, [snapshot?.settings.reducedMotion])
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.id])
  const previousInitialized = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    if (!snapshot) return
    const activated = previousInitialized.current !== true && snapshot.modelSettings.initialized
    previousInitialized.current = snapshot.modelSettings.initialized
    if (!activated || location.id) return
    const assistant = snapshot.bots.find((bot) => bot.id === snapshot.modelSettings.defaultAssistantId)
    if (assistant?.webConversationId) navigateTo('chats', assistant.webConversationId)
  }, [location.id, snapshot, navigateTo])
  function navigate(page: string, id?: string) {
    setDrawerOpen(false)
    if (page === 'chats') {
      setSettingsTab(undefined)
      navigateTo('chats', id)
    } else if (page === 'bots') {
      setSettingsTab(undefined)
      window.dispatchEvent(new CustomEvent('bots:edit-bot', { detail: id }))
    } else {
      setSettingsTab(page === 'settings' ? (id ?? 'models') : page)
    }
  }
  async function logout() {
    try {
      await request('/api/auth/logout', { method: 'POST' })
      setSettingsTab(undefined)
      setSnapshot(undefined)
      setAuth({ initialized: true, authenticated: false })
    } catch (cause) {
      setError(cause)
    }
  }
  if (!auth)
    return (
      <main className="auth">
        <Bot size={30} />
        <p role="status">{error ? '连接失败' : '正在连接 Pi Bot'}</p>
        <ErrorText error={error} />
        {Boolean(error) && (
          <Button
            onClick={() => {
              setError(undefined)
              void request<{ initialized: boolean; authenticated: boolean }>('/api/auth/status')
                .then(setAuth)
                .catch(setError)
            }}
          >
            重试连接
          </Button>
        )}
      </main>
    )
  if (!auth.authenticated)
    return <Login initialized={auth.initialized} done={() => setAuth({ initialized: true, authenticated: true })} />
  const props = snapshot ? { snapshot, refresh, navigate } : null
  if (props && !props.snapshot.modelSettings.initialized) return <ModelOnboarding {...props} />
  return (
    <div className={cn('bot-app', !listOpen && 'list-collapsed', isNarrow && drawerOpen && 'narrow-list-open')}>
      <main ref={contentFrame} className="content-frame" aria-label="Pi Bot">
        {Boolean(error) && (
          <div className="global-error">
            <ErrorText error={error} />
            <Button variant="ghost" onClick={() => void refresh().catch(() => {})}>
              重试连接
            </Button>
          </div>
        )}
        <button
          className="list-scrim"
          data-state={isNarrow && drawerOpen ? 'open' : 'closed'}
          tabIndex={-1}
          aria-label="关闭列表"
          aria-hidden={!isNarrow || !drawerOpen}
          inert={!isNarrow || !drawerOpen}
          onClick={() => setDrawerOpen(false)}
        />
        <Button
          ref={listToggle}
          variant="ghost"
          size="icon"
          className="sidebar-toggle"
          aria-label={listOpen ? '收起 Bot 列表' : '展开 Bot 列表'}
          aria-controls="bot-list"
          aria-expanded={listOpen}
          inert={isNarrow && drawerOpen}
          onClick={() => {
            if (isNarrow) setDrawerOpen((open) => !open)
            else
              setDesktopListOpen((open) => {
                localStorage.setItem('bots.layout.v1', open ? 'closed' : 'open')
                return !open
              })
          }}
        >
          {listOpen ? <PanelLeftClose size={19} strokeWidth={1.7} /> : <PanelLeftOpen size={19} strokeWidth={1.7} />}
        </Button>
        {!props ? (
          <div className="empty" role="status">
            正在读取 Bot
          </div>
        ) : (
          <div className="page-surface" data-page="chats">
            <Chats
              {...props}
              selectedId={location.id}
              listOpen={listOpen}
              online={online}
              openSettings={(tab = 'appearance') => setSettingsTab(tab)}
              logout={() => void logout()}
            />
          </div>
        )}
      </main>
      {props && settingsTab && (
        <Suspense
          fallback={
            <div className="dialog-loading" role="status">
              正在打开设置…
            </div>
          }
        >
          <SettingsDialog
            {...props}
            initialTab={settingsTab}
            close={() => {
              setSettingsTab(undefined)
              window.dispatchEvent(new Event('bots:settings-closed'))
            }}
          />
        </Suspense>
      )}
    </div>
  )
}
function Login({ initialized, done }: { initialized: boolean; done: () => void }) {
  const [password, setPassword] = useState('')
  return (
    <main className="auth">
      <Bot size={34} strokeWidth={1.5} />
      <h1>{initialized ? '登录 Pi Bot' : '创建 Pi Bot 访问密码'}</h1>
      <Form
        submit={initialized ? '登录' : '创建并进入'}
        onSubmit={async () => {
          await request(`/api/auth/${initialized ? 'login' : 'setup'}`, { method: 'POST', body: { password } })
          done()
        }}
      >
        <Field label="访问密码">
          <Input
            type="password"
            autoFocus
            required
            minLength={12}
            maxLength={256}
            autoComplete={initialized ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </Form>
    </main>
  )
}
