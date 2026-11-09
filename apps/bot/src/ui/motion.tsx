import { addTransitionType, startTransition } from 'react'

export function reducedMotion() {
  return (
    document.documentElement.dataset.reducedMotion === 'true' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function motionTransition(type: string, action: () => void) {
  if (reducedMotion()) {
    action()
    return
  }
  startTransition(() => {
    addTransitionType(type)
    action()
  })
}
