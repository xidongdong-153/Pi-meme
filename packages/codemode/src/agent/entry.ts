import { effectiveAgentAccess, isBuiltinAgentToolAllowed, type AgentAccessMode } from '@pi-meme/contracts/agent-access'

export function create(context: {
  sdk: typeof import('@earendil-works/pi-coding-agent')
  taskMode: () => import('@pi-meme/contracts/plan').TaskMode
  accessMode: () => AgentAccessMode
}) {
  return [
    {
      name: 'pi-meme-codemode',
      factory: (pi: import('@earendil-works/pi-coding-agent').ExtensionAPI) => {
        context.sdk.createCodemodeExtension({
          models: isBuiltinAgentToolAllowed(
            'image_gen',
            effectiveAgentAccess(context.accessMode(), context.taskMode()),
          ),
        })(pi)
        pi.on('session_start', () => {
          pi.setActiveTools([...new Set([...pi.getActiveTools(), 'codemode'])])
        })
      },
    },
  ]
}
