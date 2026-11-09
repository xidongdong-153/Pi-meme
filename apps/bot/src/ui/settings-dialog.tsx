import { Activity, useState } from 'react'
import { CalendarClock, Files, Globe, KeyRound, Monitor, Network, Sparkles, Brain } from 'lucide-react'
import { Modal } from './common'
import type { PageProps } from './common'
import { SettingsPage } from './settings'
import { Schedules } from './schedules'
import { Assets } from './assets'
import { Connections } from './connections'
import { cn } from './utils'

const tabs = [
  { id: 'appearance', name: '外观', icon: Monitor },
  { id: 'models', name: '模型', icon: Sparkles },
  { id: 'tools', name: '联网能力', icon: Globe },
  { id: 'memories', name: '记忆', icon: Brain },
  { id: 'schedules', name: '计划', icon: CalendarClock },
  { id: 'assets', name: '资料', icon: Files },
  { id: 'connections', name: '连接', icon: Network },
  { id: 'tokens', name: '访问凭据', icon: KeyRound },
] as const
const coreTabs = new Set(['appearance', 'models', 'tools', 'memories', 'tokens'])

export function SettingsDialog({
  close,
  initialTab,
  ...props
}: PageProps & { close: () => void; initialTab?: string }) {
  const firstTab = tabs.some((tab) => tab.id === initialTab) ? initialTab! : 'appearance'
  const [activeTab, setTab] = useState(firstTab)
  const [visited, setVisited] = useState<string[]>([firstTab])
  const [coreTab, setCoreTab] = useState(coreTabs.has(firstTab) ? firstTab : 'appearance')
  function select(tab: string) {
    setTab(tab)
    setVisited((values) => (values.includes(tab) ? values : [...values, tab]))
    if (coreTabs.has(tab)) setCoreTab(tab)
  }
  const pageProps: PageProps = {
    ...props,
    navigate: (page, id) => {
      if (page === 'settings' || tabs.some((tab) => tab.id === page)) {
        select(page === 'settings' ? (id && coreTabs.has(id) ? id : 'models') : page)
        return
      }
      close()
      props.navigate(page, id)
    },
  }
  return (
    <Modal title="设置" className="settings-dialog" onClose={close}>
      <div className="settings-dialog-layout">
        <nav className="settings-dialog-nav" aria-label="设置分类">
          {tabs.map(({ id, name, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={cn('category', activeTab === id && 'selected')}
              aria-current={activeTab === id ? 'page' : undefined}
              onClick={() => select(id)}
            >
              <Icon size={16} strokeWidth={1.7} />
              <span>{name}</span>
            </button>
          ))}
        </nav>
        <div className="settings-dialog-body">
          {visited.some((tab) => coreTabs.has(tab)) && (
            <Activity mode={coreTabs.has(activeTab) ? 'visible' : 'hidden'}>
              <SettingsPage {...pageProps} activeTab={coreTab} onTabChange={select} hideNavigation />
            </Activity>
          )}
          {visited.includes('schedules') && (
            <Activity mode={activeTab === 'schedules' ? 'visible' : 'hidden'}>
              <Schedules {...pageProps} />
            </Activity>
          )}
          {visited.includes('assets') && (
            <Activity mode={activeTab === 'assets' ? 'visible' : 'hidden'}>
              <Assets {...pageProps} />
            </Activity>
          )}
          {visited.includes('connections') && (
            <Activity mode={activeTab === 'connections' ? 'visible' : 'hidden'}>
              <Connections {...pageProps} />
            </Activity>
          )}
        </div>
      </div>
    </Modal>
  )
}
