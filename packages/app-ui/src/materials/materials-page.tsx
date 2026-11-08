import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Download,
  Grid2X2,
  List,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from 'lucide-react'
import type { SessionRef } from '@pi-meme/contracts/app-host'
import type { ImageLibraryItem, ImageLibraryQuery } from '@pi-meme/contracts/image-library'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@pi-meme/ui/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import { TooltipHint } from '@pi-meme/ui/components/ui/tooltip'
import { cn } from '@pi-meme/ui/lib/utils'
import {
  GalleryImageLoader,
  toGalleryImage,
  type GalleryImage,
  type ImageLibrarySource,
} from '../images/image-library-data'
import { useImageLibrary } from '../images/use-image-library'
import type { AppRoute } from '../layout/use-app-navigation'
import { MaterialHostDialog, MaterialOperationDialog, type MaterialDialog } from './material-dialogs'
import { imageMaterialAdapter, materialRegistry, type MaterialCreateAction } from './material-registry'
import { MaterialUploadDialog } from './material-upload-dialog'
import { MaterialActionsMenu, MaterialsCollection } from './materials-collection'
import { MaterialCreateMenu, MaterialsSidebar } from './materials-sidebar'
import {
  materialKey,
  summarizeImage,
  type ImageMaterial,
  type MaterialAction,
  type MaterialRef,
} from './material-types'
import { useMaterialRecents } from './use-material-recents'
import './materials-page.css'

type MaterialsRoute = Extract<AppRoute, { kind: 'materials' }>
type Origin = NonNullable<ImageLibraryQuery['origin']>

function readView(): 'list' | 'grid' {
  try {
    return localStorage.getItem('pi-meme:materials:view:v1') === 'grid' ? 'grid' : 'list'
  } catch {
    return 'list'
  }
}

export function MaterialsPage({
  sources,
  visible,
  route,
  onNavigate,
  onBack,
  onOpenSession,
  onCreateImage,
  renderLayout,
}: {
  sources: ImageLibrarySource[]
  visible: boolean
  route: MaterialsRoute
  onNavigate: (route: MaterialsRoute) => void
  onBack: () => void
  onOpenSession: (serviceId: string, ref: SessionRef) => Promise<void>
  onCreateImage: (serviceId: string, item?: GalleryImage) => Promise<void>
  renderLayout: (parts: { sidebar: ReactNode; content: ReactNode }) => ReactNode
}) {
  const [allOrigin, setAllOrigin] = useState<Origin>('all')
  const [worksOrigin, setWorksOrigin] = useState<Origin>('generated')
  const origin = route.section === 'images' ? worksOrigin : allOrigin
  const library = useImageLibrary({ sources, visible, origin })
  const [view, setView] = useState(readView)
  const [error, setError] = useState('')
  const [busyKey, setBusyKey] = useState('')
  const busyRequest = useRef(0)
  const [dialog, setDialog] = useState<MaterialDialog>()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [hostDialog, setHostDialog] = useState(false)
  const [droppedFiles, setDroppedFiles] = useState<File[]>()
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const search = useRef<HTMLInputElement>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const loader = useMemo(() => new GalleryImageLoader(), [])
  const recents = useMaterialRecents()
  const [detail, setDetail] = useState<{ key: string; material?: ImageMaterial; url?: string; error?: string }>({
    key: '',
  })
  const [detailRevision, setDetailRevision] = useState(0)
  const detailRequest = useRef(0)
  const materials = useMemo(() => {
    const unique = new Map<string, ImageMaterial>()
    const connected = new Set(sources.filter((source) => source.connected).map((source) => source.id))
    for (const image of library.items) {
      const material = summarizeImage(image)
      const key = materialKey(material.ref)
      const previous = unique.get(key)
      if (!previous || (!connected.has(previous.serviceId) && connected.has(material.serviceId)))
        unique.set(key, material)
    }
    return [...unique.values()]
  }, [library.items, sources])
  const sourceRef = useRef(sources)
  sourceRef.current = sources
  const materialRef = useRef(materials)
  materialRef.current = materials
  const routeRef = useRef(route)
  routeRef.current = route
  const recentsRef = useRef(recents)
  recentsRef.current = recents
  const sourceKey = sources.map((source) => `${source.id}:${source.connected}:${source.label}`).join('|')
  const detailKey = route.image ? materialKey({ ...route.image, kind: 'image' }) : ''
  const activeKnown = materials.find((item) => materialKey(item.ref) === detailKey)
  const activeMaterial = (detail.key === detailKey ? detail.material : undefined) || activeKnown
  const preview = detail.key === detailKey ? detail : undefined
  const previousDetail = useRef('')

  useEffect(() => {
    try {
      localStorage.setItem('pi-meme:materials:view:v1', view)
    } catch {
      /* 视图偏好不可写时使用窗口内状态。 */
    }
  }, [view])

  async function sourceFor(ref: MaterialRef, preferredServiceId?: string) {
    const preferred = sourceRef.current.find((source) => source.id === preferredServiceId && source.connected)
    if (preferred?.host.imageLibrary) {
      const caps = await preferred.host.capabilities()
      if (caps.hostId === ref.hostId) return { source: preferred, caps }
    }
    const candidates = await Promise.all(
      sourceRef.current
        .filter((source) => source.connected && source !== preferred && source.host.imageLibrary)
        .map(async (source) => {
          try {
            return { source, caps: await source.host.capabilities() }
          } catch {
            return undefined
          }
        }),
    )
    const found = candidates.find((candidate) => candidate?.caps.hostId === ref.hostId)
    if (!found) throw new Error('图片所属服务未连接，请连接后重试')
    return found
  }

  useEffect(() => {
    const request = ++detailRequest.current
    if (!visible || !route.image) return
    const ref = { ...route.image, kind: 'image' }
    setDetail({ key: detailKey })
    void (async () => {
      const { source, caps } = await sourceFor(ref, route.image?.serviceId)
      let material = materialRef.current.find((item) => materialKey(item.ref) === detailKey)
      if (!material) {
        let image: ImageLibraryItem | undefined
        if (caps.features.includes('image-library-upload')) image = await imageMaterialAdapter.get(source, ref.id)
        else {
          const saved = recentsRef.current.recent.find((value) => materialKey(value.ref) === detailKey)
          let cursor: string | undefined
          for (let page = 0; page < 20; page++) {
            const result = await source.host.imageLibrary!.list({ query: saved?.name, cursor, limit: 100 })
            image = result.items.find((value) => value.id === ref.id && value.hostId === ref.hostId)
            if (image || !result.nextCursor || cursor === result.nextCursor || request !== detailRequest.current) break
            cursor = result.nextCursor
          }
        }
        if (!image || image.hostId !== ref.hostId || image.id !== ref.id)
          throw new Error('图片不存在或已从资料空间移除')
        material = summarizeImage(toGalleryImage(image, source))
      }
      const loaded = {
        ...material,
        serviceId: source.id,
        image: { ...material.image, serviceId: source.id, hostLabel: source.label },
      }
      if (request !== detailRequest.current) return
      setDetail({ key: detailKey, material: loaded })
      const url = await loader.load(loaded.image, source)
      if (request !== detailRequest.current) return
      setDetail({ key: detailKey, material: loaded, url })
      recentsRef.current.remember(loaded)
    })().catch((cause: unknown) => {
      if (request === detailRequest.current)
        setDetail((current) => ({
          ...current,
          key: detailKey,
          error: cause instanceof Error ? cause.message : '图片无法打开，请重试',
        }))
    })
    return () => {
      detailRequest.current++
    }
  }, [visible, detailKey, sourceKey, detailRevision, loader])

  useEffect(() => {
    const known = materials.find((item) => materialKey(item.ref) === detailKey)
    if (!known) return
    setDetail((current) =>
      current.key === detailKey && current.material
        ? {
            ...current,
            material: summarizeImage({
              ...known.image,
              serviceId: current.material.serviceId,
              hostLabel: current.material.image.hostLabel,
            }),
          }
        : current,
    )
  }, [materials, detailKey])

  useEffect(() => {
    if (previousDetail.current && !detailKey && visible) {
      const frame = requestAnimationFrame(() => {
        if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true })
        else search.current?.focus({ preventScroll: true })
      })
      previousDetail.current = detailKey
      return () => cancelAnimationFrame(frame)
    }
    previousDetail.current = detailKey
  }, [detailKey, visible])

  useEffect(() => {
    if (!visible) {
      setDialogOpen(false)
      setHostDialog(false)
      setDragging(false)
      dragDepth.current = 0
    }
  }, [visible])

  function openMaterial(material: ImageMaterial, button?: HTMLButtonElement) {
    if (button) trigger.current = button
    setError('')
    onNavigate({
      kind: 'materials',
      section: route.section,
      image: { hostId: material.ref.hostId, id: material.ref.id, serviceId: material.serviceId },
    })
  }
  function moveDetail(offset: number) {
    const index = materials.findIndex((material) => materialKey(material.ref) === detailKey)
    const next = materials[index + offset]
    if (index >= 0 && next) openMaterial(next)
  }
  function changeOrigin(next: Origin) {
    if (route.section === 'images') setWorksOrigin(next)
    else setAllOrigin(next)
    setError('')
  }
  async function createImage(serviceId: string, image?: GalleryImage) {
    const key = image ? materialKey({ hostId: image.hostId, id: image.id, kind: 'image' }) : 'create'
    const request = ++busyRequest.current
    setBusyKey(key)
    setError('')
    try {
      await onCreateImage(serviceId, image)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法打开创作聊天，请重试')
    } finally {
      if (request === busyRequest.current) setBusyKey('')
    }
  }
  function createAction(action: MaterialCreateAction['id']) {
    setError('')
    if (action === 'image.upload') {
      setDroppedFiles(undefined)
      setUploadOpen(true)
      return
    }
    const connected = sources.filter(
      (source) => source.connected && (library.hostFilter === 'all' || source.id === library.hostFilter),
    )
    if (connected.length === 1) void createImage(connected[0].id)
    else setHostDialog(true)
  }
  async function action(material: ImageMaterial, kind: MaterialAction) {
    setError('')
    if (kind === 'info' || kind === 'rename' || kind === 'remove') {
      setDialog({ material, action: kind })
      setDialogOpen(true)
      return
    }
    const request = ++busyRequest.current
    setBusyKey(materialKey(material.ref))
    try {
      const { source } = await sourceFor(material.ref, material.serviceId)
      if (kind === 'source') {
        if (material.image.origin !== 'uploaded' && material.image.sourceStatus !== 'detached')
          await onOpenSession(source.id, material.image.session)
      } else {
        const url = await loader.load(material.image, source)
        const extension =
          material.image.mimeType === 'image/jpeg' ? 'jpg' : material.image.mimeType === 'image/webp' ? 'webp' : 'png'
        const name =
          Array.from(material.name)
            .map((character) => (character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(character) ? '_' : character))
            .join('')
            .replace(/\.(png|jpe?g|webp)$/i, '') || 'image'
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `${name}.${extension}`
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '图像操作失败，请重试')
    } finally {
      if (request === busyRequest.current) setBusyKey('')
    }
  }
  async function saveDialog(name: string) {
    if (!dialog || dialog.action === 'info' || busyKey) return
    const { material, action: kind } = dialog
    const request = ++busyRequest.current
    setBusyKey(materialKey(material.ref))
    setError('')
    try {
      const { source } = await sourceFor(material.ref, material.serviceId)
      if (kind === 'rename') {
        await imageMaterialAdapter.rename(source, material.ref.id, name)
        recents.renameRecent(material, name.trim())
        setDetail((current) =>
          current.material && materialKey(current.material.ref) === materialKey(material.ref)
            ? {
                ...current,
                material: {
                  ...current.material,
                  name: name.trim(),
                  image: { ...current.material.image, name: name.trim() },
                },
              }
            : current,
        )
      } else {
        await imageMaterialAdapter.remove(source, material.ref.id)
        loader.invalidate(material.image)
        recents.forget(material)
        if (detailKey === materialKey(material.ref)) onBack()
      }
      setDialogOpen(false)
      library.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试')
    } finally {
      if (request === busyRequest.current) setBusyKey('')
    }
  }

  const tabs: Array<{ value: Origin; label: string }> =
    route.section === 'images'
      ? [
          { value: 'generated', label: '你的作品' },
          { value: 'uploaded', label: '已上传' },
        ]
      : [
          { value: 'all', label: '全部' },
          { value: 'generated', label: '你的作品' },
          { value: 'uploaded', label: '已上传' },
        ]
  const title = route.section === 'images' ? '图像' : '全部'
  const activeIndex = materials.findIndex((material) => materialKey(material.ref) === detailKey)
  const definition = materialRegistry.find((item) => item.kind === activeMaterial?.ref.kind)
  const hasFilter = library.hostFilter !== 'all' || (origin !== 'uploaded' && library.projectFilter !== 'all')
  const notice = !dialogOpen ? error || library.error : library.error
  const sidebar = (
    <MaterialsSidebar
      route={route}
      sources={sources}
      recent={recents.recent}
      onNavigate={onNavigate}
      onCreate={createAction}
      onSearch={() => {
        if (route.image) onNavigate({ kind: 'materials', section: route.section })
        requestAnimationFrame(() => search.current?.focus())
      }}
    />
  )
  const content = (
    <main
      className="materials-content relative flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      aria-label="资料空间内容"
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        dragDepth.current++
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (!dragDepth.current) setDragging(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        const files = Array.from(event.dataTransfer.files)
        if (files.length) {
          setDroppedFiles(files)
          setUploadOpen(true)
        }
      }}
    >
      {notice && (
        <div role="alert" className="materials-notice flex items-start justify-between gap-3 text-sm text-destructive">
          <span className="break-words">{notice}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setError('')
              library.refresh()
              setDetailRevision((value) => value + 1)
            }}
          >
            重试
          </Button>
        </div>
      )}
      <div className={cn('min-h-0 flex-1 flex-col', detailKey ? 'hidden' : 'flex')} inert={Boolean(detailKey)}>
        <header className="materials-header flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
          <div className="flex min-w-0 items-center gap-3">
            <div className="relative min-w-0">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={search}
                aria-label="搜索资料"
                placeholder="搜索"
                value={library.search}
                onChange={(event) => library.setSearch(event.target.value)}
                className="materials-search h-8 rounded-full pl-9 text-xs"
              />
            </div>
            {route.section === 'images' ? (
              <Button
                className="materials-create h-8 rounded-full px-4 text-xs"
                disabled={busyKey === 'create'}
                onClick={() => createAction('image.generate')}
              >
                创建图像
              </Button>
            ) : (
              <MaterialCreateMenu onAction={createAction} />
            )}
          </div>
        </header>
        <div className="materials-toolbar flex flex-wrap items-center justify-between gap-3">
          <div role="tablist" aria-label="图片来源" className="flex items-center gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={origin === tab.value}
                aria-controls="materials-collection"
                tabIndex={origin === tab.value ? 0 : -1}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const index = tabs.findIndex((value) => value.value === origin)
                  const nextIndex =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length
                  changeOrigin(tabs[nextIndex].value)
                  const tabButtons =
                    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  const nextButton = tabButtons?.item(nextIndex)
                  nextButton?.focus()
                }}
                className={cn('materials-tab', origin === tab.value && 'is-active')}
                onClick={() => changeOrigin(tab.value)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <Popover>
              <TooltipHint content="筛选资料">
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={hasFilter ? '筛选资料，已筛选' : '筛选资料'}
                    className={cn('rounded-full', hasFilter && 'bg-secondary')}
                  >
                    <SlidersHorizontal className="size-3.5" />
                  </Button>
                </PopoverTrigger>
              </TooltipHint>
              <PopoverContent side="bottom" align="end" className="space-y-3">
                <Select value={library.hostFilter} onValueChange={library.setHostFilter}>
                  <SelectTrigger aria-label="筛选服务">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部服务</SelectItem>
                    {sources.map((source) => (
                      <SelectItem key={source.id} value={source.id}>
                        {source.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {origin !== 'uploaded' && (
                  <Select value={library.projectFilter} onValueChange={library.setProjectFilter}>
                    <SelectTrigger aria-label="筛选项目">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部项目</SelectItem>
                      <SelectItem value="standalone">独立聊天</SelectItem>
                      {library.projects.map((project) => (
                        <SelectItem key={project.value} value={project.value}>
                          {project.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {hasFilter && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full"
                    onClick={() => {
                      library.setHostFilter('all')
                      library.setProjectFilter('all')
                    }}
                  >
                    清除筛选
                  </Button>
                )}
              </PopoverContent>
            </Popover>
            <TooltipHint content="刷新资料">
              <Button
                variant="ghost"
                size="icon"
                aria-label="刷新资料"
                disabled={library.loading}
                className="rounded-full"
                onClick={library.refresh}
              >
                <RefreshCw className={cn('size-3.5', library.loading && 'animate-spin')} />
              </Button>
            </TooltipHint>
            {route.section === 'all' && (
              <>
                <span aria-hidden="true" className="mx-1 h-3 w-px bg-border" />
                {(
                  [
                    { id: 'grid', label: '网格视图', Icon: Grid2X2 },
                    { id: 'list', label: '列表视图', Icon: List },
                  ] as const
                ).map(({ id, label, Icon }) => (
                  <TooltipHint key={id} content={label}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn('rounded-full', view === id && 'bg-secondary')}
                      aria-label={label}
                      aria-pressed={view === id}
                      onClick={() => setView(id)}
                    >
                      <Icon className="size-3.5" />
                    </Button>
                  </TooltipHint>
                ))}
              </>
            )}
          </div>
        </div>
        {library.issues.length > 0 && (
          <div role="status" className="materials-issues space-y-1 text-xs text-muted-foreground">
            {library.issues.map((issue) => (
              <p key={issue}>{issue}</p>
            ))}
          </div>
        )}
        {route.section === 'images' && origin === 'generated' && (
          <section className="materials-references" aria-label="参考照片">
            <h2 className="mb-3 text-xs font-medium">参考照片</h2>
            <Button variant="outline" size="sm" className="rounded-full" onClick={() => createAction('image.upload')}>
              <Plus className="size-3.5" />
              添加
            </Button>
          </section>
        )}
        <div
          id="materials-collection"
          inert={library.changingFilter}
          role="tabpanel"
          aria-label={`${title}，${tabs.find((tab) => tab.value === origin)?.label}`}
          className="flex min-h-0 flex-1 flex-col"
        >
          <MaterialsCollection
            materials={materials}
            sources={sources}
            view={route.section === 'images' ? 'masonry' : view}
            loader={loader}
            scrollRef={library.scrollRef}
            visible={visible && !detailKey}
            loading={library.loading}
            hasMore={Boolean(library.feed?.hasMore)}
            more={library.more}
            emptyText={
              library.issues.length
                ? '暂时无法读取资料'
                : library.search || hasFilter
                  ? '未找到任何项目'
                  : origin === 'uploaded'
                    ? '还没有上传图片'
                    : '还没有图像'
            }
            busyKey={busyKey}
            onOpen={openMaterial}
            onAction={(material, kind) => void action(material, kind)}
            onLoadMore={() => void library.loadMore()}
          />
        </div>
      </div>
      {detailKey && (
        <section
          className="materials-detail flex min-h-0 flex-1 flex-col"
          aria-label="图像详情"
          onKeyDown={(event) => {
            if (
              event.defaultPrevented ||
              dialogOpen ||
              uploadOpen ||
              hostDialog ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              (event.target instanceof Element &&
                event.target.closest('input,textarea,[contenteditable=true],[role=combobox],[role=listbox]'))
            )
              return
            if (event.key === 'Escape') {
              event.preventDefault()
              onBack()
            }
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault()
              moveDetail(event.key === 'ArrowLeft' ? -1 : 1)
            }
          }}
        >
          <div className="materials-detail-header flex items-center justify-between gap-3 px-3 py-2">
            <Button variant="secondary" size="sm" className="max-w-[65%] rounded-full" onClick={onBack}>
              <ArrowLeft className="size-3.5" />
              <span className="truncate">{activeMaterial?.name || '图像'}</span>
            </Button>
            {activeMaterial && (
              <div className="flex items-center gap-2">
                <TooltipHint content="下载图片">
                  <Button
                    variant="secondary"
                    size="icon"
                    aria-label="下载图片"
                    className="rounded-full"
                    disabled={Boolean(busyKey)}
                    onClick={() => void action(activeMaterial, 'download')}
                  >
                    <Download className="size-4" />
                  </Button>
                </TooltipHint>
                <MaterialActionsMenu
                  material={activeMaterial}
                  disabled={Boolean(busyKey)}
                  onAction={(kind) => void action(activeMaterial, kind)}
                />
              </div>
            )}
          </div>
          {preview?.error ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6">
              <p role="alert" className="max-w-md break-words text-center text-sm text-destructive">
                {preview.error}
              </p>
              <Button variant="outline" onClick={() => setDetailRevision((value) => value + 1)}>
                重试
              </Button>
            </div>
          ) : preview?.url && activeMaterial && definition ? (
            <div className="materials-preview-stage grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] gap-2 p-3">
              <definition.Preview
                material={activeMaterial}
                dataUrl={preview.url}
                index={Math.max(0, activeIndex)}
                count={activeIndex < 0 ? 1 : materials.length}
                onNavigate={moveDetail}
                onError={(message) =>
                  setDetail((current) => (current.key === detailKey ? { ...current, error: message } : current))
                }
              />
            </div>
          ) : (
            <div
              role="status"
              className="ui-loading-delayed flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
            >
              正在打开图像…
            </div>
          )}
          {activeMaterial && (
            <div className="flex justify-end px-4 pb-4 pt-2">
              <Button
                variant="secondary"
                className="materials-use-image w-full max-w-md justify-between rounded-full px-5"
                disabled={Boolean(busyKey) || !preview?.url}
                onClick={() => void createImage(activeMaterial.serviceId, activeMaterial.image)}
              >
                <span className="flex items-center gap-3">
                  <Plus className="size-4" />
                  基于此图创作
                </span>
                {busyKey ? <RefreshCw className="size-4 animate-spin" /> : <ArrowUpRight className="size-4" />}
              </Button>
            </div>
          )}
        </section>
      )}
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-background/90">
          <span className="flex items-center gap-3 text-sm">
            <Check className="size-5" />
            上传图片到资料空间
          </span>
        </div>
      )}
    </main>
  )
  return (
    <div className="materials-workspace flex min-h-0 min-w-0 flex-1">
      {renderLayout({ sidebar, content })}
      <MaterialOperationDialog
        dialog={dialog}
        open={visible && dialogOpen}
        onOpenChange={setDialogOpen}
        busy={Boolean(busyKey)}
        error={error}
        onSave={(name) => void saveDialog(name)}
      />
      <MaterialUploadDialog
        open={visible && uploadOpen}
        onOpenChange={setUploadOpen}
        sources={sources}
        initialServiceId={library.hostFilter === 'all' ? undefined : library.hostFilter}
        droppedFiles={droppedFiles}
        onUploaded={(_item, _source) => {
          changeOrigin('uploaded')
          library.refresh()
          if (routeRef.current.image) onNavigate({ kind: 'materials', section: routeRef.current.section })
        }}
      />
      <MaterialHostDialog
        open={visible && hostDialog}
        onOpenChange={setHostDialog}
        sources={sources}
        onCreate={(serviceId) => void createImage(serviceId)}
      />
    </div>
  )
}
