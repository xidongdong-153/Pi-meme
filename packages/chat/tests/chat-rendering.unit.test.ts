import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityGroup } from '../src/ui/conversation/activity-group'
import type { PiContent, PiMessage } from '@pi-meme/contracts/pi'
import { groupMessageParts } from '../src/ui/model/message-parts'
import { groupConversationTurns } from '../src/ui/model/conversation-turns'
import { extractDiff, extractImages, formatDetailValue, parseToolMeta } from '../src/ui/model/tool-details'
import { groupAdjacentActivities, summarizeActivities } from '../src/ui/model/activity-summary'
import { Conversation } from '../src/ui/conversation/conversation'
import { AssistantTurnView } from '../src/ui/conversation/assistant-turn'
import { MarkdownContent } from '../src/ui/content/markdown-content'
import { applyEvent, emptyChat } from '../src/ui/model/state'
import type { ActivityItem, ChatState } from '../src/ui/model/types'
import type { MessageEditorState } from '../src/ui/conversation/inline-message-editor'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { PluginMessageProvider } from '@pi-meme/ui/components/plugin-message'
import { PluginToolCardProvider } from '@pi-meme/ui/components/plugin-tool-card'
import {
  PluginMessageActions,
  PluginMessageActionsGroup,
  PluginMessageActionsProvider,
  type MessageActionAnchor,
} from '@pi-meme/ui/components/plugin-message-actions'
import { assistantMessage, bashMessage, toolResult, userMessage } from '../../../tests/fixtures/messages.mjs'

test('子Agent只读会话不借用根Provider引用，仍保留正文和原生复制', () => {
  const source = { ownerId: 'example', generation: 1 }
  const messages: PiMessage[] = [
    userMessage('输入', 1),
    assistantMessage([{ type: 'toolCall', id: 'call', name: 'custom_tool', arguments: {} }], 2),
    { ...toolResult('call', '原生工具输出', 3), source },
    assistantMessage('原生最终回复', 4),
    {
      role: 'custom',
      customType: 'notice',
      content: '原生自定义文本',
      details: {},
      timestamp: 5,
      display: true,
      source,
    },
  ]
  const chat: ChatState = {
    ...emptyChat,
    messages: messages.map((message, index) => ({
      ...message,
      sourceEntry: {
        id: `native-${index}`,
        type: message.role === 'custom' ? 'custom_message' : 'message',
        revision: `native-${index}`,
      },
    })),
    tools: {
      call: {
        id: 'call',
        name: 'custom_tool',
        status: 'success',
        source,
        sourceEntry: { id: 'native-2', type: 'message', revision: 'native-2' },
        result: '原生工具输出',
      },
    },
  }
  const render = (agentOnly: boolean) =>
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(PluginMessageProvider, {
          render: () => 'PLUGIN_CUSTOM',
          children: createElement(PluginToolCardProvider, {
            render: () => 'PLUGIN_TOOL',
            children: createElement(PluginMessageActionsProvider, {
              render: () => 'PLUGIN_ACTION',
              renderGroup: () => 'PLUGIN_GROUP',
              children: createElement(Conversation, {
                chat,
                agentOnly,
                readOnly: agentOnly,
                canEditMessages: false,
                onEditMessage: () => {},
                onForkReply: () => {},
                onCopyError: () => {},
              }),
            }),
          }),
        }),
      ),
    )
  const main = render(false)
  assert.match(main, /PLUGIN_CUSTOM/)
  assert.match(main, /PLUGIN_ACTION/)
  assert.match(main, /PLUGIN_GROUP/)
  const child = render(true)
  assert.doesNotMatch(child, /PLUGIN_CUSTOM|PLUGIN_TOOL|PLUGIN_ACTION|PLUGIN_GROUP/)
  assert.match(child, /原生自定义文本/)
  assert.match(child, /原生最终回复/)
  assert.match(child, /复制消息/)
})

test('同一Provider的null覆盖同时关闭单条和聚合菜单，不继承根renderer', () => {
  const anchor: MessageActionAnchor = {
    role: 'tool',
    entries: [{ id: 'native', revision: 'r1' }],
    displayedText: '原生输出',
    state: 'complete',
    toolCallId: 'call',
    toolName: 'read',
  }
  const markup = renderToStaticMarkup(
    createElement(PluginMessageActionsProvider, {
      render: () => 'ROOT_SINGLE',
      renderGroup: () => 'ROOT_GROUP',
      children: createElement(PluginMessageActionsProvider, {
        render: null,
        renderGroup: () => 'INNER_GROUP',
        children: createElement(
          'div',
          null,
          '原生内容',
          createElement(PluginMessageActions, anchor),
          createElement(PluginMessageActionsGroup, {
            anchors: [anchor, { ...anchor, toolCallId: 'other', entries: [{ id: 'other', revision: 'r2' }] }],
          }),
        ),
      }),
    }),
  )
  assert.match(markup, /原生内容/)
  assert.doesNotMatch(markup, /ROOT_SINGLE|ROOT_GROUP|INNER_GROUP/)
})

for (const count of [1, 2]) {
  test(`工作过程的${count}项工具摘要在原详情未挂载时仍提供各自真实消息动作`, () => {
    const anchors: MessageActionAnchor[] = []
    const items: ActivityItem[] = Array.from({ length: count }, (_, index) => ({
      id: `call-${index}`,
      type: 'tool',
      name: index ? 'sdk_search_workspace' : 'sdk_read_workspace',
      args: index ? { query: 'needle' } : {},
      result: [{ type: 'text', text: `输出${index}` }],
      source: { ownerId: index ? 'search-plugin' : 'read-plugin', generation: index + 1 },
      sourceEntry: { id: `native-result-${index}`, type: 'message', revision: `revision-${index}` },
      status: index ? 'error' : 'success',
    }))
    const markup = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(PluginMessageActionsProvider, {
          render(anchor) {
            anchors.push(anchor)
            return createElement('span', { 'data-tool-action': anchor.toolCallId }, anchor.toolName)
          },
          children: createElement(AssistantTurnView, {
            turn: { type: 'assistant_turn', key: 'turn', activities: items, finalText: '', images: [], isLive: true },
          }),
        }),
      ),
    )
    assert.doesNotMatch(markup, /aria-label="活动详情列表"/)
    assert.equal(anchors.length, count)
    for (let index = 0; index < count; index++) {
      assert.equal(anchors[index].role, 'tool')
      assert.deepEqual(anchors[index].entries, [
        { id: `native-result-${index}`, type: 'message', revision: `revision-${index}` },
      ])
      assert.equal(anchors[index].toolCallId, `call-${index}`)
      assert.equal(anchors[index].toolName, index ? 'sdk_search_workspace' : 'sdk_read_workspace')
      assert.equal(anchors[index].source?.ownerId, index ? 'search-plugin' : 'read-plugin')
      assert.equal(anchors[index].source?.generation, index + 1)
    }
  })
}

test('Markdown 代码块保留完整语言标记，且不在 pre 中嵌套块级容器', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownContent, { children: '```c++\nint main() {}\n```' }))
  assert.match(markup, />c\+\+<\/span>/)
  assert.doesNotMatch(markup, /<pre><div/)
})

test('Markdown 单行和空代码围栏仍渲染为代码块，行内代码保持行内', () => {
  for (const code of ['单行原文', '']) {
    const markup = renderToStaticMarkup(createElement(MarkdownContent, { children: `\`\`\`\n${code}\n\`\`\`` }))
    assert.match(markup, /pi-code-block-header/)
    assert.doesNotMatch(markup, /<pre><div/)
  }
  const inline = renderToStaticMarkup(createElement(MarkdownContent, { children: '运行 `pnpm start`。' }))
  assert.match(inline, /<code class="pi-inline-code">pnpm start<\/code>/)
  assert.doesNotMatch(inline, /pi-code-block/)
})

test('Markdown 保留有序列表起始序号和任务列表语义', () => {
  const markup = renderToStaticMarkup(
    createElement(MarkdownContent, { children: '3. 第三步\n4. 第四步\n\n- [x] 已完成' }),
  )
  assert.match(markup, /<ol[^>]*start="3"/)
  assert.match(markup, /class="[^"]*contains-task-list/)
  assert.match(markup, /class="[^"]*task-list-item/)
})

function conversationFixture(): ChatState {
  return {
    ...emptyChat,
    messages: [
      { ...userMessage('子任务正文', 100), sourceEntry: { id: 'user', type: 'message', revision: '1' } },
      assistantMessage([{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'src/main.ts' } }], 120),
      toolResult('read', '文件正文', 130),
      assistantMessage('任务结果', 140),
    ],
    tools: { read: { id: 'read', name: 'read', status: 'success', result: '文件正文' } },
    sessionEntries: {
      entries: [
        { id: 'user', parentId: null, timestamp: 't1', type: 'message', role: 'user', messageTimestamp: 100 },
        { id: 'reply', parentId: 'user', timestamp: 't2', type: 'message', role: 'assistant' },
        { id: 'edited', parentId: null, timestamp: 't3', type: 'message', role: 'user', messageTimestamp: 200 },
      ],
      leafId: 'reply',
    },
  }
}

function renderConversation(readOnly: boolean, canEditMessages: boolean, editor?: MessageEditorState) {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(Conversation, {
        chat: conversationFixture(),
        readOnly,
        canEditMessages,
        editor,
        onEditMessage: () => {},
        onForkReply: () => {},
        onCopyError: () => {},
      }),
    ),
  )
}

test('侧边索引包含尚未加载的早期输入，定位锚点只出现在已渲染消息上', () => {
  const messages = Array.from({ length: 24 }, (_, index) => [
    userMessage(`第 ${index + 1} 轮输入`, 1000 + index * 100),
    assistantMessage(`第 ${index + 1} 轮回复`, 1050 + index * 100),
  ]).flat()
  const markup = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(Conversation, {
        chat: { ...emptyChat, messages },
        canEditMessages: false,
        onEditMessage: () => {},
        onForkReply: () => {},
        onCopyError: () => {},
      }),
    ),
  )
  assert.match(markup, /aria-label="对话索引"/)
  assert.equal((markup.match(/aria-label="定位到第 /g) ?? []).length, 24)
  assert.match(markup, /定位到第 1 条输入：第 1 轮输入/)
  assert.doesNotMatch(markup, /data-conversation-user="user-1000-0"/)
  assert.match(markup, /data-conversation-user="user-3300-46"/)
})

test('只读子代理对话保留正文、复制和工作过程，隐藏编辑与分叉操作', () => {
  const markup = renderConversation(true, false)
  assert.match(markup, /子任务正文/)
  assert.match(markup, /任务结果/)
  assert.match(markup, /aria-label="复制消息"/)
  assert.match(markup, /用时不足1秒/)
  assert.match(markup, /aria-label="活动详情：/)
  assert.doesNotMatch(markup, /编辑消息|从这段回复新建会话|用户消息版本|查看上一个版本|查看下一个版本/)
})

test.each([true, false])('编辑目标已消失时，仅可写会话保留草稿与取消入口（只读=%s）', (readOnly) => {
  const editor: MessageEditorState = {
    entryId: 'entry-user',
    draft: '编辑草稿',
    onDraft: () => {},
    selectedSkills: [],
    onSkills: () => {},
    attachments: [],
    uploadAttachment: async () => ({ name: 'file', path: '/attachments/file' }),
    onError: () => {},
    onAddImages: () => {},
    onRemoveImage: () => {},
    commands: [],
    focusVersion: 0,
    disabled: false,
    onSubmit: () => {},
    onCancel: () => {},
  }
  const markup = renderConversation(readOnly, true, editor)
  assert.match(markup, /子任务正文/)
  if (readOnly) assert.doesNotMatch(markup, /inline-message-editor|编辑历史消息|发送编辑后的消息|编辑草稿/)
  else {
    assert.match(markup, /inline-message-editor/)
    assert.match(markup, /取消编辑用户消息/)
  }
})

test('子代理展示只过滤派发消息，保留原始分轮、计时和自身操作', () => {
  const chat: ChatState = {
    ...emptyChat,
    messages: [
      userMessage('主代理派发的任务', 1000),
      assistantMessage([{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'a.ts' } }], 2000),
      toolResult('read', '文件内容', 3000),
      assistantMessage('第一轮结果', 5000),
      {
        role: 'custom',
        customType: 'pi-meme-collaboration',
        display: true,
        content: '主代理发来的补充消息',
        details: { fromAgentId: 'root', kind: 'message' },
        timestamp: 6000,
      },
      userMessage('主代理派发的后续任务', 7000),
      assistantMessage('第二轮结果', 12000),
      {
        role: 'custom',
        customType: 'plugin-output',
        display: true,
        content: '本代理的插件输出',
        timestamp: 13000,
      },
    ],
    tools: { read: { id: 'read', name: 'read', status: 'success', result: '文件内容' } },
  }
  const original = structuredClone(chat)
  const markup = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(Conversation, {
        chat,
        readOnly: true,
        agentOnly: true,
        canEditMessages: false,
        onEditMessage: () => {},
        onForkReply: () => {},
        onCopyError: () => {},
      }),
    ),
  )
  assert.doesNotMatch(markup, /主代理派发|主代理发来|data-message-role="user"|对话索引|data-conversation-user/)
  assert.equal((markup.match(/data-message-role="assistant"/g) ?? []).length, 2)
  assert.match(markup, /活动详情：已读取 a.ts/)
  assert.match(markup, /用时 4秒/)
  assert.match(markup, /用时 5秒/)
  assert.match(markup, /本代理的插件输出/)
  assert.ok(markup.indexOf('第一轮结果') < markup.indexOf('第二轮结果'))
  assert.deepEqual(chat, original)
})

test('主对话保留编辑与分叉，运行时只禁用按钮，历史数据也不显示消息版本操作', () => {
  for (const canEdit of [true, false]) {
    const markup = renderConversation(false, canEdit)
    for (const label of ['编辑消息', '从这段回复新建会话']) {
      const button = markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0]
      assert.ok(button, label)
      assert.equal(button.includes('disabled=""'), !canEdit, label)
    }
    assert.match(markup, /aria-label="复制消息"/)
    assert.doesNotMatch(markup, /用户消息版本|查看上一个版本|查看下一个版本|version-control/)
  }
})

test('主会话子代理结果只显示短状态，不渲染报告正文或来源ID', () => {
  const markup = renderToStaticMarkup(
    createElement(Conversation, {
      chat: {
        ...emptyChat,
        agentMessages: [
          {
            id: 'result-id',
            fromAgentId: 'private-agent-uuid',
            toAgentId: 'root',
            runId: 'private-run-uuid',
            rootTaskId: 'task',
            epoch: 1,
            kind: 'result',
            name: 'chat_activity',
            text: '私有完整报告正文',
            createdAt: new Date(2000).toISOString(),
          },
        ],
      },
      canEditMessages: false,
      onEditMessage: () => {},
      onForkReply: () => {},
      onCopyError: () => {},
    }),
  )
  assert.doesNotMatch(markup, /私有完整报告正文|private-agent-uuid|private-run-uuid|来自子代理/)
  assert.match(markup, /Chat activity/)
  assert.match(markup, /data-agent-avatar=""/)
  assert.doesNotMatch(markup, /chat_activity|animate-spin/)
})

test('只有工作过程的回复不保留空正文的复制和分叉操作栏', () => {
  const markup = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(AssistantTurnView, {
        turn: {
          type: 'assistant_turn',
          key: 'work-only',
          activities: [{ id: 'thinking', type: 'thinking', thinking: '检查项目', status: 'success' }],
          finalText: '',
          images: [],
          startedAt: 1000,
          durationMs: 26000,
          isLive: false,
        },
        canFork: true,
        onFork: () => {},
      }),
    ),
  )
  assert.match(markup, /用时 26秒/)
  assert.match(markup, /aria-label="活动详情：/)
  assert.doesNotMatch(markup, /复制消息|从这段回复新建会话/)
})

test('子代理状态后只有正文的回复不显示零秒过程头，仍可复制和分叉', () => {
  const markup = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(Conversation, {
        chat: {
          ...emptyChat,
          messages: [
            userMessage('调研项目', 1000),
            assistantMessage([{ type: 'thinking', thinking: '开始调研' }], 2000),
            assistantMessage('调研结论', 4000),
          ],
          agentMessages: [
            {
              id: 'result',
              fromAgentId: 'researcher',
              toAgentId: 'root',
              runId: 'run',
              rootTaskId: 'task',
              epoch: 1,
              kind: 'result',
              name: '调研',
              status: 'completed',
              text: '报告',
              createdAt: new Date(3000).toISOString(),
            },
          ],
        },
        canEditMessages: true,
        onEditMessage: () => {},
        onForkReply: () => {},
        onCopyError: () => {},
      }),
    ),
  )
  assert.match(markup, /调研结论/)
  assert.equal((markup.match(/aria-label="活动详情：/g) ?? []).length, 1)
  assert.doesNotMatch(markup, /用时 0秒/)
  assert.equal((markup.match(/aria-label="从这段回复新建会话"/g) ?? []).length, 1)
})

test('主对话与只读子详情都不在消息流显示已保存计划正文', () => {
  for (const readOnly of [false, true]) {
    const markup = renderToStaticMarkup(
      createElement(Conversation, {
        chat: {
          ...emptyChat,
          planDocuments: [
            {
              id: 'plan',
              sessionId: 'session',
              runId: 'run',
              revision: 1,
              title: '侧栏计划',
              markdown: '# 仅侧栏正文',
              updatedAt: '2026-10-10T00:00:00Z',
            },
          ],
        },
        readOnly,
        canEditMessages: false,
        onEditMessage: () => {},
        onForkReply: () => {},
        onCopyError: () => {},
      }),
    )
    assert.doesNotMatch(markup, /已保存计划|侧栏计划|仅侧栏正文/)
  }
})

test('groupMessageParts 将思考过程与所有工具调用内聚到同一个 activity 组中', () => {
  const parts: PiContent[] = [
    { type: 'thinking', thinking: '正在分析目录结构' },
    { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'src/main.ts' } },
    { type: 'toolCall', id: 'tool-2', name: 'bash', arguments: { command: 'pnpm test' } },
    { type: 'thinking', thinking: '测试完毕，准备修改代码' },
    { type: 'toolCall', id: 'tool-3', name: 'edit', arguments: { path: 'src/main.ts' } },
    { type: 'text', text: '已为您完成代码修改并验证完毕。' },
  ]
  const toolsMap = {
    'tool-1': { id: 'tool-1', name: 'read', status: 'success' as const, result: 'content' },
    'tool-2': { id: 'tool-2', name: 'bash', status: 'success' as const, result: 'passed' },
    'tool-3': { id: 'tool-3', name: 'edit', status: 'success' as const, result: { diff: '@@ -1 +1 @@' } },
  }

  const segments = groupMessageParts(parts, toolsMap, false)
  // 思考与工具调用连续发生时，应当内聚为 1 个 activity 组，后面紧接 1 个 text 组
  assert.equal(segments.length, 2)
  assert.equal(segments[0].type, 'activity')
  if (segments[0].type === 'activity') {
    assert.equal(segments[0].items.length, 5)
    assert.equal(segments[0].items[0].type, 'thinking')
    assert.equal(segments[0].items[1].type, 'tool')
    assert.equal(segments[0].items[2].type, 'tool')
    assert.equal(segments[0].items[3].type, 'thinking')
    assert.equal(segments[0].items[4].type, 'tool')
  }
  assert.equal(segments[1].type, 'text')
  if (segments[1].type === 'text') {
    assert.equal(segments[1].text, '已为您完成代码修改并验证完毕。')
  }
})

test('groupConversationTurns 将同一问答轮次内的多条独立 Assistant 消息、Bash 和思考聚合成单一工作组与最终正文', () => {
  const messages: PiMessage[] = [
    userMessage('1.无需处理 2.删除 3.给出解决方案', 1000),
    assistantMessage([{ type: 'toolCall', id: 'call-1', name: 'edit', arguments: { path: 'a.txt' } }], 1100),
    toolResult('call-1', 'ok', 1200),
    bashMessage('git diff', 'diff content', 1300),
    assistantMessage([{ type: 'toolCall', id: 'call-2', name: 'edit', arguments: { path: 'b.txt' } }], 1400),
    toolResult('call-2', 'ok', 1500),
    bashMessage('pnpm test', 'tests passed', 1600),
    assistantMessage(
      [
        { type: 'thinking', thinking: '梳理完成，准备答复' },
        { type: 'text', text: '三项都处理完了。\n1. AUTH_BOOTSTRAP_ADMIN_EMAIL — 未动' },
      ],
      1700,
    ),
  ]
  const toolsMap = {
    'call-1': { id: 'call-1', name: 'edit', status: 'success' as const, result: 'ok' },
    'call-2': { id: 'call-2', name: 'edit', status: 'success' as const, result: 'ok' },
  }

  const turns = groupConversationTurns(messages, null, toolsMap, false)
  // 必须只生成 2 个顶层卡片：1 个 user，1 个 assistant_turn
  assert.equal(turns.length, 2)
  assert.equal(turns[0].type, 'user')

  const assistantTurn = turns[1]
  assert.equal(assistantTurn.type, 'assistant_turn')
  if (assistantTurn.type === 'assistant_turn') {
    // 包含 2 次 edit + 2 次 bash + 1 次 thinking = 5 次操作全部归入单一 activities
    assert.equal(assistantTurn.activities.length, 5)
    assert.equal(assistantTurn.activities[0].type, 'tool')
    assert.equal(assistantTurn.activities[1].type, 'tool')
    assert.equal(assistantTurn.activities[2].type, 'tool')
    assert.equal(assistantTurn.activities[3].type, 'tool')
    assert.equal(assistantTurn.activities[4].type, 'thinking')

    // 最终正文独立存在
    assert.equal(assistantTurn.finalText, '三项都处理完了。\n1. AUTH_BOOTSTRAP_ADMIN_EMAIL — 未动')
    // 计算耗时 1700 - 1000 = 700ms
    assert.equal(assistantTurn.durationMs, 700)
    assert.equal(assistantTurn.startedAt, 1000)
    // 轮次结束，isLive 为 false（界面默认折叠）
    assert.equal(assistantTurn.isLive, false)
  }
})

test('工具详情解析保留嵌套 Diff、图片和未知工具输出', () => {
  const result = {
    content: [
      { type: 'text', text: '完成' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ],
    details: { diff: '@@ -1 +1 @@\n-old\n+new' },
  }
  assert.equal(extractDiff(result), result.details.diff)
  assert.deepEqual(extractImages(result), [{ data: 'AAAA', mimeType: 'image/png' }])
  assert.equal(formatDetailValue(result), '完成')
  assert.equal(formatDetailValue({ content: [result.content[1]] }), '')
  assert.equal(formatDetailValue({ content: [{ type: 'text', text: '自定义输出' }] }), '自定义输出')
  assert.deepEqual(parseToolMeta({ id: 'custom', type: 'tool', name: 'custom-tool', result: {} }), {
    kind: 'generic',
    summary: '已执行 custom-tool',
  })
})

test('活动摘要按实际路径去重，纯模型不需要图标组件', () => {
  const summary = summarizeActivities([
    { id: 'thought', type: 'thinking', thinking: '检查文件' },
    { id: '1', type: 'tool', name: 'read', args: { path: 'src/main.ts' } },
    { id: '2', type: 'tool', name: 'read', args: { path: 'src/main.ts' } },
    { id: '3', type: 'tool', name: 'bash', args: { command: 'pnpm test' } },
  ])
  assert.equal(summary.summary, '读取了 1 个文件 · 执行了 1 条命令')
  assert.equal(summary.kind, 'read')
})

test('只有思考活动时不显示思考过程摘要', () => {
  assert.deepEqual(summarizeActivities([{ id: 'thought', type: 'thinking', thinking: '检查文件' }]), {
    summary: '',
    kind: 'thinking',
  })
})

test('用时独立显示，运行与历史的活动摘要均默认折叠且不显示转圈', () => {
  const items = [
    { id: 'read', type: 'tool' as const, name: 'read', args: { path: 'src/main.ts' }, status: 'success' as const },
    { id: 'thought', type: 'thinking' as const, thinking: '检查文件', status: 'success' as const },
  ]
  const live = renderToStaticMarkup(createElement(ActivityGroup, { items, isLive: true, startedAt: Date.now() }))
  const liveHeader = live.match(/<button[^>]*aria-label="活动详情：.*?<\/button>/)?.[0]
  assert.ok(liveHeader)
  assert.match(liveHeader, /aria-expanded="false"/)
  assert.match(live, /处理中/)
  assert.match(liveHeader, /读取了 1 个文件/)
  assert.doesNotMatch(live, /animate-spin|lucide-loader/)

  const completed = renderToStaticMarkup(createElement(ActivityGroup, { items, durationMs: 45000 }))
  const completedHeader = completed.match(/<button[^>]*aria-label="活动详情：.*?<\/button>/)?.[0]
  assert.ok(completedHeader)
  assert.match(completedHeader, /aria-expanded="false"/)
  assert.match(completed, /用时 45秒/)
  assert.match(completedHeader, /读取了 1 个文件/)
  assert.doesNotMatch(completed, /animate-spin|lucide-loader/)
})

test('正文分隔活动组，思考与工具连续合并且保留原来顺序', () => {
  const items: ActivityItem[] = [
    { id: 'read-1', type: 'tool', name: 'read', args: { path: 'a.ts' }, status: 'success' },
    { id: 'bash', name: 'bash', args: { command: 'pnpm test' }, status: 'success' },
    { id: 'note', type: 'narration', text: '已经确认 **结构**。' },
    { id: 'read-2', type: 'tool', name: 'read', args: { path: 'b.ts' }, status: 'success' },
    { id: 'think', type: 'thinking', thinking: '准备修改', status: 'success' },
    { id: 'edit', type: 'tool', name: 'edit', args: { path: 'b.ts' }, status: 'error' },
  ]
  const groups = groupAdjacentActivities(items)
  assert.deepEqual(groups, [
    { type: 'activity', items: items.slice(0, 2) },
    { type: 'text', text: '已经确认 **结构**。' },
    { type: 'activity', items: items.slice(3) },
  ])
  assert.equal(items.length, 6)
  const markup = renderToStaticMarkup(createElement(ActivityGroup, { items, isLive: true }))
  assert.match(markup, /aria-label="活动详情：[^>]*aria-expanded="false"/)
  assert.match(markup, /读取了 1 个文件 · 执行了 1 条命令/)
  assert.match(markup, /已经确认 <strong[^>]*>结构<\/strong>。/)
  assert.doesNotMatch(markup, /工具详情：edit/)
  assert.doesNotMatch(markup, /有调用失败/)
  assert.match(markup, /读取了 1 个文件/)
  assert.doesNotMatch(markup, /lucide-circle-x/)
  assert.doesNotMatch(markup, /max-h-80|animate-spin/)
})

test('用户气泡显示多个内联技能名，不显示技能长正文和路径', async () => {
  const { UserMessageContent } = await import('../src/ui/conversation/user-message-content')
  const text =
    '123 <skill name="typescript" location="/skills/a/SKILL.md">长正文 A</skill> <skill name="review-code" location="/skills/b/SKILL.md">长正文 B</skill> 看看技能'
  const markup = renderToStaticMarkup(createElement(UserMessageContent, { text }))
  assert.match(markup, /技能：typescript/)
  assert.match(markup, /技能：review-code/)
  assert.match(markup, /123|看看技能/)
  assert.doesNotMatch(markup, /长正文 A|长正文 B/)
})

test('ThinkingActivityRow 在运行和完成态均渲染调皮文案，且文案非空', async () => {
  const { ThinkingActivityRow } = await import('../src/ui/conversation/thinking-activity-row')
  const { PLAYFUL_THINKING_LABELS } = await import('../src/ui/model/thinking-labels')

  const runningItem = {
    id: 'thought-run-1',
    type: 'thinking' as const,
    thinking: '正在思考中',
    status: 'running' as const,
  }
  const runningMarkup = renderToStaticMarkup(
    createElement(ThinkingActivityRow, { item: runningItem, open: false, onToggle: () => {} }),
  )
  const hasRunningLabel = PLAYFUL_THINKING_LABELS.some((label) => runningMarkup.includes(label))
  assert.equal(hasRunningLabel, true)

  const completedItem = {
    id: 'thought-done-1',
    type: 'thinking' as const,
    thinking: '已经思考完毕',
    status: 'success' as const,
  }
  const completedMarkup = renderToStaticMarkup(
    createElement(ThinkingActivityRow, { item: completedItem, open: false, onToggle: () => {} }),
  )
  const hasCompletedLabel = PLAYFUL_THINKING_LABELS.some((label) => completedMarkup.includes(label))
  assert.equal(hasCompletedLabel, true)
})

test('ThinkingActivityRow 展开时为无边框无框体设计，不包含复制按钮和思考内容表头', async () => {
  const { ThinkingActivityRow } = await import('../src/ui/conversation/thinking-activity-row')
  const item = {
    id: 'thought-open-1',
    type: 'thinking' as const,
    thinking: '正在分析用户诉求',
    status: 'success' as const,
  }
  const openMarkup = renderToStaticMarkup(createElement(ThinkingActivityRow, { item, open: true, onToggle: () => {} }))
  assert.match(openMarkup, /正在分析用户诉求/)
  assert.doesNotMatch(openMarkup, /复制|思考内容|border-border/)
})

test('思考展示清理尾部空白，保留内部空行、前导缩进和原始内容', async () => {
  const { ThinkingActivityRow } = await import('../src/ui/conversation/thinking-activity-row')
  const thinking = '  第一行\n\n    第二行\n\n\n\n\n\n  '
  const item: Extract<ActivityItem, { type: 'thinking' }> = { id: 'trailing', type: 'thinking', thinking }
  const markup = renderToStaticMarkup(createElement(ThinkingActivityRow, { item, open: true, onToggle: () => {} }))
  assert.equal(markup.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1], '  第一行\n\n    第二行')
  assert.equal(item.thinking, thinking)
})

test('恢复的助手回复以完成时间显示真实用时，后续命令不影响时间戳身份', () => {
  const startedAt = 1791791839305
  const message: PiMessage = {
    ...assistantMessage('历史回复', startedAt),
    completedAt: Date.parse('2026-10-12T07:57:24.763Z'),
  }
  const messages: PiMessage[] = [
    userMessage('输入', 1791791839236),
    message,
    { role: 'custom', customType: 'command-result', content: '命令结果', display: true, timestamp: 1791792328816 },
  ]
  const turns = groupConversationTurns(messages, null, {}, false)
  const liveState = applyEvent({ ...emptyChat, messages: [messages[0]!] }, { type: 'message_end', message })
  assert.deepEqual(groupConversationTurns(liveState.messages, null, {}, false), turns.slice(0, 2))
  const turn = turns.find((chunk) => chunk.type === 'assistant_turn')
  assert.ok(turn?.type === 'assistant_turn')
  assert.equal(turn.durationMs, 5527)
  assert.equal(message.timestamp, startedAt)
  const markup = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(AssistantTurnView, { turn })))
  assert.match(markup, /用时 6秒/)
})

test('后续可见命令消息保留独立卡片，不延长已完成回复用时', () => {
  const messages = [userMessage('输入', 1000), assistantMessage('回复', 7000)]
  const command: PiMessage = {
    role: 'custom',
    customType: 'command-result',
    content: '命令结果',
    display: true,
    timestamp: 491000,
  }
  const before = groupConversationTurns(messages, null, {}, false)
  const after = groupConversationTurns([...messages, command], null, {}, false)
  assert.deepEqual(after.slice(0, 2), before)
  assert.equal(after[1]?.type === 'assistant_turn' && after[1].durationMs, 6000)
  assert.deepEqual(after[2]?.type === 'custom' && after[2].message, command)
  assert.deepEqual(groupConversationTurns([...messages, { ...command, display: false }], null, {}, false), before)

  const next = groupConversationTurns([...messages, command, assistantMessage('后续回复', 492000)], null, {}, false)
  assert.equal(next[3]?.type === 'assistant_turn' && next[3].startedAt, 492000)
  assert.equal(next[3]?.type === 'assistant_turn' && next[3].durationMs, 0)
})

test('命令消息不改变工具结果的结束时间或已记录的运行用时', () => {
  const messages = [
    userMessage('执行工具', 1000),
    assistantMessage([{ type: 'toolCall', id: 'call', name: 'read', arguments: {} }], 2000),
    toolResult('call', '工具结果', 7000),
  ]
  const command: PiMessage = {
    role: 'custom',
    customType: 'command-result',
    content: '命令结果',
    display: true,
    timestamp: 491000,
  }
  const tools: ChatState['tools'] = { call: { id: 'call', name: 'read', status: 'success', result: '工具结果' } }
  for (const runIntervals of [[], [{ startedAt: 1000, endedAt: 9000 }]]) {
    const before = groupConversationTurns(messages, null, tools, false, {}, [], runIntervals)
    const after = groupConversationTurns([...messages, command], null, tools, false, {}, [], runIntervals)
    assert.deepEqual(after.slice(0, 2), before)
    assert.equal(after[1]?.type === 'assistant_turn' && after[1].durationMs, runIntervals.length ? 8000 : 6000)
  }
})

test('持久自定义消息保留序列化payload与实际来源，缺renderer时显示正文', () => {
  const message: PiMessage = {
    role: 'custom',
    customType: 'demo-card',
    content: '卸载后仍可读的正文',
    display: true,
    details: { count: 3 },
    timestamp: 150,
    source: { ownerId: 'demo-plugin', generation: 7, customType: 'demo-card' },
  }
  const turns = groupConversationTurns([message], null, {}, false)
  assert.equal(turns[0]?.type, 'custom')
  assert.deepEqual(turns[0]?.type === 'custom' && turns[0].message, message)
  const markup = renderToStaticMarkup(
    createElement(Conversation, {
      chat: { ...emptyChat, messages: [message] },
      canEditMessages: false,
      onEditMessage: () => {},
      onForkReply: () => {},
      onCopyError: () => {},
    }),
  )
  assert.match(markup, /卸载后仍可读的正文/)
  assert.equal(groupConversationTurns([{ ...message, display: false }], null, {}, false).length, 0)
})
