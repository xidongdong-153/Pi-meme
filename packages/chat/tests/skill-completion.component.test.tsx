import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createElement, type KeyboardEvent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { builtinCommands, type PiSlashCommand } from '@pi-meme/contracts/pi'
import { skillMarker } from '@pi-meme/contracts/skills'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { CommandSuggestions } from '../src/ui/composer/command-suggestions'
import { useCommandCompletion } from '../src/ui/composer/use-command-completion'

const creator: PiSlashCommand = {
  name: 'skill:skill-creator',
  description: '创建或更新技能，包含所需的说明与脚本。',
  displayName: 'Skill Creator',
  shortDescription: 'Create or update a skill',
  builtin: true,
  source: 'skill',
  sourceInfo: {
    path: '/app/builtin-skills/skill-creator/SKILL.md',
    source: 'directory',
    scope: 'temporary',
    origin: 'top-level',
  },
}

function suggestions(matches: PiSlashCommand[], skillCompletion = true) {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(CommandSuggestions, {
        matches: matches.map((command) => ({
          kind: command.source === 'skill' ? ('skill' as const) : ('command' as const),
          command,
        })),
        skillCompletion,
        suggestionIndex: 0,
        onComplete: () => {},
      }),
    ),
  )
}

afterEach(cleanup)

test('技能候选显示标题、短描述与内置来源，仍使用原命令身份和选项结构', () => {
  const markup = suggestions([creator])
  assert.match(markup, /aria-label="技能选择"/)
  assert.match(markup, /id="composer-option-0"[^>]*role="option"[^>]*aria-selected="true"/)
  assert.match(markup, /lucide-box/)
  assert.match(markup, />Skill Creator</)
  assert.match(markup, />Create or update a skill</)
  assert.match(markup, />内置</)
  assert.doesNotMatch(markup, />skill-creator<|>临时<|创建或更新技能，包含所需的说明与脚本。/)

  const slashMarkup = suggestions([creator], false)
  assert.match(slashMarkup, />Skill Creator</)
  assert.match(slashMarkup, /aria-label="技能"/)
  assert.match(slashMarkup, /Create or update a skill/)
  assert.doesNotMatch(slashMarkup, />\/skill:skill-creator</)
})

test('普通技能保留名称与说明，并区分本地文件和项目来源', () => {
  for (const [scope, label] of [
    ['user', '本地文件'],
    ['project', '项目'],
    ['temporary', '临时'],
  ] as const) {
    const markup = suggestions([
      {
        name: 'skill:verify',
        description: '检查项目',
        source: 'skill',
        sourceInfo: { ...creator.sourceInfo, scope },
      },
    ])
    assert.match(markup, />verify</)
    assert.match(markup, />检查项目</)
    assert.ok(markup.includes(`>${label}</`))
    assert.doesNotMatch(markup, />内置</)
  }
})

function completion(draft: string) {
  let result!: ReturnType<typeof useCommandCompletion>
  const changedDrafts: string[] = []
  const changedSkills: PiSlashCommand[][] = []
  function Capture() {
    result = useCommandCompletion({
      draft,
      commands: [...builtinCommands, creator],
      onDraft: (text) => changedDrafts.push(text),
      onSkills: (skills) => changedSkills.push(skills),
      selectedSkills: [],
      focusVersion: 0,
      onClearQueue: () => {},
      hasQueue: false,
    })
    return null
  }
  render(createElement(Capture))
  return { result, changedDrafts, changedSkills }
}

test('技能标题与短描述可检索，Enter、Tab和鼠标仍插入技能引用', () => {
  for (const draft of [
    '$Creator',
    '$skill-creator',
    '$update',
    '$创建',
    '/Creator',
    '/skill:skill-creator',
    '请使用 /创建',
  ]) {
    const { result } = completion(draft)
    assert.deepEqual(result.matches, [{ kind: 'skill', command: creator }], draft)
  }
  const original = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = () => 0
  try {
    for (const trigger of ['$', '/']) {
      for (const method of ['Enter', 'Tab', 'click']) {
        const { result, changedDrafts, changedSkills } = completion(`请使用 ${trigger}Creator`)
        if (method === 'click') result.completeItem({ kind: 'skill', command: creator })
        else result.keyDown({ key: method, nativeEvent: {}, preventDefault: () => {} } as KeyboardEvent<HTMLDivElement>)
        assert.deepEqual(changedSkills, [[creator]], method)
        assert.deepEqual(changedDrafts, [`请使用 ${skillMarker} `], method)
      }
    }
  } finally {
    globalThis.requestAnimationFrame = original
  }
})
