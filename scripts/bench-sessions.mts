import { loadPiSdk } from '@pi-meme/pi-runtime/sdk/load'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { readSessionHistory, invalidateSessionHistory } from '@pi-meme/pi-runtime/session-history'
import { projectSessionWindow } from '@pi-meme/contracts/session-window'
import { assistantMessage, userMessage } from '../tests/fixtures/messages.mjs'

const output = path.resolve('out/session-performance')
const label = process.argv[2] ?? 'current'
const count = Number(process.env.PI_BENCH_MESSAGES ?? 10000)
const file = path.join(output, 'data/sessions/benchmark/history.jsonl')
await mkdir(path.dirname(file), { recursive: true })
if (label === 'baseline') {
  const handle = await open(file, 'w')
  try {
    await handle.write(
      `${JSON.stringify({ type: 'session', version: 3, id: 'benchmark', cwd: output, timestamp: '2026-10-27T00:00:00Z' })}\n`,
    )
    for (let index = 0; index < count; index++) {
      await handle.write(
        `${JSON.stringify({
          type: 'message',
          id: `entry-${index}`,
          parentId: index ? `entry-${index - 1}` : null,
          timestamp: '2026-10-27T00:00:00Z',
          message: index % 2 ? assistantMessage('回'.repeat(3400), index) : userMessage('问'.repeat(3400), index),
        })}\n`,
      )
    }
  } finally {
    await handle.close()
  }
}
await loadPiSdk()
const samples: Array<{ milliseconds: number; cpuMs: number; bytes: number; messages: number }> = []
if (label === 'baseline') invalidateSessionHistory([file])
for (let index = 0; index < 12; index++) {
  const cpu = process.cpuUsage()
  const start = performance.now()
  const history = await readSessionHistory(file, label === 'baseline' ? undefined : { limit: 60, details: 'deferred' })
  const page = projectSessionWindow(history, { limit: 60 })
  const bytes = Buffer.byteLength(JSON.stringify(page))
  const elapsed = process.cpuUsage(cpu)
  samples.push({
    milliseconds: performance.now() - start,
    cpuMs: (elapsed.user + elapsed.system) / 1000,
    bytes,
    messages: page.messages.length,
  })
}
const result = { label, count, first: samples[0], warm: samples.slice(1), rss: process.memoryUsage().rss }
await writeFile(path.join(output, `${label}.json`), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result))
if (label !== 'baseline') {
  const baseline = JSON.parse(await readFile(path.join(output, 'baseline.json'), 'utf8')) as typeof result
  console.log(
    JSON.stringify({
      firstReadSpeedup: baseline.first.milliseconds / result.first.milliseconds,
      payloadReduction: 1 - result.first.bytes / baseline.first.bytes,
    }),
  )
}
