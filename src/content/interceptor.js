/* DeepSeek 聊天 SSE 流拦截器（MAIN world）。
 * 用途：直接捕获 deepseek.com/api/* 的 text/event-stream 响应，
 * 拿到 token 级完整文本，经 postMessage 桥接给 ISOLATED world 的 content script。
 * 这比 DOM 解析更可靠：DOM 选择器一变就失效，网络层协议稳定得多。
 *
 * 注册方式：background worker 用 chrome.scripting.registerContentScripts
 * 以 world:'MAIN' 注册本文件（manifest 的 content_scripts 只能是 ISOLATED）。
 */
(() => {
  "use strict";
  if (window.__dsa_interceptor) return;
  window.__dsa_interceptor = true;

  const post = (m) => window.postMessage({ __dsa_sse: true, ...m }, "*");
  const isChatStream = (url, ct) =>
    /deepseek\.com\/api\//.test(url) && /text\/event-stream/i.test(ct || "");

  function watchStream(body, id) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try { post({ kind: "start", id }); } catch {}
    const pump = () =>
      reader.read().then(({ done, value }) => {
        if (done) { try { post({ kind: "done", id }); } catch {} return; }
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        let delta = "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const p = t.slice(5).trim();
          if (!p || p === "[DONE]") continue;
          try {
            const j = JSON.parse(p);
            delta += j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content || "";
          } catch { /* 非 JSON 行忽略 */ }
        }
        if (delta) { try { post({ kind: "chunk", id, delta }); } catch {} }
        return pump();
      }).catch(() => { try { post({ kind: "done", id }); } catch {} });
    pump();
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const resp = await origFetch.apply(this, arguments);
    try {
      if (resp.body && isChatStream(url, resp.headers.get("content-type"))) {
        const [a, b] = resp.body.tee();
        watchStream(a, Math.random().toString(36).slice(2));
        return new Response(b, {
          status: resp.status,
          statusText: resp.statusText,
          headers: resp.headers,
        });
      }
    } catch { /* 降级：返回原响应 */ }
    return resp;
  };
})();
