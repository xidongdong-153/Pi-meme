export type IconName = 'panel' | 'plus' | 'folder' | 'chevron' | 'message' | 'arrow' | 'square' | 'settings'
const paths: Record<IconName, string> = {
  panel: 'M3 4h18v16H3z M9 4v16',
  plus: 'M12 5v14 M5 12h14',
  folder: 'M3 6h7l2 2h9v11H3z',
  chevron: 'm9 18 6-6-6-6',
  message: 'M4 4h16v12H8l-4 4z',
  arrow: 'M12 19V5 m-6 6 6-6 6 6',
  square: 'M6 6h12v12H6z',
  settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
}
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  )
}
