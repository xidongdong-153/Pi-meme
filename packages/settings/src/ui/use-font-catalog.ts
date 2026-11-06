import { useCallback, useEffect, useRef, useState } from 'react'
import type { InstalledFont } from '@pi-meme/contracts/settings'
import { BrowserFontCatalog, usesBrowserFonts } from './browser-fonts'

function accessError(cause: unknown) {
  if (cause instanceof DOMException) {
    if (cause.name === 'NotAllowedError') return '未获字体访问权限。可在浏览器网站设置中允许，或输入本机字体名称。'
    if (cause.name === 'SecurityError') return '浏览器限制了字体访问，可输入本机字体名称。'
  }
  return `读取本机字体失败：${cause instanceof Error ? cause.message : String(cause)}`
}

export function useFontCatalog(loadFonts: () => Promise<InstalledFont[]>) {
  const [browser] = useState(() => (usesBrowserFonts() ? new BrowserFontCatalog() : null))
  const [fonts, setFonts] = useState<InstalledFont[]>(() => browser?.list() ?? [])
  const [pending, setPending] = useState(0)
  const [error, setError] = useState('')
  const live = useRef(true)
  const nativeLoaded = useRef(false)
  const nativeLoading = useRef(false)
  const loader = useRef(loadFonts)
  loader.current = loadFonts

  const load = useCallback(
    (requestAccess = false) => {
      if (!browser && (nativeLoaded.current || nativeLoading.current)) return
      nativeLoading.current = !browser
      setPending((count) => count + 1)
      setError('')
      let task: Promise<InstalledFont[]>
      try {
        task = browser ? browser.read(requestAccess) : loader.current()
      } catch (cause) {
        task = Promise.reject(cause)
      }
      void task
        .then((next) => {
          if (!live.current) return
          setFonts(browser?.list() ?? next)
          nativeLoaded.current = true
        })
        .catch((cause) => {
          if (live.current)
            setError(browser ? accessError(cause) : cause instanceof Error ? cause.message : String(cause))
        })
        .finally(() => {
          nativeLoading.current = false
          if (live.current) setPending((count) => count - 1)
        })
    },
    [browser],
  )
  useEffect(() => {
    live.current = true
    load()
    return () => {
      live.current = false
    }
  }, [load])

  return {
    fonts,
    loading: pending > 0,
    error,
    hint: browser?.hint,
    requestAccess: browser?.canReadAll ? () => load(true) : undefined,
    retry: () => load(Boolean(browser?.canReadAll)),
    probe: browser ? (family: string) => browser.find(family) : undefined,
    remember: (family: string) => {
      if (!browser) return
      browser.remember(family)
      setFonts(browser.list())
    },
  }
}
