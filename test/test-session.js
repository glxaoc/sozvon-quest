'use strict';
// Сквозной тест сессии без Electron: mock-STT → сверка → закрытие → экспорт в test/out/.
const path = require('path');
const config = require('../src/main/config');
const { Session } = require('../src/main/session');

const cfg = config.load(null);
cfg.STT_PROVIDER = 'mock';
cfg.SESSIONS_DIR = path.join(__dirname, 'out');

const s = new Session({
  title: 'Тест сессии', config: cfg, sttProvider: 'mock', log: (...a) => console.log('  [log]', ...a),
  theses: ['Назвать стоимость пилота — 120 000 ₽', 'Спросить, кто принимает решение', 'Предложить пилот на 2 недели', 'Договориться о следующем шаге и дате'],
});
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
s.on('transcript', (e) => { if (e.kind === 'final') console.log(`[${ts()}] final ${e.channel}: ${e.text}`); });
s.on('status', (e) => { if (e.channel === 'llm') console.log(`[${ts()}] llm ${e.state} ${e.detail || ''}`); });
s.on('thesis', (e) => console.log(`[${ts()}] thesis ${e.id} ${e.event} ${e.matchedPhrase ? `«${e.matchedPhrase}» ${e.confidence}` : ''}`));
s.on('match', (m) => console.log(`[${ts()}] match applied=${JSON.stringify(m.applied)} ms=${m.ms}`));

(async () => {
  s.start();
  await new Promise((r) => setTimeout(r, 300));
  s.mockSay('them', 'Сколько это стоит?');
  await new Promise((r) => setTimeout(r, 300));
  s.mockSay('me', 'Пилот на две недели стоит сто двадцать тысяч рублей, начать можем со следующего понедельника');
  await new Promise((r) => setTimeout(r, 9000));
  // ручное закрытие/переоткрытие проверяем на t2, который речью не закрывался
  s.toggleThesis('t2');
  const paths = await s.finish();
  console.log('exported', paths);
  const closed = s.theses.filter((t) => t.status === 'closed').map((t) => t.id);
  console.log('closed:', closed.join(','));
  process.exit(closed.includes('t1') && closed.includes('t3') && closed.includes('t2') ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
