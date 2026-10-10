export function create(context: { sdk: typeof import('@earendil-works/pi-coding-agent') }) {
  const extension = context.sdk.createCodemodeExtension()
  return [
    {
      name: 'pi-meme-codemode',
      factory: (pi: import('@earendil-works/pi-coding-agent').ExtensionAPI) => {
        extension(pi)
        pi.on('session_start', () => {
          pi.setActiveTools([...new Set([...pi.getActiveTools(), 'codemode'])])
        })
      },
    },
  ]
}
