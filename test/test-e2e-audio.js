'use strict';
// Сквозной тест без Electron и без микрофона: WAV → канал «me» реальной сессии (STT по конфигу) → LLM-сверка → экспорт.
// node test/test-e2e-audio.js [file.wav]
const fs = require('fs');
const path = require('path');
const config = require('../src/main/config');
const { readWav, toMono16k } = require('../src/main/audio/wav');
const { Session } = require('../src/main/session');

const file = process.argv.find((a) => a.endsWith('.wav')) || path.join(__dirname, 'audio', 'dialog2.wav');
const cfg = config.load(null);
cfg.SESSIONS_DIR = path.join(__dirname, 'out');
const wav = readWav(fs.readFileSync(file));
const pcm = toMono16k(wav.pcm, wav.sampleRate, wav.channels);

const s = new Session({
  title: 'E2E аудио', config: cfg, sttProvider: cfg.STT_PROVIDER, log: (...a) => console.log('  [log]', ...a),
  theses: ['Назвать стоимость пилота — 120 000 ₽', 'Спросить, кто принимает решение', 'Рассказать кейс: возврат 1,9 млн ₽ за 2 месяца', 'Договориться о следующем шаге и дате'],
});
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
s.on('transcript', (e) => { if (e.kind === 'final') console.log(`[${ts()}] final ${e.channel}: ${e.text}`); });
s.on('status', (e) => { if (e.state === 'error') console.log(`[${ts()}] ${e.channel} ERROR ${e.detail}`); });
s.on('thesis', (e) => console.log(`[${ts()}] thesis ${e.id} ${e.event} ${e.matchedPhrase ? `«${e.matchedPhrase}» ${e.confidence}` : ''}`));
s.on('match', (m) => console.log(`[${ts()}] match applied=${JSON.stringify(m.applied)} llm=${m.ms}ms`));

console.log(`stt=${cfg.STT_PROVIDER}/${cfg.STT_PROVIDER === 'nexara' ? cfg.NEXARA_MODEL : cfg.STT_MODEL} llm=${cfg.LLM_MODEL} audio=${(pcm.length / 32000).toFixed(1)}s`);
s.start();
let off = 0;
const CH = 3200;
const iv = setInterval(async () => {
  if (off < pcm.length) { s.pushAudio('me', pcm.subarray(off, off + CH)); off += CH; return; }
  clearInterval(iv);
  await new Promise((r) => setTimeout(r, 1500));
  const paths = await s.finish();
  console.log('exported', paths.md);
  const closed = s.theses.filter((t) => t.status === 'closed').map((t) => t.id);
  console.log('closed:', closed.join(',') || '(none)');
  console.log(fs.readFileSync(paths.md, 'utf8'));
  process.exit(closed.includes('t1') && closed.includes('t2') && closed.includes('t3') ? 0 : 1);
}, 100);
