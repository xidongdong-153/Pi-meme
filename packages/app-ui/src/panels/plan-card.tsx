import { useState } from 'react'
import { Check, Copy, Download, Lightbulb, PanelRightOpen } from 'lucide-react'
import type { PlanDocument } from '@pi-meme/contracts/plan'
import { MarkdownContent } from '@pi-meme/chat/ui/content/markdown-content'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'

export function downloadPlan(document: PlanDocument) {
  const url = URL.createObjectURL(new Blob([document.markdown], { type: 'text/markdown;charset=utf-8' }))
  const link = globalThis.document.createElement('a')
  link.href = url
  link.download = `${document.title.replace(/[\\/:*?"<>|]/g, '-').trim() || '计划'}.md`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function PlanCard({ document, onOpen }: { document: PlanDocument; onOpen: () => void }) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const actions = [
    { label: '保存计划', icon: Download, run: () => downloadPlan(document) },
    {
      label: copied ? '已复制' : '复制完整计划',
      icon: copied ? Check : Copy,
      run: () =>
        void navigator.clipboard
          .writeText(document.markdown)
          .then(() => setCopied(true))
          .catch((cause) => setError(`无法复制计划：${String(cause)}`)),
    },
    { label: '在侧栏打开完整计划', icon: PanelRightOpen, run: onOpen },
  ]
  return (
    <section
      aria-label={`计划节选：${document.title}`}
      className="my-2 overflow-hidden rounded-xl border border-border/70 bg-foreground/[0.035]"
    >
      <header className="flex items-center justify-between gap-2 px-4 pt-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Lightbulb className="size-4" />
          计划 · 第 {document.revision} 版
        </span>
        <div className="flex gap-0.5">
          {actions.map(({ label, icon: Icon, run }) => (
            <Tooltip key={label}>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={label} onClick={run}>
                  <Icon className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </header>
      <div
        className="relative max-h-40 overflow-hidden px-4 pb-5 pt-2 [mask-image:linear-gradient(to_bottom,black_65%,transparent)] [&_.pi-h1]:mb-4! [&_.pi-h1]:border-0! [&_.pi-h1]:pb-0! [&_.pi-h1]:text-xl! [&_.pi-h2]:mt-4! [&_.pi-h2]:mb-1.5! [&_.pi-h2]:border-0! [&_.pi-h2]:text-lg!"
        aria-label="计划内容节选"
      >
        <MarkdownContent>{document.markdown.slice(0, 1800)}</MarkdownContent>
      </div>
      {error && (
        <p role="alert" className="px-4 pb-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
