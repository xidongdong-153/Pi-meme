import { useEffect, useRef, useState } from 'react'
import { motionTransition } from './motion'

type Location = { page: string; id?: string }
type Trail = { session: string; index: number; maximum: number }
const storageKey = 'bots.navigation.v1'

function readLocation(pages: readonly string[]): Location {
  const [page, value] = window.location.hash.slice(1).split('/')
  let id: string | undefined
  try {
    id = value ? decodeURIComponent(value) : undefined
  } catch {
    /* Treat malformed deep links as an empty selection. */
  }
  return { page: pages.includes(page) ? page : pages[0], id }
}

function initialTrail(): Trail {
  let stored: Partial<Trail> = {}
  try {
    stored = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}') as Partial<Trail>
  } catch {
    /* First visit. */
  }
  const item = history.state?.botsUI as Partial<Trail> | undefined
  const valid =
    typeof stored.session === 'string' &&
    item?.session === stored.session &&
    Number.isInteger(item.index) &&
    item.index! >= 0
  const trail = {
    session: valid ? stored.session! : crypto.randomUUID(),
    index: valid ? item!.index! : 0,
    maximum: valid && Number.isInteger(stored.maximum) ? Math.max(item!.index!, stored.maximum!) : 0,
  }
  history.replaceState({ ...history.state, botsUI: { session: trail.session, index: trail.index } }, '')
  sessionStorage.setItem(storageKey, JSON.stringify(trail))
  return trail
}

export function useBotNavigation(pages: readonly string[]) {
  const [location, setLocation] = useState(() => readLocation(pages))
  const [trail, setTrail] = useState(initialTrail)
  const current = useRef({ location, trail })
  useEffect(() => {
    function change() {
      const next = readLocation(pages)
      const previous = current.current
      if (next.page === previous.location.page && next.id === previous.location.id) return
      const item = history.state?.botsUI as Partial<Trail> | undefined
      const known =
        item?.session === previous.trail.session && Number.isInteger(item.index) && item.index !== previous.trail.index
      const nextTrail = { ...previous.trail, index: known ? item!.index! : previous.trail.index + 1 }
      nextTrail.maximum = known ? Math.max(nextTrail.index, nextTrail.maximum) : nextTrail.index
      history.replaceState({ ...history.state, botsUI: { session: nextTrail.session, index: nextTrail.index } }, '')
      sessionStorage.setItem(storageKey, JSON.stringify(nextTrail))
      current.current = { location: next, trail: nextTrail }
      motionTransition(previous.location.page === next.page ? 'bot-selection' : 'bot-page', () => {
        setLocation(next)
        setTrail(nextTrail)
      })
    }
    window.addEventListener('popstate', change)
    window.addEventListener('hashchange', change)
    return () => {
      window.removeEventListener('popstate', change)
      window.removeEventListener('hashchange', change)
    }
  }, [pages])
  function navigateTo(page: string, id?: string) {
    if (!pages.includes(page)) return
    const previous = current.current
    if (previous.location.page === page && previous.location.id === id) return
    const next = { page, id }
    const nextTrail = { ...previous.trail, index: previous.trail.index + 1, maximum: previous.trail.index + 1 }
    history.pushState(
      { ...history.state, botsUI: { session: nextTrail.session, index: nextTrail.index } },
      '',
      `#${page}${id ? `/${encodeURIComponent(id)}` : ''}`,
    )
    sessionStorage.setItem(storageKey, JSON.stringify(nextTrail))
    current.current = { location: next, trail: nextTrail }
    motionTransition(previous.location.page === page ? 'bot-selection' : 'bot-page', () => {
      setLocation(next)
      setTrail(nextTrail)
    })
  }
  return {
    location,
    navigateTo,
    canGoBack: trail.index > 0,
    canGoForward: trail.index < trail.maximum,
    back: () => {
      if (current.current.trail.index > 0) history.back()
    },
    forward: () => {
      if (current.current.trail.index < current.current.trail.maximum) history.forward()
    },
  }
}
