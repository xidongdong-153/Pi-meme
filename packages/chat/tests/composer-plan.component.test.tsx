import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createElement, type KeyboardEvent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { builtinCommands, type PiSlashCommand } from '@pi-meme/contracts/pi'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { Composer, type ComposerProps } from '../src/ui/composer/composer'
import { useCommandCompletion } from '../src/ui/composer/use-command-completion'

function completion(
  draft: string,
  commands: PiSlashCommand[] = builtinCommands,
  options?: { editing?: boolean; agentPlugins?: ComposerProps['agentPlugins'] },
) {
  let result!: ReturnType<typeof useCommandCompletion>
  const accepted: string[] = []
  const changedDrafts: string[] = []
  const skill: PiSlashCommand = { ...builtinCommands[0], name: 'skill:verify', source: 'skill' }
  function Capture() {
    result = useCommandCompletion({
      draft,
      commands: [...commands, skill],
      agentPlugins: options?.agentPlugins,
      editing: options?.editing,
      onPlanCommand: (text) => accepted.push(text),
      onDraft: (text) => changedDrafts.push(text),
      onSkills: () => {},
      selectedSkills: [],
      focusVersion: 0,
      onClearQueue: () => {},
      hasQueue: false,
    })
    return null
  }
  render(createElement(Capture))
  return { result, accepted, changedDrafts }
}

afterEach(cleanup)

test('斜杠候选仅有一个 plan，中文前缀匹配该候选且技能保持', () => {
  assert.deepEqual(
    completion('/').result.matches.map((item) => (item.kind === 'plugin' ? item.plugin.id : item.command.name)),
    ['plan', 'goal', 'compact', 'name', 'skill:verify'],
  )
  for (const draft of ['/p', '/pl', '/plan', '/计', '/计划', '/计划模', '/计划模式'])
    assert.deepEqual(
      completion(draft).result.matches.map((item) => (item.kind === 'plugin' ? item.plugin.id : item.command.name)),
      ['plan'],
      draft,
    )
  assert.deepEqual(
    completion('$ver').result.matches.map((item) => (item.kind === 'plugin' ? item.plugin.id : item.command.name)),
    ['skill:verify'],
  )
  assert.equal(completion('正文 /计划').result.matches.length, 0)
  assert.equal(completion('/计划外').result.matches.length, 0)
})

test('中文计划候选沿用 Enter、Tab 与鼠标选择，IME和Shift+Enter不接受候选', () => {
  const original = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = () => 0
  try {
    for (const key of ['Enter', 'Tab', 'click', 'IME', '229', 'Shift+Enter']) {
      const { result, accepted, changedDrafts } = completion('/计划模')
      if (key === 'click') result.completeItem(result.matches[0])
      else
        result.keyDown({
          key: key === 'Tab' ? 'Tab' : 'Enter',
          keyCode: key === '229' ? 229 : 13,
          shiftKey: key === 'Shift+Enter',
          nativeEvent: { isComposing: key === 'IME' },
          preventDefault: () => {},
        } as unknown as KeyboardEvent<HTMLDivElement>)
      assert.deepEqual(accepted, ['Enter', 'Tab', 'click'].includes(key) ? ['/plan '] : [], key)
      assert.deepEqual(changedDrafts, [], key)
    }
  } finally {
    globalThis.requestAnimationFrame = original
  }
})

test('旧Host的builtin计划别名合并为canonical候选，Enter、Tab与鼠标均启用而不写入命令草稿', () => {
  const plan = builtinCommands[0]
  const chinese = { ...plan, name: '计划', description: '旧中文命令' }
  const old = { ...plan, name: '计划模式', description: '旧中文命令' }
  const original = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = () => 0
  try {
    for (const commands of [[plan, old], [old], [old, plan], [plan, plan, old], [chinese, old, plan]]) {
      const choices = completion('/', commands).result.matches.flatMap((item) =>
        item.kind !== 'plugin' && item.command.source === 'builtin' ? [item.command] : [],
      )
      assert.deepEqual(
        choices.map((command) => command.name),
        ['plan'],
      )
      if (commands.includes(plan)) assert.equal(choices[0], plan)
      for (const method of ['Enter', 'Tab', 'click']) {
        const { result, accepted, changedDrafts } = completion('/计', commands)
        if (method === 'click') result.completeItem(result.matches[0])
        else result.keyDown({ key: method, nativeEvent: {}, preventDefault: () => {} } as KeyboardEvent<HTMLDivElement>)
        assert.deepEqual(accepted, ['/plan '], method)
        assert.deepEqual(changedDrafts, [], method)
      }
    }
  } finally {
    globalThis.requestAnimationFrame = original
  }
})

test('合并旧builtin计划命令不隐藏同名外部命令或技能', () => {
  const plan = builtinCommands[0]
  const commands: PiSlashCommand[] = [
    { ...plan, name: '计划模式' },
    plan,
    { ...plan, source: 'extension' },
    { ...plan, name: '计划模式', source: 'extension' },
    { ...plan, name: 'skill:计划模式', source: 'skill' },
  ]
  assert.deepEqual(
    completion('/', commands).result.matches.map((item) =>
      item.kind === 'plugin' ? ['plugin', item.plugin.id] : [item.command.source, item.command.name],
    ),
    [
      ['builtin', 'plan'],
      ['extension', 'plan'],
      ['extension', '计划模式'],
      ['skill', 'skill:计划模式'],
      ['skill', 'skill:verify'],
    ],
  )
})

function composerProps(): ComposerProps {
  return {
    mode: 'default',
    onMode: () => {},
    draft: '保留草稿',
    onDraft: () => {},
    selectedSkills: [],
    onSkills: () => {},
    attachments: [],
    uploadAttachment: async () => ({ name: 'file', path: '/attachments/file' }),
    onAddImages: () => {},
    onRemoveImage: () => {},
    running: false,
    disabled: false,
    queueMode: 'steering',
    onQueueMode: () => {},
    onSteeringMode: () => {},
    onFollowUpMode: () => {},
    queues: { steering: [], followUp: [] },
    onSend: () => {},
    onStop: () => {},
    onClearQueue: () => {},
    commands: builtinCommands,
    widgetsAbove: null,
    widgetsBelow: null,
    statusBadges: null,
    focusVersion: 0,
    onError: () => {},
    model: createElement('button', { 'aria-label': '模型测试' }, '模型'),
    access: createElement('button', { 'aria-label': '权限测试' }, '权限'),
    contextUsage: null,
    editing: false,
    onCancelEdit: () => {},
  }
}

test('计划胶囊仅在启用时位于权限右侧，禁用时仍可关闭，悬停或聚焦才显示关闭图标', () => {
  for (const mode of ['default', 'plan'] as const) {
    const markup = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(Composer, { ...composerProps(), mode, disabled: true })),
    )
    assert.doesNotMatch(markup, /开启计划模式/)
    if (mode === 'default') {
      assert.doesNotMatch(markup, /关闭计划模式|lucide-lightbulb|lucide-x|h-3 w-px/)
      continue
    }
    const label = '关闭计划模式'
    const button = markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0]
    assert.ok(button, label)
    assert.doesNotMatch(button, /disabled=/)
    assert.match(button, /h-7/)
    assert.ok(markup.indexOf('aria-label="消息"') < markup.indexOf(`aria-label="${label}"`))
    assert.ok(markup.indexOf('aria-label="权限测试"') < markup.indexOf(`aria-label="${label}"`))
    assert.ok(markup.indexOf(`aria-label="${label}"`) < markup.indexOf('aria-label="模型测试"'))
    assert.match(markup, /lucide-lightbulb/)
    assert.match(markup, /lucide-x/)
    assert.match(markup, /group-hover:hidden group-focus-visible:hidden/)
    assert.match(markup, /hidden size-4 .*group-hover:flex group-focus-visible:flex/)
    assert.doesNotMatch(markup, />计划模式<|>关闭</)
  }
})

test('编辑状态下输入 / 只渲染技能和插件，不展示 plan、goal 等内置命令', () => {
  const plugin = { id: 'plugin-preview', name: 'Preview Plugin', description: '代码预览' }
  const agentPlugins = {
    options: [plugin],
    selected: [],
    mentions: [],
    loading: false,
    saving: false,
    select: async () => true,
    deselect: async () => true,
    change: async () => true,
  }
  const result = completion('/', builtinCommands, { editing: true, agentPlugins }).result
  assert.deepEqual(
    result.matches.map((item) => (item.kind === 'plugin' ? item.plugin.id : item.command.name)),
    ['skill:verify', 'plugin-preview'],
  )
  assert.equal(completion('/p', builtinCommands, { editing: true, agentPlugins }).result.matches.length, 1)
  assert.equal(completion('/plan', builtinCommands, { editing: true, agentPlugins }).result.matches.length, 0)
})
