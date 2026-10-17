import { useEffect, useState } from 'react'
import type { SettingsBridge } from '@pi-meme/contracts/desktop'

export type UserProfile = {
  name: string
  username: string
  email: string
  avatarText: string
  avatarUrl?: string
}

const STORAGE_KEY = 'pi-meme-user-profile'

export const DEFAULT_PROFILE: UserProfile = {
  name: 'xi dongdong',
  username: '@youzegehq',
  email: 'youzegehq@gmail.com',
  avatarText: 'XD',
}

export function loadUserProfile(): UserProfile {
  if (typeof window === 'undefined') return DEFAULT_PROFILE
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_PROFILE
    const parsed = JSON.parse(raw) as Partial<UserProfile>
    return {
      name: parsed.name?.trim() || DEFAULT_PROFILE.name,
      username: parsed.username?.trim() || DEFAULT_PROFILE.username,
      email: parsed.email?.trim() || DEFAULT_PROFILE.email,
      avatarText: parsed.avatarText?.trim() || DEFAULT_PROFILE.avatarText,
      avatarUrl: parsed.avatarUrl || undefined,
    }
  } catch {
    return DEFAULT_PROFILE
  }
}

export function saveUserProfile(
  patch: Partial<UserProfile>,
  bridge?: Pick<SettingsBridge, 'saveUserProfile'>,
): UserProfile {
  const current = loadUserProfile()
  const next: UserProfile = {
    ...current,
    ...patch,
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      window.dispatchEvent(new CustomEvent('pi-user-profile-changed', { detail: next }))
    } catch {
      // 忽略存储配额错误
    }
  }
  if (bridge?.saveUserProfile) {
    void bridge
      .saveUserProfile({
        name: next.name,
        username: next.username,
        email: next.email,
        avatarText: next.avatarText,
        avatarData: next.avatarUrl,
      })
      .catch(() => {
        // 后端离线或异常时忽略，以本地存储为准
      })
  }
  return next
}

export async function syncUserProfileFromHost(
  bridge?: Pick<SettingsBridge, 'getUserProfile'>,
): Promise<UserProfile | null> {
  if (!bridge?.getUserProfile) return null
  try {
    const hostProfile = await bridge.getUserProfile()
    if (!hostProfile) return null
    return saveUserProfile({
      name: hostProfile.name,
      username: hostProfile.username,
      email: hostProfile.email,
      avatarText: hostProfile.avatarText,
      avatarUrl: hostProfile.avatarUrl,
    })
  } catch {
    return null
  }
}

export function useUserProfile(bridge?: Pick<SettingsBridge, 'getUserProfile' | 'saveUserProfile'>) {
  const [profile, setProfile] = useState<UserProfile>(loadUserProfile)

  useEffect(() => {
    const handleUpdate = () => {
      setProfile(loadUserProfile())
    }
    window.addEventListener('pi-user-profile-changed', handleUpdate)
    window.addEventListener('storage', handleUpdate)
    if (bridge?.getUserProfile) {
      void syncUserProfileFromHost(bridge)
    }
    return () => {
      window.removeEventListener('pi-user-profile-changed', handleUpdate)
      window.removeEventListener('storage', handleUpdate)
    }
  }, [bridge])

  const update = (patch: Partial<UserProfile>) => saveUserProfile(patch, bridge)

  return {
    profile,
    updateProfile: update,
  }
}
