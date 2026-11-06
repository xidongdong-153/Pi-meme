// Original model logos from Magpie (MIT © 2026 yetone).
const labs: Array<{ pattern: RegExp; src: string; mono?: boolean }> = [
  { pattern: /claude/, src: new URL('./icons/claude-color.svg', import.meta.url).href },
  { pattern: /gpt|^o\d|codex/, src: new URL('./icons/openai.svg', import.meta.url).href, mono: true },
  { pattern: /gemma/, src: new URL('./icons/gemma-color.svg', import.meta.url).href },
  { pattern: /gemini/, src: new URL('./icons/gemini-color.svg', import.meta.url).href },
  { pattern: /deepseek/, src: new URL('./icons/deepseek-color.svg', import.meta.url).href },
  { pattern: /qwen|qwq/, src: new URL('./icons/qwen-color.svg', import.meta.url).href },
  { pattern: /kimi|moonshot/, src: new URL('./icons/kimi.svg', import.meta.url).href, mono: true },
  { pattern: /glm/, src: new URL('./icons/zhipu-color.svg', import.meta.url).href },
  { pattern: /grok/, src: new URL('./icons/grok.svg', import.meta.url).href, mono: true },
  { pattern: /minimax|abab/, src: new URL('./icons/minimax-color.svg', import.meta.url).href },
  { pattern: /doubao|seed/, src: new URL('./icons/doubao-color.svg', import.meta.url).href },
  { pattern: /stral/, src: new URL('./icons/mistral-color.svg', import.meta.url).href },
  { pattern: /llama/, src: new URL('./icons/meta-color.svg', import.meta.url).href },
  { pattern: /mimo/, src: new URL('./icons/xiaomimimo.svg', import.meta.url).href, mono: true },
  { pattern: /^step/, src: new URL('./icons/stepfun-color.svg', import.meta.url).href },
  { pattern: /hunyuan/, src: new URL('./icons/hunyuan-color.svg', import.meta.url).href },
]
export function ModelIcon({ model }: { model: string }) {
  const name = model.toLowerCase().split('/').pop() ?? ''
  const lab = labs.find((one) => one.pattern.test(name))
  return lab ? (
    <img
      src={lab.src}
      alt=""
      aria-hidden="true"
      className={`ctx-model-icon${lab.mono ? ' mono' : ''}`}
      width={12}
      height={12}
    />
  ) : null
}
