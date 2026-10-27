import { useEffect, type ReactNode } from 'react'

export function HistoryDetails({ load, children }: { load: () => Promise<void>; children: ReactNode }) {
  useEffect(() => {
    void load()
  }, [load])
  return children
}
