/* 上下文管理器：token 预算 + 自动摘要 + 跨对话记忆。
* 数据持久化在 chrome.storage.local，key 形如 dsa:ctx:<conversationId>。
*/
globalThis.DSA = globalThis.DSA || {};

DSA.CONTEXT_BUDGET = 60000; // 单对话 token 预算（保守值，按需调）

DSA.ContextManager = class {
constructor(conversationId) {
this.id = conversationId || "default";
this.summary = "";
this.turns = []; // [{role:'user'|'assistant', text}]
}

static storageKey(id) {
return "dsa:ctx:" + id;
}

async load() {
const data = await chrome.storage.local.get(DSA.ContextManager.storageKey(this.id));
const saved = data[DSA.ContextManager.storageKey(this.id)];
if (saved) {
this.summary = saved.summary || "";
this.turns = saved.turns || [];
}
return this;
}

async save() {
await chrome.storage.local.set({
[DSA.ContextManager.storageKey(this.id)]: {
summary: this.summary,
turns: this.turns.slice(-50), // 只保留最近 50 轮原文
updatedAt: Date.now(),
},
});
}

addTurn(role, text) {
this.turns.push({ role, text});
}

tokenCount() {
let n = DSA.estimateTokens(this.summary);
for (const t of this.turns) n += DSA.estimateTokens(t.text);
return n;
}

usageRatio() {
return this.tokenCount() / DSA.CONTEXT_BUDGET;
}

needsSummary() {
return this.usageRatio() > 0.8;
}

/* 把最老的一半轮次压缩进 summary。summarizeFn(text) 由 background 注入，
* 内部走一次 DeepSeek 调用。 */
async compressIfNeeded(summarizeFn) {
if (!this.needsSummary() || this.turns.length < 4) return false;
const half = Math.floor(this.turns.length / 2);
const old = this.turns.splice(0, half);
const text = old.map((t) => (t.role === "user"? "用户": "助手") + "：" + t.text).join("\n");
const addendum = await summarizeFn(text);
this.summary = (this.summary? this.summary + "\n": "") + addendum;
await this.save();
return true;
}

/* 组装发给模型的上下文：记忆摘要 + 最近轮次（预算内） */
buildContext(maxTurns = 12) {
const parts = [];
if (this.summary) parts.push("\n" + this.summary);
const recent = this.turns.slice(-maxTurns);
for (const t of recent) {
parts.push((t.role === "user"? "用户": "助手") + "：" + t.text);
}
return parts.join("\n\n");
}
};
