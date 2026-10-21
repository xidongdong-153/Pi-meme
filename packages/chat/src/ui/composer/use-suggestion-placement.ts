import { useLayoutEffect, useRef, useState } from 'react'

export function useSuggestionPlacement() {
  const ref = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<'top' | 'bottom'>('top')
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return

    const update = () => {
      const parent = element.parentElement
      if (!parent) return
      const rect = parent.getBoundingClientRect()
      const spaceAbove = rect.top
      const spaceBelow = window.innerHeight - rect.bottom
      const preferBottom = spaceAbove < 240 && spaceBelow > spaceAbove
      const chosenPlacement = preferBottom ? 'bottom' : 'top'
      const availableSpace = preferBottom ? spaceBelow : spaceAbove

      setPlacement(chosenPlacement)
      if (availableSpace > 0) {
        setMaxHeight(Math.max(120, Math.min(352, availableSpace - 16)))
      }
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [])

  return { ref, placement, maxHeight }
}
