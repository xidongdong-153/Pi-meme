import { useLayoutEffect, useRef } from 'react'

/** 只在一级导航变化时淡入内容，保留外框、导航和已有页面实例。 */
export function useNavigationMotion(page: string, active: boolean) {
  const rootRef = useRef<HTMLElement>(null)

  useLayoutEffect(() => {
    if (!active) return
    const root = rootRef.current
    if (!root) return
    const preferenceRoot = document.documentElement
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const reduced = () => preferenceRoot.dataset.reducedMotion === 'true' || Boolean(media?.matches)
    if (reduced()) return
    const frame = [...root.querySelectorAll<HTMLElement>('.content-frame')].find(
      (element) => element.getClientRects().length > 0,
    )
    if (!frame) return
    for (const animation of frame.getAnimations({ subtree: true })) {
      if (animation instanceof CSSAnimation && animation.animationName === 'ui-content-enter') animation.cancel()
    }
    const animations = [...frame.children].flatMap((element) =>
      typeof element.animate === 'function'
        ? [
            element.animate([{ opacity: 0.65 }, { opacity: 1 }], {
              duration: 180,
              easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            }),
          ]
        : [],
    )
    const cancel = () => animations.forEach((animation) => animation.cancel())
    const onPreferenceChange = () => {
      if (reduced()) cancel()
    }
    media?.addEventListener('change', onPreferenceChange)
    const observer = new MutationObserver(onPreferenceChange)
    observer.observe(preferenceRoot, { attributes: true, attributeFilter: ['data-reduced-motion'] })
    return () => {
      cancel()
      media?.removeEventListener('change', onPreferenceChange)
      observer.disconnect()
    }
  }, [page, active])

  return rootRef
}
