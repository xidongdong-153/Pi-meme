import { cn } from '../lib/utils'

/** 品牌图标：底色随主题在 dark/light 两版之间切换，由 data-appearance 决定 */
export function BrandMark({ size = 24, className }: { size?: number; className?: string }) {
  return <span aria-hidden="true" className={cn('brand-mark', className)} style={{ width: size, height: size }} />
}
