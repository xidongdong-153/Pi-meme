import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { readWindowsControlledFile } from '@pi-meme/windows-native/controlled-read'

export type ControlledFileIdentity = { dev: string | number | bigint; ino: string | number | bigint }
export type ControlledFileReadOptions = {
  canonicalPath: string
  expected?: ControlledFileIdentity
  protectedRoots: readonly string[]
  readableRoots?: readonly string[]
  /** Host-verified immutable executable; never selected from PATH or a project. */
  fixedNode?: { executable: string }
  native?: { executable: string }
  maxBytes: number
  signal?: AbortSignal
}

export type ControlledDirectoryEntry = { name: string; kind: 'directory' | 'file'; size: number }
/** macOS rejects expected: public Node Dir exposes no descriptor for an honest identity binding. */
export type ControlledDirectoryReadOptions = Omit<ControlledFileReadOptions, 'maxBytes'> & { maxEntries?: number }

const directoryOutputLimit = 2 * 1024 * 1024
const maximum = 64 * 1024 * 1024
function within(root: string, target: string) {
  const relative = path.relative(root, target)
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}
function identity(value: string | number | bigint) {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new Error('controlled-read-invalid: 文件身份不精确')
  const result = String(value)
  if (!/^\d+$/.test(result)) throw new Error('controlled-read-invalid: 文件身份无效')
  return result
}
async function policyPath(value: string): Promise<string> {
  if (!path.isAbsolute(value) || value.includes('\0')) throw new Error('controlled-read-invalid: 保护根必须是绝对路径')
  const tail: string[] = []
  let current = path.resolve(value)
  for (;;) {
    try {
      return path.join(await realpath(current), ...tail)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(current) === current) throw cause
      tail.unshift(path.basename(current))
      current = path.dirname(current)
    }
  }
}

// Only this constant program receives authority. Input is bounded JSON on stdin, never executable source.
// Linux resolves one component at a time through stable directory descriptors; macOS relies on Seatbelt
// for the actual vnode read boundary, NOT repeated pathname stat/realpath comparisons.
const fixedReader = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const c = fs.constants;
const fds = [];
let file;
let listing;
function within(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}
function checkPath(target, input) {
  if (['/proc', '/sys', '/dev'].some(root => within(root, target))) throw Error('controlled-read-denied: pseudo filesystem');
  for (const root of input.protectedRoots)
    if (within(root, target) && !input.readableRoots.some(allowed => within(root, allowed) && within(allowed, target)))
      throw Error('controlled-read-denied: protected root');
}
function stamp(s) { return [s.dev, s.ino, s.size, s.nlink, s.mtimeNs, s.ctimeNs].map(String).join(':'); }
try {
  const chunks = []; let total = 0; const inputBuffer = Buffer.allocUnsafe(65536);
  for (;;) {
    const n = fs.readSync(0, inputBuffer, 0, inputBuffer.length, null);
    if (!n) break;
    total += n;
    if (total > 1024 * 1024) throw Error('controlled-read-invalid: request too large');
    chunks.push(Buffer.from(inputBuffer.subarray(0, n)));
  }
  const input = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0 || input.maxBytes > 67108864)
    throw Error('controlled-read-invalid: size limit');
  const target = input.canonicalPath;
  if (typeof target !== 'string' || !path.isAbsolute(target) || path.normalize(target) !== target || target.includes('\0'))
    throw Error('controlled-read-invalid: canonical path');
  checkPath(target, input);
  if (!c.O_NOFOLLOW || !c.O_NONBLOCK) throw Error('controlled-read-unavailable: no nofollow/nonblock');
  if (input.directory && (!Number.isSafeInteger(input.maxEntries) || input.maxEntries < 0 || input.maxEntries > 10000))
    throw Error('controlled-read-invalid: entry limit');
  if (input.directory && process.platform === 'darwin' && input.expected)
    throw Error('controlled-read-unsupported: macOS directory identity needs an exposed directory handle');
  if (process.platform === 'linux') {
    if (!c.O_DIRECTORY) throw Error('controlled-read-unavailable: no directory descriptors');
    let directory = fs.openSync('/', c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
    fds.push(directory);
    const parts = input.directory && target === '/' ? [] : target.slice(1).split('/');
    if (parts.some(p => !p || p === '.' || p === '..')) throw Error('controlled-read-invalid: components');
    for (const component of parts.slice(0, -1)) {
      directory = fs.openSync('/proc/self/fd/' + directory + '/' + component, c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
      fds.push(directory);
    }
    if (!parts.length) { file = directory; fds.pop(); }
    else file = fs.openSync('/proc/self/fd/' + directory + '/' + parts.at(-1), c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK | (input.directory ? c.O_DIRECTORY : 0));
    checkPath(fs.readlinkSync('/proc/self/fd/' + file), input);
  } else if (process.platform === 'darwin') {
    if (!input.directory) file = fs.openSync(target, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK);
  } else throw Error('controlled-read-unavailable: platform');
  if (input.directory) {
    const base = process.platform === 'linux' ? '/proc/self/fd/' + file : target;
    const before = file === undefined ? fs.lstatSync(target, { bigint: true }) : fs.fstatSync(file, { bigint: true });
    if (!before.isDirectory()) throw Error('controlled-read-denied: not a directory');
    if (input.expected && (String(before.dev) !== input.expected.dev || String(before.ino) !== input.expected.ino))
      throw Error('controlled-read-stale: directory identity changed');
    listing = fs.opendirSync(base, { encoding: 'buffer', bufferSize: 32 });
    const result = []; let scanned = 0; let bytes = 2;
    for (;;) {
      const entry = listing.readSync();
      if (!entry) break;
      if (++scanned > input.maxEntries) throw Error('controlled-read-too-large: directory entry limit');
      const raw = entry.name;
      if (!Buffer.isBuffer(raw)) throw Error('controlled-read-unsupported: runtime lacks raw directory names');
      const name = raw.toString('utf8');
      if (!Buffer.from(name, 'utf8').equals(raw)) continue;
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0') || entry.isSymbolicLink()) continue;
      try { checkPath(path.join(target, name), input); } catch { continue; }
      let stat;
      try { stat = fs.lstatSync(path.join(base, name), { bigint: true }); }
      catch (error) { if (['ENOENT', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) continue; throw error; }
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue;
      const size = stat.isDirectory() ? 0 : Number(stat.size);
      if (!Number.isSafeInteger(size) || size < 0) throw Error('controlled-read-unsupported: unrepresentable entry size');
      const value = { name, kind: stat.isDirectory() ? 'directory' : 'file', size };
      bytes += Buffer.byteLength(JSON.stringify(value)) + (result.length ? 1 : 0);
      if (bytes > 2097152) throw Error('controlled-read-too-large: directory output limit');
      result.push(value);
    }
    const after = file === undefined ? fs.lstatSync(target, { bigint: true }) : fs.fstatSync(file, { bigint: true });
    if (stamp(before) !== stamp(after)) throw Error('controlled-read-stale: directory changed during listing');
    const output = Buffer.from(JSON.stringify(result)); let written = 0;
    while (written < output.length) written += fs.writeSync(1, output, written, output.length - written);
  } else {
  const before = fs.fstatSync(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) throw Error('controlled-read-denied: not a singly linked regular file');
  if (input.expected && (String(before.dev) !== input.expected.dev || String(before.ino) !== input.expected.ino))
    throw Error('controlled-read-stale: file identity changed');
  if (before.size > BigInt(input.maxBytes)) throw Error('controlled-read-too-large');
  const output = []; let bytes = 0;
  const buffer = Buffer.allocUnsafe(Math.min(65536, input.maxBytes + 1));
  for (;;) {
    const n = fs.readSync(file, buffer, 0, Math.min(buffer.length, input.maxBytes - bytes + 1), null);
    if (!n) break;
    bytes += n;
    if (bytes > input.maxBytes) throw Error('controlled-read-too-large');
    output.push(Buffer.from(buffer.subarray(0, n)));
  }
  const after = fs.fstatSync(file, { bigint: true });
  if (stamp(before) !== stamp(after) || after.nlink !== 1n) throw Error('controlled-read-stale: file changed during read');
  const result = Buffer.concat(output, bytes);
  let written = 0;
  while (written < result.length) written += fs.writeSync(1, result, written, result.length - written);
  }
} catch (error) {
  process.stderr.write(String(error && error.message || error).slice(0, 4096));
  process.exitCode = 1;
} finally {
  if (listing !== undefined) { try { listing.closeSync(); } catch {} }
  if (file !== undefined) { try { fs.closeSync(file); } catch {} }
  for (const fd of fds.reverse()) { try { fs.closeSync(fd); } catch {} }
}
`

async function unixRead(
  executable: string,
  args: string[],
  input: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (signal?.aborted) throw new Error('aborted')
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin', HOME: '/', TMPDIR: '/tmp', LANG: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let size = 0
    let diagnostic = ''
    let failure: Error | undefined
    const stop = () => child.kill('SIGKILL')
    const abort = () => {
      failure = new Error('aborted')
      stop()
    }
    const timer = setTimeout(() => {
      failure = new Error('controlled-read-timeout')
      stop()
    }, 30000)
    process.once('exit', stop)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
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
      signal?.removeEventListener('abort', abort)
      if (failure || code !== 0) reject(failure ?? new Error(diagnostic || 'controlled-read-failed'))
      else resolve(Buffer.concat(chunks, size))
    })
    child.stdin.end(input)
  })
}

/** Read data only in the fixed adapter; unavailable isolation never falls back to owner fs.readFile. */
export async function readControlledFile(options: ControlledFileReadOptions): Promise<Buffer> {
  return controlledRead(options)
}

export async function readControlledDirectory(
  options: ControlledDirectoryReadOptions,
): Promise<ControlledDirectoryEntry[]> {
  if (options.signal?.aborted) throw new Error('aborted')
  if (process.platform === 'darwin' && options.expected)
    throw new Error('controlled-read-unsupported: macOS Node Dir 没有可公开验证的目录句柄')
  const maxEntries = options.maxEntries ?? 10000
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > 10000)
    throw new Error('controlled-read-invalid: maxEntries 必须在 0–10000 内')
  const output = await controlledRead({ ...options, maxBytes: directoryOutputLimit }, maxEntries)
  if (options.signal?.aborted) throw new Error('aborted')
  const entries: unknown = JSON.parse(output.toString('utf8'))
  if (
    !Array.isArray(entries) ||
    entries.length > maxEntries ||
    entries.some(
      (entry) =>
        !entry ||
        typeof entry.name !== 'string' ||
        !entry.name ||
        entry.name === '.' ||
        entry.name === '..' ||
        /[/\0]/.test(entry.name) ||
        (process.platform === 'win32' && entry.name.includes('\\')) ||
        !['directory', 'file'].includes(entry.kind) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0,
    )
  )
    throw new Error('controlled-read-invalid: 无效目录响应')
  return entries as ControlledDirectoryEntry[]
}

async function controlledRead(options: ControlledFileReadOptions, maxEntries?: number): Promise<Buffer> {
  if (options.signal?.aborted) throw new Error('aborted')
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || options.maxBytes > maximum)
    throw new Error('controlled-read-invalid: maxBytes 必须在 0–64 MiB 内')
  if (!path.isAbsolute(options.canonicalPath) || options.canonicalPath.includes('\0'))
    throw new Error('controlled-read-invalid: 文件路径必须绝对且无 NUL')
  const expected = options.expected && { dev: identity(options.expected.dev), ino: identity(options.expected.ino) }
  if (process.platform === 'win32') {
    if (!options.native) throw new Error('controlled-read-unavailable: 缺少固定 Windows native reader')
    return readWindowsControlledFile({
      ...options,
      expected,
      executable: options.native.executable,
      directory: maxEntries !== undefined,
      maxEntries,
    })
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error(`controlled-read-unavailable: ${process.platform}`)
  if (!options.fixedNode || !path.isAbsolute(options.fixedNode.executable))
    throw new Error('controlled-read-unavailable: 缺少固定 Node reader')
  // Canonicalization defines the policy selectors. The helper's pinned descriptors / kernel policy
  // enforce the boundary at the actual read; these metadata lookups are not a TOCTOU proof.
  const protectedRoots = await Promise.all(options.protectedRoots.map(policyPath))
  const readableRoots = await Promise.all((options.readableRoots ?? []).map(policyPath))
  for (const root of readableRoots)
    if (!protectedRoots.some((privateRoot) => within(privateRoot, root)) || protectedRoots.some((p) => within(root, p)))
      throw new Error('controlled-read-invalid: readableRoots 必须严格位于私有根内且不能覆盖其他私有根')
  for (const root of protectedRoots)
    if (
      within(root, options.canonicalPath) &&
      !readableRoots.some((r) => within(root, r) && within(r, options.canonicalPath))
    )
      throw new Error('controlled-read-denied: 私有根')
  const node = await realpath(options.fixedNode.executable)
  const input = JSON.stringify({
    canonicalPath: options.canonicalPath,
    expected,
    protectedRoots,
    readableRoots,
    maxBytes: options.maxBytes,
    directory: maxEntries !== undefined,
    maxEntries,
  })
  if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('controlled-read-invalid: 策略过大')
  if (options.signal?.aborted) throw new Error('aborted')
  if (process.platform === 'linux')
    return unixRead(
      node,
      ['--disable-sigusr1', '--no-addons', '-e', fixedReader],
      input,
      options.maxBytes,
      options.signal,
    )
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(deny network*)',
    '(deny process-fork)',
    ...protectedRoots.map((root) => {
      const exceptions = readableRoots
        .filter((entry) => within(root, entry))
        .map((entry) => `(require-not (subpath ${JSON.stringify(entry)}))`)
      if (within(root, node)) exceptions.push(`(require-not (literal ${JSON.stringify(node)}))`)
      const selector = exceptions.length
        ? `(require-all (subpath ${JSON.stringify(root)}) ${exceptions.join(' ')})`
        : `(subpath ${JSON.stringify(root)})`
      return `(deny file-read* ${selector})`
    }),
  ].join('\n')
  return unixRead(
    '/usr/bin/sandbox-exec',
    ['-p', profile, node, '--disable-sigusr1', '--no-addons', '-e', fixedReader],
    input,
    options.maxBytes,
    options.signal,
  )
}
