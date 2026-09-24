'use strict';
// Модели для режима «без ключа»: скачиваются один раз в <userData>/models, с докачкой после обрыва.
// Источники по порядку: MODELS_MIRROR (если задан, например свой сервер в РФ), затем Hugging Face.
const fs = require('fs');
const path = require('path');

const ITEMS = {
  stt: {
    title: 'Распознавание речи · T-one',
    dir: 'sherpa-onnx-streaming-t-one-russian-2025-09-08',
    files: [
      { name: 'model.onnx', size: 144193702, url: 'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-t-one-russian-2025-09-08/resolve/main/model.onnx' },
      { name: 'tokens.txt', size: 202, url: 'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-t-one-russian-2025-09-08/resolve/main/tokens.txt' },
    ],
  },
  llm: {
    title: 'Сверка тезисов · Qwen3.5 4B',
    dir: '',
    files: [
      { name: 'Qwen3.5-4B-Q4_K_M.gguf', size: 2740937888, url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf' },
    ],
  },
};

function fileSize(p) { try { return fs.statSync(p).size; } catch (e) { return 0; } }

function status(root) {
  const out = {};
  for (const [id, it] of Object.entries(ITEMS)) {
    const total = it.files.reduce((s, f) => s + f.size, 0);
    let have = 0; let ready = true;
    for (const f of it.files) {
      const p = path.join(root, it.dir, f.name);
      const sz = fileSize(p);
      if (sz === f.size) have += sz;
      else { ready = false; have += fileSize(`${p}.part`); }
    }
    out[id] = { id, title: it.title, ready, bytes: have, total };
  }
  return out;
}

function urlsFor(f, mirror) {
  const list = [];
  if (mirror) list.push(`${mirror.replace(/\/$/, '')}/${f.name}`);
  list.push(f.url);
  return list;
}

// Скачивание одного файла с докачкой (Range). onProgress(bytesDone) вызывается не чаще 4 раз в секунду.
async function fetchFile(urls, dest, size, onProgress, signal) {
  const part = `${dest}.part`;
  let lastErr = null;
  for (const url of urls) {
    try {
      let done = fileSize(part);
      if (done > size) { fs.unlinkSync(part); done = 0; }
      const headers = done > 0 ? { Range: `bytes=${done}-` } : {};
      const r = await fetch(url, { headers, signal, redirect: 'follow' });
      if (r.status === 200 && done > 0) { done = 0; fs.writeFileSync(part, ''); } // сервер не умеет Range — сначала
      else if (!(r.status === 200 || r.status === 206)) throw new Error(`HTTP ${r.status}`);
      const out = fs.createWriteStream(part, { flags: done > 0 ? 'a' : 'w' });
      let last = 0;
      try {
        for await (const chunk of r.body) {
          if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
          done += chunk.length;
          const now = Date.now();
          if (now - last > 250) { last = now; onProgress(done); }
        }
      } finally {
        await new Promise((res) => out.end(res));
      }
      if (fileSize(part) !== size) throw new Error(`размер ${fileSize(part)} вместо ${size}`);
      fs.renameSync(part, dest);
      onProgress(size);
      return;
    } catch (e) {
      if (signal && signal.aborted) throw new Error('загрузка остановлена');
      lastErr = e;
    }
  }
  throw lastErr || new Error('не удалось скачать');
}

async function download(root, id, { mirror, onProgress = () => {}, signal } = {}) {
  const it = ITEMS[id];
  if (!it) throw new Error(`нет модели ${id}`);
  const dir = path.join(root, it.dir);
  fs.mkdirSync(dir, { recursive: true });
  let base = 0;
  for (const f of it.files) {
    const dest = path.join(dir, f.name);
    if (fileSize(dest) !== f.size) {
      await fetchFile(urlsFor(f, mirror), dest, f.size, (d) => onProgress(base + d), signal);
    }
    base += f.size;
    onProgress(base);
  }
  return status(root)[id];
}

module.exports = { ITEMS, status, download };
