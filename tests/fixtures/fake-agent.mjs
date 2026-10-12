// @ts-check
// 为集成测试准备 Desktop 运行目录：模型配置和凭据只写入测试提供的应用目录。
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { startFakeProvider } from './fake-provider.mjs'

/** @typedef {import('./fake-provider.mjs').FakeProviderOptions} FakeProviderOptions */

/** @param {string} userData */
function createRuntimePaths(userData) {
  const agentDir = path.join(userData, 'pi')
  const sessionsDirectory = path.join(userData, 'sessions')
  const workspaceDataRoot = path.join(userData, 'workspaces')
  /** @param {string} cwd */
  const workspaceKey = (cwd) => {
    let normalized
    try {
      normalized = realpathSync.native(cwd)
    } catch {
      normalized = path.resolve(cwd)
    }
    return createHash('sha256').update(normalized).digest('hex')
  }
  return {
    dataRoot: userData,
    agentDir,
    skillsDirectory: path.join(userData, 'skills'),
    extensionsDirectory: path.join(userData, 'extensions'),
    builtinSkillsDirectory: path.join(userData, 'builtin-resources', 'skills'),
    sessionsDirectory,
    workspaceDataRoot,
    secureCredentialsFile: path.join(userData, 'secure', 'credentials.bin'),
    workspaceKey,
    /** @param {string} cwd */
    sessionDirectory: (cwd) => path.join(sessionsDirectory, workspaceKey(cwd)),
    /** @param {string} cwd */
    workspaceDirectory: (cwd) => path.join(workspaceDataRoot, workspaceKey(cwd)),
  }
}

function createCredentials() {
  /** @type {Map<string, string>} */
  const values = new Map()
  return {
    /** @param {string} key */
    get: (key) => values.get(key),
    /** @param {string} key @param {string} value */
    set: (key, value) => values.set(key, value),
    /** @param {string} key */
    delete: (key) => values.delete(key),
    /** @param {string} [prefix] */
    entries: (prefix = '') => [...values.entries()].filter(([key]) => key.startsWith(prefix)),
  }
}

/**
 * 启动假模型端点并在 Desktop 专属目录写入模型配置和加密存储接口。
 *
 * @param {string} directory 测试用临时根目录
 * @param {{ models?: { id: string; name?: string; reasoning?: boolean }[]; providers?: Record<string, unknown>; reply?: FakeProviderOptions['reply'] }} [options]
 * @returns {Promise<{ agentDir: string; modelsFile: string; runtimePaths: ReturnType<typeof createRuntimePaths>; credentials: ReturnType<typeof createCredentials>; provider: Awaited<ReturnType<typeof startFakeProvider>>; dispose: () => Promise<void> }>}
 *   agentDir 供断言使用，dispose 关闭假模型端点。
 */
export async function useFakeAgent(directory, options = {}) {
  const provider = await startFakeProvider({ reply: options.reply })
  const runtimePaths = createRuntimePaths(path.join(directory, 'userData'))
  const agentDir = runtimePaths.agentDir
  await mkdir(agentDir, { recursive: true })
  const modelsFile = path.join(agentDir, 'models.json')
  const models = options.models ?? [{ id: 'first', name: '模型 first', reasoning: true }]
  const credentials = createCredentials()
  const configuredProviders = options.providers ?? {
    fake: {
      name: '假服务',
      api: 'openai-completions',
      baseUrl: provider.baseUrl,
      apiKey: 'test',
      models,
    },
  }
  const providers = Object.fromEntries(
    Object.entries(configuredProviders).map(([providerId, raw]) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [providerId, raw]
      const providerConfig = /** @type {Record<string, unknown>} */ (raw)
      const { apiKey, ...config } = providerConfig
      if (typeof apiKey === 'string')
        credentials.set(
          `model-provider:${providerId}`,
          JSON.stringify({ credential: { type: 'api_key', key: apiKey } }),
        )
      return [providerId, config]
    }),
  )
  await writeFile(modelsFile, JSON.stringify({ providers }))
  return {
    agentDir,
    modelsFile,
    runtimePaths,
    credentials,
    provider,
    dispose: () => provider.close(),
  }
}
