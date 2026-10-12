# 架构设计

## 目标

把 `chat.deepseek.com` 的普通对话升级为**编程智能体工作台**：侧边栏控制台编排一切，
DeepSeek 负责推理与代码生成，扩展负责执行、渲染、纠错、多任务调度。

## 核心设计：隐形智能体（输入框即入口）

第一性原理：**不要跟用户习惯作对**。用户已经在 DeepSeek 输入框里了，最顺的交互
不是让他跑到侧边栏重新输入，而是插件"隐形接管"——照常打字发送，插件在发送前
按意图自动增强：

```
用户在 DeepSeek 输入框输入：「帮我开发一个俄罗斯方块」回车
        │
        ▼（content script 在 capture 阶段拦截 Enter / 发送按钮点击）
意图识别：游戏关键词 → 自动包裹 GAME_SMITH 提示词
        │
        ▼（发送增强后的 prompt；页面悬浮 🤖 Agent 芯片显示状态）
DeepSeek 流式生成…
        │
        ▼（MAIN world 的 fetch 钩子捕获 /api/* 的 SSE 流 → token 级完美文本）
提取 ```html 代码块 → 沙盒 iframe 渲染 → 报错回传 → 自动修复（3 轮）
        │
        ▼
右侧边栏 IDE：预览 / 代码 / 控制台 / 历史版本 四个面板自动更新
```

关键技术点：

- **网络层捕获 > DOM 解析**：`src/content/interceptor.js` 以 `world:'MAIN'` 注入，
  hook `window.fetch`，`tee()` 出聊天接口的 SSE 流逐 token 解析。DOM 选择器一变
  就失效，网络协议稳定得多；DOM 的 `waitForIdle` 只做兜底。
- **发送拦截**：`keydown`（Enter）与 `click`（发送按钮）在 capture 阶段拦截，
  `internalSend` 标志防止插件自己触发的发送被二次拦截。
- **意图路由**：`GAME_RE / CODE_RE` 关键词 → `game / code / chat`；game 走
  `GAME_SMITH`，code 走 `CHAT_ENHANCE`，chat 原样透传（只记录日志）。
- **Agent 芯片**：页面右下角悬浮 `🤖 Agent: 开/关`，一键开关，状态存
  `chrome.storage.local`。
- **Chrome 能力全开**：sidePanel（IDE 控制台）、omnibox（地址栏 `ds 俄罗斯方块`）、
  contextMenus（选中文字右键解释）、notifications（游戏完成提醒）、commands
 （Ctrl+Shift+D 开关侧边栏）、debugger（网页操控走页内 CDP）。

## 组件

```
┌─────────────────────────────────────────────────────────┐
│ sidepanel (panel.html/js/css)  智能体控制台：任务输入、     │
│   游戏预览、日志、上下文用量                                │
└──────────────────────┬──────────────────────────────────┘
                       │ chrome.runtime 消息
┌──────────────────────▼──────────────────────────────────┐
│ background worker.js  大脑：agent 循环、多 tab 调度、       │
│   chrome.debugger 网页操控、上下文管理                      │
│   agent/ : tokenizer.js / prompts.js / context.js        │
└──────┬──────────────────────────────────┬───────────────┘
       │ tabs.sendMessage                  │ chrome.debugger (CDP)
┌──────▼──────────────┐          ┌─────────▼────────┐
│ content/deepseek.js │          │ 任意目标网页 tab   │
│ 读/发/等流式结束     │          │ click/type/scroll │
│ content/artifact.js │          └──────────────────┘
│ 沙盒 iframe 游戏渲染 │
│ + 报错回传          │
└─────────────────────┘
```

## 核心循环

**游戏工坊**（最完整的 agent 闭环）：
1. 用户在侧边栏输入创意 → `AGENT_RUN{mode:game}`
2. worker 拼 `GAME_SMITH` prompt → `DS_SEND` 发到 DeepSeek tab → `DS_WAIT_IDLE` 等流式结束
3. 提取最后一个 ```html 代码块 → `ARTIFACT_RENDER` 注入沙盒 iframe（`sandbox="allow-scripts"`，无 same-origin）
4. iframe 内错误垫片经 `postMessage` 回传报错 → worker 拼 `GAME_FIX` 自动修复，最多 3 轮
5. 预览同时推到页面浮动面板和侧边栏 iframe

**多对话扇出**：每个子任务开一个新 DeepSeek tab 并行执行，结果汇总回侧边栏。
**网页操控**：`chrome.debugger.attach` 后走 CDP（`Runtime.evaluate` / `Input`），
模型根据页面快照输出下一步 JSON，循环执行。能力等价于 `--remote-debugging-port`，
但不需要用户手动加启动参数。

## 上下文策略（防 prompt 爆炸）

- `tokenizer.js`：中英混合启发式估算（CJK 1 token/字，ASCII 约 4 字符/token），宁可高估。
- `context.js`：单对话预算 60k tokens；用量超 80% 时把最老的一半轮次发给 DeepSeek
  自己做摘要，存入 `chrome.storage.local`，原文只留最近 50 轮。
- 接口预留：`estimateTokens` 可被 Rust/WASM 的 BPE 分词器无缝替换。

## 消息协议

见各文件的 `chrome.runtime.onMessage`：`AGENT_RUN / AGENT_LOG / GAME_HTML /
FANOUT_DONE / DS_SEND / DS_READ / DS_WAIT_IDLE / ARTIFACT_RENDER` 等。

## 安全边界

- 游戏 iframe：`sandbox="allow-scripts"`，无 `allow-same-origin`，游戏代码碰不到
  页面 DOM，也读不到扩展数据；three.js 只从 jsdelivr CDN 加载。
- debugger 操控：每次 attach 都会触发 Chrome 的顶部"正在调试"提示条，用户可见；
  操控只在用户主动点的任务期间 attach，结束后 detach。
- `<all_urls>` host 权限仅用于网页操控模式；content script 只注入 deepseek.com。
- 扩展不收集、不上传任何数据；记忆只存在本地 `chrome.storage.local`。
