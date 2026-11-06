import * as React from 'react'

const PresentationContext = React.createContext({ active: true, closing: false })

export function usePresentationActive() {
  return React.useContext(PresentationContext).active
}

/** Keep the original grid mounted; only its built-in presentation consumers may pause after it closes. */
export function RetainedDisclosure({
  open,
  children,
  ...props
}: React.ComponentPropsWithoutRef<'div'> & { open: boolean }) {
  const parent = React.useContext(PresentationContext)
  const elementRef = React.useRef<HTMLDivElement>(null)
  const [settled, setSettled] = React.useState({ open, closed: false })
  if (settled.open !== open) setSettled({ open, closed: false })
  const closed = settled.open === open && settled.closed
  const closing = !open && !closed
  const active = parent.active && (open || closing || parent.closing)
  const presentation = React.useMemo(
    () => ({ active, closing: parent.closing || closing }),
    [active, parent.closing, closing],
  )

  React.useLayoutEffect(() => {
    if (open) return
    const element = elementRef.current
    // Without animation inspection, preserve the existing update behavior rather than freeze mid-transition.
    if (!element || typeof element.getAnimations !== 'function') return
    let cancelled = false
    const finish = () => {
      if (cancelled || !element.isConnected) return
      const transitions = element.getAnimations().filter((animation) => {
        const property = (animation as Animation & { transitionProperty?: string }).transitionProperty
        return (
          (property === 'grid-template-rows' || property === 'opacity') &&
          (animation.pending || animation.playState === 'running' || animation.playState === 'paused')
        )
      })
      if (transitions.length) {
        // Cancellation can replace a transition; inspect again before declaring the disclosure closed.
        void Promise.allSettled(transitions.map((animation) => animation.finished)).then(finish)
      } else {
        setSettled((value) => (value.open === false && value.closed ? value : { open: false, closed: true }))
      }
    }
    finish()
    return () => {
      cancelled = true
    }
  }, [open])

  return (
    <div {...props} ref={elementRef}>
      <PresentationContext value={presentation}>{children}</PresentationContext>
    </div>
  )
}
