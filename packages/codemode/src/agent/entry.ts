export function create(context: {
  sdk: typeof import('@earendil-works/pi-coding-agent')
  taskMode?: () => import('@pi-meme/contracts/plan').TaskMode
}) {
  return [
    {
      name: 'pi-meme-codemode',
      factory: (pi: import('@earendil-works/pi-coding-agent').ExtensionAPI) => {
        context.sdk.createCodemodeExtension({ models: context.taskMode?.() !== 'plan' })(pi)
        pi.on('session_start', () => {
          pi.setActiveTools([...new Set([...pi.getActiveTools(), 'codemode'])])
        })
      },
    },
  ]
}
