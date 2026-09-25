'use strict';
// Лог в файл, диагностика для «Сообщить о проблеме», проверка обновлений на GitHub.
// В файл НЕ пишется содержимое разговора: реплики, цитаты и подсказки заменяются пометкой.
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'glxaoc/sozvon-quest';
const MAX_LOG = 2 * 1024 * 1024;
const CONTENT_EVENTS = new Set(['final', 'match', 'nudge', 'bleed dropped', 'bleed dropped (late)', 'matcher: unparseable answer']);

let logFile = null;

function initLog(userDataDir) {
  const dir = path.join(userDataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'sozvon.log');
  try { if (fs.statSync(logFile).size > MAX_LOG) fs.renameSync(logFile, `${logFile}.1`); } catch (e) { /* нет файла */ }
  return logFile;
}

function sanitize(args) {
  const head = typeof args[0] === 'string' ? args[0] : '';
  if (CONTENT_EVENTS.has(head)) {
    if (head === 'match' && args[1] && typeof args[1] === 'object') return `match ${args[1].ms || '?'} ms, закрыто ${(args[1].applied || []).length}`;
    return `${head} [текст скрыт]`;
  }
  return args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
    .replace(/(sk-aitunnel-|nx-|sk-)[A-Za-z0-9_-]{6,}/g, '$1***'); // ключи никогда не попадают в лог
}

function writeLog(args) {
  if (!logFile) return;
  const line = `${new Date().toISOString()} ${sanitize(args)}\n`;
  try { fs.appendFileSync(logFile, line, 'utf8'); } catch (e) { /* диск/права — молча */ }
}

function tail(lines = 80) {
  if (!logFile) return '';
  try { return fs.readFileSync(logFile, 'utf8').split('\n').slice(-lines - 1).join('\n'); } catch (e) { return ''; }
}

function diagnostics({ version, cfg, extra = {} }) {
  return [
    `Созвон Квест ${version}`,
    `Windows ${os.release()} ${os.arch()}, ${os.cpus().length} потоков, ${Math.round(os.totalmem() / 1073741824)} ГБ RAM`,
    `Распознавание: ${cfg.STT_PROVIDER === 'local' ? 'на компьютере' : 'облако'}, сверка: ${cfg.LLM_PROVIDER === 'local' ? 'на компьютере' : 'облако'}`,
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
    '',
    'Последние записи лога (без текста разговора):',
    tail(60),
  ].join('\n');
}

function issueUrl(title, body) {
  const b = body.length > 5500 ? `${body.slice(0, 5500)}\n…(обрезано)` : body;
  return `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(b)}`;
}

function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; }
  return false;
}

async function checkUpdate(current) {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { current, error: `HTTP ${r.status}` };
    const j = await r.json();
    const latest = String(j.tag_name || '').replace(/^v/, '');
    return { current, latest, url: j.html_url, available: newer(latest, current) };
  } catch (e) {
    return { current, error: e.message };
  }
}

module.exports = { initLog, writeLog, tail, diagnostics, issueUrl, checkUpdate, newer };
