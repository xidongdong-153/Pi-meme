import type { ReactElement } from 'react'
import { ChevronDown, Layers, Plus, Search } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { OverflowTooltip } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'
import type { ImageLibrarySource } from '../images/image-library-data'
import type { AppRoute } from '../layout/use-app-navigation'
import { materialRegistry, type MaterialCreateAction } from './material-registry'
import { materialKey, type RecentMaterial } from './material-types'

export function MaterialCreateMenu({
  onAction,
  children,
  side = 'bottom',
  align = 'end',
}: {
  onAction: (action: MaterialCreateAction['id']) => void
  children?: ReactElement
  side?: 'bottom' | 'right'
  align?: 'start' | 'end'
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {children ?? (
          <Button className="materials-create rounded-full">
            创建 <ChevronDown className="size-3.5" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} sideOffset={8} className="w-52 rounded-2xl p-2">
        {materialRegistry.flatMap((definition) =>
          definition.createActions.map(({ id, label, Icon }) => (
            <DropdownMenuItem key={id} onSelect={() => onAction(id)} className="gap-3 rounded-lg px-3 py-2.5">
              <Icon className="size-4" />
              {label}
            </DropdownMenuItem>
          )),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function MaterialsSidebar({
  route,
  sources,
  recent,
  onNavigate,
  onCreate,
  onSearch,
}: {
  route: Extract<AppRoute, { kind: 'materials' }>
  sources: ImageLibrarySource[]
  recent: RecentMaterial[]
  onNavigate: (route: Extract<AppRoute, { kind: 'materials' }>) => void
  onCreate: (action: MaterialCreateAction['id']) => void
  onSearch: () => void
}) {
  return (
    <div className="materials-sidebar appearance-sidebar flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 px-4">
        <h2 className="text-base font-semibold">资料空间</h2>
        <Button size="icon-sm" variant="ghost" aria-label="搜索资料" onClick={onSearch}>
          <Search className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
        <MaterialCreateMenu onAction={onCreate} side="right" align="start">
          <Button variant="ghost" className="materials-sidebar-entry mb-2 w-full justify-start gap-2.5 px-2.5">
            <Plus className="size-4" />
            创建
          </Button>
        </MaterialCreateMenu>
        <nav aria-label="资料分类" className="space-y-0.5">
          <button
            type="button"
            aria-current={route.section === 'all' ? 'page' : undefined}
            className={cn('materials-sidebar-entry', route.section === 'all' && 'is-active')}
            onClick={() => onNavigate({ kind: 'materials', section: 'all' })}
          >
            <Layers className="size-4 shrink-0" />
            全部
          </button>
          {materialRegistry.map(({ kind, label, section, Icon }) => (
            <button
              key={kind}
              type="button"
              aria-current={route.section === section ? 'page' : undefined}
              className={cn('materials-sidebar-entry', route.section === section && 'is-active')}
              onClick={() => onNavigate({ kind: 'materials', section })}
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </button>
          ))}
        </nav>
        {recent.length > 0 && (
          <section aria-label="最近打开的资料" className="mt-7">
            <h3 className="mb-2 px-2.5 text-xs font-medium text-muted-foreground">最近</h3>
            <div className="space-y-0.5">
              {recent.map((item) => {
                const definition = materialRegistry.find((value) => value.kind === item.ref.kind)
                if (!definition) return null
                const source = sources.find((value) => value.id === item.serviceId)
                const active = route.image && materialKey({ ...route.image, kind: 'image' }) === materialKey(item.ref)
                return (
                  <button
                    key={materialKey(item.ref)}
                    type="button"
                    className={cn('materials-sidebar-entry', active && 'is-active', !source?.connected && 'opacity-50')}
                    aria-label={source?.connected ? item.name : `${item.name}，所属服务未连接`}
                    aria-current={active ? 'page' : undefined}
                    onClick={() =>
                      onNavigate({
                        kind: 'materials',
                        section: 'images',
                        image: { hostId: item.ref.hostId, id: item.ref.id, serviceId: item.serviceId },
                      })
                    }
                  >
                    <definition.Icon className="size-3.5 shrink-0" />
                    <OverflowTooltip content={item.name}>
                      <span className="min-w-0 truncate">{item.name}</span>
                    </OverflowTooltip>
                  </button>
                )
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
