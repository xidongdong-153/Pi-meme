import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AccountSettings } from '../src/settings/account-settings'
import { DEFAULT_PROFILE } from '../src/settings/user-profile'

afterEach(cleanup)

function renderAccount(props: Partial<Parameters<typeof AccountSettings>[0]> = {}) {
  return render(<AccountSettings profile={DEFAULT_PROFILE} loading={false} updateProfile={vi.fn()} {...props} />)
}

test('AccountSettings 渲染表单时已移除状态与年龄，保留姓名、用户名与邮箱', () => {
  renderAccount()

  // 验证不包含状态、年龄与环境授权
  expect(screen.queryByText('状态')).not.toBeInTheDocument()
  expect(screen.queryByText('年龄')).not.toBeInTheDocument()
  expect(screen.queryByText('18 岁及以上')).not.toBeInTheDocument()
  expect(screen.queryByText('环境与授权')).not.toBeInTheDocument()

  // 验证包含姓名、用户名与邮箱
  expect(screen.getByText('姓名')).toBeInTheDocument()
  expect(screen.getByText('用户名')).toBeInTheDocument()
  expect(screen.getByText('电子邮箱')).toBeInTheDocument()
  expect(screen.getAllByText('@meme')[0]).toBeInTheDocument()
  expect(screen.getByText('meme@example.com')).toBeInTheDocument()
})

test('AccountSettings 具备头像上传编辑按钮并触发文件选择', () => {
  renderAccount()

  const editAvatarBtn = screen.getByRole('button', { name: '修改头像' })
  expect(editAvatarBtn).toBeInTheDocument()

  const fileInput = screen.getByLabelText('上传个人头像图片') as HTMLInputElement
  expect(fileInput).toBeInTheDocument()
  expect(fileInput.type).toBe('file')
  expect(fileInput.accept).toContain('image/')

  const clickSpy = vi.spyOn(fileInput, 'click')
  fireEvent.click(editAvatarBtn)
  expect(clickSpy).toHaveBeenCalledTimes(1)
})

test('AccountSettings 保存姓名时通知应用更新资料', () => {
  const updateProfile = vi.fn()
  renderAccount({ updateProfile })

  const nameInput = screen.getByPlaceholderText('请输入姓名')
  fireEvent.change(nameInput, { target: { value: '新名字' } })

  const saveBtn = screen.getByRole('button', { name: '保存' })
  expect(saveBtn).not.toBeDisabled()
  fireEvent.click(saveBtn)

  expect(updateProfile).toHaveBeenCalledWith({ name: '新名字' })
})

test('异步资料到达时同步表单，加载期间禁用编辑', () => {
  const { rerender } = renderAccount({ loading: true })
  const nameInput = screen.getByPlaceholderText('请输入姓名')
  expect(nameInput).toBeDisabled()
  expect(screen.getByLabelText('上传个人头像图片')).toBeDisabled()
  expect(screen.getByRole('button', { name: '修改头像' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '更改' })).toBeDisabled()

  const profile = { ...DEFAULT_PROFILE, name: '真实姓名', email: 'host@example.com' }
  rerender(<AccountSettings profile={profile} loading={false} updateProfile={vi.fn()} />)

  expect(nameInput).toBeEnabled()
  expect(nameInput).toHaveValue(profile.name)
  fireEvent.click(screen.getByRole('button', { name: '更改' }))
  expect(screen.getByPlaceholderText('请输入邮箱')).toHaveValue(profile.email)
})

test('资料更新不覆盖未保存的姓名和邮箱草稿，取消邮箱编辑恢复最新值', () => {
  const { rerender } = renderAccount()
  fireEvent.change(screen.getByPlaceholderText('请输入姓名'), { target: { value: '未保存姓名' } })
  fireEvent.click(screen.getByRole('button', { name: '更改' }))
  fireEvent.change(screen.getByPlaceholderText('请输入邮箱'), { target: { value: 'draft@example.com' } })

  const profile = { ...DEFAULT_PROFILE, name: '新资料姓名', email: 'updated@example.com' }
  rerender(<AccountSettings profile={profile} loading={false} updateProfile={vi.fn()} />)

  expect(screen.getByPlaceholderText('请输入姓名')).toHaveValue('未保存姓名')
  expect(screen.getByPlaceholderText('请输入邮箱')).toHaveValue('draft@example.com')
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  fireEvent.click(screen.getByRole('button', { name: '更改' }))
  expect(screen.getByPlaceholderText('请输入邮箱')).toHaveValue(profile.email)
})
