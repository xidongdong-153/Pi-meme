export function installTooltips(root: HTMLElement) {
  const tooltip = document.createElement('div')
  tooltip.id = `pi-viz-tooltip-${crypto.randomUUID()}`
  tooltip.className = 'viz-tooltip'
  tooltip.setAttribute('role', 'tooltip')
  tooltip.setAttribute('data-viz-capture-exclude', '')
  tooltip.hidden = true
  document.body.append(tooltip)
  let owner: HTMLElement | undefined
  let timer: number | undefined
  let described = false

  const hide = () => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = undefined
    if (owner && described) {
      const ids = (owner.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id && id !== tooltip.id)
      if (ids.length) owner.setAttribute('aria-describedby', ids.join(' '))
      else owner.removeAttribute('aria-describedby')
    }
    described = false
    owner = undefined
    tooltip.hidden = true
  }
  const locate = (target: EventTarget | null) => {
    const node = target instanceof Element ? target.closest<HTMLElement>('[data-tooltip]') : null
    return node && root.contains(node) ? node : undefined
  }
  const show = (target: HTMLElement, immediate: boolean) => {
    if (target === owner) return
    hide()
    const text = target.dataset.tooltip?.trim().slice(0, 2000)
    if (!text) return
    owner = target
    const reveal = () => {
      timer = undefined
      if (!target.isConnected || owner !== target) return
      tooltip.textContent = text
      tooltip.hidden = false
      const anchor = target.getBoundingClientRect()
      const bounds = tooltip.getBoundingClientRect()
      const gutter = 8
      const viewportWidth = document.documentElement.clientWidth
      let top = anchor.top - bounds.height - gutter
      if (target.dataset.tooltipSide === 'bottom' || top < gutter) top = anchor.bottom + gutter
      top = Math.max(gutter, Math.min(top, window.innerHeight - bounds.height - gutter))
      const left = Math.max(
        gutter,
        Math.min(anchor.left + (anchor.width - bounds.width) / 2, viewportWidth - bounds.width - gutter),
      )
      tooltip.style.left = `${left}px`
      tooltip.style.top = `${top}px`
      const ids = target.getAttribute('aria-describedby')?.trim()
      target.setAttribute('aria-describedby', ids ? `${ids} ${tooltip.id}` : tooltip.id)
      described = true
    }
    if (immediate) reveal()
    else timer = window.setTimeout(reveal, 300)
  }
  const over = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return
    const target = locate(event.target)
    if (target) show(target, false)
  }
  const out = (event: PointerEvent) => {
    if (owner && (!(event.relatedTarget instanceof Node) || !owner.contains(event.relatedTarget))) hide()
  }
  const focus = (event: FocusEvent) => {
    const target = locate(event.target)
    if (target) show(target, true)
  }
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') hide()
  }
  root.addEventListener('pointerover', over)
  root.addEventListener('pointerout', out)
  root.addEventListener('focusin', focus)
  root.addEventListener('focusout', hide)
  root.addEventListener('input', hide)
  root.addEventListener('pointerdown', hide)
  document.addEventListener('scroll', hide, true)
  document.addEventListener('keydown', key)
  window.addEventListener('resize', hide)
  return {
    refresh: () => {
      if (owner && (!owner.isConnected || owner.dataset.tooltip?.trim().slice(0, 2000) !== tooltip.textContent)) hide()
    },
    hide,
    dispose: () => {
      hide()
      tooltip.remove()
      root.removeEventListener('pointerover', over)
      root.removeEventListener('pointerout', out)
      root.removeEventListener('focusin', focus)
      root.removeEventListener('focusout', hide)
      root.removeEventListener('input', hide)
      root.removeEventListener('pointerdown', hide)
      document.removeEventListener('scroll', hide, true)
      document.removeEventListener('keydown', key)
      window.removeEventListener('resize', hide)
    },
  }
}
