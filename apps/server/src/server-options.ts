import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerOptions } from '@pi-meme/host/server'
import { createAppUpdateService } from '@pi-meme/host/app-update'
import { errorCode } from '@pi-meme/host/host-status'
import { hostPort } from '@pi-meme/contracts/host-runtime'

export async function serverOptions(
  entryUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ServerOptions> {
  const authMode = environment.PI_MEME_AUTH_MODE
  if (authMode !== undefined && authMode !== 'token-required')
    throw new Error('PI_MEME_AUTH_MODE 只支持 token-required；未设置时沿用默认认证方式')
  const certificate = environment.PI_MEME_TLS_CERT
  const key = environment.PI_MEME_TLS_KEY
  if (Boolean(certificate) !== Boolean(key)) throw new Error('HTTPS 证书与私钥必须同时配置')
  const directory = path.dirname(fileURLToPath(entryUrl))
  const bundled = entryUrl.endsWith('.js')
  const release = bundled
    ? await readFile(path.resolve(directory, '../../../release.json'), 'utf8').catch((cause: unknown) => {
        if (errorCode(cause) !== 'ENOENT') throw cause
        return undefined
      })
    : undefined
  const metadata = release ?? (await readFile(path.join(directory, '../package.json'), 'utf8'))
  const { version } = JSON.parse(metadata) as { version: string }
  if (typeof version !== 'string' || !version) throw new Error('Host 包元数据缺少产品版本')
  return {
    appUpdate: createAppUpdateService({
      kind: release !== undefined && environment.PI_MEME_DISTRIBUTION === 'docker' ? 'docker' : 'host',
      version,
      packaged: release !== undefined,
      developmentFeed: release === undefined ? environment.PI_MEME_UPDATE_FEED : undefined,
    }),
    dataRoot: environment.PI_MEME_DATA_ROOT,
    restrictedNode: environment.PI_MEME_PLUGIN_NODE || process.execPath,
    restrictedEntry:
      environment.PI_MEME_PLUGIN_ENTRY || (bundled ? path.join(directory, 'restricted-entry.mjs') : undefined),
    testCredentials: environment.PI_MEME_TEST_CREDENTIALS === 'memory',
    hostname: environment.PI_MEME_HOST ?? '127.0.0.1',
    port: hostPort(environment.PI_MEME_PORT),
    owner: 'server',
    token: environment.PI_MEME_TOKEN,
    localAutoLogin: authMode !== 'token-required',
    staticDirectory: environment.PI_MEME_WEB_ROOT ?? path.resolve(directory, '../../web/dist'),
    tls: certificate && key ? { cert: await readFile(certificate), key: await readFile(key) } : undefined,
    workerPath: environment.PI_MEME_WORKER_PATH ?? (bundled ? path.join(directory, 'session-worker.js') : undefined),
    builtinSkillsSource: bundled ? path.join(directory, 'skills') : undefined,
  }
}
