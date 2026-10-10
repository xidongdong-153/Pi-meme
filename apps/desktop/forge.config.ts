import type { ForgeConfig } from '@electron-forge/shared-types'
import { MakerZIP } from '@electron-forge/maker-zip'
import { VitePlugin } from '@electron-forge/plugin-vite'
import { FusesPlugin } from '@electron-forge/plugin-fuses'
import { FuseV1Options, FuseVersion } from '@electron/fuses'
import path from 'node:path'
import { cp, readdir, mkdir } from 'node:fs/promises'
import { copyPiRuntime } from '../../scripts/copy-pi-runtime.mjs'

const signingIdentity = process.env.PI_DESKTOP_SIGNING_IDENTITY

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // 不带扩展名，@electron/packager 按平台补 .icns / .ico
    icon: path.join(__dirname, 'assets/icons/pi-dev-dark'),
    // 本地包使用 ad-hoc 签名；正式证书通过 PI_DESKTOP_SIGNING_IDENTITY 指定。
    osxSign: signingIdentity
      ? { identity: signingIdentity }
      : {
          identity: '-',
          identityValidation: false,
          optionsForFile: () => ({ hardenedRuntime: false, timestamp: false }),
        },
    // Vite 插件只把 .vite 打进 asar，运行时切换的 Dock 图标要额外拷到 Resources 下
    extraResource: [path.join(__dirname, 'assets/dock')],
  },
  rebuildConfig: {},
  makers: [new MakerZIP({}, ['darwin'])],
  hooks: {
    // Vite 会把主进程代码打成单文件，Pi SDK 以 external 保留；这里把运行时需要的
    // SDK 文件复制进打包目录，让打包应用不依赖本机安装的 pi。
    packageAfterCopy: async (_config, buildPath) => {
      await copyPiRuntime(path.join(buildPath, 'node_modules'))
      const pluginsRoot = path.resolve(__dirname, '../../plugins')
      for (const entry of await readdir(pluginsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const target = path.join(buildPath, '.vite/plugins', entry.name)
        await mkdir(target, { recursive: true })
        await cp(path.join(pluginsRoot, entry.name, 'package.json'), path.join(target, 'package.json'))
        await cp(path.join(pluginsRoot, entry.name, 'dist'), path.join(target, 'dist'), { recursive: true })
      }
    },
  },
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main/main.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        { entry: 'src/main/host-process.ts', config: 'vite.main.config.mts', target: 'main' },
        { entry: '../../packages/pi-adapter/src/session-worker.ts', config: 'vite.main.config.mts', target: 'main' },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
}

export default config
