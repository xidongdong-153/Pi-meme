import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AccessSandbox } from '@pi-meme/pi-runtime/sdk/access-sandbox'
import { readControlledDirectory, readControlledFile } from '@pi-meme/pi-runtime/sdk/controlled-file-read'
import type { WorkspaceFileBackend } from './workspace-files'

export function controlledWorkspaceFiles(options: {
  dataRoot: string
  agentDir: string
  nodePath: string
  nativePath?: string
  protectedRoots: string[]
  readOnlyRoots: string[]
  runtimeReadables: () => Promise<string[]>
  readableRoots: (workspace?: string) => Promise<string[]>
  signal: () => AbortSignal | undefined
}): WorkspaceFileBackend {
  const policy = async (workspace?: string, signal?: AbortSignal) => {
    const current = options.signal()
    return {
      protectedRoots: options.protectedRoots,
      readableRoots: await options.readableRoots(workspace),
      fixedNode: { executable: options.nodePath },
      native: options.nativePath ? { executable: options.nativePath } : undefined,
      signal: current && signal ? AbortSignal.any([current, signal]) : (current ?? signal),
    }
  }
  return {
    read: async (filename, maximum, expected, root, signal) =>
      readControlledFile({
        ...(await policy(root, signal)),
        canonicalPath: filename,
        expected,
        maxBytes: maximum,
      }),
    list: async (directory, root) =>
      readControlledDirectory({
        ...(await policy(root)),
        canonicalPath: directory,
        maxEntries: 10000,
      }),
    write: async ({ root, filename, content, expected }) => {
      const signal = options.signal()
      signal?.throwIfAborted()
      const temporary = await mkdtemp(path.join(tmpdir(), 'pi-file-write-'))
      let sandbox: Awaited<ReturnType<typeof AccessSandbox.create>> | undefined
      try {
        sandbox = await AccessSandbox.create({
          mode: 'workspace-write',
          cwd: root,
          temporary,
          nodePath: options.nodePath,
          agentDir: options.agentDir,
          dataRoot: options.dataRoot,
          protectedRoots: options.protectedRoots,
          readOnlyRoots: options.readOnlyRoots,
          readableRoots: await options.runtimeReadables(),
          network: 'deny',
          requirements: ['filesystem-write-boundary', 'environment-isolation', 'network-deny'],
          signal,
        })
        signal?.throwIfAborted()
        await sandbox.writeFile(filename, content, signal, expected)
      } finally {
        await sandbox?.stopAll()
        await rm(temporary, { recursive: true, force: true })
      }
    },
  }
}
