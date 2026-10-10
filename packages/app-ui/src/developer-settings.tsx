import { useEffect, useState, type ReactNode } from 'react'

export function DeveloperSettings({
  call,
  children,
}: {
  call: <T>(method: string, args?: unknown[]) => Promise<T>
  children: ReactNode
}) {
  const [diagnostics, setDiagnostics] = useState<{ id?: string; directory?: string; message: string }[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void call<typeof diagnostics>('plugins:diagnostics')
      .then((value) => {
        if (active) setDiagnostics(value)
      })
      .catch((cause) => {
        if (active) setError(`无法读取插件恢复诊断：${String(cause)}`)
      })
    return () => {
      active = false
    }
  }, [call])
  return (
    <div className="space-y-8">
      {(diagnostics.length > 0 || error) && (
        <section aria-label="插件恢复诊断" className="space-y-2 rounded-xl border border-border p-4 text-sm">
          <h3 className="font-medium">插件恢复诊断</h3>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {diagnostics.map((item, index) => (
            <p key={`${item.id}:${index}`} role="alert" className="whitespace-pre-wrap break-words text-destructive">
              {item.id || item.directory || '安装清单'}：{item.message}
            </p>
          ))}
        </section>
      )}
      {children}
    </div>
  )
}
