'use strict';
// Единая точка вызова языковой модели: облако (AiTunnel, OpenAI-совместимо) или локально (node-llama-cpp).
// complete(config, { system, user, maxTokens, temperature, json, timeoutMs }) → { text, usage }
const local = require('./local');

async function cloud(config, { system, user, maxTokens = 700, temperature = 0, timeoutMs = 25000 }) {
  if (!config.AITUNNEL_API_KEY) throw new Error('нет ключа AiTunnel');
  const body = {
    model: config.LLM_MODEL || 'claude-haiku-4.5',
    temperature, max_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  const r = await fetch(`${config.AITUNNEL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.AITUNNEL_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return { text: j.choices?.[0]?.message?.content || '', usage: j.usage || {} };
}

function isLocal(config) { return config.LLM_PROVIDER === 'local'; }

async function complete(config, opts) {
  return isLocal(config) ? local.complete(config, opts) : cloud(config, opts);
}

module.exports = { complete, isLocal };
