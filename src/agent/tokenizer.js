/* token 估算器（中英混合启发式）。
 *
 * 设计说明：
 * - 接口刻意保持极简：estimateTokens(text) -> number。
 *   将来若引入 Rust/WASM 的 BPE 分词器，只需替换本函数实现，
 *   所有调用方（context.js / worker.js）无需改动。
 * - 策略：CJK 字符按 1 token 计；其余按约 4 字符 1 token 计。
 *   对预算控制而言，宁可高估不可低估。
 */
globalThis.DSA = globalThis.DSA || {};

DSA.estimateTokens = function (text) {
  if (!text) return 0;
  const s = String(text);
  const cjk = (s.match(/[\u2e80-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]/g) || []).length;
  const rest = s.length - cjk;
  return cjk + Math.ceil(rest / 4);
};

/* 未来 WASM 替换位（示例，不启用）：
 *
 * // Rust crate 暴露 wasm_estimate_tokens(ptr, len) -> u32
 * let wasmReady = false, wasmCount = null;
 * DSA.initWasmTokenizer = async function (wasmUrl) {
 *   const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl));
 *   ... // 内存读写封装后：
 *   // DSA.estimateTokens = (text) => wasmCount(text);
 *   // wasmReady = true;
 * };
 */
