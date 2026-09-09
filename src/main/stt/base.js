'use strict';
// Общий контракт STT-провайдера.
// new Provider({ channel, config, log }) ; provider.start() ; provider.push(pcm16Buffer) ; provider.stop()
// События:
//   'partial' { channel, text, t }          — черновик текущей реплики (может меняться)
//   'final'   { channel, text, t0, t1 }     — зафиксированная реплика
//   'status'  { channel, state, detail }    — 'connecting' | 'listening' | 'speech' | 'error' | 'stopped'
//   'error'   Error
const { EventEmitter } = require('events');

// Известные галлюцинации Whisper на тишине/шуме (русский сегмент)
const HALLUCINATIONS = [
  /субтитр/i, /продолжение следует/i, /dimatorzok/i, /спасибо за просмотр/i,
  /подписывайтесь/i, /^[\s.,!?…\-—]*$/,
];

class SttProvider extends EventEmitter {
  constructor({ channel, config, log }) {
    super();
    this.channel = channel;
    this.config = config;
    this.log = log || (() => {});
    this.running = false;
  }
  start() { this.running = true; }
  push(_pcm) {}
  stop() { this.running = false; this.emit('status', { channel: this.channel, state: 'stopped' }); }

  status(state, detail) { this.emit('status', { channel: this.channel, state, detail }); }

  static looksLikeHallucination(text) {
    const t = (text || '').trim();
    if (t.length < 2) return true;
    return HALLUCINATIONS.some((re) => re.test(t));
  }
}

module.exports = { SttProvider };
