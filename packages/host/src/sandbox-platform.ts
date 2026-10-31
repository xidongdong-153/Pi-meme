/** Host 与静态 Worker 共用的平台选择；未支持平台保留明确不可用的服务。 */
export function sandboxPluginId(platform = process.platform) {
  return platform === 'win32'
    ? '@pi-meme/sandbox-windows'
    : platform === 'linux'
      ? '@pi-meme/sandbox-linux'
      : '@pi-meme/sandbox-macos'
}
