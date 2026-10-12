/* Artifact 渲染器（content script，与 deepseek.js 同页运行）。
 * 在 DeepSeek 对话页注入一个浮动预览面板，用沙盒 iframe 渲染生成的
 * Three.js 游戏；iframe 内的报错通过 postMessage 回传给扩展，形成
 * "生成 -> 运行 -> 报错 -> 自动修复" 的闭环。
 */
(() => {
  "use strict";

  const PANEL_ID = "dsa-artifact-panel";
  let errorListener = null;
  let errors = [];

  /* 注入到 srcdoc 头部的报错转发垫片 */
  const ERROR_SHIM = `<script>
window.addEventListener('error', function (e) {
  parent.postMessage({ __dsa: 'error', msg: String(e.message), line: e.lineno || 0, src: (e.filename || '').slice(-40) }, '*');
});
window.addEventListener('unhandledrejection', function (e) {
  var r = e.reason;
  parent.postMessage({ __dsa: 'error', msg: 'unhandledrejection: ' + String((r && r.message) || r) }, '*');
});
<\/script>`;

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.cssText = [
      "position:fixed", "right:16px", "bottom:16px", "width:min(560px,44vw)", "height:420px",
      "z-index:2147483647", "background:#0f172a", "border-radius:12px",
      "box-shadow:0 12px 48px rgba(0,0,0,.45)", "display:flex", "flex-direction:column",
      "overflow:hidden", "font-family:system-ui,sans-serif",
    ].join(";");

    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1e293b;color:#e2e8f0;font-size:13px;";
    bar.innerHTML = `<span style="flex:1">🎮 <b>DS Agent</b> · 游戏预览 <span id="dsa-art-status" style="color:#94a3b8"></span></span>`;
    const mkBtn = (label, title) => {
      const b = document.createElement("button");
      b.textContent = label; b.title = title;
      b.style.cssText = "background:#334155;border:none;color:#e2e8f0;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;";
      return b;
    };
    const btnPop = mkBtn("⤢", "在侧边栏大屏预览");
    const btnClose = mkBtn("✕", "关闭预览");
    btnPop.onclick = () => chrome.runtime.sendMessage({ type: "ARTIFACT_POPOUT" }).catch(() => {});
    btnClose.onclick = () => panel.remove();
    bar.append(btnPop, btnClose);

    const frame = document.createElement("iframe");
    frame.id = "dsa-art-frame";
    // 沙盒：只允许脚本，不给 same-origin，游戏代码碰不到页面 DOM，也读不到扩展数据
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.cssText = "flex:1;border:none;background:#fff;width:100%;";

    panel.append(bar, frame);
    document.body.appendChild(panel);
    return panel;
  }

  function setStatus(text, color = "#94a3b8") {
    const el = document.getElementById("dsa-art-status");
    if (el) { el.textContent = text; el.style.color = color; }
  }

  /* 渲染游戏 HTML。返回 Promise<errors[]>：收集 windowMs 内的运行时报错 */
  function render(html, { windowMs = 4000 } = {}) {
    return new Promise((resolve) => {
      errors = [];
      const panel = ensurePanel();
      const frame = panel.querySelector("iframe");
      setStatus("运行中…");

      if (errorListener) window.removeEventListener("message", errorListener);
      errorListener = (ev) => {
        const d = ev.data;
        if (d && d.__dsa === "error") {
          errors.push(`[${d.line ? "行 " + d.line : "未知行"}] ${d.msg}${d.src ? " (" + d.src + ")" : ""}`);
          setStatus(`⚠ ${errors.length} 个报错`, "#fbbf24");
        }
      };
      window.addEventListener("message", errorListener);

      // 错误垫片插到 <head> 后（若无 head 则放最前）
      let doc = html;
      if (/<head[^>]*>/i.test(doc)) doc = doc.replace(/<head[^>]*>/i, (m) => m + ERROR_SHIM);
      else doc = ERROR_SHIM + doc;

      frame.srcdoc = doc;
      setTimeout(() => {
        if (!errors.length) setStatus("✓ 运行正常", "#34d399");
        resolve(errors);
      }, windowMs);
    });
  }

  function close() {
    document.getElementById(PANEL_ID)?.remove();
    if (errorListener) window.removeEventListener("message", errorListener);
  }

  /* 对外接口 */
  window.DSA_ARTIFACT = { render, close, getErrors: () => errors };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === "ARTIFACT_RENDER") {
          const errs = await render(msg.html, msg.opts);
          sendResponse({ ok: true, errors: errs });
        } else if (msg.type === "ARTIFACT_CLOSE") {
          close();
          sendResponse({ ok: true });
        } else {
          // 不是发给 artifact 的消息（如 DS_*）：沉默，让 deepseek.js 响应，避免竞态。
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  });
})();
