'use strict';
// Энергетический VAD + нарезка на сегменты речи. Вход: PCM16 16kHz mono (Buffer любой длины).
// Выход: события 'segment' { pcm: Buffer, t0, t1 } (t в секундах от старта), 'speech-start', 'speech-end'.
const { EventEmitter } = require('events');

const SR = 16000;
const FRAME_MS = 20;
const FRAME = (SR * FRAME_MS) / 1000; // 320 сэмплов

class VadChunker extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.minRms = opts.minRms ?? 300;          // абсолютный минимум (≈ -40 dBFS)
    this.ratio = opts.ratio ?? 2.5;            // во сколько раз громче шумового пола
    this.hangMs = opts.hangMs ?? 600;          // пауза, после которой сегмент закрывается
    this.preRollMs = opts.preRollMs ?? 240;    // сколько тишины перед речью захватываем
    this.minSegMs = opts.minSegMs ?? 500;
    this.maxSegMs = opts.maxSegMs ?? 12000;
    this.noise = 200;                          // адаптивный шумовой пол (RMS)
    this.carry = Buffer.alloc(0);
    this.frames = 0;                           // всего принятых фреймов (для таймстампов)
    this.inSpeech = false;
    this.silentFrames = 0;
    this.seg = [];                             // Buffer'ы текущего сегмента
    this.segStartFrame = 0;
    this.pre = [];                             // кольцо pre-roll
    this.preMax = Math.ceil(this.preRollMs / FRAME_MS);
    this.lastRms = 0;
  }

  push(buf) {
    const data = this.carry.length ? Buffer.concat([this.carry, buf]) : buf;
    const bytesPerFrame = FRAME * 2;
    let off = 0;
    while (off + bytesPerFrame <= data.length) {
      this._frame(data.subarray(off, off + bytesPerFrame));
      off += bytesPerFrame;
    }
    this.carry = Buffer.from(data.subarray(off));
  }

  _frame(f) {
    let sum = 0;
    for (let i = 0; i < f.length; i += 2) { const s = f.readInt16LE(i); sum += s * s; }
    const rms = Math.sqrt(sum / (f.length / 2));
    this.lastRms = rms;
    const speech = rms > Math.max(this.minRms, this.noise * this.ratio);
    if (!speech) this.noise = this.noise * 0.98 + rms * 0.02;   // шумовой пол плывёт только по тишине
    else this.noise = Math.min(this.noise, rms);                  // но никогда не выше речи
    this.frames++;

    if (!this.inSpeech) {
      this.pre.push(Buffer.from(f));
      if (this.pre.length > this.preMax) this.pre.shift();
      if (speech) {
        this.inSpeech = true;
        this.silentFrames = 0;
        this.seg = this.pre.slice();
        this.segStartFrame = this.frames - this.seg.length;
        this.pre = [];
        this.emit('speech-start', { t: this.segStartFrame * FRAME_MS / 1000 });
      }
      return;
    }

    this.seg.push(Buffer.from(f));
    this.silentFrames = speech ? 0 : this.silentFrames + 1;
    const segMs = this.seg.length * FRAME_MS;
    const hang = this.silentFrames * FRAME_MS >= this.hangMs;
    if (hang || segMs >= this.maxSegMs) {
      this._flush(hang ? 'pause' : 'max');
    }
  }

  _flush(reason) {
    const pcm = Buffer.concat(this.seg);
    const t0 = this.segStartFrame * FRAME_MS / 1000;
    const t1 = this.frames * FRAME_MS / 1000;
    const ms = this.seg.length * FRAME_MS;
    this.seg = [];
    this.inSpeech = false;
    this.silentFrames = 0;
    this.emit('speech-end', { t: t1 });
    if (ms - (reason === 'pause' ? this.hangMs : 0) >= this.minSegMs) {
      this.emit('segment', { pcm, t0, t1, reason });
    }
  }

  // Принудительно закрыть текущий сегмент (конец сессии)
  flush() { if (this.inSpeech) this._flush('flush'); }
}

module.exports = { VadChunker, FRAME_MS, SR };
