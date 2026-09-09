'use strict';
// «Почти-стриминг» через OpenAI-совместимый батч-эндпоинт (AiTunnel или Nexara): VAD режет речь
// на фразы по паузам, каждая фраза уходит в POST /v1/audio/transcriptions.
// Провайдер выбирается через opts.backend: { baseUrl, apiKey, model, name }.
// Задержка = пауза (600 мс) + время ответа API (обычно 1–2 с). Не 300 мс, но для сверки тезисов хватает.
const { SttProvider } = require('./base');
const { VadChunker } = require('../audio/vad');
const { pcm16ToWav } = require('../audio/wav');

class AitunnelChunkedStt extends SttProvider {
  constructor(opts) {
    super(opts);
    this.backend = opts.backend || {
      name: 'aitunnel', baseUrl: this.config.AITUNNEL_BASE_URL, apiKey: this.config.AITUNNEL_API_KEY,
      model: this.config.STT_MODEL || 'whisper-large-v3-turbo',
    };
    this.vad = new VadChunker(opts.vad || {});
    this.queue = [];
    this.inflight = 0;
    this.maxInflight = 2;
    this.seq = 0;          // порядок сегментов
    this.nextEmit = 0;     // какой seq выдавать следующим (чтобы реплики не путались местами)
    this.done = new Map(); // seq → result
    this.vad.on('speech-start', () => this.status('speech'));
    this.vad.on('speech-end', () => this.status('listening'));
    this.vad.on('segment', (seg) => this._enqueue(seg));
  }

  start() {
    super.start();
    this.status('listening', `${this.backend.name} · ${this.backend.model}`);
  }

  push(pcm) { if (this.running) this.vad.push(pcm); }

  stop() {
    this.vad.flush();
    super.stop();
  }

  _enqueue(seg) {
    const seq = this.seq++;
    this.emit('partial', { channel: this.channel, text: '…', t: seg.t0 });
    this.queue.push({ seq, seg });
    this._pump();
  }

  _pump() {
    while (this.inflight < this.maxInflight && this.queue.length) {
      const job = this.queue.shift();
      this.inflight++;
      this._transcribe(job.seg)
        .then((text) => { this.done.set(job.seq, { text, seg: job.seg }); })
        .catch((err) => { this.log('stt error', err.message); this.status('error', err.message); this.done.set(job.seq, { text: '', seg: job.seg }); })
        .finally(() => { this.inflight--; this._drain(); this._pump(); });
    }
  }

  _drain() {
    while (this.done.has(this.nextEmit)) {
      const { text, seg } = this.done.get(this.nextEmit);
      this.done.delete(this.nextEmit);
      this.nextEmit++;
      if (text && !SttProvider.looksLikeHallucination(text)) {
        this.emit('final', { channel: this.channel, text, t0: seg.t0, t1: seg.t1 });
      } else {
        this.emit('partial', { channel: this.channel, text: '', t: seg.t1 });
      }
    }
  }

  async _transcribe(seg) {
    const wav = pcm16ToWav(seg.pcm, 16000);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');
    form.append('model', this.backend.model);
    form.append('language', 'ru');
    form.append('response_format', 'json');
    if (this.backend.name !== 'nexara') form.append('temperature', '0'); // Nexara принимает только 0.1–1, дефолт у неё и так минимальный
    // Подсказка снижает галлюцинации Whisper. У Nexara поле prompt включает LLM-постобработку (ответ в 6–9 раз медленнее
    // и другой формат), поэтому ей не шлём.
    if (this.backend.name !== 'nexara') form.append('prompt', 'Деловой разговор по видеосвязи на русском языке.');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch(`${this.backend.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.backend.apiKey}` },
        body: form,
        signal: ctl.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      return (j.text || (j.transcription && j.transcription.text) || '').trim();
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { AitunnelChunkedStt };
