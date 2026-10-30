import { useEffect, useState } from 'react'
import { defaultUserAvatar } from '@pi-meme/assets/builtin'
import type { SettingsBridge } from '@pi-meme/contracts/desktop'
import { DEFAULT_USER_PROFILE } from '@pi-meme/settings/shared/user-profile'

export type UserProfile = {
  name: string
  username: string
  email: string
  avatarText: string
  avatarUrl?: string
}

type ProfileBridge = Pick<SettingsBridge, 'getUserProfile' | 'saveUserProfile'>

const STORAGE_KEY = 'pi-meme-user-profile'

export const DEFAULT_PROFILE: UserProfile = {
  ...DEFAULT_USER_PROFILE,
  avatarUrl: defaultUserAvatar,
}

function normalizeProfile(profile: Partial<UserProfile>): UserProfile {
  return {
    name: profile.name?.trim() || DEFAULT_PROFILE.name,
    username: profile.username?.trim() || DEFAULT_PROFILE.username,
    email: profile.email?.trim() || DEFAULT_PROFILE.email,
    avatarText: profile.avatarText?.trim() || DEFAULT_PROFILE.avatarText,
    avatarUrl: profile.avatarUrl?.trim() || DEFAULT_PROFILE.avatarUrl,
  }
}

function loadUserProfile(): UserProfile | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return normalizeProfile(JSON.parse(raw) as Partial<UserProfile>)
  } catch {
    return null
  }
}

function cacheUserProfile(profile: UserProfile) {
  if (typeof window === 'undefined') return
  try {
    const avatarUrl = profile.avatarUrl === DEFAULT_PROFILE.avatarUrl ? undefined : profile.avatarUrl
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...profile, avatarUrl }))
  } catch {
    // 缓存不可用时仍使用内存中的资料。
  }
}

function initialProfileState(bridge?: ProfileBridge) {
  const cached = loadUserProfile()
  return {
    bridge,
    profile: cached ?? DEFAULT_PROFILE,
    loading: Boolean(bridge?.getUserProfile),
    hasProfile: cached !== null,
  }
}

export function useUserProfile(bridge?: ProfileBridge) {
  const [state, setState] = useState(() => initialProfileState(bridge))
  if (state.bridge !== bridge) setState(initialProfileState(bridge))

  useEffect(() => {
    const getUserProfile = bridge?.getUserProfile
    if (!getUserProfile) return
    let active = true
    const load = async () => {
      let profile: UserProfile | undefined
      try {
        const hostProfile = await getUserProfile()
        if (hostProfile) profile = normalizeProfile(hostProfile)
      } catch {
        // Host 不可用时保留缓存或默认资料，不阻塞聊天。
      }
      if (!active) return
      setState((current) => ({
        ...current,
        profile: profile ?? current.profile,
        loading: false,
        hasProfile: profile !== undefined || current.hasProfile,
      }))
      if (profile) cacheUserProfile(profile)
    }
    void load()
    window.addEventListener('pi-meme:system-changed', load)
    return () => {
      window.removeEventListener('pi-meme:system-changed', load)
      active = false
    }
  }, [bridge])

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== STORAGE_KEY) return
      const cached = loadUserProfile()
      setState((current) => ({ ...current, profile: cached ?? DEFAULT_PROFILE, hasProfile: cached !== null }))
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  const updateProfile = (patch: Partial<UserProfile>) => {
    if (state.loading) return
    const next = normalizeProfile({ ...state.profile, ...patch })
    setState((current) => ({ ...current, profile: next, hasProfile: true }))
    cacheUserProfile(next)
    if (bridge?.saveUserProfile) {
      void bridge
        .saveUserProfile({
          name: next.name,
          username: next.username,
          email: next.email,
          avatarText: next.avatarText,
          avatarData: next.avatarUrl === DEFAULT_PROFILE.avatarUrl ? undefined : next.avatarUrl,
        })
        .catch(() => {
          // 保留现有保存语义：Host 保存失败时继续使用本地资料。
        })
    }
  }

  return {
    profile: state.profile,
    loading: state.loading,
    showPlaceholder: state.loading && !state.hasProfile,
    updateProfile,
  }
}
