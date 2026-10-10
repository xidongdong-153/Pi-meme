export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function serverError(name: string, config: unknown): string | undefined {
  if (!/^[\w-]+$/.test(name)) return '服务名称只能包含字母、数字、下划线和连字符'
  if (!object(config)) return '服务配置必须是 JSON 对象'
  const http = typeof config.url === 'string'
  const stdio = typeof config.command === 'string'
  if (http === stdio) return '请填写 URL 或可执行命令，不能同时填写两者'
  if (http) {
    if (!URL.canParse(config.url as string) || !['http:', 'https:'].includes(new URL(config.url as string).protocol))
      return 'URL 必须使用 HTTP 或 HTTPS'
    if (config.type !== undefined && !['http', 'streamable-http'].includes(String(config.type)))
      return 'HTTP 服务的 type 必须是 http 或 streamable-http'
  } else {
    if (!(config.command as string).trim() || (config.command as string).includes('\0'))
      return '可执行命令不能为空或包含空字符'
    if (config.type !== undefined && config.type !== 'stdio') return '本地服务的 type 必须是 stdio'
    if (
      config.args !== undefined &&
      (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== 'string'))
    )
      return 'args 必须是字符串数组'
    if (config.cwd !== undefined && typeof config.cwd !== 'string') return 'cwd 必须是字符串'
  }
  for (const key of ['headers', 'env'] as const) {
    if (
      config[key] !== undefined &&
      (!object(config[key]) || Object.values(config[key]).some((v) => typeof v !== 'string'))
    )
      return `${key} 必须是字符串键值对象`
  }
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') return 'enabled 必须是布尔值'
  if (config.description !== undefined && typeof config.description !== 'string') return 'description 必须是字符串'
  if (
    config.timeout !== undefined &&
    (typeof config.timeout !== 'number' || !Number.isFinite(config.timeout) || config.timeout <= 0)
  )
    return 'timeout 必须是大于 0 的秒数'
  const exposures = ['codemode', 'codemode-deferred', 'direct', 'deferred', 'hidden']
  if (config.exposure !== undefined && !exposures.includes(String(config.exposure))) return '工具暴露方式无效'
  if (
    config.toolExposure !== undefined &&
    (!object(config.toolExposure) || Object.values(config.toolExposure).some((v) => !exposures.includes(String(v))))
  )
    return 'toolExposure 必须将工具名称映射到有效的暴露方式'
  if (config.oauth !== undefined) {
    if (!object(config.oauth)) return 'oauth 必须是 JSON 对象'
    for (const key of ['clientId', 'clientSecret', 'scope', 'clientName', 'callbackUrl', 'authServerMetadataUrl']) {
      if (config.oauth[key] !== undefined && typeof config.oauth[key] !== 'string') return `oauth.${key} 必须是字符串`
    }
    const port = config.oauth.callbackPort
    if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535))
      return 'oauth.callbackPort 必须是 1 到 65535 的端口号'
    for (const key of ['callbackUrl', 'authServerMetadataUrl']) {
      const value = config.oauth[key]
      if (value === undefined) continue
      if (typeof value !== 'string' || !URL.canParse(value)) return `oauth.${key} 必须是有效 URL`
      const url = new URL(value)
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      if (key === 'callbackUrl') {
        if (!loopback || url.protocol !== 'http:' || url.search || url.hash)
          return 'OAuth 回调必须是本机 HTTP 地址，不能带查询参数或片段'
        if (url.port && port !== undefined && Number(url.port) !== port) return 'OAuth 回调地址与端口不一致'
      } else if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
        return 'OAuth 元数据地址必须使用 HTTPS 或本机 HTTP'
    }
  }
  if (config.auth !== undefined) {
    if (!http || !object(config.auth) || typeof config.auth.provider !== 'string' || !config.auth.provider.trim())
      return 'auth.provider 必须是 HTTP 服务的服务商名称'
    const url = new URL(config.url as string)
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      return '服务商认证需要 HTTPS 或本机 HTTP 地址'
  }
  return undefined
}
