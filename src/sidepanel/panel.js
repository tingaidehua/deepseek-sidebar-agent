/* 侧边栏控制台逻辑：纯 UI 层，所有智能体能力走 background。 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let lastGameHtml = "";
  let running = false;

  /* ---------- tabs ---------- */
  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      $("tab-" + btn.dataset.tab).classList.add("active");
    });
  });

  /* ---------- 日志 ---------- */
  const logEl = $("log");
  function addLog(text) {
    const div = document.createElement("div");
    div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  /* ---------- IDE 子面板 ---------- */
  document.querySelectorAll(".ide-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".ide-tabs button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".ide-pane").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $("ide-" + btn.dataset.ide).classList.add("active");
    });
  });

  function showIde(name) {
    const btn = document.querySelector(`.ide-tabs button[data-ide="${name}"]`);
    if (btn) btn.click();
  }

  function renderConsole(errors, round) {
    const cv = $("consoleView");
    if (!errors.length) {
      cv.innerHTML = `<div class="console-ok">✓ 第 ${round} 轮运行无报错</div>`;
      return;
    }
    cv.innerHTML = errors.map((e) => `<div class="console-err">⚠ ${e}</div>`).join("");
  }

  async function refreshHistory() {
    const d = await chrome.storage.local.get("dsa:games");
    const games = d["dsa:games"] || [];
    const hv = $("historyView");
    if (!games.length) {
      hv.innerHTML = `<div class="console-empty">暂无历史版本</div>`;
      return;
    }
    hv.innerHTML = "";
    games.forEach((g, i) => {
      const b = document.createElement("button");
      b.className = "hist-item";
      const time = new Date(g.ts).toLocaleString();
      b.innerHTML = `<div>${i + 1}. ${g.idea}</div><div class="t">${time}</div>`;
      b.addEventListener("click", () => {
        lastGameHtml = g.html;
        $("gamePreview").srcdoc = g.html;
        $("codeView").textContent = g.html;
        $("gameStatus").textContent = "(历史版本)";
        showIde("preview");
        addLog("已载入历史版本：" + g.idea);
      });
      hv.appendChild(b);
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "AGENT_LOG") addLog(msg.text);
    else if (msg.type === "GAME_HTML") {
      lastGameHtml = msg.html;
      $("gamePreview").srcdoc = msg.html;
      $("codeView").textContent = msg.html;
      $("gameStatus").textContent = `(第 ${msg.round} 轮)`;
      addLog("✓ 预览已更新");
      refreshHistory();
    } else if (msg.type === "GAME_ERRORS") {
      renderConsole(msg.errors || [], msg.round);
      if ((msg.errors || []).length) showIde("console");
    } else if (msg.type === "FANOUT_DONE") {
      const box = $("fanoutResults");
      box.innerHTML = "";
      for (const r of msg.results) {
        const d = document.createElement("div");
        d.className = "fanout-item";
        const h = document.createElement("h4");
        h.textContent = "📌 " + r.subtask.slice(0, 50);
        const p = document.createElement("pre");
        p.textContent = r.result.slice(0, 2000);
        d.append(h, p);
        box.appendChild(d);
      }
    }
  });

  function setRunning(v, btn) {
    running = v;
    document.querySelectorAll("button.primary").forEach((b) => (b.disabled = v));
    if (btn) btn.textContent = v ? "运行中…" : btn.dataset.label;
  }
  document.querySelectorAll("button.primary").forEach((b) => (b.dataset.label = b.textContent));

  const call = (msg) =>
    new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r)));

  const getModes = () => ({
    deepThink: $("modeDeepThink").checked,
    webSearch: $("modeWebSearch").checked,
  });

  /* ---------- 游戏工坊 ---------- */
  async function doGame(idea) {
    if (!idea.trim()) return addLog("请先输入游戏创意");
    setRunning(true, $("runGame"));
    try {
      addLog("🚀 启动游戏工坊…");
      const r = await call({ type: "AGENT_RUN", mode: "game", payload: { idea, modes: getModes() } });
      if (!r?.ok) addLog("✕ " + (r?.error || "失败"));
    } finally {
      setRunning(false, $("runGame"));
    }
  }
  $("runGame").addEventListener("click", () => doGame($("gameIdea").value));
  $("regenGame").addEventListener("click", () => {
    const idea = $("gameIdea").value.trim() || "一个有创意的街机小游戏";
    doGame(idea + "（换一种玩法和美术风格）");
  });
  $("dlGame").addEventListener("click", () => {
    if (!lastGameHtml) return addLog("还没有可下载的游戏");
    const blob = new Blob([lastGameHtml], { type: "text/html;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dsa-game-" + Date.now() + ".html";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  /* ---------- 对话增强 ---------- */
  $("runChat").addEventListener("click", async () => {
    const task = $("chatTask").value;
    if (!task.trim()) return addLog("请先输入任务描述");
    setRunning(true, $("runChat"));
    try {
      const r = await call({ type: "AGENT_RUN", mode: "chat", payload: { task, modes: getModes() } });
      addLog(r?.ok ? "✓ 智能体已回复（见 DeepSeek 对话页）" : "✕ " + (r?.error || "失败"));
    } finally {
      setRunning(false, $("runChat"));
    }
  });

  /* ---------- 多对话扇出 ---------- */
  $("runFanout").addEventListener("click", async () => {
    const subtasks = $("fanoutTasks").value.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!subtasks.length) return addLog("请每行输入一个子任务");
    setRunning(true, $("runFanout"));
    try {
      const r = await call({ type: "AGENT_RUN", mode: "fanout", payload: { subtasks, modes: getModes() } });
      if (!r?.ok) addLog("✕ " + (r?.error || "失败"));
    } finally {
      setRunning(false, $("runFanout"));
    }
  });

  /* ---------- 网页操控 ---------- */
  $("runOperate").addEventListener("click", async () => {
    const url = $("opUrl").value.trim();
    const task = $("opTask").value.trim();
    if (!url || !task) return addLog("网址和任务都要填");
    setRunning(true, $("runOperate"));
    try {
      const r = await call({ type: "AGENT_RUN", mode: "operate", payload: { url, task, modes: getModes() } });
      addLog(r?.ok ? "✓ 操控结束：" + (r.answer || "").slice(0, 300) : "✕ " + (r?.error || "失败"));
    } finally {
      setRunning(false, $("runOperate"));
    }
  });

  $("copyCode").addEventListener("click", async () => {
    if (!lastGameHtml) return addLog("还没有可复制的代码");
    try {
      await navigator.clipboard.writeText(lastGameHtml);
      addLog("✓ 代码已复制到剪贴板");
    } catch { addLog("复制失败，请手动选择复制"); }
  });

  /* 模型开关持久化（输入框发起的任务也读这份配置） */
  document.querySelectorAll(".switch input").forEach((cb) =>
    cb.addEventListener("change", () =>
      chrome.storage.local.set({ "dsa:modes": getModes() }).catch(() => {})));

  /* 初始化：恢复开关 + 加载历史版本 */
  (async () => {
    try {
      const d = await chrome.storage.local.get("dsa:modes");
      const m = d["dsa:modes"];
      if (m) {
        $("modeDeepThink").checked = !!m.deepThink;
        $("modeWebSearch").checked = !!m.webSearch;
      }
    } catch {}
    refreshHistory();
  })();

  addLog("⚡ DS Agent 就绪。在 DeepSeek 对话页打开本侧边栏即可接管。");
  addLog("💡 直接在 DeepSeek 输入框说「帮我开发一个俄罗斯方块」，右边自动出游戏。");
})();
