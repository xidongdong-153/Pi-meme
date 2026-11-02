import type { PiSdk } from './sdk/load'

/** 没有相同行时直接输出整段替换，避免 diff 搜索随改动行数平方增长。 */
export function generateFilePatch(
  sdk: Pick<PiSdk, 'generateUnifiedPatch'>,
  file: string,
  before: string,
  after: string,
) {
  if (before === after) return sdk.generateUnifiedPatch(file, before, after)
  const lines = (text: string) => {
    if (!text) return []
    const result = text.split('\n')
    if (text.endsWith('\n')) result.pop()
    return result
  }
  const oldLines = lines(before)
  const newLines = lines(after)
  const existing = new Set(oldLines)
  if (newLines.some((line) => existing.has(line))) return sdk.generateUnifiedPatch(file, before, after)
  const section = (values: string[], prefix: string, text: string) =>
    values.length
      ? values.map((line) => `${prefix}${line}\n`).join('') +
        (text.endsWith('\n') ? '' : '\\ No newline at end of file\n')
      : ''
  return [
    `--- ${file}`,
    `+++ ${file}`,
    `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`,
    section(oldLines, '-', before) + section(newLines, '+', after),
  ].join('\n')
}
