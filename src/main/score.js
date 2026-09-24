'use strict';
const callTypes = require('./call-types');
// Балл созвона из 100 в духе караоке: покрытие тезисов (65) + собранная информация (25) + тайминг (10).
// Гигиена разговора (доля речи, монологи, паразиты, смены говорящих) считается, но в балл не входит.

const RANKS = [
  { min: 95, rank: 'SS', title: 'Волк созвонов' },
  { min: 90, rank: 'S', title: 'Закрыватель' },
  { min: 80, rank: 'A', title: 'Уверенный' },
  { min: 65, rank: 'B', title: 'Ну такое' },
  { min: 50, rank: 'C', title: 'Тёплый разговор ни о чём' },
  { min: 0, rank: 'D', title: 'Клиент вёл, ты кивал' },
];

const GRADE_VALUE = { perfect: 1, good: 0.8, partial: 0.4, miss: 0 };
const FILLERS = /(^|\s)(э-?э+|а-?а+|м-?м+|хм+|ну|вот|как бы|типа|короче|в общем|значит|соответственно|в целом)(?=[\s,.!?]|$)/gi;

// Оценка тезиса в момент закрытия (или по его текущему состоянию)
function gradeOf(t) {
  if (t.status === 'closed') {
    if (t.closedBy === 'manual') return 'good';
    return (t.confidence ?? 0) >= 0.9 ? 'perfect' : 'good';
  }
  if (t.suspect && (t.suspect.confidence ?? 0) >= 0.7) return 'partial';
  return 'miss';
}

function rankFor(score) {
  return RANKS.find((r) => score >= r.min) || RANKS[RANKS.length - 1];
}

// Гигиена по транскрипту: t0/t1 — время в аудио, wall — время сессии
function hygiene(transcript, durationSec) {
  const me = transcript.filter((e) => e.channel === 'me');
  const them = transcript.filter((e) => e.channel === 'them');
  const dur = (list) => list.reduce((s, e) => s + Math.max(0, (e.t1 || 0) - (e.t0 || 0)), 0);
  const meSec = dur(me), themSec = dur(them);
  const talkRatio = meSec + themSec > 0 ? meSec / (meSec + themSec) : null;

  // самый длинный монолог: соседние «me» с паузой < 2 с склеиваем
  let longest = 0, cur = 0, prevEnd = null;
  for (const e of transcript.slice().sort((a, b) => (a.wall || 0) - (b.wall || 0))) {
    if (e.channel !== 'me') { cur = 0; prevEnd = null; continue; }
    const len = Math.max(0, (e.t1 || 0) - (e.t0 || 0));
    cur = prevEnd != null && (e.t0 || 0) - prevEnd < 2 ? cur + len : len;
    prevEnd = e.t1 || 0;
    longest = Math.max(longest, cur);
  }
  const meText = me.map((e) => e.text).join(' ');
  const fillers = (meText.match(FILLERS) || []).length;
  const meMin = meSec / 60;
  let switches = 0;
  for (let i = 1; i < transcript.length; i++) if (transcript[i].channel !== transcript[i - 1].channel) switches++;
  const totalMin = (durationSec || 0) / 60;
  return {
    talkRatio: talkRatio == null ? null : Math.round(talkRatio * 100),
    longestMonologueSec: Math.round(longest),
    fillersPerMin: meMin > 0.5 ? +(fillers / meMin).toFixed(1) : null,
    switchesPerMin: totalMin > 0.5 ? +(switches / totalMin).toFixed(1) : null,
    meSec: Math.round(meSec), themSec: Math.round(themSec),
  };
}

// theses: [{ critical, status, confidence, closedBy, closedAt, suspect, kind, answered }]
// debrief (необязательно): результат LLM-разбора — kind/answered по каждому тезису
function compute({ theses, transcript, durationSec, debrief, callType }) {
  // длительность не может быть короче последней реплики или последнего закрытия (страховка для прогонов записей)
  durationSec = Math.max(durationSec || 0, ...transcript.map((e) => e.t1 || 0), ...theses.map((t) => t.closedAt || 0));
  const info = (t) => debrief?.theses?.find((d) => d.id === t.id) || {};
  const graded = theses.map((t) => {
    const grade = gradeOf(t);
    const d = info(t);
    return { id: t.id, text: t.text, critical: !!t.critical, grade, value: GRADE_VALUE[grade], weight: t.critical ? 2 : 1,
      kind: d.kind || null, answered: d.answered || null, answer: d.answer || '', missedHint: d.missed_hint || '', missedAt: d.missed_at || null,
      closedAt: t.closedAt };
  });

  const wsum = graded.reduce((s, g) => s + g.weight, 0) || 1;
  const coverage = graded.reduce((s, g) => s + g.value * g.weight, 0) / wsum;

  const asks = graded.filter((g) => g.kind === 'ask');
  let infoScore = null;
  if (asks.length) {
    const v = { full: 1, partial: 0.5, none: 0 };
    infoScore = asks.reduce((s, g) => s + (g.grade === 'miss' ? 0 : (v[g.answered] ?? 0)), 0) / asks.length;
  }

  const closed = graded.filter((g) => g.closedAt != null);
  let timing = 1;
  if (durationSec > 180 && closed.length) {
    timing = closed.filter((g) => g.closedAt <= durationSec * 0.8).length / closed.length;
  }

  // веса: 65/25/10; если тезисов-вопросов нет — блок «информация» уходит в покрытие
  const wCov = infoScore == null ? 90 : 65;
  const wInfo = infoScore == null ? 0 : 25;
  let total = Math.round(wCov * coverage + wInfo * (infoScore || 0) + 10 * timing);
  const criticalMiss = graded.some((g) => g.critical && g.grade === 'miss');
  if (criticalMiss) total = Math.min(total, 89); // как в osu!: промах по критичному — потолок A
  total = Math.max(0, Math.min(100, total));
  const { rank, title } = callTypes.rankFor(total, callType);

  const counts = { perfect: 0, good: 0, partial: 0, miss: 0 };
  graded.forEach((g) => { counts[g.grade]++; });

  return {
    total, rank, title, criticalMiss,
    parts: { coverage: Math.round(coverage * 100), info: infoScore == null ? null : Math.round(infoScore * 100), timing: Math.round(timing * 100) },
    weights: { coverage: wCov, info: wInfo, timing: 10 },
    counts, graded,
    hygiene: { ...hygiene(transcript, durationSec), talkNorm: callTypes.get(callType).talk },
    callType: callTypes.get(callType).id,
    comment: debrief?.comment || '',
    highlight: debrief?.highlight || '',
  };
}

module.exports = { compute, gradeOf, rankFor, hygiene, RANKS, GRADE_VALUE };
