'use strict';
// Прогон WAV-файла через VAD-чанкер → AiTunnel STT, как будто это живой канал.
// Использование: node test/test-stt-chunked.js [path.wav] [--provider=aitunnel|yandex]
const fs = require('fs');
const path = require('path');
const config = require('../src/main/config');
const { readWav, toMono16k } = require('../src/main/audio/wav');
const { createStt } = require('../src/main/stt');

const file = process.argv.find((a) => a.endsWith('.wav')) || path.join(__dirname, 'audio', 'dialog.wav');
const provArg = process.argv.find((a) => a.startsWith('--provider='));
const cfg = config.load(null);
const provider = provArg ? provArg.split('=')[1] : cfg.STT_PROVIDER;

const wav = readWav(fs.readFileSync(file));
const pcm = toMono16k(wav.pcm, wav.sampleRate, wav.channels);
console.log(`file ${file}: ${wav.sampleRate} Hz, ${wav.channels} ch, ${(pcm.length / 32000).toFixed(1)} s → provider ${provider}`);

const stt = createStt(provider, { channel: 'me', config: cfg, log: (...a) => console.log('  [log]', ...a) });
const t0 = Date.now();
const finals = [];
stt.on('status', (s) => console.log(`  [status ${((Date.now() - t0) / 1000).toFixed(1)}s]`, s.state, s.detail || ''));
stt.on('partial', (p) => { if (p.text && p.text !== '…') console.log(`  [partial ${((Date.now() - t0) / 1000).toFixed(1)}s]`, p.text); });
stt.on('final', (f) => { finals.push(f); console.log(`  [FINAL ${((Date.now() - t0) / 1000).toFixed(1)}s] (${f.t0.toFixed(1)}–${f.t1.toFixed(1)}s) ${f.text}`); });
stt.start();

// Подаём аудио в реальном времени: 100 мс каждые 100 мс
const CH = 3200; // байт = 100 мс
let off = 0;
const iv = setInterval(() => {
  if (off >= pcm.length) {
    clearInterval(iv);
    stt.stop();
    // ждём хвост
    const wait = () => {
      const busy = (stt.inflight || 0) > 0 || (stt.queue && stt.queue.length);
      if (busy && Date.now() - t0 < 60000) return setTimeout(wait, 200);
      console.log(`\nfinals: ${finals.length}`);
      finals.forEach((f) => console.log(' -', f.text));
      process.exit(finals.length ? 0 : 1);
    };
    setTimeout(wait, 300);
    return;
  }
  stt.push(pcm.subarray(off, off + CH));
  off += CH;
}, 100);
