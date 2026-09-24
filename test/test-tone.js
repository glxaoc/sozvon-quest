'use strict';
// Замер локального распознавания T-one (sherpa-onnx) на реальной речи: скорость и расхождение с Nexara.
// node test/test-tone.js [threads]   — по фрагментам outputs/bench/seg*.wav (вырезаны из реального созвона)
const fs = require('fs');
const path = require('path');
const os = require('os');
const sherpa = require('sherpa-onnx-node');
const { readWav, toMono16k } = require('../src/main/audio/wav');

const threads = Number(process.argv[2]) || 2;
const MODEL = path.join(__dirname, '..', 'models', 'sherpa-onnx-streaming-t-one-russian-2025-09-08');

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
function wer(ref, hyp) {
  const r = norm(ref).split(' ').filter(Boolean), h = norm(hyp).split(' ').filter(Boolean);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return r.length ? d[r.length][h.length] / r.length : 0;
}

const t0 = Date.now();
const recognizer = new sherpa.OnlineRecognizer({
  modelConfig: { toneCtc: { model: path.join(MODEL, 'model.onnx') }, tokens: path.join(MODEL, 'tokens.txt'), numThreads: threads, provider: 'cpu', debug: 0 },
});
console.log(`CPU: ${os.cpus()[0].model} ×${os.cpus().length}, threads=${threads}, загрузка модели ${Date.now() - t0} ms`);

const bench = path.join(__dirname, '..', 'outputs', 'bench');
const meta = JSON.parse(fs.readFileSync(path.join(bench, 'segments.json'), 'utf8'));
const results = fs.existsSync(path.join(bench, 'results.json')) ? JSON.parse(fs.readFileSync(path.join(bench, 'results.json'), 'utf8')) : null;
let refs = null;
// эталон — Nexara nexara-ru (переснятый в bench-stt.js); если нет — текст из диаризации
try { refs = JSON.parse(fs.readFileSync(path.join(bench, 'nexara-refs.json'), 'utf8')); } catch (e) { refs = meta.map((m) => m.ref); }

let audioSec = 0, cpuMs = 0, w = 0;
for (let i = 0; i < meta.length; i++) {
  const wav = readWav(fs.readFileSync(path.join(bench, meta[i].file)));
  const pcm = toMono16k(wav.pcm, wav.sampleRate, wav.channels);
  const f = new Float32Array(pcm.length / 2);
  for (let k = 0; k < f.length; k++) f[k] = pcm.readInt16LE(k * 2) / 32768;
  audioSec += f.length / 16000;
  const stream = recognizer.createStream();
  const s0 = Date.now();
  // подаём кусками по 100 мс, как в живом созвоне
  for (let off = 0; off < f.length; off += 1600) {
    stream.acceptWaveform({ sampleRate: 16000, samples: f.subarray(off, off + 1600) });
    while (recognizer.isReady(stream)) recognizer.decode(stream);
  }
  stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(16000 * 0.6) });
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const ms = Date.now() - s0; cpuMs += ms;
  const text = recognizer.getResult(stream).text;
  const e = wer(refs[i], text); w += e;
  console.log(`${meta[i].file} ${(f.length / 16000).toFixed(1)}s → ${ms} ms, расхождение ${(100 * e).toFixed(0)}% | ${text.slice(0, 90)}`);
}
console.log(`\nИТОГ: ${audioSec.toFixed(0)} с речи за ${(cpuMs / 1000).toFixed(1)} с CPU → в ${(audioSec / (cpuMs / 1000)).toFixed(1)} раз быстрее реального времени; среднее расхождение с эталоном ${(100 * w / meta.length).toFixed(0)}%`);
