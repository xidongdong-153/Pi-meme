import * as React from 'react'
import { ErrorLine } from '@pi-meme/ui/components/error-line'
import { ArrowRight, ChevronLeft, ChevronRight, MessageCircleQuestionMark, Pencil, X } from 'lucide-react'
import type { PiExtensionUIResponse } from '@pi-meme/contracts/pi'
import type { PiUserInputRequest } from '@pi-meme/contracts/user-input'
import {
  collectQuestionAnswers,
  createQuestionDraft,
  questionAnswer,
  selectQuestionOption,
  writeQuestionDraft,
  type QuestionDraft,
  type UserInputDraft,
} from './user-input-state'

export type { UserInputDraft } from './user-input-state'

type UserInputPanelProps = {
  request: PiUserInputRequest
  onRespond: (id: string, response: PiExtensionUIResponse) => Promise<void>
  sourceName?: string
  draft?: UserInputDraft
  onDraft?: (draft: UserInputDraft) => void
}

export function UserInputPanel(props: UserInputPanelProps) {
  return <UserInputPanelContent key={props.request.id} {...props} />
}

function UserInputPanelContent({ request, onRespond, sourceName, draft: savedDraft, onDraft }: UserInputPanelProps) {
  const [state, setState] = React.useState<UserInputDraft>(
    () =>
      savedDraft ?? {
        currentIndex: 0,
        drafts: request.questions.map(createQuestionDraft),
      },
  )
  const { currentIndex: page, drafts } = state
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState('')
  const submission = React.useRef(false)
  const optionRefs = React.useRef<(HTMLButtonElement | null)[]>([])
  const headingId = React.useId()
  const question = request.questions[page]
  const draft = drafts[page]
  const lastPage = page === request.questions.length - 1
  const answered = question && draft ? questionAnswer(question, draft) !== undefined : false

  function updateState(next: UserInputDraft) {
    setState(next)
    onDraft?.(next)
  }

  function updateDraft(next: QuestionDraft) {
    updateState({ currentIndex: page, drafts: drafts.map((value, index) => (index === page ? next : value)) })
    setError('')
  }

  async function respond(response: PiExtensionUIResponse) {
    if (submission.current) return
    submission.current = true
    setSubmitting(true)
    setError('')
    try {
      await onRespond(request.id, response)
    } catch (cause) {
      submission.current = false
      setSubmitting(false)
      setError(`回复发送失败：${String(cause)}。可重试。`)
    }
  }

  function advance(skip = false) {
    if (submission.current || !question || !draft) return
    const nextDraft = skip ? { ...draft, skipped: true } : draft
    if (!questionAnswer(question, nextDraft)) return
    const nextDrafts = drafts.map((value, index) => (index === page ? nextDraft : value))
    setError('')
    if (!lastPage) {
      updateState({ currentIndex: page + 1, drafts: nextDrafts })
      return
    }
    updateState({ currentIndex: page, drafts: nextDrafts })
    const answers = collectQuestionAnswers(request.questions, nextDrafts)
    if (answers) {
      void respond({ answers })
    } else {
      const missing = request.questions.findIndex((item, index) => !questionAnswer(item, nextDrafts[index]))
      updateState({ currentIndex: missing, drafts: nextDrafts })
    }
  }

  if (!question || !draft) return null

  return (
    <section
      role="region"
      aria-label="Agent 提问"
      aria-busy={submitting}
      className="user-input-panel"
      onKeyDown={(event) => {
        if (
          submitting ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229 ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]'))
        ) {
          return
        }
        const index = Number(event.key) - 1
        if (/^[1-9]$/.test(event.key) && question.options?.[index]) {
          event.preventDefault()
          updateDraft(selectQuestionOption(index))
          optionRefs.current[index]?.focus()
        }
      }}
    >
      <header className="user-input-header">
        <div className="user-input-title">
          <MessageCircleQuestionMark aria-hidden="true" />
          <span>问题</span>
          {sourceName ? <span className="user-input-source">{sourceName}</span> : null}
        </div>
        <div className="user-input-navigation">
          {request.questions.length > 1 ? (
            <>
              <button
                type="button"
                className="user-input-nav-button"
                aria-label="上一题"
                disabled={submitting || page === 0}
                onClick={() => {
                  updateState({ currentIndex: page - 1, drafts })
                  setError('')
                }}
              >
                <ChevronLeft aria-hidden="true" />
              </button>
              <span
                role="status"
                aria-live="polite"
                aria-label={`第 ${page + 1} 题，共 ${request.questions.length} 题`}
                className="user-input-page"
              >
                {page + 1} of {request.questions.length}
              </span>
              <button
                type="button"
                className="user-input-nav-button"
                aria-label="下一题"
                disabled={submitting || lastPage || !answered}
                onClick={() => advance()}
              >
                <ChevronRight aria-hidden="true" />
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="user-input-nav-button user-input-close"
            aria-label="关闭问题"
            disabled={submitting}
            onClick={() => void respond({ cancelled: true })}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </header>
      <div key={question.id} className="user-input-content">
        <h2 id={headingId} className="user-input-question">
          {question.question}
        </h2>
        {question.options?.length ? (
          <div role="radiogroup" aria-labelledby={headingId} className="user-input-options">
            {question.options.map((option, index) => {
              const selected = !draft.skipped && !draft.text.trim() && draft.selectedIndex === index
              return (
                <button
                  key={index}
                  ref={(element) => {
                    optionRefs.current[index] = element
                  }}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={submitting}
                  tabIndex={index === (draft.selectedIndex ?? 0) ? 0 : -1}
                  className="user-input-option"
                  onClick={() => updateDraft(selectQuestionOption(index))}
                  onKeyDown={(event) => {
                    const count = question.options?.length ?? 0
                    let next: number
                    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % count
                    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + count) % count
                    else if (event.key === 'Home') next = 0
                    else if (event.key === 'End') next = count - 1
                    else return
                    event.preventDefault()
                    updateDraft(selectQuestionOption(next))
                    optionRefs.current[next]?.focus()
                  }}
                >
                  <span aria-hidden="true" className="user-input-number">
                    {index + 1}
                  </span>
                  <span className="user-input-option-text">
                    <span>{option.label}</span>
                    {option.description ? (
                      <span className="user-input-option-description">{option.description}</span>
                    ) : null}
                  </span>
                  <ArrowRight aria-hidden="true" className="user-input-option-arrow" />
                </button>
              )
            })}
          </div>
        ) : null}
      </div>
      <div className="user-input-footer">
        {error ? <ErrorLine message={error} className="user-input-error" /> : null}
        <div className="user-input-response">
          <Pencil aria-hidden="true" className="user-input-pencil" />
          <textarea
            aria-label="自行撰写回复"
            placeholder="或自行撰写回复"
            value={draft.text}
            disabled={submitting}
            rows={1}
            className="user-input-textarea"
            onChange={(event) => updateDraft(writeQuestionDraft(draft, event.target.value))}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault()
                advance()
              }
            }}
          />
          <div className="user-input-actions">
            <button type="button" className="user-input-skip" disabled={submitting} onClick={() => advance(true)}>
              跳过
            </button>
            <button
              type="button"
              className="user-input-send"
              disabled={submitting || !answered}
              onClick={() => advance()}
            >
              {submitting ? '发送中…' : lastPage ? '发送' : '下一步'}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
