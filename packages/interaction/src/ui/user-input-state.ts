import type { UserInputAnswer, UserInputQuestion } from '@pi-meme/contracts/user-input'

export type QuestionDraft = {
  selectedIndex: number | null
  text: string
  skipped: boolean
}

export type UserInputDraft = {
  currentIndex: number
  drafts: QuestionDraft[]
}

export function createQuestionDraft(): QuestionDraft {
  return { selectedIndex: null, text: '', skipped: false }
}

export function selectQuestionOption(index: number): QuestionDraft {
  return { selectedIndex: index, text: '', skipped: false }
}

export function writeQuestionDraft(draft: QuestionDraft, text: string): QuestionDraft {
  return { ...draft, text, selectedIndex: text.trim() ? null : draft.selectedIndex, skipped: false }
}

export function questionAnswer(question: UserInputQuestion, draft: QuestionDraft): UserInputAnswer | undefined {
  if (draft.skipped) return { id: question.id, value: null }
  const text = draft.text.trim()
  if (text) return { id: question.id, value: text }
  const option = draft.selectedIndex === null ? undefined : question.options?.[draft.selectedIndex]
  return option ? { id: question.id, value: option.label } : undefined
}

export function collectQuestionAnswers(
  questions: UserInputQuestion[],
  drafts: QuestionDraft[],
): UserInputAnswer[] | undefined {
  const answers: UserInputAnswer[] = []
  for (const [index, question] of questions.entries()) {
    const answer = questionAnswer(question, drafts[index] ?? createQuestionDraft())
    if (!answer) return undefined
    answers.push(answer)
  }
  return answers
}
