import { spawn } from 'node:child_process'
import path from 'node:path'

export type WindowsControlledReadOptions = {
  executable: string
  canonicalPath: string
  expected?: { dev: string; ino: string }
  protectedRoots: readonly string[]
  readableRoots?: readonly string[]
  maxBytes: number
  directory?: boolean
  maxEntries?: number
  signal?: AbortSignal
}

/** Fixed native command only. No PSEC discovery and no JS/process execution request is accepted. */
export async function readWindowsControlledFile(options: WindowsControlledReadOptions): Promise<Buffer> {
  if (process.platform !== 'win32') throw new Error('controlled-read-unavailable: Windows reader 仅限 Windows')
  if (!path.isAbsolute(options.executable)) throw new Error('controlled-read-unavailable: native 路径必须固定且绝对')
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || options.maxBytes > 64 * 1024 * 1024)
    throw new Error('controlled-read-invalid: maxBytes 超出限制')
  if (options.signal?.aborted) throw new Error('aborted')
  const input = JSON.stringify({
    canonicalPath: options.canonicalPath,
    expected: options.expected,
    protectedRoots: options.protectedRoots,
    readableRoots: options.readableRoots ?? [],
    maxBytes: options.maxBytes,
    directory: options.directory ?? false,
    maxEntries: options.maxEntries,
  })
  if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('controlled-read-invalid: 策略过大')
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {}
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
    if (systemRoot) env.SystemRoot = systemRoot
    const child = spawn(options.executable, ['controlled-read'], {
      cwd: path.parse(options.executable).root,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let size = 0
    let diagnostic = ''
    let failure: Error | undefined
    const stop = () => child.kill()
    const abort = () => {
      failure = new Error('aborted')
      stop()
    }
    const timer = setTimeout(() => {
      failure = new Error('controlled-read-timeout')
      stop()
    }, 30000)
    process.once('exit', stop)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      // Error JSON from the native command is bounded too; failed reads never return its bytes as content.
      if (size > Math.max(options.maxBytes, 8192)) {
        failure = new Error('controlled-read-too-large')
        stop()
      } else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096)
    })
    child.stdin.on('error', () => {})
    child.once('error', (cause) => {
      failure = cause
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      process.removeListener('exit', stop)
      options.signal?.removeEventListener('abort', abort)
      if (code !== 0 && !failure) {
        try {
          const response = JSON.parse(Buffer.concat(chunks, Math.min(size, 8192)).toString('utf8')) as {
            type?: string
            message?: string
          }
          if (response.type === 'error' && typeof response.message === 'string')
            diagnostic = response.message.slice(0, 4096)
        } catch {
          /* Preserve only the bounded diagnostic, never partial file content. */
        }
      }
      if (failure || code !== 0 || size > options.maxBytes)
        reject(failure ?? new Error(diagnostic || 'controlled-read-failed'))
      else resolve(Buffer.concat(chunks, size))
    })
    child.stdin.end(input)
  })
}
