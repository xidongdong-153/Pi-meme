import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { discoverSshCandidates } from '../src/ssh-config'

// 只使用临时配置；不会访问测试用户的真实 ~/.ssh。
test('SSH 候选提取支持多别名、Include、条件候选与循环，不展开模式或执行 Match', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'pi-ssh-config-'))
  const directory = path.join(home, '.ssh')
  await mkdir(path.join(directory, 'conf.d'), { recursive: true })
  await writeFile(
    path.join(directory, 'config'),
    [
      'Host work "quoted-host" work !blocked prod-* *',
      '  HostName private.example',
      'Include conf.d/*.conf',
      'Match exec "never-run-this-command"',
      '  Include conditional.conf',
    ].join('\n'),
  )
  await writeFile(path.join(directory, 'conf.d', 'b.conf'), 'Host b\nInclude config')
  await writeFile(path.join(directory, 'conf.d', 'a.conf'), 'Host a # 注释\nIdentityFile ~/.ssh/private-key')
  await writeFile(path.join(directory, 'conditional.conf'), 'Host conditional\n')
  try {
    const values = await discoverSshCandidates(home)
    assert.deepEqual(
      values.map((value) => value.target),
      ['work', 'quoted-host', 'a', 'b', 'conditional'],
    )
    const resolvedDirectory = await realpath(directory)
    assert.ok(values.every((value) => value.source.startsWith(resolvedDirectory)))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('SSH 配置不存在返回空列表，未闭合引号保留错误', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'pi-ssh-empty-'))
  try {
    assert.deepEqual(await discoverSshCandidates(home), [])
    await mkdir(path.join(home, '.ssh'))
    await writeFile(path.join(home, '.ssh', 'config'), 'Host "unterminated')
    await assert.rejects(discoverSshCandidates(home), /未闭合/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
