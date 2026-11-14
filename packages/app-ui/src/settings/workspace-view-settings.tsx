import { SettingsCard, SettingsGroup, SettingsRow } from '@pi-meme/ui/components/settings'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import type { WorkspaceView } from '../layout/use-workspace-view'

export function WorkspaceViewSettings({ workspaceView }: { workspaceView: WorkspaceView }) {
  return (
    <SettingsGroup title="布局">
      <SettingsCard>
        <SettingsRow className="flex-nowrap">
          <div className="min-w-0">
            <p className="font-medium">完整视图</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">将聊天和工具合并为顶栏标签页。</p>
          </div>
          <Switch label="完整视图" checked={workspaceView.unified} onChange={workspaceView.change} />
        </SettingsRow>
      </SettingsCard>
    </SettingsGroup>
  )
}
