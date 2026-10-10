import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completionQuery } from '../src/ui/composer/completion-query'

test('$ 技能补全支持开头、句中、换行和光标之后的正文', () => {
  assert.deepEqual(completionQuery('$', 1), { kind: 'skill', query: '', start: 0 })
  assert.deepEqual(completionQuery('请用 $type 检查代码', 8), { kind: 'skill', query: 'type', start: 3 })
  assert.deepEqual(completionQuery('检查代码\n$文档', 8), { kind: 'skill', query: '文档', start: 5 })
  assert.equal(completionQuery('价格 US$10', 8), null)
  assert.equal(completionQuery('$type 已选完', 9), null)
})

test('斜杠命令只在消息开头补全，不匹配路径或句中的命令', () => {
  assert.deepEqual(completionQuery('  /skill:ty', 11), { kind: 'command', query: 'skill:ty', start: 2 })
  assert.equal(completionQuery('读取 src/main', 11), null)
  assert.equal(completionQuery('请用 /review', 10), null)
})

test('@ 文件补全支持句中、嵌套路径和含空格的引号路径，不匹配邮箱和已闭合引用', () => {
  assert.deepEqual(completionQuery('@', 1), { kind: 'file', query: '', start: 0, quoted: false })
  const draft = '请看 @src/main.ts 后面的正文'
  assert.deepEqual(completionQuery(draft, '请看 @src/main.ts'.length), {
    kind: 'file',
    query: 'src/main.ts',
    start: 3,
    quoted: false,
  })
  assert.deepEqual(completionQuery('@"src/中文 文件', 11), {
    kind: 'file',
    query: 'src/中文 文件',
    start: 0,
    quoted: true,
  })
  assert.equal(completionQuery('name@example.com', 16), null)
  assert.equal(completionQuery('@"src/中文 文件"', 12), null)
})
