import { glob, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { queryWindowsNative } from '@pi-meme/windows-native/runtime'
import type { ProjectApp } from '@pi-meme/contracts/desktop'

const executables: Record<Exclude<ProjectApp['id'], 'finder'>, string> = {
  vscode: 'Code.exe',
  cursor: 'Cursor.exe',
  zed: 'zed.exe',
  windsurf: 'Windsurf.exe',
  'sublime-text': 'sublime_text.exe',
  'intellij-idea': 'idea64.exe',
  webstorm: 'webstorm64.exe',
  pycharm: 'pycharm64.exe',
  goland: 'goland64.exe',
  phpstorm: 'phpstorm64.exe',
  rubymine: 'rubymine64.exe',
  clion: 'clion64.exe',
  rider: 'rider64.exe',
  rustrover: 'rustrover64.exe',
}

export async function windowsProjectApps(): Promise<Array<{ id: ProjectApp['id']; path: string }>> {
  const roots = await queryWindowsNative('editor-roots')
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== 'string'))
    throw new Error('Windows 编辑器安装信息格式无效')
  const directories = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
  ].filter((value): value is string => Boolean(value))
  const candidates = new Set<string>(
    roots.map((root: string) => root.replace(/^"([^"]+)"(?:,\d+)?$/, '$1').replace(/,\d+$/, '')),
  )
  for (const directory of directories) {
    for (const pattern of [
      '*/Code.exe',
      '*/Cursor.exe',
      '*/Windsurf.exe',
      '*/zed.exe',
      'Zed/zed.exe',
      '*/sublime_text.exe',
      'JetBrains/*/bin/*64.exe',
    ]) {
      for await (const candidate of glob(pattern, { cwd: directory })) candidates.add(path.join(directory, candidate))
    }
  }
  if (process.env.LOCALAPPDATA) {
    const toolbox = path.join(process.env.LOCALAPPDATA, 'JetBrains/Toolbox/apps')
    for (const pattern of ['*/bin/*64.exe', '*/*/bin/*64.exe', '*/*/*/bin/*64.exe']) {
      for await (const candidate of glob(pattern, { cwd: toolbox })) candidates.add(path.join(toolbox, candidate))
    }
  }
  const apps: Array<{ id: ProjectApp['id']; path: string }> = []
  for (const [id, executable] of Object.entries(executables) as Array<[Exclude<ProjectApp['id'], 'finder'>, string]>) {
    const locations = [...candidates].flatMap((candidate) => [
      candidate,
      path.join(candidate, executable),
      path.join(candidate, 'bin', executable),
    ])
    for (const location of locations) {
      if (
        path.basename(location).toLowerCase() !== executable.toLowerCase() ||
        !path.isAbsolute(location) ||
        location.includes('\0')
      )
        continue
      try {
        const target = await realpath(location)
        if (!(await stat(target)).isFile()) continue
        apps.push({ id, path: target })
        break
      } catch (cause) {
        if (!['ENOENT', 'ENOTDIR'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw cause
      }
    }
  }
  return apps
}
