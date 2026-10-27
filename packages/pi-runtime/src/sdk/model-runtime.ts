import type { Api, Credential, CredentialStore, Model } from '@earendil-works/pi-ai'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models'
import type { PiModel } from '@pi-meme/contracts/pi'
import type { SecureCredentialStorage } from '@pi-meme/contracts/secure-storage'
import type { PiSdk } from './load'

type StoredModelCredentials = { credential?: Credential; env?: Record<string, string> }

export function projectModel(model: Model<Api>): PiModel {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    thinkingLevels: getSupportedThinkingLevels(model),
  }
}

function modelCredentialKey(providerId: string) {
  return `model-provider:${providerId}`
}

function parseCredential(value: string | undefined): StoredModelCredentials | undefined {
  if (!value) return undefined
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型凭据格式无效')
  return parsed as StoredModelCredentials
}

export function createModelCredentialStore(storage: SecureCredentialStorage): CredentialStore {
  const locks = new Map<string, Promise<unknown>>()
  const serialize = <T>(id: string, work: () => Promise<T>) => {
    const previous = locks.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    locks.set(id, next)
    void next.finally(() => {
      if (locks.get(id) === next) locks.delete(id)
    })
    return next
  }
  const read = (providerId: string) => parseCredential(storage.get(modelCredentialKey(providerId)))
  return {
    read: async (providerId) => {
      const value = read(providerId)
      if (!value) return undefined
      if (value.credential)
        return { ...value.credential, ...(value.credential.type === 'api_key' ? { env: value.env } : {}) }
      return value.env ? ({ type: 'api_key', env: value.env } satisfies Credential) : undefined
    },
    list: async () =>
      storage.entries('model-provider:').flatMap(([key, value]) => {
        const credential = parseCredential(value)
        if (!credential) return []
        return [
          {
            providerId: key.slice('model-provider:'.length),
            type: credential?.credential?.type ?? ('api_key' as const),
          },
        ]
      }),
    modify: (providerId, fn) =>
      serialize(providerId, async () => {
        const value = read(providerId)
        const current = await fn(
          value?.credential ?? (value?.env ? ({ type: 'api_key', env: value.env } satisfies Credential) : undefined),
        )
        if (current || value?.env)
          storage.set(
            modelCredentialKey(providerId),
            JSON.stringify({
              credential: current,
              env: value?.env,
            }),
          )
        else storage.delete(modelCredentialKey(providerId))
        return current
      }),
    delete: async (providerId) => {
      storage.delete(modelCredentialKey(providerId))
    },
  }
}

/** 所有 Pi 模型运行时显式使用 Desktop 模型文件、凭据存储和空环境认证上下文。 */
export async function createDesktopModelRuntime(
  sdk: PiSdk,
  agentDir: string,
  storage: SecureCredentialStorage,
  modelsPath = `${agentDir}/models.json`,
) {
  const runtime = await sdk.ModelRuntime.create({
    modelsPath,
    authPath: `${agentDir}/auth.json`,
    credentials: createModelCredentialStore(storage),
    allowModelNetwork: false,
    refreshOnCreate: false,
  })
  const internals = runtime as unknown as {
    models?: {
      authContext?: { env: (name: string) => Promise<string | undefined>; fileExists: () => Promise<boolean> }
    }
  }
  if (!internals.models || !('authContext' in internals.models)) throw new Error('当前 Pi SDK 不支持注入隔离认证上下文')
  internals.models.authContext = {
    env: async () => undefined,
    fileExists: async () => false,
  }
  await runtime.refresh({ allowNetwork: false })
  return runtime
}

let builtinProviderIds: Promise<ReadonlySet<string>> | undefined

/** Pi 安装包自带的服务商 ID。自定义 models.json 服务商不在其中。 */
export function desktopBuiltinProviderIds() {
  builtinProviderIds ??= import('@earendil-works/pi-ai/providers/all')
    .then(({ builtinProviders }) => new Set(builtinProviders().map((provider) => provider.id)))
    .catch((cause: unknown) => {
      builtinProviderIds = undefined
      throw cause
    })
  return builtinProviderIds
}
