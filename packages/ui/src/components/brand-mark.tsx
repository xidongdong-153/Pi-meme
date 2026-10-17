import { cn } from '../lib/utils'

/** 应用内品牌图标：透明背景的白猫与键盘。 */
export function BrandMark({ size = 24, className }: { size?: number; className?: string }) {
  return <span aria-hidden="true" className={cn('brand-mark', className)} style={{ width: size, height: size }} />
}
