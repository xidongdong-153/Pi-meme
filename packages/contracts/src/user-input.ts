export type UserInputQuestion = {
  id: string
  question: string
  options?: Array<{ label: string; description?: string }>
}
export type UserInputAnswer = { id: string; value: string | null }
export type UserInputResult = { answers: UserInputAnswer[]; cancelled: boolean }
export type PiUserInputRequest = {
  type: 'extension_ui_request'
  id: string
  method: 'questions'
  questions: UserInputQuestion[]
  timeout?: number
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key))
}

export function validateUserInputQuestions(value: unknown): asserts value is UserInputQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error('提问必须包含 1 到 3 道题')
  const ids = new Set<string>()
  for (const question of value) {
    if (
      !object(question) ||
      !keys(question, ['id', 'question', 'options']) ||
      !text(question.id) ||
      !text(question.question)
    )
      throw new Error('每道题必须包含非空 id 和问题正文')
    if (ids.has(question.id)) throw new Error('题目 id 不能重复')
    ids.add(question.id)
    if (question.options !== undefined) {
      if (!Array.isArray(question.options) || !question.options.length) throw new Error('题目选项不能为空')
      const labels = new Set<string>()
      for (const option of question.options) {
        if (
          !object(option) ||
          !keys(option, ['label', 'description']) ||
          !text(option.label) ||
          (option.description !== undefined && !text(option.description))
        )
          throw new Error('选项必须包含非空 label，说明不能留空')
        if (labels.has(option.label)) throw new Error('同一道题的选项 label 不能重复')
        labels.add(option.label)
      }
    }
  }
}

export function validateUserInputAnswers(
  value: unknown,
  questions?: UserInputQuestion[],
): asserts value is UserInputAnswer[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error('回答必须包含 1 到 3 道题的答案')
  const ids = new Set<string>()
  for (const answer of value) {
    if (
      !object(answer) ||
      !keys(answer, ['id', 'value']) ||
      !text(answer.id) ||
      (answer.value !== null && !text(answer.value))
    )
      throw new Error('答案必须包含题目 id，值为非空文本或 null')
    if (ids.has(answer.id)) throw new Error('答案题目 id 不能重复')
    ids.add(answer.id)
  }
  if (questions && (value.length !== questions.length || questions.some((question) => !ids.has(question.id))))
    throw new Error('答案必须恰好对应请求中的每道题')
}

export function validateExtensionUIResponse(value: unknown): asserts value is import('./pi').PiExtensionUIResponse {
  if (!object(value) || Object.keys(value).length !== 1) throw new Error('扩展交互响应无效')
  if (value.cancelled === true || typeof value.value === 'string' || typeof value.confirmed === 'boolean') return
  if ('answers' in value) {
    validateUserInputAnswers(value.answers)
    return
  }
  throw new Error('扩展交互响应无效')
}

export function validateExtensionDialogResponse(
  request: import('./pi').PiExtensionDialogRequest,
  response: unknown,
): asserts response is import('./pi').PiExtensionUIResponse {
  validateExtensionUIResponse(response)
  if ('cancelled' in response) return
  if (request.method === 'questions') {
    if (!('answers' in response)) throw new Error('多题交互必须使用 answers 回答')
    validateUserInputAnswers(response.answers, request.questions)
  } else if (request.method === 'confirm') {
    if (!('confirmed' in response)) throw new Error('确认弹窗响应无效')
  } else {
    if (!('value' in response)) throw new Error('扩展弹窗响应无效')
    if (request.method === 'select' && !request.options.includes(response.value))
      throw new Error('所选项不在弹窗选项内')
  }
}
