'use strict';
// Экспорт итога сессии: summary.md + session.json в SESSIONS_DIR/<дата>_<slug>/
const fs = require('fs');
const path = require('path');
const callTypes = require('./call-types');

const stripQ = (s) => String(s ?? '').replace(/^[«"'\s]+|[»"'\s]+$/g, '');

function mmss(sec) {
  if (sec == null || Number.isNaN(sec)) return '--:--';
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function buildMarkdown(s) {
  const snap = s.snapshot();
  const closed = snap.theses.filter((t) => t.status === 'closed');
  const open = snap.theses.filter((t) => t.status !== 'closed');
  const dur = (snap.endedAt || Date.now()) - snap.startedAt;
  const lines = [];
  lines.push(`# ${snap.title} — ${fmtDate(snap.startedAt)}`);
  lines.push('');
  lines.push(`Тип: ${callTypes.get(snap.callType).name}`);
  lines.push('');
  lines.push(`Длительность: ${mmss(dur / 1000)} · Закрыто ${closed.length}/${snap.theses.length} · STT: ${snap.stt} · LLM: ${snap.llm} (${snap.usage.calls} сверок, ${snap.usage.prompt_tokens + snap.usage.completion_tokens} токенов)`);
  lines.push('');
  if (snap.score) {
    const sc = snap.score;
    lines.push(`## ${sc.total} из 100 — ${sc.rank} «${sc.title}»`);
    lines.push('');
    const p = sc.parts;
    lines.push(`Покрытие ${p.coverage}% (вес ${sc.weights.coverage}) · Информация ${p.info == null ? '—' : p.info + '%'} (вес ${sc.weights.info}) · Тайминг ${p.timing}% (вес 10)${sc.criticalMiss ? ' · пропущен критичный тезис → потолок A' : ''}`);
    lines.push(`Perfect ${sc.counts.perfect} · Good ${sc.counts.good} · Partial ${sc.counts.partial} · Miss ${sc.counts.miss}`);
    const h = sc.hygiene;
    lines.push(`Гигиена (справочно): доля моей речи ${h.talkRatio == null ? '—' : h.talkRatio + '%'} · самый длинный монолог ${mmss(h.longestMonologueSec)} · паразитов/мин ${h.fillersPerMin ?? '—'} · смен говорящих/мин ${h.switchesPerMin ?? '—'}`);
    if (sc.comment) { lines.push(''); lines.push(`> Степаныч: ${sc.comment}`); }
    if (sc.highlight) lines.push(`> Лучший момент: ${sc.highlight}`);
    lines.push('');
    const answers = sc.graded.filter((g) => g.kind === 'ask' && g.answer);
    if (answers.length) {
      lines.push('## Что узнал');
      lines.push('');
      answers.forEach((g) => lines.push(`- **${g.text}** — ${g.answer}${g.answered === 'partial' ? ' _(уклончиво)_' : ''}`));
      lines.push('');
    }
    const missed = sc.graded.filter((g) => g.grade === 'miss' || g.grade === 'partial');
    if (missed.length) {
      lines.push('## Что стоило спросить');
      lines.push('');
      missed.forEach((g) => lines.push(`- ${g.text}${g.missedAt ? ` — уместно было в ${g.missedAt}` : ''}${g.missedHint ? `: «${stripQ(g.missedHint)}»` : ''}`));
      lines.push('');
    }
  }
  lines.push('## Тезисы');
  lines.push('');
  for (const t of snap.theses) {
    if (t.status === 'closed') {
      const how = t.closedBy === 'manual' ? 'вручную' : `«${t.matchedPhrase}»${t.confidence != null ? ` · ${Math.round(t.confidence * 100)}%` : ''}`;
      lines.push(`- ✅ [${mmss(t.closedAt)}] ${t.text} — ${how}`);
    } else {
      const sus = t.suspect ? ` — возможно: «${t.suspect.phrase}» (${Math.round(t.suspect.confidence * 100)}%)` : '';
      lines.push(`- ⬜ ${t.text}${sus}`);
    }
  }
  if (open.length) {
    lines.push('');
    lines.push('## Не озвучено');
    lines.push('');
    open.forEach((t) => lines.push(`- ${t.text}`));
  }
  lines.push('');
  lines.push('## Транскрипт');
  lines.push('');
  for (const e of snap.transcript) {
    lines.push(`[${mmss(e.wall)}] ${e.channel === 'me' ? 'Я' : 'Собеседник'}: ${e.text}`);
  }
  lines.push('');
  return lines.join('\n');
}

function exportSession(session, dir, slugName) {
  const d = new Date(session.startedAt);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
  const folder = path.join(dir, `${stamp}_${slugName}`);
  fs.mkdirSync(folder, { recursive: true });
  const md = path.join(folder, 'summary.md');
  const json = path.join(folder, 'session.json');
  fs.writeFileSync(md, buildMarkdown(session), 'utf8');
  fs.writeFileSync(json, JSON.stringify(session.snapshot(), null, 2), 'utf8');
  return { folder, md, json };
}

module.exports = { exportSession, buildMarkdown, mmss };
