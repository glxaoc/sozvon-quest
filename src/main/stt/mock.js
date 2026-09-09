'use strict';
// Mock-STT: ничего не слушает, реплики приходят из UI (поле «сказать за канал») — для отладки LLM-сверки и анимаций.
const { SttProvider } = require('./base');

class MockStt extends SttProvider {
  start() {
    super.start();
    this.t0 = Date.now();
    this.status('listening', 'mock');
  }
  push() {}
  // вызывается из main по IPC session:mock-say
  say(text) {
    const t = (Date.now() - this.t0) / 1000;
    this.emit('partial', { channel: this.channel, text, t });
    setTimeout(() => this.emit('final', { channel: this.channel, text, t0: t, t1: t + 1 }), 150);
  }
}

module.exports = { MockStt };
