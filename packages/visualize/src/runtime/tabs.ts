const listSelector = '[role="tablist"], [data-tab-list], .nav-tabs, .tabs'
const tabSelector = '[role="tab"], [data-tab], [data-tab-target], .nav-link, .nav-tab, .tab'

function attribute(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value)
}

function tabsIn(list: Element) {
  return Array.from(list.querySelectorAll<HTMLElement>(tabSelector)).filter((tab) => tab.closest(listSelector) === list)
}

function disabled(tab: HTMLElement) {
  return tab.matches(':disabled, [aria-disabled="true"], [hidden]')
}

function panelFor(tab: HTMLElement) {
  const target = tab.getAttribute('aria-controls') || tab.dataset.tabTarget || tab.dataset.tab
  return target ? document.getElementById(target.replace(/^#/, '')) : null
}

let nextTab = 0

function select(list: Element, selected: HTMLElement | undefined, emit = false) {
  const tabs = tabsIn(list)
  const previous = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')
  for (const tab of tabs) {
    const active = tab === selected
    attribute(tab, 'role', 'tab')
    attribute(tab, 'aria-selected', String(active))
    attribute(tab, 'tabindex', active ? '0' : '-1')
    if (tab.classList.contains('active') !== active) tab.classList.toggle('active', active)
    if (!tab.id) tab.id = `pi-viz-tab-${++nextTab}`
    if (tab instanceof HTMLButtonElement && !tab.hasAttribute('type')) tab.type = 'button'
    const panel = panelFor(tab)
    if (!panel) continue
    attribute(tab, 'aria-controls', panel.id)
    attribute(panel, 'role', 'tabpanel')
    attribute(panel, 'aria-labelledby', tab.id)
    if (!panel.hasAttribute('tabindex')) panel.tabIndex = 0
    if (panel.hidden === active) panel.hidden = !active
  }
  if (emit && selected && previous !== selected)
    selected.dispatchEvent(
      new CustomEvent('tabchange', {
        bubbles: true,
        detail: { value: selected.dataset.tab ?? panelFor(selected)?.id, tab: selected, panel: panelFor(selected) },
      }),
    )
}

export function installTabs(root: HTMLElement) {
  const refresh = () => {
    for (const list of root.querySelectorAll<HTMLElement>(listSelector)) {
      const tabs = tabsIn(list)
      if (!tabs.length) continue
      attribute(list, 'role', 'tablist')
      const enabled = tabs.filter((tab) => !disabled(tab))
      const selected =
        enabled.find((tab) => tab.getAttribute('aria-selected') === 'true') ??
        enabled.find((tab) => tab.classList.contains('active')) ??
        enabled[0]
      select(list, selected)
    }
  }
  const findTab = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return
    const tab = target.closest<HTMLElement>(tabSelector)
    const list = tab?.closest<HTMLElement>(listSelector)
    return tab && list && root.contains(list) && !disabled(tab) ? { tab, list } : undefined
  }
  const click = (event: MouseEvent) => {
    const found = findTab(event.target)
    if (!found) return
    event.preventDefault()
    select(found.list, found.tab, true)
  }
  const keydown = (event: KeyboardEvent) => {
    const found = findTab(event.target)
    if (!found || event.altKey || event.ctrlKey || event.metaKey) return
    const { tab, list } = found
    const tabs = tabsIn(list).filter((item) => !disabled(item))
    const vertical = list.getAttribute('aria-orientation') === 'vertical'
    const rtl = getComputedStyle(list).direction === 'rtl'
    let destination: HTMLElement | undefined
    if (event.key === 'Home') destination = tabs[0]
    if (event.key === 'End') destination = tabs.at(-1)
    const forward = vertical ? 'ArrowDown' : rtl ? 'ArrowLeft' : 'ArrowRight'
    const backward = vertical ? 'ArrowUp' : rtl ? 'ArrowRight' : 'ArrowLeft'
    if (event.key === forward || event.key === backward) {
      const step = event.key === forward ? 1 : -1
      destination = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length]
    }
    if (destination) {
      event.preventDefault()
      if (list.dataset.activation === 'manual') {
        for (const item of tabs) attribute(item, 'tabindex', item === destination ? '0' : '-1')
      } else select(list, destination, true)
      destination.focus({ preventScroll: true })
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      select(list, tab, true)
    }
  }
  root.addEventListener('click', click)
  root.addEventListener('keydown', keydown)
  return {
    refresh,
    dispose: () => {
      root.removeEventListener('click', click)
      root.removeEventListener('keydown', keydown)
    },
  }
}
