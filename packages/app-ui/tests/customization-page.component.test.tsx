import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ResourceCatalog, ResourceItem } from '@pi-meme/contracts/resources'
import type { ResourceClient } from '@pi-meme/client/resource-client'
import type { PluginClient } from '@pi-meme/client/plugin-client'
import { TooltipProvider } from '@pi-meme/ui/components/ui/tooltip'
import { CustomizationPage } from '../src/plugins/customization-page'
import { PluginPage } from '../src/settings/plugin-page'
import { SkillPage } from '../src/settings/skill-page'
import { plugin } from './integration-pages-fixture'

afterEach(cleanup)

function renderPage() {
  const items: ResourceItem[] = Array.from({ length: 9 }, (_, index) => ({
    id: `skill-${index}`,
    kind: 'skill',
    name: `skill-${index}`,
    description: `技能说明 ${index}`,
    revision: 'r1',
    path: `/skills/skill-${index}/SKILL.md`,
    sourcePath: '/skills',
    baseDir: `/skills/skill-${index}`,
    scope: index === 8 ? 'builtin' : 'host',
    owner: { id: 'loose', type: 'loose' },
    enabled: true,
    defaultPolicy: {},
    invocation: 'automatic',
    diagnostics: [],
    editable: index !== 8,
  }))
  const catalog: ResourceCatalog = { generation: 1, dataRoot: '/data', items, diagnostics: [] }
  const resources = {
    catalog: vi.fn(async () => catalog),
    onChange: vi.fn(() => () => {}),
  } satisfies Pick<ResourceClient, 'catalog' | 'onChange'>
  const onSettings = vi.fn()
  const onCreatePlugin = vi.fn(async () => true)
  const onCreateSkill = vi.fn(async () => true)
  const plugins = [plugin, { ...plugin, id: 'builtin-plugin', builtin: true }, { ...plugin, id: '@pi-meme/terminal' }]
  render(
    <TooltipProvider>
      <CustomizationPage
        plugins={plugins}
        nativeWindow={false}
        rail={null}
        onDismiss={vi.fn()}
        renderContent={(section, selection) =>
          section === 'plugins' ? (
            <PluginPage
              client={{} as PluginClient}
              plugins={plugins}
              errors={{}}
              view="catalog"
              selection={selection}
              onChanged={async () => {}}
              onSettings={() => onSettings('plugins')}
              onCreate={onCreatePlugin}
            />
          ) : (
            <SkillPage
              client={resources as unknown as ResourceClient}
              commands={[]}
              view="catalog"
              onUse={vi.fn()}
              onChanged={async () => {}}
              onSettings={() => onSettings('skills')}
              onCreate={onCreateSkill}
            />
          )
        }
      />
    </TooltipProvider>,
  )
  return { onSettings, onCreatePlugin, onCreateSkill }
}

test('侧栏仅显示个人插件，点击后可查看详情并打开对应设置', () => {
  const props = renderPage()
  const sidebar = screen.getByRole('region', { name: '已安装插件' })
  expect(within(sidebar).getAllByRole('button')).toHaveLength(1)
  fireEvent.click(within(sidebar).getByRole('button', { name: '打开插件：example:app' }))
  expect(screen.getByRole('heading', { name: 'example:app' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '插件设置' }))
  expect(props.onSettings).toHaveBeenLastCalledWith('plugins')
})

test('技能列表展开和收起后仍可搜索，齿轮打开技能设置', async () => {
  const props = renderPage()
  fireEvent.click(within(screen.getByRole('navigation', { name: '自定义分类' })).getByRole('button', { name: '技能' }))
  const installed = await screen.findByRole('region', { name: '已安装技能' })
  await within(installed).findByRole('list', { name: '已安装技能列表' })
  expect(within(installed).getAllByRole('listitem')).toHaveLength(6)
  fireEvent.click(screen.getByRole('button', { name: /查看 skill-6/ }))
  expect(within(installed).getAllByRole('listitem')).toHaveLength(9)
  fireEvent.click(screen.getByRole('button', { name: '收起已安装技能' }))
  expect(within(installed).getAllByRole('listitem')).toHaveLength(6)
  fireEvent.change(screen.getByRole('textbox', { name: '搜索技能' }), { target: { value: 'skill-7' } })
  expect(within(installed).getAllByRole('listitem')).toHaveLength(1)
  expect(within(installed).getByRole('button', { name: '查看技能：skill-7' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '技能设置' }))
  expect(props.onSettings).toHaveBeenLastCalledWith('skills')
})

test('插件和技能的添加菜单分别唤起对应创建向导', async () => {
  const props = renderPage()
  fireEvent.pointerDown(screen.getByRole('button', { name: '添加插件' }), { button: 0, ctrlKey: false })
  fireEvent.click(await screen.findByRole('menuitem', { name: '创建插件' }))
  await waitFor(() => expect(props.onCreatePlugin).toHaveBeenCalledOnce())
  await act(async () => {})
  fireEvent.click(within(screen.getByRole('navigation', { name: '自定义分类' })).getByRole('button', { name: '技能' }))
  fireEvent.pointerDown(screen.getByRole('button', { name: '添加技能' }), { button: 0, ctrlKey: false })
  fireEvent.click(await screen.findByRole('menuitem', { name: '创建技能' }))
  await waitFor(() => expect(props.onCreateSkill).toHaveBeenCalledOnce())
})
