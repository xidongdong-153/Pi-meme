import type { ExtensionWidget } from './use-extension-ui'

export function ExtensionWidgets({
  widgets,
  placement,
}: {
  widgets: ExtensionWidget[]
  placement: ExtensionWidget['placement']
}) {
  return (
    <>
      {widgets
        .filter((widget) => widget.placement === placement)
        .map((widget) => (
          <div
            aria-label={placement === 'aboveEditor' ? '输入框上方扩展挂件' : '输入框下方扩展挂件'}
            key={widget.key}
            className={
              placement === 'aboveEditor'
                ? 'mb-2 rounded-lg bg-secondary/40 p-2 text-xs text-muted-foreground'
                : 'mt-2 rounded-lg bg-secondary/40 p-2 text-xs text-muted-foreground'
            }
          >
            {widget.lines.map((line, index) => (
              <div key={`${widget.key}-${index}`}>{line}</div>
            ))}
          </div>
        ))}
    </>
  )
}
