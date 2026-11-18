import { useLayoutEffect, useRef } from 'react'

interface LineEnd {
  block: HTMLElement
  top: number
  bottom: number
  right: number
  width: number
}

// Measure only the last glyph. The browser already knows where rich inline text wraps.
function lastLine(root: HTMLElement): LineEnd | undefined {
  let tail: Node = root
  while (tail.lastChild) tail = tail.lastChild
  if (!(tail instanceof Text) || !tail.length) return
  const block = tail.parentElement?.closest<HTMLElement>('p,li,h1,h2,h3,h4,h5,h6')
  if (!block || !root.contains(block) || tail.parentElement?.closest('button,pre,.katex')) return
  const range = document.createRange()
  range.setStart(tail, tail.length - 1)
  range.setEnd(tail, tail.length)
  const glyph = range.getBoundingClientRect()
  if (!glyph.height || !glyph.width) return
  const bounds = block.getBoundingClientRect()
  const lineHeight = Number.parseFloat(getComputedStyle(block).lineHeight) || glyph.height
  const top = Math.max(0, glyph.top - bounds.top - (lineHeight - glyph.height) / 2)
  return { block, top, bottom: top + lineHeight, right: glyph.right - bounds.left, width: bounds.width }
}

function createLineReveal(root: HTMLElement) {
  let pending: LineEnd | undefined
  let shown = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let animation: Animation | undefined
  let deadline = 0

  function clear() {
    clearTimeout(timer)
    animation?.cancel()
    pending?.block.removeAttribute('data-stream-line')
    pending = undefined
    shown = 0
  }

  function paint(line: LineEnd, from: number, to: number) {
    const { block, top, bottom } = line
    const feather = Math.max(1, to - from)
    animation?.cancel()
    animation = undefined
    block.style.setProperty('--stream-line-top', `${top}px`)
    block.style.setProperty('--stream-line-height', `${bottom - top}px`)
    block.style.setProperty('--stream-line-width', `${to}px`)
    block.style.setProperty('--stream-line-from', `${from}px`)
    block.style.setProperty('--stream-feather', `${feather}px`)
    block.style.setProperty('--stream-edge', `${to}px`)
    block.setAttribute('data-stream-line', '')
    if (to > from) {
      animation = block.animate([{ '--stream-edge': `${from - feather}px` }, { '--stream-edge': `${to}px` }], {
        duration: 240,
        easing: 'ease-out',
      })
    }
  }

  return {
    clear,
    update() {
      const next = lastLine(root)
      if (!next) return clear()
      const previous = pending
      if (!previous || previous.block !== next.block || previous.width !== next.width || next.top < previous.top - 2) {
        clear()
        paint(next, 0, 0)
        deadline = performance.now() + 600
      } else if (next.top > previous.top + 2) {
        // Reveal the completed visual line and collect the new line underneath it.
        paint(previous, shown, previous.width)
        shown = 0
        deadline = performance.now() + 600
      } else if (!next.block.hasAttribute('data-stream-line')) {
        paint(next, shown, shown)
      }
      pending = next
      clearTimeout(timer)
      // Flush a short answer on a pause, and bound the wait even on a very wide line.
      timer = setTimeout(
        () => {
          paint(next, Math.min(shown, next.right), next.right)
          shown = next.right
          // Release the mask at rest so font changes and resizes can reflow freely.
          if (animation) {
            animation.onfinish = () => {
              if (pending === next) next.block.removeAttribute('data-stream-line')
            }
          } else {
            next.block.removeAttribute('data-stream-line')
          }
          deadline = performance.now() + 600
        },
        Math.max(0, Math.min(180, deadline - performance.now())),
      )
    },
  }
}

export function useStreamingLines(streaming: boolean, content: string) {
  const root = useRef<HTMLDivElement>(null)
  const reveal = useRef<ReturnType<typeof createLineReveal> | undefined>(undefined)
  useLayoutEffect(() => {
    const element = root.current
    if (!streaming || !element) return
    const controller = createLineReveal(element)
    reveal.current = controller
    return () => {
      controller.clear()
      reveal.current = undefined
    }
  }, [streaming])
  useLayoutEffect(() => reveal.current?.update(), [streaming, content])
  return root
}
