const { createHash } = require('node:crypto')
const { realpathSync } = require('node:fs')
const path = require('node:path')

module.exports.sessionDirectory = (userData, cwd) => {
  let normalized
  try {
    normalized = realpathSync.native(cwd)
  } catch {
    normalized = path.resolve(cwd)
  }
  const workspaceKey = createHash('sha256').update(normalized).digest('hex')
  return path.join(userData, 'sessions', workspaceKey)
}
