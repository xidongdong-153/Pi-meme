import path from 'node:path'
import { parseArgs } from 'node:util'
import { features, suites, type Layer, type TestSuite } from './catalog'

export const layers: Layer[] = ['unit', 'component', 'integration', 'e2e', 'artifact']
const sourceLayers: Layer[] = ['unit', 'component', 'integration']

export interface TestSelection {
  suites: TestSuite[]
  list: boolean
  help: boolean
  name?: string
  coverage: boolean
}

export function selectTests(args: string[], platform: NodeJS.Platform = process.platform): TestSelection {
  const { values } = parseArgs({
    args: args.filter((argument) => argument !== '--'),
    options: {
      feature: { type: 'string', multiple: true },
      layer: { type: 'string' },
      target: { type: 'string' },
      file: { type: 'string', multiple: true },
      name: { type: 'string' },
      all: { type: 'boolean' },
      list: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      coverage: { type: 'boolean' },
    },
    allowPositionals: false,
  })
  const requestedFeatures = values.feature ?? []
  const files = (values.file ?? []).map((file) =>
    path.relative(process.cwd(), path.resolve(file)).split(path.sep).join('/'),
  )
  const scoped = Boolean(values.all || requestedFeatures.length || files.length)
  if (values.help || (!scoped && values.list))
    return { suites: [], help: true, list: Boolean(values.list), coverage: false }
  if (!scoped) throw new Error('请用 --feature、--file 或 --all 明确选择测试范围。')
  if (values.all && (requestedFeatures.length || files.length))
    throw new Error('--all 不能与 --feature 或 --file 同时使用。')
  if (requestedFeatures.length && files.length) throw new Error('--feature 与 --file 请分别使用。')
  for (const feature of requestedFeatures)
    if (!Object.hasOwn(features, feature)) throw new Error(`未知功能：${feature}。使用 pnpm test --list 查看功能清单。`)
  for (const file of files)
    if (!suites.some((suite) => suite.file === file)) throw new Error(`未登记的测试文件：${file}`)
  const requestedLayers = values.layer?.split(',') ?? (values.all || files.length ? layers : sourceLayers)
  for (const layer of requestedLayers) if (!layers.includes(layer as Layer)) throw new Error(`未知测试层次：${layer}`)
  if (values.target && !['web', 'desktop', 'server'].includes(values.target))
    throw new Error(`未知测试目标：${values.target}`)
  if (values.name !== undefined && !files.length) throw new Error('--name 必须同时指定 --file，避免加载全仓测试。')
  const name = values.name === undefined ? undefined : new RegExp(values.name).source
  let selected = suites.filter(
    (suite) =>
      (values.all ||
        files.includes(suite.file) ||
        suite.features.some((feature) => requestedFeatures.includes(feature))) &&
      requestedLayers.includes(suite.layer) &&
      (!values.target || suite.target === values.target),
  )
  const unsupported = selected.filter((suite) => suite.platforms && !suite.platforms.includes(platform))
  if (unsupported.length && (values.target || files.length))
    throw new Error(`当前平台 ${platform} 不支持所选测试：${unsupported.map((suite) => suite.file).join('、')}`)
  selected = selected.filter((suite) => !suite.platforms || suite.platforms.includes(platform))
  if (!selected.length) throw new Error('所选范围没有可在当前平台执行的测试。')
  if (values.coverage && selected.some((suite) => !sourceLayers.includes(suite.layer)))
    throw new Error('--coverage 只用于 unit、component、integration，请同时指定 --layer。')
  return { suites: selected, list: Boolean(values.list), help: false, name, coverage: Boolean(values.coverage) }
}

export function requiredBuilds(selected: TestSuite[]): string[] {
  const builds = new Set<string>()
  for (const suite of selected) {
    if (suite.layer === 'e2e' && suite.target === 'web') builds.add('build:web')
    if (suite.layer === 'artifact' && suite.target === 'server') builds.add('build:server')
    if (['e2e', 'artifact'].includes(suite.layer) && suite.target === 'desktop') builds.add('package')
  }
  return [...builds]
}

export function featureHelp(): string {
  return Object.entries(features)
    .map(([id, label]) => `  ${id.padEnd(14)} ${label}`)
    .join('\n')
}
