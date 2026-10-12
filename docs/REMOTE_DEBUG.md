# 远程调试：9222 端口方案

本扩展的"网页操控"默认走 **`chrome.debugger` API**（扩展内直接 attach 任意 tab，
走的就是 CDP 协议），**不需要**你手动开 9222 端口。这是给扩展场景最省事的路。

9222 方案留给**扩展之外的外部程序**（比如你本机跑的 Python/Node 自动化脚本）
想直接驱动 Chrome 的场景。

## 开启 9222

先彻底退出 Chrome，然后：

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug &

# Windows
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\chrome-debug

# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug &
```

注意 `--user-data-dir` 必须和日常 profile 分开，否则 Chrome 拒绝启动第二个实例。

验证：浏览器打开 `http://localhost:9222/json`，能看到 tab 列表即成功；
`chrome://inspect/#devices` 里也能看到目标。

## 外部程序驱动示例（Node）

```bash
npm i chrome-remote-interface
```

```js
const CDP = require('chrome-remote-interface');
(async () => {
  const client = await CDP({ port: 9222 });
  const { Runtime, Page } = client;
  await Page.enable();
  await Page.navigate({ url: 'https://chat.deepseek.com' });
  await Page.loadEventFired();
  const r = await Runtime.evaluate({ expression: 'document.title' });
  console.log(r.result.value);
  await client.close();
})();
```

## 两条路线的取舍

| | chrome.debugger（扩展默认） | 9222（外部程序） |
|---|---|---|
| 需要用户操作 | 否（点一下"开始操控"就行） | 是（命令行启动 Chrome） |
| 调试提示条 | 有（Chrome 强制显示） | 有 |
| 适用 | 扩展内的网页操控模式 | 批量任务、CI、非扩展脚本 |
| 权限 | `debugger` 权限 | 本机端口访问 |

结论：日常用扩展就够了；哪天你要写独立的自动化流水线，再开 9222。
