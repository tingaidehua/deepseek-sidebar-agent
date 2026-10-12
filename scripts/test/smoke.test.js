/* DS Agent 桩测试：在 Node 里模拟 chrome.* / DOM，把全部 JS 文件逐个加载，
 * 抓加载期异常；再对纯逻辑（tokenizer / prompts / context / 意图识别 / 代码块提取）做单元断言。
 * 运行：node scripts/test/smoke.test.js
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "../..");
let passed = 0;
const ok = (name) => { passed++; console.log("  ✓ " + name); };

function makeCtx() {
  const el = () => ({
    addEventListener() {}, removeEventListener() {}, appendChild() {}, append() {},
    click() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute() {}, getAttribute() { return null; },
    classList: { add() {}, remove() {}, contains() { return false; } },
    style: {}, dataset: {},
    _h: "", set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; },
    _t: "", set textContent(v) { this._t = v; }, get textContent() { return this._t; },
    disabled: false, checked: true, value: "", files: null,
    contains() { return false; }, focus() {},
  });
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Blob, TextDecoder,
    Event: class { constructor() {} },
    InputEvent: class { constructor() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    HTMLTextAreaElement: class {}, HTMLInputElement: class {},
    File: class { constructor(parts, name, opts) { this.name = name; } },
    DataTransfer: class { constructor() { this.items = { add() {} }; this.files = []; } },
    fetch: async () => ({ blob: async () => new Blob([]) }),
    navigator: { clipboard: { writeText: async () => {} } },
    location: { pathname: "/", href: "https://chat.deepseek.com/" },
    importScripts() {},
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: () => Promise.resolve({ ok: true }),
        getURL: (p) => "chrome-extension://test/" + p,
        onInstalled: { addListener() {} },
        openOptionsPage: async () => {},
        lastError: null,
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      tabs: {
        onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        sendMessage: async () => ({ ok: true }), query: async () => [],
        create: async () => ({ id: 1 }), get: async (id) => ({ id }),
        reload: async () => {},
      },
      sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
      scripting: { registerContentScripts: async () => {} },
      debugger: { attach: async () => {}, sendCommand: (t, m, p, cb) => cb({}), detach: async () => {} },
      downloads: { download: async () => {} },
      contextMenus: { create() {}, onClicked: { addListener() {} } },
      notifications: { create() {} },
      commands: { onCommand: { addListener() {} } },
      omnibox: { onInputEntered: { addListener() {} } },
    },
    document: {
      addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; },
      createElement() { return el(); }, getElementById() { return el(); },
      body: el(), execCommand() { return true; },
    },
  };
  sandbox.window = {
    addEventListener() {}, removeEventListener() {},
    postMessage() {}, fetch: sandbox.fetch, open() {},
  };
  sandbox.globalThis = sandbox;
  return vm.createContext(sandbox);
}

const ctx = makeCtx();
const load = (rel) => {
  const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
  vm.runInContext(code, ctx, { filename: rel });
  ok("加载无异常: " + rel);
};

(async () => {
  console.log("== 1. 文件加载 ==");
  ["src/agent/tokenizer.js", "src/agent/prompts.js", "src/agent/context.js",
   "src/content/interceptor.js", "src/content/deepseek.js", "src/content/artifact.js",
   "src/sidepanel/panel.js", "src/background/worker.js",
   "src/options/options.html"].forEach((f) => {
    if (f.endsWith(".html")) {
      const html = fs.readFileSync(path.join(ROOT, f), "utf8");
      assert.ok(html.includes("<html"), f + " 应为合法 HTML");
      ok("HTML 结构: " + f);
    } else load(f);
  });
  await new Promise((r) => setTimeout(r, 100));

  console.log("== 2. tokenizer ==");
  const est = ctx.DSA.estimateTokens;
  assert.strictEqual(est(""), 0);
  assert.strictEqual(est("你好世界"), 4);
  assert.ok(est("hello world") > 0 && est("hello world") < 10);
  assert.ok(est("俄罗斯方块游戏") >= 7);
  ok("estimateTokens 中英混合启发式");

  console.log("== 3. prompts ==");
  const gs = ctx.DSA.PROMPTS.GAME_SMITH("做个俄罗斯方块");
  assert.ok(gs.includes("俄罗斯方块"), "创意应被拼入");
  assert.ok(gs.includes("```html"), "应要求 html 代码块");
  assert.ok(gs.includes("three"), "应要求 three.js");
  assert.ok(gs.includes("importmap"), "应用 importmap 方式引入");
  const fix = ctx.DSA.PROMPTS.GAME_FIX("TypeError: x");
  assert.ok(fix.includes("TypeError: x") && fix.includes("```html"));
  const chat = ctx.DSA.PROMPTS.CHAT_ENHANCE("写个脚本");
  assert.ok(chat.includes("写个脚本"), "任务应被拼入");
  ok("GAME_SMITH / GAME_FIX / CHAT_ENHANCE 模板插值");

  console.log("== 4. context ==");
  const Ctx = ctx.DSA.ContextManager;
  const c = new Ctx("t1");
  c.addTurn("user", "帮我开发一个俄罗斯方块");
  c.addTurn("assistant", "好的，这是代码");
  assert.ok(c.tokenCount() > 0);
  assert.ok(c.usageRatio() < 1);
  assert.ok(!c.needsSummary());
  assert.ok(c.buildContext().includes("俄罗斯方块"));
  await c.save();
  ok("ContextManager 记账/预算/持久化");

  console.log("== 5. 意图识别（取自 deepseek.js 字面量） ==");
  const src = fs.readFileSync(path.join(ROOT, "src/content/deepseek.js"), "utf8");
  const GAME_RE = eval(src.match(/const GAME_RE = (\/.*?\/i);/)[1]);
  const CODE_RE = eval(src.match(/const CODE_RE = (\/.*?\/i);/)[1]);
  const detect = (t) => (GAME_RE.test(t) ? "game" : CODE_RE.test(t) ? "code" : "chat");
  assert.strictEqual(detect("帮我开发一个俄罗斯方块"), "game");
  assert.strictEqual(detect("写一个贪吃蛇小游戏"), "game");
  assert.strictEqual(detect("写个 python 脚本批量转图片"), "code");
  assert.strictEqual(detect("帮我 debug 这个报错"), "code");
  assert.strictEqual(detect("今天天气怎么样"), "chat");
  ok("意图路由 game/code/chat");

  console.log("== 6. 代码块提取（worker.js） ==");
  const extract = ctx.extractCodeBlock;
  assert.ok(typeof extract === "function", "worker 顶层函数应挂到全局");
  assert.strictEqual(extract("bla ```html\n<H1>x</H1>\n``` tail", "html"), "<H1>x</H1>");
  assert.strictEqual(extract("没有代码块", "html"), "");
  assert.ok(extract("```js\nvar a=1;\n```", "html").includes("var a=1"), "html 找不到时回退任意代码块");
  assert.ok(typeof ctx.lastAssistantText === "function");
  ok("extractCodeBlock / lastAssistantText");

  console.log(`\n全部通过：${passed} 项`);
})().catch((e) => { console.error("❌ 失败:", e.message); process.exit(1); });
