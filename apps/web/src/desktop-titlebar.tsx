import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DesktopWindowCommand, PlatformAdapter } from '@pi-meme/contracts/host'
import { BrandMark } from '@pi-meme/ui/components/brand-mark'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import './desktop-titlebar.css'

type MenuItem = { command: DesktopWindowCommand; label: string; shortcut?: string }
const menus: { label: string; groups: MenuItem[][] }[] = [
  {
    label: '文件',
    groups: [
      [
        { command: 'close', label: '关闭窗口', shortcut: 'Ctrl+W' },
        { command: 'quit', label: '退出', shortcut: 'Alt+F4' },
      ],
    ],
  },
  {
    label: '编辑',
    groups: [
      [
        { command: 'undo', label: '撤销', shortcut: 'Ctrl+Z' },
        { command: 'redo', label: '重做', shortcut: 'Ctrl+Y' },
      ],
      [
        { command: 'cut', label: '剪切', shortcut: 'Ctrl+X' },
        { command: 'copy', label: '复制', shortcut: 'Ctrl+C' },
        { command: 'paste', label: '粘贴', shortcut: 'Ctrl+V' },
        { command: 'selectAll', label: '全选', shortcut: 'Ctrl+A' },
      ],
    ],
  },
  {
    label: '视图',
    groups: [
      [
        { command: 'reload', label: '重新加载', shortcut: 'Ctrl+R' },
        { command: 'forceReload', label: '强制重新加载', shortcut: 'Ctrl+Shift+R' },
        { command: 'toggleDevTools', label: '开发者工具', shortcut: 'Ctrl+Shift+I' },
      ],
      [
        { command: 'resetZoom', label: '实际大小', shortcut: 'Ctrl+0' },
        { command: 'zoomIn', label: '放大', shortcut: 'Ctrl++' },
        { command: 'zoomOut', label: '缩小', shortcut: 'Ctrl+-' },
      ],
      [{ command: 'toggleFullscreen', label: '切换全屏', shortcut: 'F11' }],
    ],
  },
  { label: '帮助', groups: [[{ command: 'about', label: '关于 Pi meme' }]] },
]

export function DesktopTitleBar({ platform }: { platform: NonNullable<PlatformAdapter['titleBar']> }) {
  const header = useRef<HTMLElement>(null)
  const triggers = useRef<(HTMLButtonElement | null)[]>([])
  const previousFocus = useRef<HTMLElement | null>(null)
  const pendingCommand = useRef<{ command: DesktopWindowCommand; menu: number } | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  const [focused, setFocused] = useState(0)
  const [error, setError] = useState('')

  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.desktopTitlebar = ''
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const color = (value: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      return `#${[...context.getImageData(0, 0, 1, 1).data]
        .slice(0, 3)
        .map((part) => part.toString(16).padStart(2, '0'))
        .join('')}`
    }
    let lastColors = ''
    const sync = () => {
      if (!header.current) return
      const style = getComputedStyle(header.current)
      const background = color(style.backgroundColor)
      const foreground = color(style.color)
      const colors = background + foreground
      if (colors === lastColors) return
      lastColors = colors
      void platform
        .update({ background, foreground })
        .catch((cause: unknown) => setError(`标题栏主题更新失败：${String(cause)}`))
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['style', 'data-appearance'] })
    return () => {
      observer.disconnect()
      delete root.dataset.desktopTitlebar
    }
  }, [platform])

  function move(index: number, expand = open !== null) {
    const next = (index + menus.length) % menus.length
    setFocused(next)
    if (!expand) triggers.current[next]?.focus()
    setOpen(expand ? next : null)
  }

  useEffect(() => {
    const focusMenu = (event: KeyboardEvent) => {
      if (event.key !== 'F10' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return
      event.preventDefault()
      if (document.activeElement instanceof HTMLElement) previousFocus.current = document.activeElement
      triggers.current[0]?.focus()
      setFocused(0)
    }
    window.addEventListener('keydown', focusMenu)
    return () => window.removeEventListener('keydown', focusMenu)
  }, [])

  function execute(command: DesktopWindowCommand, menu: number) {
    setError('')
    pendingCommand.current = { command, menu }
    setOpen(null)
  }

  return (
    <header
      ref={header}
      className="desktop-titlebar window-drag"
      aria-label="Pi meme 标题栏"
      onPointerDownCapture={() => {
        if (
          document.activeElement instanceof HTMLElement &&
          !header.current?.contains(document.activeElement) &&
          !document.activeElement.closest('[role="menu"]')
        )
          previousFocus.current = document.activeElement
      }}
      onFocusCapture={(event) => {
        if (
          event.relatedTarget instanceof HTMLElement &&
          !header.current?.contains(event.relatedTarget) &&
          !event.relatedTarget.closest('[role="menu"]') &&
          open === null
        )
          previousFocus.current = event.relatedTarget
      }}
    >
      <span className="desktop-titlebar-brand" title="Pi meme">
        <BrandMark size={21} />
      </span>
      <nav role="menubar" aria-label="应用菜单" className="desktop-titlebar-menus no-drag">
        {menus.map((menu, index) => (
          <DropdownMenu
            key={menu.label}
            modal={false}
            open={open === index}
            onOpenChange={(value) => setOpen((current) => (value ? index : current === index ? null : current))}
          >
            <DropdownMenuTrigger asChild>
              <button
                ref={(element) => {
                  triggers.current[index] = element
                }}
                type="button"
                role="menuitem"
                tabIndex={focused === index ? 0 : -1}
                className="desktop-titlebar-trigger"
                onFocus={() => setFocused(index)}
                onPointerEnter={() => {
                  if (open !== null && open !== index) move(index, true)
                }}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  move(
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? menus.length - 1
                        : index + (event.key === 'ArrowRight' ? 1 : -1),
                  )
                }}
              >
                {menu.label}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="bottom"
              align="start"
              sideOffset={3}
              className="desktop-titlebar-menu no-drag"
              onCloseAutoFocus={(event) => {
                const pending = pendingCommand.current
                if (pending?.menu === index) {
                  event.preventDefault()
                  pendingCommand.current = null
                  previousFocus.current?.focus({ preventScroll: true })
                  void platform
                    .execute(pending.command)
                    .catch((cause: unknown) => setError(`窗口操作失败：${String(cause)}`))
                } else if (openRef.current !== null) event.preventDefault()
              }}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                move(index + (event.key === 'ArrowRight' ? 1 : -1), true)
              }}
            >
              {menu.groups.map((group, groupIndex) => (
                <div key={groupIndex} role="group">
                  {groupIndex > 0 && <DropdownMenuSeparator />}
                  {group.map((item) => (
                    <DropdownMenuItem key={item.command} onSelect={() => execute(item.command, index)}>
                      <span className="flex-1">{item.label}</span>
                      {item.shortcut && <span className="ml-6 text-muted-foreground text-[11px]">{item.shortcut}</span>}
                    </DropdownMenuItem>
                  ))}
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
      </nav>
      {error && (
        <p role="alert" className="desktop-titlebar-error no-drag">
          {error}
        </p>
      )}
    </header>
  )
}
