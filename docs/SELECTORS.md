# DeepSeek Web 选择器地图

> 来源：2026-10-13 云端浏览器真实 DOM 侦察（已登录）。未发送任何消息。
> 维护经验：**语义类名**（`ds-toggle-button`、`ds-button--*`、`aria-pressed`、
> placeholder 文案、href 前缀）比**哈希类名**（`_27c9245` 等构建产物）稳定，
> 改版时优先按语义类名修复。

| 用途 | 选择器 | 状态判断 / 备注 |
|---|---|---|
| 输入框 | `textarea[placeholder="给 DeepSeek 发送消息 "]` | `<textarea rows=2>`，非 contenteditable；placeholder 最稳定 |
| 发送按钮 | `div[role="button"].ds-button--primary.ds-button--filled.ds-button--circle` | 无文字，向上箭头 SVG；输入为空时附加 `ds-button--disabled` |
| 深度思考开关 | `div.ds-toggle-button[tabindex="0"]` 内层文字含"深度思考" | `aria-pressed="true"`=开；开时附加 `ds-toggle-button--selected` |
| 智能搜索开关 | `div.ds-toggle-button[tabindex="0"]` 内层文字含"智能搜索" | 同上 |
| 新对话 | `div._5a8ac7a[tabindex="0"]`（内含"开启新对话"）；顶栏 `div[role="button"].ds-button--capsule._4f3769f` | 哈希类名，改版时先坏这里 |
| 对话列表项 | `a._546d736[href^="/a/chat/s/"]`，标题 `div.c08e6e93` | 容器 `div._6d215eb`；日期分组 `div._3098d02` |
| 上传按钮 | `div[role="button"].ds-button--capsule`（回形针图标） | 注意与新对话胶囊按钮区分：排除含 `_4f3769f` 类或"新对话"文字的 |
| 隐藏 file input | `input[type="file"]` | ⚠️ 侦察时未能定位；代码里先点回形针再找，找不到则抛错 |

## 未能验证（需登录态下真实发送一次）

- 消息列表容器与单条消息选择器：消息为普通 DOM 流式渲染，无 Shadow DOM、无 Canvas；
  用户/AI 无 role/data-* 属性，区分靠"AI 回复下方带操作工具栏（复制/重试/朗读/点赞），用户消息纯文本"。
- 生成中状态标识（流式光标/loading 元素）。
- 代码块 `pre/code` 类名与复制按钮（历史对话里没发现围栏代码块）。

## 对代码的影响

- `src/content/deepseek.js` 的 `SELECTORS` 已按上表校准。
- 文本捕获主路径是 `src/content/interceptor.js` 的 SSE 网络层拦截，不依赖 DOM，
  因此上面"未能验证"的三项不阻塞核心功能（游戏工坊走 SSE）。
