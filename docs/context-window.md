---
description: '会话上下文窗口的入口、请求采集、分项估算、正文保留与只读接口'
status: implemented
paths:
  - packages/context-window/src/
  - packages/contracts/src/context-window.ts
  - packages/pi-runtime/src/sdk/context-observer.ts
  - packages/app-ui/src/panels/context-window-tool.tsx
---

# 会话上下文窗口

在聊天右侧工具目录中打开“上下文窗口”，或点击输入框上下文圆环浮层中的“查看上下文窗口”。工具目录要求会话已有正式记录且存在真实主请求摘要；新会话、只有草稿或没有捕获记录的旧会话不显示入口。有摘要但正文未留存时仍可查看摘要。面板绑定明确的 `SessionRef`，不使用另一个窗口的当前选择。旧 Host 未声明 `context-window` capability 时隐藏该入口。

入口与输入框共用 `list({ limit: 1 })` 的摘要状态，订阅建立后补读，按 `context-window/resync` 事件和前台刷新更新。首次未知和查询失败不冒充空记录；同目标短暂失败保留最后确认值。已有标签不会因摘要归零或断线被关闭，确认能力撤销时才清理实例。

卡片沿用 Magpie 的布局、七分类、非线性地图、400 格窗口、分类筛选、默认八行内容和请求历史曲线。点击地图、图例或内容行查看正文，点击历史曲线固定旧请求，“返回实时”恢复最近一次可解析的主请求；最新请求中断或无法解析时保留此前真实卡片和历史，并说明当前显示的是最近可用快照。正文按需读取，支持 Reply、分页、复制和内联位图；切换会话或隐藏面板会关闭正文窗口。卡片按自身宽度使用 420/520 断点，并同时支持系统和应用的减少动态效果设置。

## 数据含义

系统提示、工具、技能、记忆、文件、工具结果、对话的分类与 token 估算移植自 Magpie。ASCII/CJK、工具定义、图片、read/MCP 与原生协议的处理保留其规则。它不是对 Pi 标签或 codemode 的另一次语义分类。

- **估算**：根据实际请求的逻辑 payload 估算输入；没有服务商用量时保持估算。
- **已计数**：同一次流的输入用量为 `input + cacheRead + cacheWrite`。总量使用该计量，各分类和细项仍是按全局比例校准后的估算；舍入后非负且合计对齐。
- **容量**：使用本次请求模型目录声明的窗口，不表示远端路由最终选中模型的真实容量。目录缺失时显示未知，不使用固定容量补齐历史。
- **缓存**：计量值与字段是否已知分开保存。当前 SDK 观察入口没有可靠的原始字段存在性；正的 `cacheRead` 可确认命中，归一化后的零仍保持 `unknown`，不解释成已知零命中率。
- **历史**：仅展示启用本实现后采到的真实请求，不从旧 JSONL 重建或伪造快照。请求数表示运行时逻辑请求，不承诺等于服务商内部每一次重试。

请求默认只列主对话。摘要、缓存预热、输入提示和未知来源通过 `includeAuxiliary` 显式查询。主请求使用当前原生会话、原始 payload hook、默认 stream 函数和 Context 身份联合判定；已确认主 Context 的复用归为预热。虚拟模型递归保留同一个私有调用标记，避免双重采集。

## 采集与存储

观察器装饰同一个 ModelRuntime 的 `stream` / `streamSimple`，保留原认证与 SDK stream 函数身份。先执行原 payload hook，再记录 `replacement === undefined ? payload : replacement`，并原样返回原 hook 的结果。不会提前读取 `result()` 或启动第二个流消费者；取消和原错误继续返回原调用者。

含 getter、Proxy、可执行 `toJSON` 或非普通 JSON 对象的自定义 payload 标为不可读，避免观察器额外执行其序列化副作用。逻辑 payload 不等于最终网络字节：SDK 的 WebSocket delta、远程 Magpie 的后续重写以及上游重试可能继续改变线上请求。只保存白名单路由模型标识，不保存认证头、环境变量或完整响应头。正文里原本由用户或模型输入的内容仍会原样包含在快照中。

Worker 通过专用桥发送快照，Node Host 是唯一写入者。正文不进入聊天消息、Pi JSONL、普通会话快照或控制事件日志；控制事件只携带请求 ID 和修订。观察错误不阻断模型执行。

| 内容              | 保留方式                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| 请求摘要          | `state/modules/%40pi-meme%2Fcontext-window/<session-hash>/<request-hash>.json`，保留 30 日，总量清理上限 200 MiB |
| 请求与 Reply 正文 | 默认仅 Host 内存，全 Host 最近访问最多 10 个请求、合计 64 MiB；单份请求或 Reply 最多 32 MiB                      |
| 可选正文归档      | 设置 → 通用 → 会话 → “归档上下文正文”，默认关闭；开启后在同一目录保存 gzip，清理上限 1 GiB、30 日                |
| 临时会话          | 仅对应临时运行目录的摘要和内存正文，不写永久 gzip；关闭、会话删除和启动扫尾沿用临时会话清理                      |

容量和日期清理在启动、定期更新及归档写入后执行。正文过期或被逐出后，摘要仍可展示；正文入口明确返回不可用。已保存的归档不因关闭开关立即删除，之后不再新增归档。完整正文与回复可能包含私人信息，开关只控制归档，不改变原会话保存方式。

Reply 超额时保留开头并标明截断，密封思考不解密。图片只允许限额内的 PNG/JPEG/GIF/WebP 内联 data URL，不访问远程 URL、SVG 或任意路径。Host 重启后内存正文不可恢复；未结束请求显示为中断。

Worker 最多四条并发采集通道、128 个排队请求，活动与排队正文合计最多 64 MiB；单份分类摘要另限 256 KiB，超限明确标为不可解析。同请求按 payload → terminal 保序；过载先丢正文，队列全部占满时可丢观测事件，均不等待存储后才继续模型。该限制意味着极端过载时历史可能缺项。

## 只读接口

能力契约见 [context-window.ts](../packages/contracts/src/context-window.ts)，所有调用都先校验 Host、会话存在性、临时会话归属及关闭状态。Agent 读取自己的临时执行根时使用 Host 绑定的执行身份；显式读取其他临时会话仍校验原归属，客户端不能传入该执行身份。Desktop、Web 和远程转发使用同一 HostApi v3 与现有 HTTP/WebSocket 通路。

| 方法                  | 参数（省略共同的第一个 `SessionRef`）                                 | 返回                                                                     |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `contextWindow.list`  | `{cursor?,limit?,includeAuxiliary?}`                                  | 摘要列表；每页最多 100 条，默认仅主请求                                  |
| `contextWindow.get`   | `requestId`                                                           | 单个摘要与正文可用状态                                                   |
| `contextWindow.item`  | `{requestId,payloadRevision?,kind,itemId?,offset?,limit?}`            | 最多 100 个项目及 piece 元数据，无正文或图片数据                         |
| `contextWindow.reply` | `requestId`                                                           | Reply piece 元数据及截断标记                                             |
| `contextWindow.piece` | `{requestId,payloadRevision?,kind,itemId?,pieceIndex,offset?,limit?}` | 最多 20000 个 UTF-16 字符，序列化文本另限 48 KiB，按实际返回偏移继续读取 |
| `contextWindow.image` | `{requestId,payloadRevision?,kind,itemId?,pieceIndex}`                | 受限内联位图                                                             |

`kind` 使用七分类；读取回复时 `piece/image` 可传 `reply`。项目 ID 是稳定编码的分类、tag、名称组合，不使用行号。摘要的 `revision` 随更新递增，`payloadRevision` 表示正文版本；分页可携带后者，版本改变时明确拒绝继续读取，避免拼接不同版本。界面在 payload 改变时关闭旧正文窗口。极小文本分页仍保留完整代理对，偏移以返回的 `nextOffset` 为准。`memory/archive/off/missing/cut/unread/too-large/pending` 表示可用位置或失败状态，不把不可用内容替换为空正文冒充成功。

Agent 通过 [Host 内置工具](host-system-tools.md) 的同名 `contextWindow.*` 只读操作访问，`args` 为 `[query-or-requestId, SessionRef?]`。默认只读摘要，正文和图像必须显式调用对应方法；Plan 不因此获得写权限。

代码、样式、布局算法及模型图标衍生自 [Magpie](https://github.com/yetone/magpie)，保留 MIT 声明，见 [第三方许可](../THIRD_PARTY_NOTICES.md)。
