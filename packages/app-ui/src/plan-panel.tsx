import { useState } from 'react'
import type { PlanDocument } from '@pi-meme/contracts/plan'
import { MarkdownContent } from '@pi-meme/chat/ui/content/markdown-content'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'

function SavedPlanDocument({ document }: { document: PlanDocument }) {
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  function download() {
    const url = URL.createObjectURL(new Blob([document.markdown], { type: 'text/markdown;charset=utf-8' }))
    const link = globalThis.document.createElement('a')
    link.href = url
    link.download = `${document.title.replace(/[\\/:*?"<>|]/g, '-').trim() || '计划'}.md`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <section
      aria-label={`已保存计划：${document.title}`}
      className="space-y-3 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{document.title}</h3>
        <span className="text-xs text-muted-foreground">已保存 · 第 {document.revision} 版</span>
      </div>
      <MarkdownContent>{document.markdown}</MarkdownContent>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigator.clipboard
              .writeText(document.markdown)
              .then(() => setCopied(true))
              .catch((cause) => setError(`无法复制计划：${String(cause)}`))
          }
        >
          {copied ? '已复制' : '复制'}
        </Button>
        <Button size="sm" variant="outline" onClick={download}>
          导出 Markdown
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}

export function PlanPanel({
  documents,
  selectedId,
  onSelect,
}: {
  documents: PlanDocument[]
  selectedId?: string
  onSelect: (id: string) => void
}) {
  const ordered = [...documents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const document = ordered.find((item) => item.id === selectedId) ?? ordered[0]
  return (
    <div aria-label="计划文档" className="min-h-0 flex-1 overflow-y-auto p-3 [overflow-wrap:anywhere]">
      {!document ? (
        <p className="text-sm text-muted-foreground">当前会话还没有保存的计划。</p>
      ) : (
        <>
          {ordered.length > 1 && (
            <Select value={document.id} onValueChange={onSelect}>
              <SelectTrigger aria-label="选择计划文档" className="mb-3 h-8 bg-background text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="w-[var(--radix-select-trigger-width)]">
                {ordered.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title} · 第 {item.revision} 版
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <SavedPlanDocument key={`${document.id}:${document.revision}`} document={document} />
        </>
      )}
    </div>
  )
}
