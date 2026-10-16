import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const frontendMime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2',
}

export async function serveFrontend(requestPath: string, options: { staticDirectory?: string; frontendUrl?: string }) {
  const requestUrl = new URL(requestPath, 'http://frontend')
  if (options.frontendUrl) {
    const target = new URL(options.frontendUrl)
    target.pathname = requestUrl.pathname
    target.search = requestUrl.search
    const upstream = await fetch(target, { redirect: 'manual' })
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream' },
    })
  }
  if (!options.staticDirectory) return Response.json({ error: '没有配置 Web 静态目录' }, { status: 404 })
  const root = path.resolve(options.staticDirectory)
  let target = path.resolve(root, `.${decodeURIComponent(requestUrl.pathname)}`)
  if (target !== root && !target.startsWith(`${root}${path.sep}`))
    return Response.json({ error: '文件路径无效' }, { status: 403 })
  if (!(await stat(target).catch(() => undefined))?.isFile()) target = path.join(root, 'index.html')
  const data = await readFile(target)
  const hashes =
    path.extname(target) === '.html'
      ? [...data.toString('utf8').matchAll(/<script\s[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/g)]
          .map((match) => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`)
          .join(' ')
      : ''
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': frontendMime[path.extname(target)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'self'; script-src 'self' ${hashes}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'`,
    },
  })
}
