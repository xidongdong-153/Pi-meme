import {
  BentoSkeletonBar,
  BentoSkeletonButton,
  BentoSkeletonCard,
  BentoSkeletonCircle,
  BentoSkeletonPill,
} from '@pi-meme/ui/components/bento-skeleton'
import { ProfileSkeleton } from '@pi-meme/usage/ui/profile-skeleton'
import type { SettingsSection } from './settings-page'

export function GeneralSkeleton() {
  return (
    <div className="space-y-6" data-testid="settings-skeleton-general">
      <section className="space-y-3">
        <BentoSkeletonBar className="w-12" size="sm" />
        <BentoSkeletonCard delay={0}>
          <div className="space-y-4">
            <div className="space-y-2">
              <BentoSkeletonBar className="w-24" size="md" />
              <BentoSkeletonBar className="w-64 max-w-full" size="xs" />
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <div className="h-16 rounded-xl border border-border/50 bg-muted/30 p-3" />
              <div className="h-16 rounded-xl border border-border/50 bg-muted/30 p-3" />
              <div className="h-16 rounded-xl border border-border/50 bg-muted/30 p-3" />
            </div>
          </div>
        </BentoSkeletonCard>
      </section>
      <section className="space-y-3">
        <BentoSkeletonBar className="w-12" size="sm" />
        <BentoSkeletonCard delay={80}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-2">
              <BentoSkeletonBar className="w-28" size="sm" />
              <BentoSkeletonBar className="w-72 max-w-full" size="xs" />
              <BentoSkeletonBar className="w-20" size="xs" />
            </div>
            <div className="flex gap-2">
              <BentoSkeletonButton className="w-20" />
              <BentoSkeletonButton className="w-20" />
            </div>
          </div>
        </BentoSkeletonCard>
      </section>
      <section className="space-y-3">
        <BentoSkeletonBar className="w-12" size="sm" />
        <BentoSkeletonCard delay={160}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-2">
              <BentoSkeletonBar className="w-24" size="sm" />
              <BentoSkeletonBar className="w-32" size="xs" />
            </div>
            <div className="flex gap-2">
              <BentoSkeletonButton className="w-16" />
              <BentoSkeletonButton className="w-20" />
            </div>
          </div>
        </BentoSkeletonCard>
      </section>
    </div>
  )
}

export function AppearanceSkeleton() {
  return (
    <div className="space-y-6" data-testid="settings-skeleton-appearance">
      <div className="flex justify-end gap-2">
        <BentoSkeletonButton className="h-8 w-8 rounded-lg" />
        <BentoSkeletonButton className="h-8 w-8 rounded-lg" />
        <BentoSkeletonButton className="h-8 w-8 rounded-lg" />
      </div>
      <section className="space-y-3">
        <BentoSkeletonBar className="w-16" size="sm" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <BentoSkeletonCard delay={0} className="flex h-28 flex-col justify-between p-4">
            <div className="h-10 w-full rounded-lg bg-muted/40" />
            <BentoSkeletonBar className="w-16" size="xs" />
          </BentoSkeletonCard>
          <BentoSkeletonCard delay={80} className="flex h-28 flex-col justify-between p-4">
            <div className="h-10 w-full rounded-lg bg-muted/40" />
            <BentoSkeletonBar className="w-16" size="xs" />
          </BentoSkeletonCard>
          <BentoSkeletonCard delay={160} className="flex h-28 flex-col justify-between p-4">
            <div className="h-10 w-full rounded-lg bg-muted/40" />
            <BentoSkeletonBar className="w-16" size="xs" />
          </BentoSkeletonCard>
        </div>
      </section>
      <section className="space-y-3">
        <BentoSkeletonBar className="w-16" size="sm" />
        <BentoSkeletonCard delay={120}>
          <div className="flex flex-wrap items-center gap-3">
            {Array.from({ length: 8 }).map((_, index) => (
              <BentoSkeletonCircle key={index} className="size-8" />
            ))}
          </div>
        </BentoSkeletonCard>
      </section>
      <section className="space-y-3">
        <BentoSkeletonBar className="w-20" size="sm" />
        <BentoSkeletonCard delay={180}>
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <BentoSkeletonBar className="w-24" size="sm" />
                <BentoSkeletonBar className="w-48" size="xs" />
              </div>
              <BentoSkeletonBar className="h-8 w-40 rounded-lg" />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <BentoSkeletonBar className="w-20" size="sm" />
                <BentoSkeletonBar className="w-36" size="xs" />
              </div>
              <BentoSkeletonBar className="h-6 w-32 rounded-lg" />
            </div>
          </div>
        </BentoSkeletonCard>
      </section>
    </div>
  )
}

export { ProfileSkeleton }

export function ModelsSkeleton() {
  return (
    <div className="space-y-4" data-testid="settings-skeleton-models">
      <BentoSkeletonCard delay={0}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <BentoSkeletonBar className="w-24" size="sm" />
            <BentoSkeletonBar className="w-64 max-w-full" size="xs" />
          </div>
          <BentoSkeletonBar className="h-8 w-44 rounded-lg" />
        </div>
      </BentoSkeletonCard>
      <BentoSkeletonCard delay={60}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <BentoSkeletonBar className="w-28" size="sm" />
            <BentoSkeletonBar className="w-72 max-w-full" size="xs" />
          </div>
          <BentoSkeletonBar className="h-8 w-36 rounded-lg" />
        </div>
      </BentoSkeletonCard>
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between">
          <BentoSkeletonBar className="w-28" size="sm" />
          <BentoSkeletonButton className="w-24" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <BentoSkeletonCard key={index} delay={index * 60} className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3">
                <BentoSkeletonCircle className="size-8" />
                <div className="space-y-1">
                  <BentoSkeletonBar className="w-24" size="sm" />
                  <BentoSkeletonBar className="w-16" size="xs" />
                </div>
              </div>
              <BentoSkeletonPill className="h-5 w-10" />
            </BentoSkeletonCard>
          ))}
        </div>
      </div>
    </div>
  )
}

export function InstructionsSkeleton() {
  return (
    <div className="space-y-8" data-testid="settings-skeleton-instructions">
      <section className="space-y-4">
        <BentoSkeletonBar className="w-12" size="sm" />
        <BentoSkeletonCard delay={0} className="p-0">
          <div className="flex items-center gap-4 p-5">
            <BentoSkeletonCircle className="size-6" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-center gap-2">
                <BentoSkeletonBar className="w-20" size="sm" />
                <BentoSkeletonBar className="w-24" size="xs" />
              </div>
              <BentoSkeletonBar className="w-56 max-w-full" size="xs" />
            </div>
            <BentoSkeletonBar className="size-4 rounded" />
          </div>
        </BentoSkeletonCard>
      </section>
      <section className="space-y-4">
        <BentoSkeletonBar className="w-12" size="sm" />
        <BentoSkeletonCard delay={80} className="divide-y divide-border/60 p-0">
          <div className="flex items-center gap-4 p-5">
            <BentoSkeletonCircle className="size-6" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-center gap-2">
                <BentoSkeletonBar className="w-24" size="sm" />
                <BentoSkeletonBar className="w-24" size="xs" />
              </div>
              <BentoSkeletonBar className="w-64 max-w-full" size="xs" />
            </div>
            <BentoSkeletonBar className="size-4 rounded" />
          </div>
          <div className="flex items-center gap-4 p-5">
            <BentoSkeletonCircle className="size-6" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-center gap-2">
                <BentoSkeletonBar className="w-28" size="sm" />
                <BentoSkeletonBar className="w-28" size="xs" />
              </div>
              <BentoSkeletonBar className="w-52 max-w-full" size="xs" />
            </div>
            <BentoSkeletonBar className="size-4 rounded" />
          </div>
        </BentoSkeletonCard>
      </section>
    </div>
  )
}

export function ListSectionSkeleton({ testId }: { testId: string }) {
  return (
    <div className="space-y-6" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <BentoSkeletonBar className="h-10 w-64 max-w-full rounded-full" />
          <div className="flex gap-1 rounded-full border border-border/50 p-1">
            <BentoSkeletonPill className="h-7 w-16" />
            <BentoSkeletonPill className="h-7 w-16" />
          </div>
        </div>
        <div className="flex gap-2">
          <BentoSkeletonButton className="h-9 w-9 rounded-lg" />
          <BentoSkeletonButton className="h-9 w-24 rounded-lg" />
        </div>
      </div>
      <BentoSkeletonCard delay={60} className="divide-y divide-border/60 p-0">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex items-center gap-4 p-5">
            <BentoSkeletonCircle className="size-9 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-center gap-2">
                <BentoSkeletonBar className="w-32" size="sm" />
                <BentoSkeletonBar className="w-16" size="xs" />
              </div>
              <BentoSkeletonBar className="w-72 max-w-full" size="xs" />
            </div>
            <BentoSkeletonPill className="h-6 w-12" />
          </div>
        ))}
      </BentoSkeletonCard>
    </div>
  )
}

export function HostSkeleton() {
  return (
    <div className="space-y-6" data-testid="settings-skeleton-host">
      <BentoSkeletonCard delay={0} className="p-6">
        <div className="flex items-center gap-4">
          <BentoSkeletonCircle className="size-12 rounded-xl" />
          <div className="space-y-1.5">
            <BentoSkeletonBar className="w-28" size="md" />
            <BentoSkeletonBar className="w-48 max-w-full" size="xs" />
          </div>
        </div>
      </BentoSkeletonCard>
      <section className="space-y-3">
        <BentoSkeletonBar className="w-24" size="sm" />
        <BentoSkeletonCard delay={80} className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <BentoSkeletonBar className="w-64 max-w-full" size="sm" />
            <BentoSkeletonButton className="w-16" />
          </div>
        </BentoSkeletonCard>
      </section>
    </div>
  )
}

export function AboutSkeleton() {
  return (
    <div className="space-y-6" data-testid="settings-skeleton-about">
      <BentoSkeletonCard delay={0} className="space-y-4 p-6">
        <BentoSkeletonBar className="w-24" size="sm" />
        <div className="grid grid-cols-2 gap-2">
          <BentoSkeletonBar className="w-16" size="xs" />
          <BentoSkeletonBar className="w-20" size="xs" />
        </div>
        <BentoSkeletonBar className="w-full" size="xs" />
      </BentoSkeletonCard>
    </div>
  )
}

export function SettingsSkeleton({ section }: { section: SettingsSection }) {
  switch (section) {
    case 'general':
      return <GeneralSkeleton />
    case 'appearance':
      return <AppearanceSkeleton />
    case 'profile':
      return <ProfileSkeleton />
    case 'models':
      return <ModelsSkeleton />
    case 'instructions':
      return <InstructionsSkeleton />
    case 'skills':
      return <ListSectionSkeleton testId="settings-skeleton-skills" />
    case 'plugins':
      return <ListSectionSkeleton testId="settings-skeleton-plugins" />
    case 'mcp':
      return <ListSectionSkeleton testId="settings-skeleton-mcp" />
    case 'host':
      return <HostSkeleton />
    case 'about':
      return <AboutSkeleton />
    default:
      return <GeneralSkeleton />
  }
}
