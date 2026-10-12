# DeepSeek Sidebar Agent ⚡

把 DeepSeek 的普通对话，升级为**编程智能体工作台**。

DeepSeek 的模型能力很强，但网页版只是一个聊天框。这个插件给它装上"手"和"眼睛"：
侧边栏控制台负责编排，DeepSeek 负责推理和写代码，插件负责执行、渲染、纠错、
多任务并行、操控任意网页。目标是帮 DeepSeek 破圈——在浏览器里释放它的全部智能。

## 功能

- ⌨️ **输入框即入口（隐形智能体）**：直接在 DeepSeek 输入框说"帮我开发一个俄罗斯方块"，
  插件拦截发送、按意图自动增强提示词，游戏在右侧边栏自动开发好。页面右下角有 🤖 Agent 开关。
- 🎮 **右侧纯舞台**：侧边栏只做一件事——把生成的程序跑起来。生成开始自动打开，
  预览占满整个侧边栏；悬浮小工具条只有重新生成 / 新标签页打开 / 下载 / 关闭。
  所有配置（深度思考/联网搜索/Agent 开关/修复轮次）都在扩展选项页（⚙️）。
- 🎮 **游戏工坊**：DeepSeek 写 Three.js 游戏 → 沙盒 iframe 直接试玩 →
  运行时报错自动回传、自动修复（轮次可在选项页调）。历史版本可一键回滚。
- 💬 **对话增强**：把"帮我写个脚本"升级为 agent 模式——先给执行计划，再给完整可运行代码。
- ⇄ **多对话调度**：每行一个子任务，并行开多个 DeepSeek 对话执行，结果汇总回侧边栏。
  专治"提示词上下文不够用"：单对话 token 预算 + 超限自动摘要 + 本地记忆。
- 🌐 **网页操控**：输入网址和目标，插件用 `chrome.debugger`（页内 CDP）打开页面、
  按模型的下一步指令点击/输入/滚动，循环直到任务完成。不需要手动开 9222。
- 🔍 **SSE 网络层捕获**：MAIN world 注入 fetch 钩子，直接拿聊天接口的 token 流，
  比 DOM 解析可靠一个数量级。
- ⌨️ **地址栏直达**：`ds 俄罗斯方块` 回车即生成；`Ctrl+Shift+D` 开关侧边栏；选中文字右键"用 DS Agent 解释"。
- 📦 **沙盒安全**：游戏跑在 `sandbox="allow-scripts"` 的 iframe 里，碰不到页面和扩展数据。

## 安装

1. 下载本仓库（或 releases 里的 zip）并解压。
2. Chrome 打开 `chrome://extensions`，右上角打开**开发者模式**。
3. 点**加载已解压的扩展程序**，选择项目根目录（含 `manifest.json` 的那层）。
4. 打开 https://chat.deepseek.com 并登录，点击工具栏的 ⚡ 图标，侧边栏即出现。

## 使用

- **生成游戏**：侧边栏 → 游戏工坊 → 输入创意（"太空射击，躲陨石吃能量豆"）→ 生成并试玩。
  预览会同时出现在页面右下角浮动面板和侧边栏里；满意点"下载 HTML"带走。
- **多对话**：多对话 tab → 每行一个子任务 → 并行执行。
- **操控网页**：网页操控 tab → 填网址和任务 → 开始操控。Chrome 顶部会出现"正在调试"
  提示条（正常现象），任务结束自动 detach。

## 技术决策

| 问题 | 决策 |
|---|---|
| 侧边栏怎么做 | Chrome `sidePanel` API，本身就是网页；游戏预览另用沙盒 iframe 可注入页面 |
| 9222 远程调试 | 扩展内用 `chrome.debugger` 即可，等价 CDP 能力；9222 留给外部程序，见 `docs/REMOTE_DEBUG.md` |
| C++/Rust/WASM | 插件场景 C++ 无用武之地；tokenizer 用 JS 启发式实现，接口预留 WASM 替换位，不硬上技术 |
| 上下文不够用 | token 预算 60k → 超 80% 自动让 DeepSeek 自己摘要 → 记忆存 `chrome.storage.local` |
| 选择器失效 | `src/content/deepseek.js` 顶部 `SELECTORS` 集中配置 + 启发式兜底 |
| 深度思考 / 联网搜索 | 侧边栏顶部开关；深度思考默认开（智能体推理质量生命线），联网搜索默认只在多对话调研场景开，游戏生成不开（防脏数据+省延迟） |
| 图片识别 | 已支持消息带图发送（content script 走 file input）；操控模式截图视觉定位在路线图 |

## 项目结构

```
├── manifest.json               # MV3：sidePanel/tabs/debugger/storage 等全权限
├── src/
│   ├── sidepanel/              # 智能体控制台 UI
│   ├── content/deepseek.js     # 对话页控制器（读/发/等流式结束）
│   ├── content/artifact.js     # 游戏沙盒渲染 + 报错回传
│   ├── background/worker.js    # 大脑：agent 循环、多 tab 调度、debugger 操控
│   └── agent/                  # tokenizer / prompts / context（上下文管理）
├── docs/                       # ARCHITECTURE.md / REMOTE_DEBUG.md
└── scripts/pack.sh
```

## 路线图

- [ ] `SELECTORS` 按真实 DOM 校准（进行中）
- [ ] 游戏错误修复轮次可配置；支持 p5.js / Phaser 模板
- [ ] 网页操控：截图 + 视觉定位（接多模态）
- [ ] Rust/WASM BPE tokenizer 替换启发式估算
- [ ] Chrome 应用商店上架

## 许可

MIT
