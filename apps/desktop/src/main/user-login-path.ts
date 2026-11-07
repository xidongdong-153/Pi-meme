import path from 'node:path'

/** Owner startup never executes a login shell or sources user-writable profiles. */
export async function prepareDesktopHostEnv(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const result = { ...env }
  for (const key of Object.keys(result)) if (/^(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV)$/i.test(key)) delete result[key]
  const fixedNode = result.PI_MEME_PLUGIN_NODE
  const fixed = fixedNode && path.isAbsolute(fixedNode) ? [path.dirname(fixedNode)] : []
  const system =
    process.platform === 'win32'
      ? []
      : ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin']
  const inheritedPath =
    process.platform === 'win32'
      ? Object.entries(result).find(([key]) => key.toUpperCase() === 'PATH')?.[1]
      : result.PATH
  if (process.platform === 'win32')
    for (const key of Object.keys(result)) if (key.toUpperCase() === 'PATH') delete result[key]
  const entries = [...fixed, ...(inheritedPath ?? '').split(path.delimiter), ...system].filter((entry) =>
    path.isAbsolute(entry),
  )
  result.PATH = [...new Set(entries)].join(path.delimiter)
  return result
}
