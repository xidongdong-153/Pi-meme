import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseGitDiff } from '../src/ui/git-diff-viewer'

test('parseGitDiff 正确解析新文件的 Unified Diff 并过滤协议头', () => {
  const sample = `diff --git a/tests/fixtures/skills/typescript/SKILL.md b/tests/fixtures/skills/typescript/SKILL.md
new file mode 100644
index 0000000..2766e2d
--- /dev/null
+++ b/tests/fixtures/skills/typescript/SKILL.md
@@ -0,0 +1,6 @@
+---
+name: typescript
+description: TypeScript 技能
+---
+
+检查 TypeScript 类型和边界条件。`

  const result = parseGitDiff(sample)

  assert.equal(result.isNotice, false)
  assert.equal(result.isNew, true)
  assert.equal(result.isDeleted, false)
  assert.equal(result.additions, 6)
  assert.equal(result.deletions, 0)
  assert.equal(result.hunks.length, 1)

  const hunk = result.hunks[0]!
  assert.equal(hunk.oldStart, 0)
  assert.equal(hunk.oldCount, 0)
  assert.equal(hunk.newStart, 1)
  assert.equal(hunk.newCount, 6)
  assert.equal(hunk.lines.length, 6)

  // 验证各行与行号
  assert.deepEqual(
    hunk.lines.map((l) => ({ type: l.type, new: l.newLineNumber, content: l.content })),
    [
      { type: 'add', new: 1, content: '---' },
      { type: 'add', new: 2, content: 'name: typescript' },
      { type: 'add', new: 3, content: 'description: TypeScript 技能' },
      { type: 'add', new: 4, content: '---' },
      { type: 'add', new: 5, content: '' },
      { type: 'add', new: 6, content: '检查 TypeScript 类型和边界条件。' },
    ],
  )
})

test('parseGitDiff 正确解析修改文件的多 Hunk、删除与上下文行号', () => {
  const sample = `diff --git a/src/app.ts b/src/app.ts
index 1234567..89abcdef 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,5 +10,6 @@ export function main() {
   const a = 1
-  const b = 2
+  const b = 20
+  const c = 30
   return a + b
 }
@@ -30,4 +31,3 @@ export function helper() {
   step1()
-  step2()
   step3()
 }`

  const result = parseGitDiff(sample)

  assert.equal(result.isNotice, false)
  assert.equal(result.isNew, false)
  assert.equal(result.isDeleted, false)
  assert.equal(result.additions, 2)
  assert.equal(result.deletions, 2)
  assert.equal(result.hunks.length, 2)

  // Hunk 1
  const h1 = result.hunks[0]!
  assert.equal(h1.heading, 'export function main() {')
  assert.equal(h1.lines[0]?.type, 'context')
  assert.equal(h1.lines[0]?.oldLineNumber, 10)
  assert.equal(h1.lines[0]?.newLineNumber, 10)

  assert.equal(h1.lines[1]?.type, 'del')
  assert.equal(h1.lines[1]?.oldLineNumber, 11)
  assert.equal(h1.lines[1]?.newLineNumber, undefined)

  assert.equal(h1.lines[2]?.type, 'add')
  assert.equal(h1.lines[2]?.oldLineNumber, undefined)
  assert.equal(h1.lines[2]?.newLineNumber, 11)

  assert.equal(h1.lines[3]?.type, 'add')
  assert.equal(h1.lines[3]?.newLineNumber, 12)

  assert.equal(h1.lines[4]?.type, 'context')
  assert.equal(h1.lines[4]?.oldLineNumber, 12)
  assert.equal(h1.lines[4]?.newLineNumber, 13)

  // Hunk 2
  const h2 = result.hunks[1]!
  assert.equal(h2.oldStart, 30)
  assert.equal(h2.newStart, 31)
  assert.equal(h2.lines[1]?.type, 'del')
  assert.equal(h2.lines[1]?.oldLineNumber, 31)
})

test('parseGitDiff 支持未跟踪纯文本文件，行号自增并展示完整内容', () => {
  const untrackedContent = `console.log('hello world')\nconst x = 42\nexport default x`
  const result = parseGitDiff(untrackedContent, true)

  assert.equal(result.isNotice, false)
  assert.equal(result.isUntrackedText, true)
  assert.equal(result.additions, 3)
  assert.equal(result.deletions, 0)
  assert.deepEqual(result.rawLines, ["console.log('hello world')", 'const x = 42', 'export default x'])
})

test('parseGitDiff 过滤末尾换行符，不产生幽灵空行或无效行号', () => {
  const sample = `diff --git a/.npmrc b/.npmrc
new file mode 100644
index 0000000..d67f374
--- /dev/null
+++ b/.npmrc
@@ -0,0 +1 @@
+node-linker=hoisted
`
  const result = parseGitDiff(sample)
  assert.equal(result.isNew, true)
  assert.equal(result.additions, 1)
  assert.equal(result.deletions, 0)
  assert.equal(result.hunks[0]?.lines.length, 1)
  assert.equal(result.hunks[0]?.lines[0]?.content, 'node-linker=hoisted')
  assert.equal(result.hunks[0]?.lines[0]?.newLineNumber, 1)
})

test('parseGitDiff 识别二进制、超大文件、错误消息及空差异提示', () => {
  const binaryNotice = parseGitDiff('二进制文件，不提供文本预览。')
  assert.equal(binaryNotice.isNotice, true)
  assert.equal(binaryNotice.isBinary, true)

  const binaryDiff = parseGitDiff('Binary files a/logo.png and b/logo.png differ')
  assert.equal(binaryDiff.isNotice, true)
  assert.equal(binaryDiff.isBinary, true)

  const largeNotice = parseGitDiff('文件超过 200 KiB，未在面板中预览。')
  assert.equal(largeNotice.isNotice, true)
  assert.equal(largeNotice.noticeMessage, '文件超过 200 KiB，未在面板中预览。')

  const errorNotice = parseGitDiff('读取变更失败：Command failed')
  assert.equal(errorNotice.isNotice, true)
  assert.match(errorNotice.noticeMessage ?? '', /读取变更失败/)

  const emptyDiff = parseGitDiff('')
  assert.equal(emptyDiff.isNotice, true)
  assert.equal(emptyDiff.noticeMessage, '无文件内容或差异')
})
