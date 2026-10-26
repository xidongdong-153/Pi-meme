import { useState } from 'react'
import { downloadPlan } from './plan-card'
import type { PlanDocument } from '@pi-meme/contracts/plan'
import { MarkdownContent } from '@pi-meme/chat/ui/content/markdown-content'
import { Button } from '@pi-meme/ui/components/ui/button'

function SavedPlanDocument({ document }: { document: PlanDocument }) {
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  return (
    <section
      aria-label={`已保存计划：${document.title}`}
      className="space-y-3 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{document.title}</h3>
        <span className="text-xs text-muted-foreground">已保存</span>
      </div>
      <MarkdownContent>{document.markdown}</MarkdownContent>
      <div className="flex flex-wrap gap-2">
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
        <Button size="sm" variant="outline" onClick={() => downloadPlan(document)}>
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

export function PlanPanel({ documents }: { documents: PlanDocument[] }) {
  const document = documents.at(-1)
  return (
    <div aria-label="计划文档" className="min-h-0 flex-1 overflow-y-auto p-3 [overflow-wrap:anywhere]">
      {!document ? (
        <p className="text-sm text-muted-foreground">当前会话还没有保存的计划。</p>
      ) : (
        <SavedPlanDocument key={`${document.id}:${document.revision}`} document={document} />
      )}
    </div>
  )
}
