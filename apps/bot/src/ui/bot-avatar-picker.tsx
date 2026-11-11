import { botAvatarLabels, isBotAvatarPreset } from '@pi-meme/assets/bot-avatars'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@pi-meme/ui/components/ui/dropdown-menu'
import { Avatar, Button } from './common'

export function BotAvatarPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const selected = isBotAvatarPreset(value) ? value : ''
  const label = selected ? botAvatarLabels[selected] : '默认'
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="bot-avatar-trigger" aria-label={`选择 Bot 头像，当前${label}`}>
          <Avatar name={label} avatar={value} />
          <span>更换头像</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="bot-dropdown-content bot-avatar-menu"
        aria-label="Bot 头像"
        side="bottom"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        loop
        onEscapeKeyDown={(event) => {
          if (event.isComposing || event.keyCode === 229) event.preventDefault()
        }}
        onKeyDownCapture={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) event.stopPropagation()
        }}
      >
        <DropdownMenuRadioGroup className="bot-avatar-options" value={selected} onValueChange={onChange}>
          <DropdownMenuRadioItem value="" textValue="默认" className="bot-avatar-option bot-avatar-default">
            <Avatar name="默认" />
            <span>默认</span>
          </DropdownMenuRadioItem>
          {Object.entries(botAvatarLabels).map(([id, name]) => (
            <DropdownMenuRadioItem key={id} value={id} textValue={name} className="bot-avatar-option">
              <Avatar name={name} avatar={id} />
              <span>{name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
