/* Background Service Worker：智能体大脑。
 * 职责：sidepanel <-> content 的消息路由、agent 任务循环、
 * DeepSeek tab 注册表、多对话扇出、chrome.debugger 网页操控。
 */
importScripts("../agent/tokenizer.js", "../agent/prompts.js", "../agent/context.js");

/* MAIN world 拦截器注册：捕获 DeepSeek 聊天 SSE 流（注册是持久化的，重复会抛错，忽略） */
try {
  chrome.scripting.registerContentScripts([{
    id: "dsa-interceptor",
    matches: ["https://chat.deepseek.com/*"],
    js: ["src/content/interceptor.js"],
    world: "MAIN",
    runAt: "document_start",
  }]).catch(() => {});
} catch {}

const DS_MATCH = "https://chat.deepseek.com/";
const dsTabs = new Set(); // 已知的 DeepSeek tab id
const contexts = new Map(); // conversationId -> DSA.ContextManager

/* ---------- 侧边栏行为：点工具栏图标打开 ---------- */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/* ---------- DeepSeek tab 注册 ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CS_READY" && sender.tab) {
    dsTabs.add(sender.tab.id);
    broadcast({ type: "AGENT_LOG", text: `✓ 已接管对话页 tab#${sender.tab.id}` });
  }
  return false;
});
chrome.tabs.onRemoved.addListener((id) => dsTabs.delete(id));
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.status === "complete" && tab.url?.startsWith(DS_MATCH)) dsTabs.add(id);
});

async function ensureDsTab(preferTabId) {
  if (preferTabId && dsTabs.has(preferTabId)) return preferTabId;
  for (const id of dsTabs) {
    try { await chrome.tabs.get(id); return id; } catch { dsTabs.delete(id); }
  }
  const tab = await chrome.tabs.create({ url: DS_MATCH, active: false });
  // 等 content script 上线
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (dsTabs.has(tab.id)) return tab.id;
  }
  throw new Error("DeepSeek 页面未响应（content script 未加载）");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendToTab(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg);
}

async function getContext(conversationId) {
  if (!contexts.has(conversationId)) {
    contexts.set(conversationId, await new DSA.ContextManager(conversationId).load());
  }
  return contexts.get(conversationId);
}

/* 发一句话并等流式结束，返回最新消息列表 */
async function askDeepSeek(tabId, text, conversationId, modes) {
  const ctx = await getContext(conversationId || "default");
  ctx.addTurn("user", text);
  await ctx.compressIfNeeded(async (t) =>
    (await askDeepSeekRaw(tabId, DSA.PROMPTS.SUMMARIZER(t))).assistantText);
  await ctx.save();

  const res = await sendToTab(tabId, { type: "DS_SEND", text, modes });
  if (!res?.ok) throw new Error("发送失败：" + (res?.error || "未知"));
  const assistantText = lastAssistantText(res.messages);
  ctx.addTurn("assistant", assistantText);
  await ctx.save();
  return { messages: res.messages, assistantText };
}

/* 不计入上下文的裸调用（给摘要、operator 脏调用用） */
async function askDeepSeekRaw(tabId, text, modes) {
  const res = await sendToTab(tabId, { type: "DS_SEND", text, modes });
  if (!res?.ok) throw new Error("发送失败：" + (res?.error || "未知"));
  return { messages: res.messages, assistantText: lastAssistantText(res.messages) };
}

function lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i].text;
  }
  return messages.length ? messages[messages.length - 1].text : "";
}

function extractCodeBlock(text, lang = "html") {
  const re = new RegExp("```" + lang + "\\s*\\n([\\s\\S]*?)```", "i");
  const m = text.match(re);
  if (m) return m[1].trim();
  const any = text.match(/```\s*\n([\s\S]*?)```/);
  return any ? any[1].trim() : "";
}

/* ---------- 日志广播到 sidepanel ---------- */
function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}
const log = (text) => broadcast({ type: "AGENT_LOG", text });

/* 游戏版本历史（本地存档，最多 20 版） */
async function saveGameVersion(idea, html) {
  const k = "dsa:games";
  const d = await chrome.storage.local.get(k);
  const arr = d[k] || [];
  arr.unshift({ idea: String(idea).slice(0, 80), html, ts: Date.now() });
  await chrome.storage.local.set({ [k]: arr.slice(0, 20) });
}

function notifyGameDone() {
  try {
    chrome.notifications.create("dsa-game-done", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon48.png"),
      title: "DS Agent",
      message: "游戏已生成，去右侧边栏试玩",
    });
  } catch {}
}

/* 渲染 + 报错自动修复（输入框任务与侧边栏任务共用） */
async function renderGameAndFix(html, tabId, idea, modes) {
  await saveGameVersion(idea, html);
  for (let round = 1; round <= 3; round++) {
    log(`② 第 ${round} 轮渲染…`);
    const res = await sendToTab(tabId, { type: "ARTIFACT_RENDER", html });
    if (!res?.ok) throw new Error("渲染失败：" + (res?.error || "未知"));
    broadcast({ type: "GAME_HTML", html, round });
    broadcast({ type: "GAME_ERRORS", errors: res.errors || [], round });
    if (!res.errors.length) {
      log("③ ✓ 运行无报错，游戏已就绪");
      notifyGameDone();
      return { html, rounds: round };
    }
    log(`③ 发现 ${res.errors.length} 个报错，自动修复中…`);
    log(res.errors.map((e) => "   " + e).join("\n"));
    const fix = await askDeepSeek(tabId, DSA.PROMPTS.GAME_FIX(res.errors.join("\n")), "game", modes);
    html = extractCodeBlock(fix.assistantText, "html") || html;
    await saveGameVersion(idea + `（修复${round}）`, html);
  }
  log("⚠ 3 轮后仍有报错，已保留最后一版供手动调整");
  return { html, rounds: 3 };
}

/* ---------- 游戏工坊：生成 -> 渲染 -> 报错 -> 自动修复 ---------- */
async function runGameFlow(idea, tabId, modes) {
  const tab = await ensureDsTab(tabId);
  log(`🎮 游戏创意：${idea}`);
  log("① 正在让 DeepSeek 编写游戏…");
  const { assistantText } = await askDeepSeek(tab, DSA.PROMPTS.GAME_SMITH(idea), "game", modes);
  const html = extractCodeBlock(assistantText, "html");
  if (!html) throw new Error("没从回复里提取到 ```html 代码块");
  return renderGameAndFix(html, tab, idea, modes);
}

/* ---------- 多对话扇出 ---------- */
async function runFanOut(subtasks, modes) {
  const results = [];
  for (const [i, st] of subtasks.entries()) {
    const tab = await chrome.tabs.create({ url: DS_MATCH, active: false });
    log(`⇄ 子任务 ${i + 1}/${subtasks.length} 已开新对话 tab#${tab.id}`);
    try {
      await ensureDsTab(tab.id);
      const { assistantText } = await askDeepSeekRaw(tab.id, DSA.PROMPTS.FAN_OUT(st), modes);
      results.push({ subtask: st, result: assistantText });
      log(`✓ 子任务 ${i + 1} 完成（${DSA.estimateTokens(assistantText)} tokens）`);
    } catch (e) {
      results.push({ subtask: st, result: "失败：" + e.message });
      log(`✕ 子任务 ${i + 1} 失败：${e.message}`);
    }
  }
  broadcast({ type: "FANOUT_DONE", results });
  return results;
}

/* ---------- 网页操控（chrome.debugger 版 CDP） ---------- */
async function dbgAttach(tabId) {
  await chrome.debugger.attach({ tabId }, "1.3");
  return {
    send: (method, params = {}) =>
      new Promise((res, rej) =>
        chrome.debugger.sendCommand({ tabId }, method, params, (r) =>
          chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r))),
    detach: () => chrome.debugger.detach({ tabId }).catch(() => {}),
  };
}

async function dbgEval(dbg, expr) {
  const r = await dbg.send("Runtime.evaluate", { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error("页面执行异常：" + (r.exceptionDetails.text || ""));
  return r.result?.value;
}

async function runOperator(targetUrl, task, brainTabId, modes) {
  const brain = await ensureDsTab(brainTabId);
  const tab = await chrome.tabs.create({ url: targetUrl, active: true });
  log(`🌐 已打开目标页面，attach debugger…`);
  const dbg = await dbgAttach(tab.id);
  try {
    for (let step = 1; step <= 15; step++) {
      const snapshot = String(await dbgEval(dbg, "document.body.innerText.slice(0,6000)"));
      const { assistantText } = await askDeepSeekRaw(brain, DSA.PROMPTS.OPERATOR(task, snapshot), modes);
      let cmd;
      try { cmd = JSON.parse(assistantText.match(/\{[\s\S]*\}/)[0]); }
      catch { throw new Error("模型未返回合法 JSON: " + assistantText.slice(0, 200)); }
      log(`步骤 ${step}: ${cmd.action}${cmd.selector ? " " + cmd.selector : ""}`);
      if (cmd.action === "done" || cmd.action === "answer") {
        log("✓ 任务完成：" + (cmd.answer || ""));
        return cmd.answer || "";
      } else if (cmd.action === "click") {
        await dbgEval(dbg, `document.querySelector(${JSON.stringify(cmd.selector)})?.click()`);
      } else if (cmd.action === "type") {
        await dbgEval(dbg, `(el=>{if(el){el.focus();document.execCommand('selectAll',false,null);document.execCommand('insertText',false,${JSON.stringify(cmd.text)})}})(document.querySelector(${JSON.stringify(cmd.selector)}))`);
      } else if (cmd.action === "scroll") {
        await dbgEval(dbg, "window.scrollBy(0, window.innerHeight*0.8)");
      }
      await sleep(1500);
    }
    return "达到最大步数，任务未完成";
  } finally {
    await dbg.detach();
  }
}

/* ---------- sidepanel 消息入口 ---------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "AGENT_RUN": {
          const { mode, payload } = msg;
          // 模型开关：深度思考默认开；联网搜索默认只在多对话（调研）场景开
          const modes = {
            deepThink: payload.modes?.deepThink ?? true,
            webSearch: payload.modes?.webSearch ?? mode === "fanout",
          };
          if (mode === "game") {
            const r = await runGameFlow(payload.idea, payload.tabId, modes);
            sendResponse({ ok: true, ...r });
          } else if (mode === "chat") {
            const tab = await ensureDsTab(payload.tabId);
            const r = await askDeepSeek(tab, DSA.PROMPTS.CHAT_ENHANCE(payload.task), payload.conversationId, modes);
            sendResponse({ ok: true, text: r.assistantText });
          } else if (mode === "fanout") {
            const r = await runFanOut(payload.subtasks, modes);
            sendResponse({ ok: true, results: r });
          } else if (mode === "operate") {
            const r = await runOperator(payload.url, payload.task, payload.tabId, modes);
            sendResponse({ ok: true, answer: r });
          } else {
            sendResponse({ ok: false, error: "未知模式" });
          }
          break;
        }
        case "DS_TABS":
          sendResponse({ ok: true, tabs: [...dsTabs] });
          break;
        case "PAGE_GAME_DONE": {
          // 用户在 DeepSeek 输入框直接下的游戏任务（隐形智能体路径）
          const html = extractCodeBlock(msg.text, "html");
          if (!html) {
            log("页面任务完成，但没提取到 ```html 代码块");
            sendResponse({ ok: false, error: "no code block" });
            break;
          }
          const tabId = _sender.tab?.id || (await ensureDsTab());
          const r = await renderGameAndFix(html, tabId, msg.idea || "（输入框任务）",
            { deepThink: true, webSearch: false });
          sendResponse({ ok: true, ...r });
          break;
        }
        case "ARTIFACT_POPOUT":
          broadcast({ type: "AGENT_LOG", text: "（侧边栏大屏预览：见游戏工坊面板）" });
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: "unknown: " + msg.type });
      }
    } catch (e) {
      log("✕ " + e.message);
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true;
});

/* ---------- omnibox：地址栏输入 ds 俄罗斯方块 ---------- */
if (chrome.omnibox) {
  chrome.omnibox.onInputEntered.addListener(async (text) => {
    const idea = text.replace(/^game\s+/i, "").trim() || text;
    try {
      const tab = await ensureDsTab();
      await runGameFlow(idea, tab, { deepThink: true, webSearch: false });
    } catch (e) {
      log("✕ " + e.message);
    }
  });
}

/* ---------- 右键菜单：选中文字发给 DS Agent ---------- */
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({
      id: "dsa-explain",
      title: "用 DS Agent 解释所选内容",
      contexts: ["selection"],
    });
  } catch {}
});
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === "dsa-explain" && info.selectionText) {
    try {
      const tab = await ensureDsTab();
      await askDeepSeekRaw(tab, `解释下面这段内容（简明扼要，分条列出要点）：\n${info.selectionText}`,
        { deepThink: true, webSearch: false });
      log("✓ 已发送到 DeepSeek 对话页");
    } catch (e) {
      log("✕ " + e.message);
    }
  }
});

/* ---------- 快捷键：Ctrl+Shift+D 开关侧边栏 ---------- */
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === "toggle-panel") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
});
