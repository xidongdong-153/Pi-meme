import { useRef, useState, type ChangeEvent } from 'react'
import { Check, Pencil, UserCheck } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import type { UserProfile } from './user-profile'

export function AccountSettings({
  profile,
  loading,
  updateProfile,
}: {
  profile: UserProfile
  loading: boolean
  updateProfile: (patch: Partial<UserProfile>) => void
}) {
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [isEditingEmail, setIsEditingEmail] = useState(false)
  const [emailDraft, setEmailDraft] = useState<string | null>(null)
  const nameInput = nameDraft ?? profile.name
  const emailInput = emailDraft ?? profile.email
  const [nameSavedNotice, setNameSavedNotice] = useState(false)
  const [emailSavedNotice, setEmailSavedNotice] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const isNameChanged = nameInput.trim() !== '' && nameInput.trim() !== profile.name

  const handleSaveName = () => {
    if (loading || !nameInput.trim()) return
    updateProfile({ name: nameInput.trim() })
    setNameDraft(null)
    setNameSavedNotice(true)
    setTimeout(setNameSavedNotice, 2000, false)
  }

  const handleSaveEmail = () => {
    if (loading || !emailInput.trim()) return
    updateProfile({ email: emailInput.trim() })
    setEmailDraft(null)
    setIsEditingEmail(false)
    setEmailSavedNotice(true)
    setTimeout(setEmailSavedNotice, 2000, false)
  }

  const handleAvatarClick = () => {
    if (loading) return
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (event) => {
      const dataUrl = event.target?.result
      if (typeof dataUrl === 'string') {
        updateProfile({ avatarUrl: dataUrl })
      }
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  return (
    <div className="space-y-6 max-w-2xl text-foreground">
      {/* 头部个人展示卡片（包含头像上传配置，参考图设计） */}
      <section className="flex flex-col items-center justify-center py-6 px-4 rounded-2xl border border-border bg-card/50 text-center gap-3">
        {/* 隐藏的文件上传 input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          disabled={loading}
          onChange={handleFileChange}
          className="hidden"
          aria-label="上传个人头像图片"
        />

        {/* 头像容器，支持 hover 触发铅笔 ICON */}
        <div className="relative group cursor-pointer" onClick={handleAvatarClick}>
          <div className="flex size-20 items-center justify-center rounded-full bg-[#e8a838] text-2xl font-bold text-neutral-900 shadow-md overflow-hidden transition-transform group-hover:scale-102">
            {profile.avatarUrl ? (
              <img src={profile.avatarUrl} alt={profile.name} className="size-full rounded-full object-cover" />
            ) : (
              profile.avatarText
            )}
          </div>

          {/* 鼠标移上去显示的铅笔 ICON（参考设计稿右上角浮层） */}
          <button
            type="button"
            aria-label="修改头像"
            disabled={loading}
            onClick={(e) => {
              e.stopPropagation()
              handleAvatarClick()
            }}
            className="absolute -top-1 -right-1 flex size-7 items-center justify-center rounded-full bg-neutral-800 text-white border border-neutral-600/80 shadow-md transition-all opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:scale-110 active:scale-95 cursor-pointer"
          >
            <Pencil className="size-3.5 text-white" />
          </button>
        </div>

        <div className="space-y-1">
          <h2 className="text-xl font-bold text-foreground tracking-tight">{profile.name}</h2>
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-secondary/80 text-xs font-mono text-muted-foreground border border-border/50">
            <UserCheck className="size-3 text-primary" />
            <span>{profile.username}</span>
          </div>
        </div>
      </section>

      {/* 账户卡片区域（已移除状态和年龄） */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground px-1">账户设置</h3>
        <div className="rounded-2xl border border-border bg-card divide-y divide-border/60 overflow-hidden text-sm">
          {/* 姓名 */}
          <div className="flex items-center justify-between gap-4 px-5 py-3.5">
            <span className="text-muted-foreground shrink-0">姓名</span>
            <div className="flex items-center gap-2 max-w-xs w-full justify-end">
              <Input
                value={nameInput}
                disabled={loading}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="请输入姓名"
                className="h-8 text-xs bg-background/60"
              />
              <Button
                size="sm"
                variant={isNameChanged ? 'default' : 'secondary'}
                disabled={loading || !isNameChanged}
                onClick={handleSaveName}
                className="h-8 text-xs shrink-0 cursor-pointer"
              >
                {nameSavedNotice ? <Check className="size-3 text-emerald-400" /> : '保存'}
              </Button>
            </div>
          </div>

          {/* 用户名 */}
          <div className="flex items-center justify-between px-5 py-3.5">
            <span className="text-muted-foreground">用户名</span>
            <span className="font-mono text-xs text-foreground/90">{profile.username}</span>
          </div>

          {/* 电子邮箱 */}
          <div className="flex items-center justify-between gap-4 px-5 py-3.5">
            <div className="space-y-0.5">
              <span className="text-muted-foreground block">电子邮箱</span>
              {!isEditingEmail && <span className="text-xs font-mono text-foreground/90">{profile.email}</span>}
            </div>
            <div className="flex items-center gap-2">
              {isEditingEmail ? (
                <>
                  <Input
                    value={emailInput}
                    disabled={loading}
                    onChange={(e) => setEmailDraft(e.target.value)}
                    placeholder="请输入邮箱"
                    className="h-8 text-xs w-52 bg-background/60"
                  />
                  <Button
                    size="sm"
                    variant="default"
                    disabled={loading}
                    onClick={handleSaveEmail}
                    className="h-8 text-xs cursor-pointer"
                  >
                    {emailSavedNotice ? <Check className="size-3 text-emerald-400" /> : '确定'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEmailDraft(null)
                      setIsEditingEmail(false)
                    }}
                    className="h-8 text-xs cursor-pointer"
                  >
                    取消
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loading}
                  onClick={() => setIsEditingEmail(true)}
                  className="h-8 text-xs cursor-pointer"
                >
                  更改
                </Button>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
