import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AccountSettings } from '../src/settings/account-settings'

afterEach(cleanup)

test('AccountSettings 渲染表单时已移除状态与年龄，保留姓名、用户名与邮箱', () => {
  render(<AccountSettings />)

  // 验证不包含状态和年龄
  expect(screen.queryByText('状态')).not.toBeInTheDocument()
  expect(screen.queryByText('年龄')).not.toBeInTheDocument()
  expect(screen.queryByText('18 岁及以上')).not.toBeInTheDocument()

  // 验证包含姓名、用户名与邮箱
  expect(screen.getByText('姓名')).toBeInTheDocument()
  expect(screen.getByText('用户名')).toBeInTheDocument()
  expect(screen.getByText('电子邮箱')).toBeInTheDocument()
  expect(screen.getAllByText('@youzegehq')[0]).toBeInTheDocument()
  expect(screen.getByText('youzegehq@gmail.com')).toBeInTheDocument()
})

test('AccountSettings 具备头像上传编辑按钮并触发文件选择', () => {
  render(<AccountSettings />)

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

test('AccountSettings 保存姓名时调用持久化保存', () => {
  const saveUserProfile = vi.fn().mockResolvedValue({
    name: '新名字',
    username: '@youzegehq',
    email: 'youzegehq@gmail.com',
  })
  render(<AccountSettings bridge={{ getUserProfile: async () => null as never, saveUserProfile }} />)

  const nameInput = screen.getByPlaceholderText('请输入姓名')
  fireEvent.change(nameInput, { target: { value: '新名字' } })

  const saveBtn = screen.getByRole('button', { name: '保存' })
  expect(saveBtn).not.toBeDisabled()
  fireEvent.click(saveBtn)

  expect(saveUserProfile).toHaveBeenCalledWith(
    expect.objectContaining({
      name: '新名字',
    }),
  )
})
