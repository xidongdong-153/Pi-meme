import { createHash } from 'node:crypto'
import { object } from './config'

/** 授权绑定具体服务配置；同名项目服务不能继承其他地址的授权。 */
export function mcpAuthorization(config: unknown): string {
  function normalize(value: unknown, location: string[] = []): unknown {
    if (Array.isArray(value)) return value.map((item) => normalize(item, location))
    if (!object(value)) return value
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter(
          (key) =>
            !(
              (location.length === 0 && ['enabled', 'exposure', 'toolExposure'].includes(key)) ||
              (location.length === 1 && location[0] === 'oauth' && key === 'clientSecret')
            ),
        )
        .map((key) => [key, normalize(value[key], [...location, key])]),
    )
  }
  return createHash('sha256')
    .update(JSON.stringify(normalize(config)))
    .digest('hex')
}
