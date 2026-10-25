import type { BrowserSettings } from '@pi-meme/contracts/browser'

export function browserUrl(input: string, search: BrowserSettings['search'] = 'bing') {
  const text = input.trim()
  if (!text || text === 'about:blank') return 'about:blank'
  if (/^[a-z][\w+.-]*:/i.test(text) && !/^(?:localhost|[\w.-]+\.\w+):\d/i.test(text)) {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('网址须使用 HTTP 或 HTTPS，且不能包含用户名和密码')
    return url.href
  }
  if (/^(?:localhost|127(?:\.\d+){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(text)) return new URL(`http://${text}`).href
  if (/^[^\s/][^\s./]*\.[^\s/]+(?:[/?#]|$)/.test(text)) return new URL(`https://${text}`).href
  const engines = {
    bing: 'https://www.bing.com/search?q=',
    google: 'https://www.google.com/search?q=',
    duckduckgo: 'https://duckduckgo.com/?q=',
  }
  return engines[search] + encodeURIComponent(text)
}
export function isLocalBrowserUrl(value: string) {
  try {
    return (
      ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname) ||
      /^127\.\d+\.\d+\.\d+$/.test(new URL(value).hostname)
    )
  } catch {
    return false
  }
}
