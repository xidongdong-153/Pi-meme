import { useRef, useState, type ChangeEvent } from 'react'
import { Check, Pencil, UserCheck } from 'lucide-react'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { CrossfadeText } from '@pi-meme/ui/components/crossfade-text'
import { SettingsCard, SettingsGroup, SettingsRow, settingsControlClassName } from '@pi-meme/ui/components/settings'
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
    <div className="min-w-0 space-y-6 text-foreground">
      <SettingsCard>
        <SettingsRow className="justify-start">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            disabled={loading}
            onChange={handleFileChange}
            className="hidden"
            aria-label="上传个人头像图片"
          />
          <button
            type="button"
            aria-label="修改头像"
            disabled={loading}
            onClick={handleAvatarClick}
            className="group relative size-12 shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-50"
          >
            <span className="flex size-full items-center justify-center overflow-hidden rounded-full bg-[#e8a838] text-lg font-semibold text-neutral-900">
              {profile.avatarUrl ? (
                <img src={profile.avatarUrl} alt="" className="size-full object-cover" />
              ) : (
                profile.avatarText
              )}
            </span>
            <span
              className="absolute -bottom-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full border border-border bg-secondary text-foreground transition-colors group-hover:bg-background"
              aria-hidden="true"
            >
              <Pencil className="size-2.5" />
            </span>
          </button>
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="break-words text-sm font-medium text-foreground [overflow-wrap:anywhere]">
              <CrossfadeText>{loading ? '正在读取个人资料…' : profile.name}</CrossfadeText>
            </h3>
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <UserCheck aria-hidden="true" className="size-3 shrink-0" />
              <CrossfadeText className="min-w-0 break-all">{loading ? '读取中…' : profile.username}</CrossfadeText>
            </div>
          </div>
        </SettingsRow>
      </SettingsCard>

      <SettingsGroup title="账户设置">
        <SettingsCard>
          <SettingsRow>
            <label htmlFor="settings-profile-name" className="shrink-0 font-medium">
              姓名
            </label>
            <div className="flex w-full min-w-0 max-w-xs items-center justify-end gap-2">
              <Input
                id="settings-profile-name"
                value={nameInput}
                disabled={loading}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="请输入姓名"
                className={`${settingsControlClassName} min-w-0 bg-background/60`}
              />
              <Button
                size="sm"
                variant={isNameChanged ? 'default' : 'secondary'}
                disabled={loading || !isNameChanged}
                onClick={handleSaveName}
                className={`${settingsControlClassName} shrink-0`}
              >
                {nameSavedNotice ? <Check aria-label="已保存" className="size-3" /> : '保存'}
              </Button>
            </div>
          </SettingsRow>
          <SettingsRow>
            <span className="font-medium">用户名</span>
            <CrossfadeText className="min-w-0 break-all text-muted-foreground">
              {loading ? '读取中…' : profile.username}
            </CrossfadeText>
          </SettingsRow>
          <SettingsRow>
            <div className="min-w-0 space-y-0.5">
              <span className="block font-medium">电子邮箱</span>
              {!isEditingEmail && (
                <CrossfadeText className="min-h-4 break-all text-[11px] text-muted-foreground">
                  {loading ? '读取中…' : profile.email}
                </CrossfadeText>
              )}
            </div>
            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
              {isEditingEmail ? (
                <>
                  <Input
                    aria-label="电子邮箱"
                    value={emailInput}
                    disabled={loading}
                    onChange={(e) => setEmailDraft(e.target.value)}
                    placeholder="请输入邮箱"
                    className={`${settingsControlClassName} min-w-0 flex-1 basis-44 bg-background/60`}
                  />
                  <Button
                    size="sm"
                    variant="default"
                    disabled={loading}
                    onClick={handleSaveEmail}
                    className={settingsControlClassName}
                  >
                    {emailSavedNotice ? <Check aria-label="已保存" className="size-3" /> : '确定'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEmailDraft(null)
                      setIsEditingEmail(false)
                    }}
                    className={settingsControlClassName}
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
                  className={settingsControlClassName}
                >
                  更改
                </Button>
              )}
            </div>
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>
    </div>
  )
}
