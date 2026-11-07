import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { visualizationPreviewPath, visualizationPreviewResponse } from '@pi-meme/visualize/server/preview-page'

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
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
}

export async function serveFrontend(requestPath: string, options: { staticDirectory?: string; frontendUrl?: string }) {
  const requestUrl = new URL(requestPath, 'http://frontend')
  if (requestUrl.pathname === visualizationPreviewPath) return visualizationPreviewResponse()
  if (options.frontendUrl)
    return Response.json(
      { error: 'runtime-snapshot-required: 拥有者界面不接受 live frontendUrl，请使用固定静态运行时快照' },
      { status: 503 },
    )
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
