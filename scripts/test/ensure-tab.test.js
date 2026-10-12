/* ensureDsTab 专项测试：ping 不可达时自动重载已有 tab */
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const assert = require("assert");
const ROOT = path.resolve(__dirname, "../..");

function makeWorkerCtx({ pingOkOn = [], existingTabs = [] }) {
  let reloadCalled = [];
  let createdTabs = 0;
  const pingCount = { n: 0 };
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Blob, TextDecoder,
    Event: class {}, InputEvent: class {},
    MutationObserver: class { observe() {} disconnect() {} },
    HTMLTextAreaElement: class {}, HTMLInputElement: class {},
    File: class {}, DataTransfer: class {},
    fetch: async () => ({}),
    navigator: {}, location: { pathname: "/", href: "https://chat.deepseek.com/" },
    importScripts() {},
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async (tabId, msg) => {
          if (msg.type === "DS_PING") {
            pingCount.n++;
            if (pingOkOn.includes(tabId)) return { ok: true };
            throw new Error("Could not establish connection");
          }
          return { ok: true };
        },
        getURL: (p) => p, onInstalled: { addListener() {} }, lastError: null,
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      tabs: {
        onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        sendMessage: async (tabId, msg) => sandbox.chrome.runtime.sendMessage(tabId, msg),
        query: async () => existingTabs,
        create: async () => { createdTabs++; return { id: 900 + createdTabs }; },
        reload: async (id) => { reloadCalled.push(id); pingOkOn.push(id); },
        get: async (id) => ({ id }),
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
    document: { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, createElement() { return {}; }, getElementById() { return {}; }, body: {} },
  };
  sandbox.window = { addEventListener() {}, postMessage() {} };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const f of ["src/agent/tokenizer.js", "src/agent/prompts.js", "src/agent/context.js", "src/background/worker.js"]) {
    vm.runInContext(fs.readFileSync(ROOT + "/" + f, "utf8"), ctx, { filename: f });
  }
  return { ctx, state: { reloadCalled, get createdTabs() { return createdTabs; }, pingCount } };
}

(async () => {
  // 场景1：已有 tab 且 content script 可达 → 直接复用，不开新 tab
  {
    const { ctx, state } = makeWorkerCtx({ pingOkOn: [7], existingTabs: [] });
    const id = await ctx.ensureDsTab(7);
    assert.strictEqual(id, 7);
    assert.strictEqual(state.createdTabs, 0);
    console.log("  ✓ 已有可达 tab 直接复用");
  }
  // 场景2：tab 存在但 script 未注入（刚装完没刷新）→ 自动 reload 后接管
  {
    const { ctx, state } = makeWorkerCtx({ pingOkOn: [], existingTabs: [{ id: 8, url: "https://chat.deepseek.com/" }] });
    const id = await ctx.ensureDsTab();
    assert.strictEqual(id, 8);
    assert.deepStrictEqual(state.reloadCalled, [8]);
    assert.strictEqual(state.createdTabs, 0);
    console.log("  ✓ 不可达 tab 自动 reload 后接管（装完没刷新的场景）");
  }
  // 场景3：一个 deepseek 页面都没开 → 开新 tab
  {
    const { ctx, state } = makeWorkerCtx({ pingOkOn: [901], existingTabs: [] });
    const id = await ctx.ensureDsTab();
    assert.strictEqual(id, 901);
    assert.strictEqual(state.createdTabs, 1);
    console.log("  ✓ 无页面时开新 tab");
  }
  console.log("\nensureDsTab 专项全部通过");
})().catch((e) => { console.error("❌ 失败:", e); process.exit(1); });
