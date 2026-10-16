import assert from 'node:assert/strict'
import { test } from 'vitest'
import { loadHostPage, retryHostPage } from '../src/main/window/load-host-page'
import { recoveryUrl } from '../src/main/window/recovery-page'
import { isTrustedPlatformSource } from '../src/main/ipc/platform-source'

test('远程切换失败先恢复连接身份，再载入原页面并报告中文错误', async () => {
  const actions: string[] = []
  await assert.rejects(
    loadHostPage(
      {
        loadURL: async (url) => {
          actions.push(url)
          if (url === 'https://unavailable.example') throw new Error('ERR_CONNECTION_REFUSED')
        },
      },
      'https://unavailable.example',
      'https://previous.example',
      () => {
        actions.push('rollback')
      },
    ),
    /无法连接 Host/,
  )
  assert.deepEqual(actions, ['https://unavailable.example', 'rollback', 'https://previous.example'])
})

test('初始 Host 不可达时载入固定恢复页', async () => {
  const actions: string[] = []
  await assert.rejects(
    loadHostPage(
      {
        loadURL: async (url) => {
          actions.push(url)
          if (url !== recoveryUrl) throw new Error('ERR_CONNECTION_REFUSED')
        },
      },
      'https://unavailable.example',
    ),
    /无法连接 Host/,
  )
  assert.equal(actions[1], recoveryUrl)
})

test('原页面也无法恢复时仍显示恢复入口', async () => {
  const actions: string[] = []
  await assert.rejects(
    loadHostPage(
      {
        loadURL: async (url) => {
          actions.push(url)
          if (url !== recoveryUrl) throw new Error('ERR_CONNECTION_REFUSED')
        },
      },
      'https://unavailable.example',
      'https://previous.example',
    ),
    /无法连接 Host/,
  )
  assert.deepEqual(actions, ['https://unavailable.example', 'https://previous.example', recoveryUrl])
})

test('恢复页只允许重试和回本地，不允许读取令牌或本机文件', () => {
  assert.equal(isTrustedPlatformSource(recoveryUrl, 'https://host.example', 'platform:retry-connection', []), true)
  assert.equal(isTrustedPlatformSource(recoveryUrl, 'https://host.example', 'platform:set-connection', [null]), true)
  for (const channel of ['platform:connection', 'platform:directory', 'platform:open-path', 'platform:project-apps'])
    assert.equal(isTrustedPlatformSource(recoveryUrl, 'https://host.example', channel, []), false)
  assert.equal(
    isTrustedPlatformSource(recoveryUrl, 'https://host.example', 'platform:set-connection', [
      { url: 'https://other.example', token: '' },
    ]),
    false,
  )
})

test('其他 data/file 页面和伪造恢复 URL 不受信任', () => {
  for (const url of [
    'data:text/html,invalid',
    `${recoveryUrl}#forged`,
    'file:///tmp/recovery.html',
    'https://other.example',
  ])
    assert.equal(isTrustedPlatformSource(url, 'https://host.example', 'platform:set-connection', [null]), false)
  assert.equal(
    isTrustedPlatformSource('https://host.example/path', 'https://host.example', 'platform:connection', []),
    true,
  )
})

test('无效远程配置重试不启动本地 Host', async () => {
  let localStarted = false
  const navigations: string[] = []
  await assert.rejects(
    retryHostPage(
      {
        loadURL: async (url) => {
          navigations.push(url)
        },
      },
      async () => {
        localStarted = true
        return 'http://127.0.0.1:31415'
      },
      new Error('远程 Host 配置无效'),
    ),
    /远程 Host 配置无效/,
  )
  assert.equal(localStarted, false)
  assert.deepEqual(navigations, [])
})

test('没有已知 Host 时不把 localhost 当作可信源', () => {
  assert.equal(isTrustedPlatformSource('http://localhost/', '', 'platform:connection', []), false)
  assert.equal(isTrustedPlatformSource(recoveryUrl, '', 'platform:set-connection', [null]), true)
})
