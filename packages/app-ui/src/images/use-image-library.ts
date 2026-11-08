import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImageLibraryQuery } from '@pi-meme/contracts/image-library'
import {
  compareImages,
  galleryKey,
  ImageLibraryFeed,
  type GalleryImage,
  type ImageLibrarySource,
} from './image-library-data'

/** 列表、网格和详情共用同一份分页与刷新状态。 */
export function useImageLibrary({
  sources,
  visible,
  origin,
}: {
  sources: ImageLibrarySource[]
  visible: boolean
  origin: NonNullable<ImageLibraryQuery['origin']>
}) {
  const [hostFilter, setHostFilter] = useState('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<GalleryImage[]>([])
  const [feed, setFeed] = useState<ImageLibraryFeed>()
  const [loading, setLoading] = useState(false)
  const [more, setMore] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const moreRequest = useRef(false)
  const sourcesRef = useRef(sources)
  sourcesRef.current = sources
  const itemsRef = useRef(items)
  itemsRef.current = items
  const scrollRef = useRef<HTMLDivElement>(null)
  const sourceKey = sources.map((source) => `${source.id}:${source.connected}:${source.label}`).join('|')
  const filterKey = JSON.stringify([hostFilter, projectFilter, query, origin])
  const previousFilter = useRef(filterKey)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => {
    const timer = setTimeout(setQuery, 250, search)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    if (!visible) return
    const version = ++generation.current
    const changed = previousFilter.current !== filterKey
    previousFilter.current = filterKey
    moreRequest.current = false
    setMore(false)
    if (changed) {
      setItems([])
      scrollRef.current?.scrollTo({ top: 0 })
    }
    let projectHost: string | undefined
    let projectId: string | undefined
    if (projectFilter !== 'all' && projectFilter !== 'standalone') {
      try {
        ;[projectHost, projectId] = JSON.parse(projectFilter) as [string, string]
      } catch {
        setProjectFilter('all')
        return
      }
    }
    const selected = sourcesRef.current.filter(
      (source) => (hostFilter === 'all' || source.id === hostFilter) && (!projectHost || source.id === projectHost),
    )
    const next = new ImageLibraryFeed(selected, {
      query,
      origin,
      projectId: origin === 'uploaded' ? undefined : projectFilter === 'standalone' ? 'standalone' : projectId,
    })
    setLoading(true)
    setError('')
    void next
      .more(changed ? 40 : Math.max(40, itemsRef.current.length))
      .then((result) => {
        if (version !== generation.current) return
        const failed = new Set(next.sources.filter((state) => state.error).map((state) => state.source.id))
        const retained = changed
          ? []
          : itemsRef.current.filter(
              (item) => failed.has(item.serviceId) && !result.some((loaded) => galleryKey(loaded) === galleryKey(item)),
            )
        setItems([...result, ...retained].sort(compareImages))
        setFeed(next)
      })
      .catch((cause: unknown) => {
        if (version === generation.current) setError(cause instanceof Error ? cause.message : '无法读取图片，请重试')
      })
      .finally(() => {
        if (version === generation.current) setLoading(false)
      })
    return () => {
      generation.current++
    }
  }, [visible, sourceKey, filterKey, revision, hostFilter, projectFilter, query, origin])

  useEffect(() => {
    if (!visible) return
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const subscriptions: Array<() => void> = []
    for (const source of sourcesRef.current.filter((value) => value.connected)) {
      void source.host.events
        .subscribe({}, (event) => {
          if (event.type !== 'image-library' && event.type !== 'resync') return
          clearTimeout(timer)
          timer = setTimeout(refresh, 300)
        })
        .then((unsubscribe) => (closed ? unsubscribe() : subscriptions.push(unsubscribe)))
        .catch(() => {})
    }
    return () => {
      closed = true
      clearTimeout(timer)
      subscriptions.forEach((unsubscribe) => unsubscribe())
    }
  }, [visible, sourceKey, refresh])

  useEffect(() => {
    if (!visible || !feed?.sources.some((state) => state.page?.scan.running)) return
    const timer = setTimeout(refresh, 1000)
    return () => clearTimeout(timer)
  }, [visible, feed, refresh])

  async function loadMore() {
    if (!feed || loading || moreRequest.current) return
    const version = generation.current
    moreRequest.current = true
    setMore(true)
    try {
      const result = await feed.more()
      if (version !== generation.current) return
      const failed = new Set(feed.sources.filter((state) => state.error).map((state) => state.source.id))
      setItems(
        [
          ...result,
          ...itemsRef.current.filter(
            (item) => failed.has(item.serviceId) && !result.some((loaded) => galleryKey(loaded) === galleryKey(item)),
          ),
        ].sort(compareImages),
      )
    } catch (cause) {
      if (version === generation.current) setError(cause instanceof Error ? cause.message : '加载失败，请重试')
    } finally {
      if (version === generation.current) {
        moreRequest.current = false
        setMore(false)
      }
    }
  }

  const projects =
    feed?.sources.flatMap(
      (state) =>
        state.page?.projects.map((project) => ({
          value: JSON.stringify([state.source.id, project.id]),
          label: `${project.name} · ${state.source.label}`,
        })) ?? [],
    ) ?? []
  const issues = feed?.sources.flatMap((state) => (state.error ? [`${state.source.label}：${state.error}`] : [])) ?? []

  return {
    items,
    feed,
    loading: loading || previousFilter.current !== filterKey,
    changingFilter: previousFilter.current !== filterKey,
    more,
    error,
    issues,
    projects,
    search,
    setSearch,
    hostFilter,
    setHostFilter: (value: string) => {
      setHostFilter(value)
      setProjectFilter('all')
    },
    projectFilter,
    setProjectFilter,
    scrollRef,
    refresh,
    loadMore,
  }
}
