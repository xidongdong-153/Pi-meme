import { MessageCircleQuestionMark } from 'lucide-react'
import { ErrorLine } from '@pi-meme/ui/components/error-line'
import { cn } from '@pi-meme/ui/lib/utils'
import {
  validateUserInputQuestions,
  validateUserInputAnswers,
  type UserInputQuestion,
  type UserInputResult,
} from '@pi-meme/contracts/user-input'
import type { ActivityItem } from '../model/types'
import { formatDetailValue } from '../model/tool-details'
import { userMessageBubbleClassName } from './user-message-bubble'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function questionResult(value: unknown, questions: UserInputQuestion[]): UserInputResult | undefined {
  const result = record(value)
  const details = record(result.details ?? result)
  if (details.cancelled === true) return { answers: [], cancelled: true }
  try {
    validateUserInputAnswers(details.answers, questions)
    return { answers: details.answers, cancelled: false }
  } catch {
    return undefined
  }
}

export function QuestionAnswerRow({
  item,
  isLive = true,
  isPaused = false,
}: {
  item: ActivityItem
  isLive?: boolean
  isPaused?: boolean
}) {
  if (item.type === 'thinking' || item.type === 'narration') return null
  const questions = record(item.args).questions
  try {
    validateUserInputQuestions(questions)
  } catch {
    return item.status === 'running' ? (
      <p role="status" className="conversation-event text-muted-foreground">
        正在准备问题…
      </p>
    ) : (
      <ErrorLine message="提问内容无效" />
    )
  }
  const result = item.status === 'error' ? undefined : questionResult(item.result, questions)
  const answers = new Map(result?.answers.map((answer) => [answer.id, answer.value]))
  const waiting = isLive && item.status === 'running'

  return (
    <section aria-label="交互式提问记录" className="min-w-0 space-y-3">
      {result && !result.cancelled ? (
        <div className="flex justify-end">
          <dl
            className={cn(
              userMessageBubbleClassName,
              'min-w-0 max-w-[85%] space-y-4 leading-[var(--conversation-line-height,1.72)] [overflow-wrap:anywhere]',
            )}
          >
            {questions.map((question) => (
              <div key={question.id} className="space-y-1 whitespace-pre-wrap">
                <dt className="opacity-70">{question.question}</dt>
                <dd>{answers.get(question.id) ?? '已跳过'}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : (
        <>
          <div className="conversation-event flex items-center gap-2 text-muted-foreground">
            <MessageCircleQuestionMark aria-hidden="true" className="size-[1.15em] shrink-0" />
            <span role="status">
              {item.status === 'error'
                ? '提问失败'
                : result?.cancelled
                  ? '已取消提问'
                  : waiting
                    ? isPaused
                      ? '已暂停提问'
                      : '等待你的回答'
                    : item.status === 'success'
                      ? '此历史记录未保存回答'
                      : '提问已结束，未收到回答'}
            </span>
          </div>
          <div className="space-y-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {questions.map((question) => (
              <p key={question.id}>{question.question}</p>
            ))}
          </div>
          {item.status === 'error' && <ErrorLine message={formatDetailValue(item.result) || '未能完成提问'} />}
        </>
      )}
    </section>
  )
}
