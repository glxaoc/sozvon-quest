'use strict';
// Прогон моно-записи по спикерам: Nexara diarize → выбор «кто из спикеров я» → реплики подаются в сессию
// с таймингами записи (без повторного STT). Результат диаризации кэшируется рядом с файлом: <file>.diarize.json
const fs = require('fs');
const path = require('path');

async function diarize(filePath, cfg, log = () => {}) {
  const cache = `${filePath}.diarize.json`;
  if (fs.existsSync(cache)) {
    try { const j = JSON.parse(fs.readFileSync(cache, 'utf8')); if (Array.isArray(j.segments)) { log('diarize: cache hit'); return j; } } catch (e) { /* перечитаем */ }
  }
  if (!cfg.NEXARA_API_KEY) throw new Error('нет NEXARA_API_KEY — диаризация идёт через Nexara');
  const bytes = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([bytes]), path.basename(filePath));
  form.append('model', cfg.NEXARA_MODEL || 'nexara-ru');
  form.append('language', 'ru');
  form.append('response_format', 'verbose_json');
  form.append('task', 'diarize');
  const t0 = Date.now();
  const r = await fetch(`${cfg.NEXARA_BASE_URL}/audio/transcriptions`, {
    method: 'POST', headers: { Authorization: `Bearer ${cfg.NEXARA_API_KEY}` }, body: form,
    signal: AbortSignal.timeout(20 * 60 * 1000),
  });
  if (!r.ok) throw new Error(`Nexara HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const segments = (j.segments || []).map((s) => ({
    start: Number(s.start) || 0, end: Number(s.end) || 0, speaker: String(s.speaker || 'speaker_0'), text: String(s.text || '').trim(),
  })).filter((s) => s.text);
  const out = { duration: j.duration, segments, diarizedAt: new Date().toISOString(), ms: Date.now() - t0 };
  fs.writeFileSync(cache, JSON.stringify(out, null, 1), 'utf8');
  log(`diarize: ${segments.length} segments, ${Math.round(j.duration || 0)} s, ${out.ms} ms`);
  return out;
}

// Сводка по спикерам для выбора «кто я»: время речи, число реплик, первые фразы
function speakers(segments) {
  const map = new Map();
  for (const s of segments) {
    if (!map.has(s.speaker)) map.set(s.speaker, { id: s.speaker, seconds: 0, count: 0, samples: [] });
    const sp = map.get(s.speaker);
    sp.seconds += Math.max(0, s.end - s.start);
    sp.count++;
    if (sp.samples.length < 3 && s.text.length > 25) sp.samples.push(s.text.slice(0, 140));
  }
  return [...map.values()].sort((a, b) => b.seconds - a.seconds).map((s) => ({ ...s, seconds: Math.round(s.seconds) }));
}

// Подаёт сегменты в сессию по таймингам записи (ускорение speed). Возвращает stop().
function scheduleTranscript(session, segments, meSpeaker, speed = 1, onDone = () => {}) {
  const sorted = segments.slice().sort((a, b) => a.start - b.start);
  const timers = [];
  const t0 = Date.now();
  let stopped = false;
  const at = (sec, fn) => {
    const delay = Math.max(0, sec * 1000 / speed - (Date.now() - t0));
    timers.push(setTimeout(() => { if (!stopped) fn(); }, delay));
  };
  for (const s of sorted) {
    const channel = s.speaker === meSpeaker ? 'me' : 'them';
    at(s.start, () => session.injectPartial(channel, s.text, s.start));
    at(s.end, () => session.injectFinal(channel, s.text, s.start, s.end));
  }
  const last = sorted.length ? sorted[sorted.length - 1].end : 0;
  at(last + 1.5, () => onDone());
  return () => { stopped = true; timers.forEach(clearTimeout); };
}

module.exports = { diarize, speakers, scheduleTranscript };
