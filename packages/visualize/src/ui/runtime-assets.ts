/// <reference path="./runtime-modules.d.ts" />

const loaders = {
  core: () => import('../runtime/core.ts?visualize-source'),
  echarts: () => import('../runtime/echarts.ts?visualize-source'),
  capture: () => import('../runtime/capture.ts?visualize-source'),
  standalone: () => import('../runtime/standalone.ts?visualize-source'),
}

const cache = new Map<keyof typeof loaders, Promise<string>>()

function loadRuntime(name: keyof typeof loaders): Promise<string> {
  const existing = cache.get(name)
  if (existing) return existing
  const pending = loaders[name]()
    .then((module) => module.default)
    .catch((cause: unknown) => {
      if (cache.get(name) === pending) cache.delete(name)
      throw cause
    })
  cache.set(name, pending)
  return pending
}

export async function loadVisualizationAssets(
  libraries: 'echarts'[] = [],
): Promise<{ core: string; echarts?: string }> {
  if (!Array.isArray(libraries) || libraries.some((library) => library !== 'echarts'))
    throw new Error('不支持的可视化运行时库')
  const [core, echarts] = await Promise.all([
    loadRuntime('core'),
    libraries.includes('echarts') ? loadRuntime('echarts') : undefined,
  ])
  return echarts === undefined ? { core } : { core, echarts }
}

export function loadVisualizationCapture(): Promise<string> {
  return loadRuntime('capture')
}

export function loadVisualizationStandalone(): Promise<string> {
  return loadRuntime('standalone')
}
