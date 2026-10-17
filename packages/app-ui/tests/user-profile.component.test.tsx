import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { SettingsBridge } from '@pi-meme/contracts/desktop'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { AppRail } from '../src/layout/app-rail'
import { AccountSettings } from '../src/settings/account-settings'
import { DEFAULT_PROFILE, useUserProfile, type UserProfile } from '../src/settings/user-profile'

const storageKey = 'pi-meme-user-profile'
const hostProfile: UserProfile = {
  name: '喜东东',
  username: '@xdd',
  email: 'xdd@example.com',
  avatarText: '东',
  avatarUrl: 'data:image/png;base64,aG9zdA==',
}

function deferredProfile() {
  let resolve!: (profile: UserProfile) => void
  const promise = new Promise<UserProfile>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

test('缓存写入失败时仍显示 Host 资料，后续修改不丢失已加载字段', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('缓存空间不足', 'QuotaExceededError')
  })
  const saveUserProfile = vi.fn().mockResolvedValue(hostProfile)
  const bridge = { getUserProfile: vi.fn().mockResolvedValue(hostProfile), saveUserProfile }
  const { result } = renderHook(() => useUserProfile(bridge))

  await waitFor(() => expect(result.current.profile).toEqual(hostProfile))
  act(() => {
    result.current.updateProfile({ name: '新名字' })
  })

  expect(result.current.profile).toEqual({ ...hostProfile, name: '新名字' })
  expect(saveUserProfile).toHaveBeenCalledWith({
    name: '新名字',
    username: hostProfile.username,
    email: hostProfile.email,
    avatarText: hostProfile.avatarText,
    avatarData: hostProfile.avatarUrl,
  })
})

test('启动先显示缓存，Host 返回后更新资料和缓存', async () => {
  window.localStorage.setItem(storageKey, JSON.stringify(DEFAULT_PROFILE))
  const request = deferredProfile()
  const bridge = { getUserProfile: vi.fn(() => request.promise) }
  const { result } = renderHook(() => useUserProfile(bridge))

  expect(result.current.profile).toEqual(DEFAULT_PROFILE)
  expect(result.current.loading).toBe(true)
  expect(result.current.showPlaceholder).toBe(false)
  await act(async () => request.resolve(hostProfile))

  expect(result.current.profile).toEqual(hostProfile)
  expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toEqual(hostProfile)
})

test('Host 加载失败时保留缓存并结束加载', async () => {
  window.localStorage.setItem(storageKey, JSON.stringify(hostProfile))
  const bridge = { getUserProfile: vi.fn().mockRejectedValue(new Error('Host 离线')) }
  const { result } = renderHook(() => useUserProfile(bridge))

  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.profile).toEqual(hostProfile)
  expect(result.current.showPlaceholder).toBe(false)
})

test('卸载后的 Host 响应不再写入缓存', async () => {
  const request = deferredProfile()
  const bridge = { getUserProfile: vi.fn(() => request.promise) }
  const { unmount } = renderHook(() => useUserProfile(bridge))

  unmount()
  await act(async () => request.resolve(hostProfile))

  expect(window.localStorage.getItem(storageKey)).toBeNull()
})

test('切换 bridge 后忽略旧 Host 的响应', async () => {
  const oldRequest = deferredProfile()
  const oldBridge = { getUserProfile: vi.fn(() => oldRequest.promise) }
  const newBridge = { getUserProfile: vi.fn().mockResolvedValue(hostProfile) }
  const { result, rerender } = renderHook(({ bridge }) => useUserProfile(bridge), {
    initialProps: { bridge: oldBridge },
  })

  rerender({ bridge: newBridge })
  await waitFor(() => expect(result.current.profile).toEqual(hostProfile))
  await act(async () => oldRequest.resolve({ ...DEFAULT_PROFILE, name: '旧 Host' }))

  expect(result.current.profile).toEqual(hostProfile)
  expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toEqual(hostProfile)
})

test('无缓存且 Host 失败时结束占位并使用默认资料', async () => {
  const bridge = { getUserProfile: vi.fn().mockRejectedValue(new Error('Host 离线')) }
  const { result } = renderHook(() => useUserProfile(bridge))

  expect(result.current.showPlaceholder).toBe(true)
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.showPlaceholder).toBe(false)
  expect(result.current.profile).toEqual(DEFAULT_PROFILE)
})

function ProfileApp({
  bridge,
  accountOpen = false,
}: {
  bridge: Pick<SettingsBridge, 'getUserProfile' | 'saveUserProfile'>
  accountOpen?: boolean
}) {
  const { profile, loading, showPlaceholder, updateProfile } = useUserProfile(bridge)
  return (
    <TooltipProvider>
      <AppRail profile={profile} profileLoading={showPlaceholder} />
      {accountOpen && <AccountSettings profile={profile} loading={loading} updateProfile={updateProfile} />}
    </TooltipProvider>
  )
}

test('不打开设置也能加载侧栏头像，进入设置复用资料且保存后同步侧栏', async () => {
  const request = deferredProfile()
  const bridge = {
    getUserProfile: vi.fn(() => request.promise),
    saveUserProfile: vi.fn().mockResolvedValue(hostProfile),
  }
  const { rerender } = render(<ProfileApp bridge={bridge} />)
  const avatar = screen.getByRole('button', { name: '用户菜单与设置' })
  expect(avatar).toHaveAttribute('aria-busy', 'true')
  expect(avatar).not.toHaveTextContent('XD')
  expect(screen.queryByPlaceholderText('请输入姓名')).not.toBeInTheDocument()

  await act(async () => request.resolve(hostProfile))

  expect(avatar).toHaveAttribute('aria-busy', 'false')
  expect(avatar.querySelector('img')).toHaveAttribute('src', hostProfile.avatarUrl)
  expect(avatar.querySelector('img')).toHaveAttribute('alt', hostProfile.name)

  rerender(<ProfileApp bridge={bridge} accountOpen />)
  expect(bridge.getUserProfile).toHaveBeenCalledTimes(1)
  expect(screen.getByPlaceholderText('请输入姓名')).toHaveValue(hostProfile.name)
  fireEvent.change(screen.getByPlaceholderText('请输入姓名'), { target: { value: '更新姓名' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  expect(avatar.querySelector('img')).toHaveAttribute('alt', '更新姓名')
  expect(screen.getByPlaceholderText('请输入姓名')).toHaveValue('更新姓名')
  expect(bridge.saveUserProfile).toHaveBeenLastCalledWith(
    expect.objectContaining({ name: '更新姓名', avatarData: hostProfile.avatarUrl }),
  )

  fireEvent.click(screen.getByRole('button', { name: '更改' }))
  fireEvent.change(screen.getByPlaceholderText('请输入邮箱'), { target: { value: 'new@example.com' } })
  fireEvent.click(screen.getByRole('button', { name: '确定' }))
  expect(screen.getByText('new@example.com')).toBeInTheDocument()
  expect(bridge.saveUserProfile).toHaveBeenLastCalledWith(
    expect.objectContaining({ name: '更新姓名', email: 'new@example.com' }),
  )

  fireEvent.change(screen.getByLabelText('上传个人头像图片'), {
    target: { files: [new File(['avatar'], 'avatar.png', { type: 'image/png' })] },
  })
  const avatarData = 'data:image/png;base64,YXZhdGFy'
  await waitFor(() => expect(avatar.querySelector('img')).toHaveAttribute('src', avatarData))
  expect(bridge.saveUserProfile).toHaveBeenLastCalledWith(
    expect.objectContaining({ name: '更新姓名', email: 'new@example.com', avatarData }),
  )
})
