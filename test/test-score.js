'use strict';
// Пересчёт балла для уже сохранённой сессии: node test/test-score.js <папка сессии> [--no-llm]
// Гоняет разбор (debrief) на реальном транскрипте и печатает балл, ранг, ответы и реплику Степаныча.
const fs = require('fs');
const path = require('path');
const config = require('../src/main/config');
const score = require('../src/main/score');
const { debrief } = require('../src/main/llm/matcher');

const folder = process.argv[2];
if (!folder) { console.error('usage: node test/test-score.js <session folder>'); process.exit(2); }
const snap = JSON.parse(fs.readFileSync(path.join(folder, 'session.json'), 'utf8'));
const cfg = config.load(null);
const durationSec = snap.replay ? Math.max(...snap.transcript.map((e) => e.t1 || 0)) : (snap.endedAt - snap.startedAt) / 1000;

(async () => {
  let d = { theses: [], comment: '', highlight: '' };
  if (!process.argv.includes('--no-llm')) {
    const t0 = Date.now();
    d = await debrief(cfg, { theses: snap.theses, transcript: snap.transcript, log: console.log });
    console.log(`debrief ${Date.now() - t0} ms`);
  }
  const sc = score.compute({ theses: snap.theses, transcript: snap.transcript, durationSec, debrief: d });
  console.log(`\n${sc.total} / 100 — ${sc.rank} «${sc.title}»  parts=${JSON.stringify(sc.parts)} counts=${JSON.stringify(sc.counts)}`);
  console.log('hygiene', JSON.stringify(sc.hygiene));
  console.log('\nСтепаныч:', sc.comment);
  console.log('Лучший момент:', sc.highlight);
  console.log('\nТезисы:');
  for (const g of sc.graded) {
    console.log(` ${g.grade.padEnd(7)} ${g.kind || '?'}${g.answered ? '/' + g.answered : ''} ${g.text}`);
    if (g.answer) console.log(`         → ${g.answer}`);
    if (g.missedHint) console.log(`         ✎ ${g.missedAt || ''} ${g.missedHint}`);
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
