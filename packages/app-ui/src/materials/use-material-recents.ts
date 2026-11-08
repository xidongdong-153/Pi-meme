import { useEffect, useState } from 'react'
import { materialKey, type MaterialSummary, type RecentMaterial } from './material-types'

const storageKey = 'pi-meme:materials:recent:v1'

function readRecent(): RecentMaterial[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || 'null')
    if (value?.version !== 1 || !Array.isArray(value.items)) return []
    return value.items
      .filter(
        (item: RecentMaterial) =>
          item &&
          typeof item.name === 'string' &&
          item.name.length <= 512 &&
          typeof item.serviceId === 'string' &&
          item.ref &&
          item.ref.kind === 'image' &&
          typeof item.ref.hostId === 'string' &&
          typeof item.ref.id === 'string' &&
          Number.isFinite(item.openedAt),
      )
      .slice(0, 10)
  } catch {
    return []
  }
}

export function useMaterialRecents() {
  const [recent, setRecent] = useState(readRecent)
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ version: 1, items: recent }))
    } catch {
      /* 本地偏好不可写不影响资料操作。 */
    }
  }, [recent])
  return {
    recent,
    remember: (material: MaterialSummary) =>
      setRecent((current) =>
        [
          { ref: material.ref, serviceId: material.serviceId, name: material.name, openedAt: Date.now() },
          ...current.filter((item) => materialKey(item.ref) !== materialKey(material.ref)),
        ].slice(0, 10),
      ),
    renameRecent: (material: MaterialSummary, name: string) =>
      setRecent((current) =>
        current.map((item) => (materialKey(item.ref) === materialKey(material.ref) ? { ...item, name } : item)),
      ),
    forget: (material: MaterialSummary) =>
      setRecent((current) => current.filter((item) => materialKey(item.ref) !== materialKey(material.ref))),
  }
}
