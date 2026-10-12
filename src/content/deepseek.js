/* DeepSeek 对话页控制器（content script）。
 * 职责：读对话、发消息、等流式结束、新对话、列对话。
 * 所有选择器集中在 SELECTORS，可按真实 DOM 一次配好；找不到时走启发式兜底。
 */
(() => {
  "use strict";

  /* ===== 选择器配置表（TODO: 按 DOM 侦察结果填写精确值） ===== */
  /* 选择器配置表（2026-10-13 经真实 DOM 侦察校准）。
   * 经验：语义类名（ds-toggle-button、ds-button--*、aria-pressed、placeholder、href 前缀）
   * 比哈希类名（_27c9245 等构建产物）稳定，优先使用前者。 */
  const SELECTORS = {
    composer: [
      'textarea[placeholder="给 DeepSeek 发送消息 "]',
      'textarea[placeholder*="DeepSeek 发送消息"]',
      'textarea[placeholder*="问"]',
      "textarea",
    ],
    sendButton: [
      'div[role="button"].ds-button--primary.ds-button--filled.ds-button--circle',
    ],
    messageList: ["main"],
    // 消息无 role/data-* 角色属性；AI 回复下方带操作工具栏（复制/重试/朗读/点赞），用户消息为纯文本
    message: ['[class*="message-item"]', "[data-message-id]"],
    generating: ['[class*="typing"]', '[class*="loading"]', '[class*="cursor"]'],
    newChat: [
      'div._5a8ac7a[tabindex="0"]', // 内含"开启新对话"
      'div[role="button"].ds-button--capsule._4f3769f', // 顶栏加号图标
    ],
    convoItem: ['a._546d736[href^="/a/chat/s/"]'],
    convoTitle: ["div.c08e6e93"],
    // 开关：div.ds-toggle-button[tabindex="0"]，以内层文字（"深度思考"/"智能搜索"）区分；aria-pressed 表状态
    toggle: ['div.ds-toggle-button[tabindex="0"]'],
    // 上传：回形针图标的 ds-button--capsule（注意与新对话胶囊按钮区分开）
    attachButton: ['div[role="button"].ds-button--capsule'],
    fileInput: ['input[type="file"]'], // 侦察时未能定位到隐藏 input，attachImages 会先点回形针再找
  };

  const pick = (cands, root = document) => {
    for (const s of cands) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  };
  const pickAll = (cands, root = document) => {
    for (const s of cands) {
      const els = root.querySelectorAll(s);
      if (els.length) return [...els];
    }
    return [];
  };

  const findComposer = () => pick(SELECTORS.composer);
  const findSendButton = () => {
    const btn = pick(SELECTORS.sendButton);
    if (btn) return btn;
    // 兜底：输入框附近的 button
    const composer = findComposer();
    const scope = composer ? composer.closest("form") || composer.parentElement : document;
    return scope ? scope.querySelector("button") : null;
  };

  /* 开关按钮状态：优先 aria-pressed，其次看 class 是否含 active/selected */
  function isToggleOn(el) {
    if (!el) return false;
    const pressed = el.getAttribute("aria-pressed");
    if (pressed !== null) return pressed === "true";
    const cls = (el.className || "").toString().toLowerCase();
    return /active|selected|\bon\b/.test(cls);
  }

  /* 按内层文字找开关按钮（"深度思考" / "智能搜索"） */
  function findToggle(label) {
    const btns = [...document.querySelectorAll(SELECTORS.toggle[0])];
    return btns.find((b) => (b.innerText || "").includes(label)) || null;
  }

  /* 把 深度思考 / 联网搜索 设置到目标状态 */
  async function setModes({ deepThink, webSearch } = {}) {
    const jobs = [
      [deepThink, "深度思考"],
      [webSearch, "智能搜索"],
    ];
    for (const [want, label] of jobs) {
      if (want === undefined) continue;
      const btn = findToggle(label);
      if (!btn) continue;
      if (isToggleOn(btn) !== want) {
        btn.click();
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }

  /* 回形针上传按钮：排除新对话胶囊按钮（含 _4f3769f 类或"新对话"文字） */
  function findAttachButton() {
    const cands = [...document.querySelectorAll(SELECTORS.attachButton[0])];
    return cands.find((el) => {
      const cls = (el.className || "").toString();
      return !cls.includes("_4f3769f") && !/新对话/.test(el.innerText || "");
    }) || null;
  }

  /* 通过隐藏的 file input 附加图片（dataUrl 列表） */
  async function attachImages(images = []) {
    if (!images.length) return;
    let fileInput = pick(SELECTORS.fileInput);
    if (!fileInput) {
      const btn = findAttachButton();
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 500));
      fileInput = pick(SELECTORS.fileInput);
    }
    if (!fileInput) throw new Error("找不到图片上传入口");
    const dt = new DataTransfer();
    for (const img of images) {
      const blob = await (await fetch(img.dataUrl)).blob();
      dt.items.add(new File([blob], img.name || "image.png", { type: img.type || blob.type }));
    }
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
  }

  /* React 受控组件设值：必须走原生 setter 并派发 input 事件 */
  function setComposerValue(el, value) {
    if (el.isContentEditable) {
      el.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, value);
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
        || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  /* 解析消息列表 -> [{role, text}]。role 启发式：看 class 是否含 user/human */
  function readMessages() {
    const items = pickAll(SELECTORS.message);
    if (!items.length) {
      // 兜底：按 main 内的块级文本切分
      const main = pick(SELECTORS.messageList) || document.body;
      return [{ role: "unknown", text: main.innerText.slice(0, 20000) }];
    }
    return items.map((el) => {
      const cls = (el.className || "").toString().toLowerCase();
      const role = /user|human|question/.test(cls) ? "user"
        : /assistant|ai|answer|deepseek/.test(cls) ? "assistant" : "unknown";
      return { role, text: el.innerText.trim() };
    }).filter((m) => m.text);
  }

  function isGenerating() {
    if (pick(SELECTORS.generating)) return true;
    // 发送按钮是 div：disabled 态表现为 ds-button--disabled 类
    const btn = findSendButton();
    return !!(btn && (btn.disabled || (btn.classList && btn.classList.contains("ds-button--disabled"))));
  }

  /* 等待流式输出结束：连续 quietMs 无 DOM 变化且 isGenerating() 为 false */
  function waitForIdle({ timeout = 180000, quietMs = 2500 } = {}) {
    return new Promise((resolve) => {
      const target = pick(SELECTORS.messageList) || document.body;
      let lastChange = Date.now();
      const t0 = Date.now();
      const obs = new MutationObserver(() => { lastChange = Date.now(); });
      obs.observe(target, { childList: true, subtree: true, characterData: true });
      const timer = setInterval(() => {
        const quiet = Date.now() - lastChange > quietMs;
        if ((!isGenerating() && quiet) || Date.now() - t0 > timeout) {
          clearInterval(timer);
          obs.disconnect();
          resolve({ timedOut: Date.now() - t0 > timeout });
        }
      }, 500);
    });
  }

  async function sendMessage(text, { images = [], modes } = {}) {
    if (modes) await setModes(modes);
    const composer = findComposer();
    if (!composer) throw new Error("找不到输入框（composer）");
    composer.focus();
    setComposerValue(composer, text);
    await new Promise((r) => setTimeout(r, 400));
    if (images.length) await attachImages(images);
    const btn = findSendButton();
    if (!btn) throw new Error("找不到发送按钮");
    btn.click();
    return waitForResponse();
  }

  function newChat() {
    const btn = pick(SELECTORS.newChat);
    if (btn) { btn.click(); return true; }
    return false;
  }

  function listConversations() {
    const items = document.querySelectorAll(
      [...SELECTORS.convoItem, 'aside a[href*="/chat/"]'].join(",")
    );
    return [...items]
      .map((el) => ({
        title: (
          (el.querySelector(SELECTORS.convoTitle[0]) || {}).innerText ||
          el.innerText ||
          ""
        ).trim().slice(0, 60),
        href: el.getAttribute("href") || "",
      }))
      .filter((c) => c.title);
  }

  function conversationId() {
    const m = location.pathname.match(/\/a\/chat\/s\/([a-zA-Z0-9-_]+)/) ||
      location.pathname.match(/\/chat\/([a-zA-Z0-9-_]+)/);
    return m ? m[1] : "home";
  }

  /* ============================================================
   * Agent 模式：输入框即入口（隐形智能体）
   * 用户在 DeepSeek 输入框照常打字发送；Agent 模式开启时，
   * 发送前按意图自动包裹系统提示词，SSE 流式结果被网络层
   * 拦截器捕获，游戏类任务自动渲染到侧边栏与浮动面板。
   * ============================================================ */
  let agentMode = true; // 默认开：开箱即有"输入框说句话，右边出游戏"的效果
  let lastIntent = null;
  let lastIdea = "";
  let internalSend = false;
  let streamWaiters = [];
  let sseAccum = "";

  const GAME_RE = /(游戏|小游戏|俄罗斯方块|贪吃蛇|打砖块|飞机大战|3d|three\.?js|webgl|能玩|玩的)/i;
  const CODE_RE = /(写|开发|实现|代码|脚本|函数|debug|报错|bug|重构|优化|算法)/i;
  const detectIntent = (t) => (GAME_RE.test(t) ? "game" : CODE_RE.test(t) ? "code" : "chat");

  async function getModes() {
    const d = await chrome.storage.local.get("dsa:settings");
    const s = d["dsa:settings"] || {};
    return { deepThink: s.deepThink !== false, webSearch: !!s.webSearch };
  }

  function lastAssistantTextLocal(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].text;
    }
    return "";
  }

  /* ---------- SSE 流桥接（interceptor.js 在 MAIN world 推送） ---------- */
  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || d.__dsa_sse !== true) return;
    if (d.kind === "start") {
      sseAccum = "";
    } else if (d.kind === "chunk") {
      sseAccum += d.delta || "";
      updateChip("生成中…");
    } else if (d.kind === "done") {
      const text = sseAccum;
      sseAccum = "";
      const ws = streamWaiters;
      streamWaiters = [];
      ws.forEach((w) => w(text));
      onStreamDone(text);
    }
  });

  /* 等待回复：SSE 流优先，DOM 变化做兜底 */
  function waitForResponse({ timeout = 180000 } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      const timer = setTimeout(() => done({ timedOut: true, text: null }), timeout);
      streamWaiters.push((text) => { clearTimeout(timer); done({ timedOut: false, text }); });
      waitForIdle({ timeout, quietMs: 2500 }).then((r) => {
        clearTimeout(timer);
        done({ timedOut: r.timedOut, text: null, via: "dom" });
      });
    });
  }

  function onStreamDone(text) {
    if (agentMode && lastIntent === "game" && text && text.length > 200) {
      chrome.runtime.sendMessage({ type: "PAGE_GAME_DONE", text, idea: lastIdea }).catch(() => {});
      updateChip("已送去渲染");
    } else {
      updateChip("");
    }
    lastIntent = null;
  }

  /* ---------- Agent 悬浮开关 ---------- */
  function updateChip(s) {
    const el = document.getElementById("dsa-chip-status");
    if (el) el.textContent = s ? "· " + s : "";
  }

  function ensureChip() {
    if (document.getElementById("dsa-chip")) return;
    const chip = document.createElement("div");
    chip.id = "dsa-chip";
    chip.style.cssText = [
      "position:fixed", "right:24px", "bottom:460px", "z-index:2147483647",
      "display:flex", "align-items:center", "gap:6px", "background:#111827", "color:#e5e7eb",
      "border:1px solid #374151", "border-radius:999px", "padding:6px 12px",
      "font-size:12px", "font-family:system-ui,sans-serif", "cursor:pointer",
      "box-shadow:0 4px 16px rgba(0,0,0,.35)", "user-select:none",
    ].join(";");
    chip.innerHTML = `<span id="dsa-chip-toggle">🤖 Agent: ${agentMode ? "开" : "关"}</span><span id="dsa-chip-status" style="color:#9ca3af"></span>`;
    chip.title = "点击开关 Agent 模式：开=在输入框发送时自动按意图增强";
    chip.addEventListener("click", async () => {
      agentMode = !agentMode;
      const d = await chrome.storage.local.get("dsa:settings");
      const s = d["dsa:settings"] || {};
      s.agentMode = agentMode;
      await chrome.storage.local.set({ "dsa:settings": s });
      document.getElementById("dsa-chip-toggle").textContent = `🤖 Agent: ${agentMode ? "开" : "关"}`;
    });
    document.body.appendChild(chip);
  }

  /* ---------- 发送拦截 ---------- */
  function composerText(el) {
    if (!el) return "";
    return el.isContentEditable ? el.innerText : el.value;
  }

  function clearComposer(el) {
    if (!el) return;
    if (el.isContentEditable) {
      el.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
    } else {
      setComposerValue(el, "");
    }
  }

  async function userSend(raw) {
    const text = (raw || "").trim();
    if (!text) return;
    lastIntent = detectIntent(text);
    lastIdea = text;
    updateChip(`Agent(${lastIntent})…`);
    const modes = await getModes();
    const wrapped = lastIntent === "game" ? DSA.PROMPTS.GAME_SMITH(text)
      : lastIntent === "code" ? DSA.PROMPTS.CHAT_ENHANCE(text)
      : text;
    const composer = findComposer();
    clearComposer(composer);
    internalSend = true;
    try {
      const res = await sendMessage(wrapped, { modes });
      if (res.timedOut) {
        updateChip("超时，请重试");
      } else if (!res.text && lastIntent === "game") {
        // SSE 没抓到时走 DOM 兜底
        const t = lastAssistantTextLocal(readMessages());
        if (t && /```html/i.test(t)) {
          chrome.runtime.sendMessage({ type: "PAGE_GAME_DONE", text: t, idea: lastIdea }).catch(() => {});
          updateChip("已送去渲染");
        } else {
          updateChip("");
        }
      }
    } finally {
      internalSend = false;
    }
  }

  /* ===== 对外消息接口（background 调用） ===== */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case "DS_PING":
            sendResponse({ ok: true, url: location.href, conversationId: conversationId() });
            break;
          case "DS_READ":
            sendResponse({ ok: true, messages: readMessages(), generating: isGenerating() });
            break;
          case "DS_SEND":
            await sendMessage(msg.text, { images: msg.images, modes: msg.modes });
            sendResponse({ ok: true, messages: readMessages() });
            break;
          case "DS_NEW_CHAT":
            sendResponse({ ok: newChat() });
            break;
          case "DS_CONVOS":
            sendResponse({ ok: true, convos: listConversations() });
            break;
          case "DS_WAIT_IDLE":
            sendResponse({ ok: true, ...(await waitForIdle(msg.opts)) });
            break;
          default:
            // 不是发给本脚本的消息（如 ARTIFACT_*）：必须沉默，不响应。
            // 两个 content script 都响应会形成竞态，sendMessage 取先到的那个，
            // 经常拿到错误的响应（"not artifact msg" 的由来）。
            return;
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true; // 异步响应
  });

  /* ---------- 输入框发送拦截（capture 阶段先于页面自身处理） ---------- */
  document.addEventListener("keydown", (e) => {
    if (!agentMode || internalSend) return;
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    const composer = findComposer();
    if (!composer) return;
    const t = e.target;
    if (t !== composer && !(composer.contains && composer.contains(t))) return;
    e.preventDefault();
    e.stopPropagation();
    userSend(composerText(composer));
  }, true);

  document.addEventListener("click", (e) => {
    if (!agentMode || internalSend) return;
    const btn = findSendButton();
    if (!btn) return;
    if (e.target === btn || btn.contains(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      userSend(composerText(findComposer()));
    }
  }, true);

  // Agent 模式初始状态（默认开，可在选项页改）
  chrome.storage.local.get("dsa:settings").then((d) => {
    agentMode = (d["dsa:settings"] || {}).agentMode !== false;
    ensureChip();
  }).catch(() => ensureChip());

  // 上线打招呼
  chrome.runtime.sendMessage({ type: "CS_READY", url: location.href }).catch(() => {});
})();
