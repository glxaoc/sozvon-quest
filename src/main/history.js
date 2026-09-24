'use strict';
// История созвонов: индекс по папкам SESSIONS_DIR/<дата>_<slug>/session.json.
// Ничего дополнительно не хранит — источником правды остаётся session.json каждой сессии.
const fs = require('fs');
const path = require('path');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

const LEGACY = path.join(require('os').homedir(), 'Documents', 'CallQuest');

function list(dir) {
  const dirs = [dir, LEGACY].filter((d, i, a) => d && fs.existsSync(d) && a.indexOf(d) === i);
  const out = [];
  for (const d of dirs) for (const name of fs.readdirSync(d)) {
    const folder = path.join(d, name);
    const jsonPath = path.join(folder, 'session.json');
    if (!fs.existsSync(jsonPath)) continue;
    const s = readJson(jsonPath);
    if (!s || !Array.isArray(s.theses)) continue;
    const closed = s.theses.filter((t) => t.status === 'closed').length;
    out.push({
      id: s.id, folder, title: s.title, startedAt: s.startedAt, endedAt: s.endedAt,
      durationSec: s.endedAt && s.startedAt ? Math.round((s.endedAt - s.startedAt) / 1000) : null,
      closed, total: s.theses.length,
      score: s.score ? s.score.total : null,
      rank: s.score ? s.score.rank : null,
      title2: s.score ? s.score.title : null,
      callType: s.callType || 'sales',
      isReplay: !!s.replay,
    });
  }
  return out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

function load(folder) {
  const s = readJson(path.join(folder, 'session.json'));
  if (!s) return null;
  return { ...s, paths: { folder, md: path.join(folder, 'summary.md'), json: path.join(folder, 'session.json') } };
}

function best(dir) {
  const all = list(dir).filter((s) => s.score != null && !s.isReplay);
  if (!all.length) return null;
  return all.reduce((a, b) => (b.score > a.score ? b : a));
}

module.exports = { list, load, best };
