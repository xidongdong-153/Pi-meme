import { createContext, useContext, type ReactNode } from 'react'
import { validateVisualizationRef, type VisualizationRef } from '@pi-meme/contracts/visualize'

export const VisualizationRendererContext = createContext<((ref: VisualizationRef) => ReactNode) | null>(null)
export function VisualizationRenderer({ reference }: { reference: unknown }) {
  const render = useContext(VisualizationRendererContext)
  try {
    validateVisualizationRef(reference)
    return render ? render(reference) : <p>当前环境不支持草图预览。</p>
  } catch {
    return <p role="alert">草图引用无效。</p>
  }
}
