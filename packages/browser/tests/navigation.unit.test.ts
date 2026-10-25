import { describe, expect, it } from 'vitest'
import { browserUrl, isLocalBrowserUrl } from '../src/shared/navigation'

describe('浏览器网址', () => {
  it('区分本机地址、网址和搜索', () => {
    expect(browserUrl('localhost:3181/path')).toBe('http://localhost:3181/path')
    expect(browserUrl('127.0.0.1:3181')).toBe('http://127.0.0.1:3181/')
    expect(browserUrl('[::1]:3181')).toBe('http://[::1]:3181/')
    expect(browserUrl('example.com/path')).toBe('https://example.com/path')
    expect(browserUrl('界面设计', 'google')).toBe(`https://www.google.com/search?q=${encodeURIComponent('界面设计')}`)
    expect(isLocalBrowserUrl('http://127.2.3.4:3181')).toBe(true)
    expect(isLocalBrowserUrl('https://localhost.example.com')).toBe(false)
  })
  it.each(['javascript:alert(1)', 'file:///tmp/test', 'data:text/html,hello', 'https://user:secret@example.com'])(
    '拒绝非网页协议或携带凭据的地址：%s',
    (value) => expect(() => browserUrl(value)).toThrow(),
  )
})
