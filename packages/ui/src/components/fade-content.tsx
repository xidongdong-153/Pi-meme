import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { gsap } from 'gsap'

// 改编自 React Bits FadeContent：仅保留界面切换的淡入，许可见 react-bits.LICENSE.md。
// https://reactbits.dev/animations/fade-content
export function FadeContent({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const root = document.documentElement
    let context: gsap.Context | undefined
    if (root.dataset.reducedMotion !== 'true') {
      context = gsap.context(() => {
        gsap.fromTo(
          element,
          { autoAlpha: 0, y: 6 },
          { autoAlpha: 1, y: 0, duration: 0.24, ease: 'power2.out', clearProps: 'opacity,visibility,transform' },
        )
      }, element!)
    }
    const observer = new MutationObserver(() => {
      if (root.dataset.reducedMotion === 'true') {
        context?.revert()
        context = undefined
      }
    })
    observer.observe(root, { attributes: true, attributeFilter: ['data-reduced-motion'] })
    return () => {
      observer.disconnect()
      context?.revert()
    }
  }, [])

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}
