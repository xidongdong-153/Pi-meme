import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerOptions } from '@pi-meme/host/server'
import { hostPort } from '@pi-meme/contracts/host-runtime'
import { readRuntimeSnapshot } from '@pi-meme/host/runtime-snapshot'

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
  const snapshot = environment.PI_MEME_RUNTIME_SNAPSHOT
    ? await readRuntimeSnapshot(environment.PI_MEME_RUNTIME_SNAPSHOT, environment.PI_MEME_DATA_ROOT)
    : undefined
  const directory = path.dirname(fileURLToPath(entryUrl))
  const bundled = entryUrl.endsWith('.js')
  return {
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
    staticDirectory:
      snapshot?.staticDirectory ?? environment.PI_MEME_WEB_ROOT ?? path.resolve(directory, '../../web/dist'),
    tls: certificate && key ? { cert: await readFile(certificate), key: await readFile(key) } : undefined,
    workerPath:
      snapshot?.workerPath ??
      environment.PI_MEME_WORKER_PATH ??
      (bundled ? path.join(directory, 'session-worker.js') : undefined),
    builtinSkillsSource: snapshot?.skillsDirectory ?? (bundled ? path.join(directory, 'skills') : undefined),
  }
}
