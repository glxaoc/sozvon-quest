'use strict';
// Конфиг: defaults ← .env (корень проекта) ← <userData>/config.json (правится из UI).
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

const DEFAULTS = {
  AITUNNEL_BASE_URL: 'https://api.aitunnel.ru/v1',
  AITUNNEL_API_KEY: '',
  // сверка по умолчанию: 17/17 на регрессе ×3, 0,6–1,5 с, 0,09 ₽ за запрос (замер 25.09.2026)
  LLM_MODEL: 'gemini-3.5-flash-lite',
  // 'aitunnel' — сверка в облаке по ключу; 'local' — модель на компьютере
  LLM_PROVIDER: 'aitunnel',
  MODELS_DIR: '',
  MODELS_MIRROR: 'https://drobitko.pro/dl/sozvon-quest',
  LOCAL_GPU: 'auto',
  LOCAL_THREADS: '',
  // stt: 'aitunnel' (один ключ, дефолт) | 'nexara' | 'yandex' | 'mock'
  STT_PROVIDER: 'aitunnel',
  STT_MODEL: 'nova-3',
  NEXARA_API_KEY: '',
  NEXARA_BASE_URL: 'https://api.nexara.ru/v1',
  NEXARA_MODEL: 'nexara-ru',
  YANDEX_API_KEY: '',
  YANDEX_FOLDER_ID: '',
  CONFIDENCE_THRESHOLD: 0.8,
  CHECK_INTERVAL_MS: 4000,
  SESSIONS_DIR: path.join(os.homedir(), 'Documents', 'SozvonQuest'),
};

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

function coerce(cfg) {
  cfg.CONFIDENCE_THRESHOLD = Number(cfg.CONFIDENCE_THRESHOLD) || 0.8;
  cfg.CHECK_INTERVAL_MS = Number(cfg.CHECK_INTERVAL_MS) || 4000;
  return cfg;
}

function load(userDataDir) {
  const cfg = { ...DEFAULTS };
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) Object.assign(cfg, parseEnv(fs.readFileSync(envPath, 'utf8')));
  if (userDataDir) {
    const p = path.join(userDataDir, 'config.json');
    if (fs.existsSync(p)) {
      try { Object.assign(cfg, JSON.parse(fs.readFileSync(p, 'utf8'))); } catch (e) { /* битый json — игнорируем */ }
    }
  }
  // переменные окружения перекрывают всё (удобно для тестов: LLM_MODEL=gpt-5.4-nanoaiku-4.5 node test/test-llm.js)
  for (const k of Object.keys(DEFAULTS)) if (process.env[k] !== undefined && process.env[k] !== '') cfg[k] = process.env[k];
  // режим «один ключ»: выбран Nexara, но ключа нет — слушаем через AiTunnel
  if (cfg.STT_PROVIDER === 'nexara' && !cfg.NEXARA_API_KEY && cfg.AITUNNEL_API_KEY) cfg.STT_PROVIDER = 'aitunnel';
  // режим «без ключа»: облачный слух без ключа невозможен — слушаем на компьютере
  if (cfg.LLM_PROVIDER === 'local' && cfg.STT_PROVIDER === 'aitunnel' && !cfg.AITUNNEL_API_KEY) cfg.STT_PROVIDER = 'local';
  return coerce(cfg);
}

// Миграция настроек 0.1 → 0.2: старые умолчания не должны перекрывать новые.
// В 0.1 окно настроек сохраняло все поля, включая модель сверки, поэтому у обновившихся она «застряла».
const CONFIG_VERSION = 2;
function migrate(userDataDir) {
  const p = path.join(userDataDir, 'config.json');
  if (!fs.existsSync(p)) return null;
  let cur; try { cur = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
  if ((cur.CONFIG_VERSION || 1) >= CONFIG_VERSION) return null;
  const changes = [];
  // модели сверки, которые стояли по умолчанию в 0.1
  if (/^claude-(haiku|sonnet)/.test(String(cur.LLM_MODEL || ''))) { delete cur.LLM_MODEL; changes.push('модель сверки → по умолчанию'); }
  if (cur.STT_PROVIDER === 'aitunnel') { cur.STT_PROVIDER = 'local'; changes.push('распознавание → на компьютере'); }
  for (const k of Object.keys(cur)) if (k in DEFAULTS && String(cur[k]) === String(DEFAULTS[k])) delete cur[k];
  cur.CONFIG_VERSION = CONFIG_VERSION;
  fs.writeFileSync(p, JSON.stringify(cur, null, 2), 'utf8');
  return changes;
}

function save(userDataDir, patch) {
  const p = path.join(userDataDir, 'config.json');
  let cur = {};
  if (fs.existsSync(p)) { try { cur = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { cur = {}; } }
  const next = { ...cur, ...patch, CONFIG_VERSION };
  // значения, совпадающие с умолчаниями, не храним — чтобы новые версии могли менять умолчания
  for (const k of Object.keys(patch)) if (k in DEFAULTS && String(next[k]) === String(DEFAULTS[k])) delete next[k];
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// Что можно показывать в UI (ключи маскируем)
function publicView(cfg) {
  const mask = (s) => (s ? s.slice(0, 6) + '…' + s.slice(-4) : '');
  return {
    ...cfg,
    AITUNNEL_API_KEY: mask(cfg.AITUNNEL_API_KEY),
    YANDEX_API_KEY: mask(cfg.YANDEX_API_KEY),
    NEXARA_API_KEY: mask(cfg.NEXARA_API_KEY),
    hasNexaraKey: !!cfg.NEXARA_API_KEY,
    hasAitunnelKey: !!cfg.AITUNNEL_API_KEY,
    hasYandexKey: !!cfg.YANDEX_API_KEY,
  };
}

module.exports = { load, save, migrate, publicView, DEFAULTS, ROOT };
