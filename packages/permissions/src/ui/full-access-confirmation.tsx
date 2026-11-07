import { Button } from '@pi-meme/ui/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@pi-meme/ui/components/ui/dialog'

export function FullAccessConfirmation({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>启用完全权限？</DialogTitle>
          <DialogDescription>
            Agent 将不使用本地文件沙箱，可修改当前系统用户有权修改的文件，并加载已授权的 Agent 插件和 MCP。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
          >
            启用完全权限
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
