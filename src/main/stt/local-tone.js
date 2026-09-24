'use strict';
// Локальное распознавание речи: T-one (Т-Банк, Apache-2.0) через sherpa-onnx, без ключа и без интернета.
// Поток: PCM16 16 кГц → стриминговый распознаватель (partial на каждом куске) + наш энергетический VAD
// решает, где фраза закончилась → final, сброс потока. Замер 24.09.2026 на реальной речи: в 15–20 раз
// быстрее реального времени на одном ядре, расхождение с Nexara ~20% (уровень Whisper large-v3).
const path = require('path');
const fs = require('fs');
const { SttProvider } = require('./base');
const { VadChunker } = require('../audio/vad');

const MODEL_NAME = 'sherpa-onnx-streaming-t-one-russian-2025-09-08';
let shared = null; // один распознаватель на оба канала, у каждого канала свой поток

function modelDir(config) {
  const dirs = [config.MODELS_DIR, path.join(__dirname, '..', '..', '..', 'models')].filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, MODEL_NAME);
    if (fs.existsSync(path.join(p, 'model.onnx')) && fs.existsSync(path.join(p, 'tokens.txt'))) return p;
  }
  return null;
}

function getRecognizer(config) {
  if (shared) return shared;
  const dir = modelDir(config);
  if (!dir) throw new Error('модель распознавания не скачана');
  const sherpa = require('sherpa-onnx-node');
  shared = new sherpa.OnlineRecognizer({
    modelConfig: { toneCtc: { model: path.join(dir, 'model.onnx') }, tokens: path.join(dir, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0 },
  });
  return shared;
}

// «да извините что перебил» → «Да извините что перебил»
function pretty(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

class LocalToneStt extends SttProvider {
  constructor(opts) {
    super(opts);
    this.vad = new VadChunker(opts.vad || {});
    this.lastPartial = '';
    this.endText = null;
  }

  start() {
    super.start();
    try {
      this.rec = getRecognizer(this.config);
    } catch (e) {
      this.status('error', e.message);
      this.running = false;
      return;
    }
    this.stream = this.rec.createStream();
    this.vad.on('speech-start', () => this.status('speech'));
    // конец фразы: забираем текст потока и начинаем новый; final уйдёт, если VAD признал фразу речью
    this.vad.on('speech-end', () => {
      // хвост тишины: модели нужно ~0,6 с, чтобы дописать последнее слово
      this.stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(16000 * 0.6) });
      while (this.rec.isReady(this.stream)) this.rec.decode(this.stream);
      this.endText = this.rec.getResult(this.stream).text;
      this.stream = this.rec.createStream();
      this.lastPartial = '';
      this.status('listening');
    });
    this.vad.on('segment', (seg) => {
      const text = pretty(this.endText);
      this.endText = null;
      if (text && !SttProvider.looksLikeHallucination(text)) this.emit('final', { channel: this.channel, text, t0: seg.t0, t1: seg.t1 });
      else this.emit('partial', { channel: this.channel, text: '', t: seg.t1 });
    });
    this.status('listening', 'на компьютере · T-one');
  }

  push(pcm) {
    if (!this.running || !this.stream) return;
    this.vad.push(pcm);
    // короткий шум: speech-end был, segment — нет
    if (this.endText != null) { this.endText = null; this.emit('partial', { channel: this.channel, text: '', t: 0 }); }
    const f = new Float32Array(pcm.length / 2);
    for (let i = 0; i < f.length; i++) f[i] = pcm.readInt16LE(i * 2) / 32768;
    this.stream.acceptWaveform({ sampleRate: 16000, samples: f });
    while (this.rec.isReady(this.stream)) this.rec.decode(this.stream);
    if (this.vad.inSpeech) {
      const text = this.rec.getResult(this.stream).text;
      if (text && text !== this.lastPartial) {
        this.lastPartial = text;
        this.emit('partial', { channel: this.channel, text: pretty(text), t: 0 });
      }
    }
  }

  stop() {
    this.vad.flush();
    super.stop();
  }
}

module.exports = { LocalToneStt, modelDir, MODEL_NAME };
