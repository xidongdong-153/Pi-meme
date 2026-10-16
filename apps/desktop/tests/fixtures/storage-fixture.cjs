const path = require('node:path')
const { app, dialog } = require('electron')

// 测试驱动负责启动每一轮真实进程；生产实现仍使用 app.relaunch。
app.relaunch = () => {}
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.env.PI_MEME_STORAGE_TEST_TARGET] })
dialog.showMessageBox = async (_window, options) => {
  console.error(`存储验收弹窗：${options.message}`)
  return { response: 0, checkboxChecked: false }
}
require(path.resolve(__dirname, '../../.vite/build/main.js'))
