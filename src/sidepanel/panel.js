/* DS Agent 侧边栏：纯舞台。输入只发生在 DeepSeek 输入框 / 地址栏，
 * 这里只负责把生成的程序跑起来。配置全部在扩展选项页。 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let lastGameHtml = "";
  let lastIdea = "";

  const show = (el, on) => { el.hidden = !on; };
  const setStatus = (t) => { $("status").textContent = t; };

  function showEmpty() {
    show($("empty"), true); show($("loading"), false);
    show($("gameFrame"), false); show($("toolbar"), false); show($("errbar"), false);
    setStatus("就绪");
  }
  function showLoading(idea) {
    show($("empty"), false); show($("loading"), true);
    show($("gameFrame"), false); show($("toolbar"), false); show($("errbar"), false);
    $("loadingText").textContent = "正在生成「" + (idea || "").slice(0, 20) + "」…";
    setStatus("生成中…");
  }
  function showGame(html, label) {
    lastGameHtml = html;
    show($("empty"), false); show($("loading"), false);
    show($("errbar"), false);
    const f = $("gameFrame");
    f.srcdoc = html;
    show(f, true); show($("toolbar"), true);
    setStatus(label || "运行中");
  }

  async function refreshHistory() {
    const d = await chrome.storage.local.get("dsa:games");
    const games = d["dsa:games"] || [];
    const sel = $("history");
    sel.innerHTML = "";
    if (!games.length) { sel.hidden = true; return; }
    sel.hidden = false;
    games.forEach((g, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      const time = new Date(g.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      o.textContent = `v${games.length - i} · ${(g.idea || "").slice(0, 12)} · ${time}`;
      sel.appendChild(o);
    });
    sel.onchange = () => {
      const g = games[Number(sel.value)];
      if (g) { lastIdea = g.idea; showGame(g.html, "历史版本"); }
    };
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "AGENT_LOG") {
      const t = String(msg.text || "").replace(/^[✓✕⚠🎮⇄🌐①②③ ]+/, "").slice(0, 26);
      if (t) setStatus(t);
    } else if (msg.type === "GAME_START") {
      lastIdea = msg.idea || "";
      showLoading(lastIdea);
    } else if (msg.type === "GAME_HTML") {
      lastIdea = lastIdea || "";
      showGame(msg.html, "运行中 · 第 " + msg.round + " 轮");
      refreshHistory();
    } else if (msg.type === "GAME_ERRORS") {
      const n = (msg.errors || []).length;
      if (n) {
        const bar = $("errbar");
        bar.hidden = false;
        bar.textContent = `自动修复中…（${n} 个运行时报错）`;
        setStatus(`修复中（${n} 个报错）`);
      } else {
        $("errbar").hidden = true;
      }
    }
  });

  const call = (msg) =>
    new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r)));

  $("btnRegen").addEventListener("click", async () => {
    const idea = (lastIdea || "一个有创意的街机小游戏") + "（换一种玩法和美术风格）";
    showLoading(idea);
    await call({ type: "AGENT_RUN", mode: "game", payload: { idea } });
  });
  $("btnDl").addEventListener("click", () => {
    if (!lastGameHtml) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lastGameHtml], { type: "text/html;charset=utf-8" }));
    a.download = "dsa-game-" + Date.now() + ".html";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $("btnOpen").addEventListener("click", () => {
    if (!lastGameHtml) return;
    const url = URL.createObjectURL(new Blob([lastGameHtml], { type: "text/html;charset=utf-8" }));
    window.open(url, "_blank");
  });
  $("btnClose").addEventListener("click", () => { lastGameHtml = ""; showEmpty(); });
  $("btnOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

  refreshHistory();
})();
