'use strict';
// Локальная языковая модель через node-llama-cpp (llama.cpp): Vulkan, если есть видеокарта, иначе процессор.
// Модель и контекст держим в памяти между вызовами; системная часть промпта одинаковая, поэтому
// её токены переиспользуются из кэша, и каждая сверка считает только новый хвост.
const path = require('path');
const fs = require('fs');

const MODEL_FILE = 'Qwen3.5-4B-Q4_K_M.gguf';

let state = null;      // { llama, model, context, sequence, gpu }
let loading = null;
let queue = Promise.resolve(); // одна генерация за раз

function modelPath(config) {
  const dirs = [config.MODELS_DIR, path.join(__dirname, '..', '..', '..', 'models')].filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, MODEL_FILE);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function load(config, log = () => {}) {
  if (state) return state;
  if (loading) return loading;
  loading = (async () => {
    const file = modelPath(config);
    if (!file) throw new Error('локальная модель не скачана');
    const { getLlama } = await import('node-llama-cpp');
    const t0 = Date.now();
    let llama;
    const wantGpu = config.LOCAL_GPU !== 'off';
    try { llama = await getLlama(wantGpu ? { gpu: 'auto' } : { gpu: false }); } catch (e) { llama = await getLlama({ gpu: false }); }
    const model = await llama.loadModel({ modelPath: file });
    const threads = Number(config.LOCAL_THREADS) || undefined;
    const context = await model.createContext({ contextSize: 8192, sequences: 1, threads });
    state = { llama, model, context, sequence: context.getSequence(), gpu: llama.gpu || 'cpu' };
    log(`local llm: ${path.basename(file)} на ${state.gpu}, загрузка ${Date.now() - t0} ms`);
    return state;
  })();
  try { return await loading; } finally { loading = null; }
}

async function complete(config, { system, user, maxTokens = 700, temperature = 0, schema = null, log = () => {} }) {
  const run = async () => {
    const s = await load(config, log);
    const { LlamaChatSession } = await import('node-llama-cpp');
    const session = new LlamaChatSession({ contextSequence: s.sequence, systemPrompt: system, autoDisposeSequence: false });
    const opts = { maxTokens, temperature, budgets: { thoughtTokens: 0 } };
    // строгая схема ответа: модель физически не может выдать ничего, кроме нужного JSON
    // Схема через грамматику ломается о режим размышлений Qwen3.5: первая «{» уходит в скрытый блок.
    // Без неё и с thoughtTokens:0 модель отдаёт корректный JSON в ```json-блоке, extractJson его разбирает.
    if (schema && config.LOCAL_GRAMMAR === 'on') { s.grammars = s.grammars || new Map(); if (!s.grammars.has(schema)) s.grammars.set(schema, await s.llama.createGrammarForJsonSchema(schema)); opts.grammar = s.grammars.get(schema); }
    const t0 = Date.now();
    try {
      const text = await session.prompt(user, opts);
      return { text, usage: { local_ms: Date.now() - t0 } };
    } finally {
      session.dispose({ disposeSequence: false });
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

// Прогрев на старте созвона, чтобы первая сверка не ждала загрузку модели
function warmup(config, log) { return load(config, log).then(() => true, (e) => { log(`local llm warmup: ${e.message}`); return false; }); }

module.exports = { complete, warmup, modelPath, MODEL_FILE };
