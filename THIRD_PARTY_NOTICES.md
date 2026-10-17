# 第三方许可

pi-meme 自有代码使用根目录 `LICENSE` 中的 MIT 许可。第三方代码、字体、图标和运行时保留各自许可，不因应用的 MIT 许可而改变。

分发包中的 `THIRD_PARTY_LICENSES.txt` 在构建时从已安装依赖收集包名、版本、许可声明以及随 npm 包提供的 LICENSE、NOTICE 等文件。它包含构建依赖，不表示列出的每个包都参与运行。依赖包缺少独立许可文件时保留其 package.json 声明和项目地址，不能将缺失文本解释为无许可限制。

- Desktop 保留 Electron 自带的 `LICENSE`、`LICENSES.chromium.html` 及 framework 中的许可文件。
- Host 的 Node.js 许可及其第三方声明位于 `runtime/LICENSE`。
- Host 的生产依赖也保留各自包内的许可文件。
- Pi SDK、Chord、React、xterm、CodeMirror、Shiki 等的许可声明见生成的依赖清单及对应包文件。
- GSAP 使用 [GSAP Standard License](https://gsap.com/standard-license/)，不是 MIT 许可。
- React Bits 衍生组件使用 MIT + Commons Clause，许可全文保留在 `packages/ui/src/components/react-bits.LICENSE.md`，并复制进生成的许可清单。允许作为应用的一部分分发，不将组件作为独立组件包出售、再许可或重新分发。
- 内置 Skill Creator 的许可保留在随包技能的 `license.txt`，并复制进生成的许可清单。

重新分发或商用前应核对相应第三方条款。仓库不授予第三方商标或应用外独立分发组件的权利。
