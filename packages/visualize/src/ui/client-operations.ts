import type { HostApi } from '@pi-meme/contracts/app-host'
import type { SystemClientRequest, SystemClientExecutionContext } from '@pi-meme/contracts/system-tools'
import { readRecord, SystemReadError, validateReadArguments } from '@pi-meme/contracts/system-read'
import { validateVisualizationRef, visualizationClientOperationDefinitions } from '@pi-meme/contracts/visualize'
import { getVisualizationStateStore, visualizationStorageKey } from './visualization-state'
import {
  createStandaloneVisualization,
  createVisualizationPng,
  downloadVisualizationFile,
  visualizationFileName,
  withVisualizationExport,
} from './visualization-export'

export async function handleVisualizationClientOperation(
  host: HostApi,
  request: SystemClientRequest,
  context: SystemClientExecutionContext,
) {
  const definition = visualizationClientOperationDefinitions.find((value) => value.name === request.operation)
  if (!definition || !host.visualizations) throw new SystemReadError('not-supported', '当前客户端不支持此可视化操作')
  validateReadArguments(definition.inputSchema, request.args)
  const reference = readRecord(request.args[0], ['id', 'revision'], '可视化引用')
  try {
    validateVisualizationRef(reference)
  } catch {
    throw new SystemReadError('invalid-input', '可视化引用无效')
  }
  const assertCurrent = () => {
    context.assertActive()
    if (!Number.isFinite(request.deadline) || Date.now() >= request.deadline) {
      throw new SystemReadError('timeout', '可视化客户端请求已超时，未继续下载')
    }
  }
  assertCurrent()
  const capabilities = await host.capabilities()
  assertCurrent()
  if (capabilities.hostId !== request.session.hostId)
    throw new SystemReadError('permission-denied', '可视化请求的 Host 身份不匹配')
  if (!capabilities.features.includes('visualize-runtime-v2'))
    throw new SystemReadError('not-supported', '当前 Host 不支持可视化运行时 v2')
  // UI 操作同样读取明确会话的版本，不用当前界面选择替代分支授权。
  const document = await host.visualizations.get(request.session, reference)
  assertCurrent()
  const store = getVisualizationStateStore(visualizationStorageKey(request.session, reference), document)
  if (request.operation === 'visualizations.previewState') {
    const snapshot = store.getSnapshot()
    return { reference, state: { ...snapshot.state }, source: snapshot.source }
  }
  const { format } = readRecord(request.args[1], ['format'], '导出格式')
  return withVisualizationExport(store, async () => {
    let blob: Blob
    if (format === 'html') {
      blob = await createStandaloneVisualization(document, store.getSnapshot().state)
    } else {
      try {
        blob = await createVisualizationPng(() => store.capture())
      } catch (cause) {
        if (cause instanceof Error && cause.message.includes('请先打开')) {
          throw new SystemReadError('not-loaded', cause.message)
        }
        throw cause
      }
    }
    assertCurrent()
    const fileName = visualizationFileName(document, format as string)
    downloadVisualizationFile(blob, fileName)
    return { status: 'download-started' as const, fileName, mimeType: format === 'png' ? 'image/png' : 'text/html' }
  })
}
