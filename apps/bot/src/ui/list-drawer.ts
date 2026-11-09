import { useEffect } from 'react'
import type { RefObject } from 'react'

export function useListDrawer(
  open: boolean,
  page: string,
  label: string,
  root: RefObject<HTMLElement | null>,
  toggle: RefObject<HTMLButtonElement | null>,
) {
  useEffect(() => {
    if (!open) return
    const pane = root.current?.querySelector<HTMLElement>(`[data-page="${page}"] .list-pane`)
    if (!pane) return
    const previousRole = pane.getAttribute('role')
    const previousModal = pane.getAttribute('aria-modal')
    const previousLabel = pane.getAttribute('aria-label')
    const siblings = Array.from(pane.parentElement?.children ?? [])
      .filter((item): item is HTMLElement => item instanceof HTMLElement && item !== pane)
      .map((item) => ({ item, inert: item.inert }))
    for (const { item } of siblings) item.inert = true
    pane.setAttribute('role', 'dialog')
    pane.setAttribute('aria-modal', 'true')
    pane.setAttribute('aria-label', label)
    const focusable = () =>
      Array.from(
        pane.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
        ),
      ).filter((item) => item.getClientRects().length && !item.closest('[inert]'))
    if (!pane.contains(document.activeElement)) focusable()[0]?.focus({ preventScroll: true })
    function keyboard(event: KeyboardEvent) {
      if (
        event.key !== 'Tab' ||
        Array.from(document.querySelectorAll('[data-bot-modal]')).some((item) => item.getClientRects().length)
      )
        return
      const items = focusable()
      if (!items.length) {
        event.preventDefault()
        return
      }
      const first = items[0]
      const last = items.at(-1)!
      if (event.shiftKey && (document.activeElement === first || !pane!.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !pane!.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', keyboard)
    return () => {
      window.removeEventListener('keydown', keyboard)
      for (const { item, inert } of siblings) item.inert = inert
      for (const [name, value] of [
        ['role', previousRole],
        ['aria-modal', previousModal],
        ['aria-label', previousLabel],
      ]) {
        if (value === null) pane.removeAttribute(name!)
        else pane.setAttribute(name!, value!)
      }
      if (pane.contains(document.activeElement) || document.activeElement === document.body)
        toggle.current?.focus({ preventScroll: true })
    }
  }, [open, page, label, root, toggle])
}
