import { useEffect, useState, useSyncExternalStore } from 'react'
import type { FileEntry, HostApi, WorkspaceRef } from '@pi-meme/contracts/app-host'
import type { UiContributionProps, UiPluginContext } from '@pi-meme/plugin-sdk/ui'

function Directory({
  host,
  root,
  entries,
  choose,
}: {
  host: HostApi
  root: WorkspaceRef
  entries: FileEntry[]
  choose: (file: FileEntry) => void
}) {
  return (
    <ul style={{ listStyle: 'none', paddingLeft: 12, margin: 0 }}>
      {entries.map((entry) => (
        <DirectoryEntry key={entry.relativePath} host={host} root={root} entry={entry} choose={choose} />
      ))}
    </ul>
  )
}
function DirectoryEntry({
  host,
  root,
  entry,
  choose,
}: {
  host: HostApi
  root: WorkspaceRef
  entry: FileEntry
  choose: (file: FileEntry) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!expanded) return
    let live = true
    void host.files
      .list(root, entry.relativePath)
      .then((entries) => {
        if (live) setChildren(entries)
      })
      .catch((cause) => {
        if (live) setError(String(cause))
      })
    return () => {
      live = false
    }
  }, [host, root, expanded, entry.relativePath])
  return (
    <li>
      <button
        type="button"
        style={{
          display: 'block',
          padding: '5px 0',
          textAlign: 'left',
          width: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        aria-expanded={entry.kind === 'directory' ? expanded : undefined}
        onClick={() => (entry.kind === 'directory' ? setExpanded((value) => !value) : choose(entry))}
      >
        {entry.kind === 'directory' ? (expanded ? '− ' : '+ ') : '  '}
        {entry.name}
      </button>
      {expanded &&
        (error ? (
          <p role="alert">{error}</p>
        ) : children ? (
          <Directory host={host} root={root} entries={children} choose={choose} />
        ) : (
          <p>正在读取目录…</p>
        ))}
    </li>
  )
}

export async function activate(context: UiPluginContext) {
  if (!(await context.host.capabilities()).features.includes('files')) throw new Error('所属 Host 不支持文件接口')
  let preview = { root: '', path: '', content: '', error: '' }
  const listeners = new Set<() => void>()
  const getPreview = () => preview
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  function publish(next: typeof preview) {
    preview = next
    for (const listener of listeners) listener()
  }
  function Explorer({ host, target }: UiContributionProps) {
    const root = target.session ?? target.project
    const key = JSON.stringify(root)
    const [entries, setEntries] = useState<FileEntry[]>([])
    const [error, setError] = useState('')
    const [revision, setRevision] = useState(0)
    useEffect(() => {
      if (!root) return
      let live = true
      setEntries([])
      setError('')
      void host.files
        .list(root)
        .then((value) => {
          if (live) setEntries(value)
        })
        .catch((cause) => {
          if (live) setError(String(cause))
        })
      return () => {
        live = false
      }
    }, [host, key, revision])
    function choose(file: FileEntry) {
      if (!root) return
      const selectedRoot = key
      publish({ root: selectedRoot, path: file.relativePath, content: '', error: '' })
      context.panels.open(`${context.pluginId}:preview`)
      void host.files
        .read(root, file.relativePath)
        .then((value) => {
          if (preview.root === selectedRoot && preview.path === file.relativePath)
            publish({ root: selectedRoot, path: value.relativePath, content: value.content, error: '' })
        })
        .catch((cause) => {
          if (preview.root === selectedRoot && preview.path === file.relativePath)
            publish({ ...preview, error: String(cause) })
        })
    }
    return (
      <div style={{ padding: 12, overflow: 'auto', height: '100%', fontSize: 13 }}>
        <button type="button" onClick={() => setRevision((value) => value + 1)}>
          刷新目录
        </button>
        {!root ? (
          <p>请选择项目或会话。</p>
        ) : error ? (
          <p role="alert">{error}</p>
        ) : (
          <Directory key={`${key}:${revision}`} host={host} root={root} entries={entries} choose={choose} />
        )}
      </div>
    )
  }
  function Preview({ target }: UiContributionProps) {
    const selected = useSyncExternalStore(subscribe, getPreview)
    if (selected.root !== JSON.stringify(target.session ?? target.project) || !selected.path)
      return <p style={{ padding: 16 }}>在文件目录中选择 UTF-8 文本文件。</p>
    return (
      <div style={{ padding: 16, height: '100%', overflow: 'auto' }}>
        <h3>{selected.path}</h3>
        {selected.error ? (
          <p role="alert">{selected.error}</p>
        ) : (
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'var(--font-code)' }}>
            {selected.content}
          </pre>
        )}
      </div>
    )
  }
  const releases = [
    context.panels.register({
      id: `${context.pluginId}:directory`,
      title: '文件目录',
      icon: (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
        </svg>
      ),
      location: 'right',
      scope: 'project',
      render: (props) => <Explorer {...props} />,
    }),
    context.panels.register({
      id: `${context.pluginId}:preview`,
      title: '文件预览',
      icon: (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z M14 3v6h6 M8 13h8 M8 17h6" />
        </svg>
      ),
      location: 'right',
      scope: 'project',
      render: (props) => <Preview {...props} />,
    }),
  ]
  return () => {
    for (const release of releases.reverse()) release()
    listeners.clear()
  }
}
