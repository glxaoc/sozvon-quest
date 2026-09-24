'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, session: esession, desktopCapturer, shell, dialog } = require('electron');
const config = require('./config');
const { Session } = require('./session');
const replay = require('./replay');
const history = require('./history');
const callTypes = require('./call-types');
const templates = require('./templates');
const models = require('./models');
const localLlm = require('./llm/local');

// ---- CLI args: --stt=mock|aitunnel|yandex  --screenshot=path  --demo -------
const argv = process.argv.slice(1);
const arg = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : (argv.includes(`--${name}`) ? true : null);
};
const ARGS = { stt: arg('stt'), screenshot: arg('screenshot'), demo: !!arg('demo'), autostart: Number(arg('autostart')) || 0, replay: arg('replay') || null, me: arg('me') || null, speed: Number(arg('speed')) || 0, theses: arg('theses') || null, onboarding: !!arg('onboarding'), compact: !!arg('compact') };
if (ARGS.theses) { try { ARGS.thesesText = fs.readFileSync(ARGS.theses, 'utf8'); } catch (e) { ARGS.thesesText = null; } }

let win = null;
let current = null;
let cfg = null;
let pendingShot = null;
let pendingShot3 = null;
let replayStop = null;
const diarizeCache = new Map(); // path → результат (в памяти на время работы)

const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log('[cq]', line);
  if (win && !win.isDestroyed()) win.webContents.send('log', line);
};

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 680,
    minWidth: 340,
    minHeight: 480,
    alwaysOnTop: true,
    backgroundColor: '#EBE9E4',
    title: 'Созвон Квест',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#EBE9E4', symbolColor: '#101012', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (ARGS.screenshot) {
    // dev: снимок через 1.5 с; в --demo ещё один через 9 с (когда LLM успеет закрыть тезисы), затем выход
    const shot = async (suffix) => {
      const img = await win.webContents.capturePage();
      const base = path.resolve(process.cwd(), ARGS.screenshot);
      const out = suffix ? base.replace(/\.png$/i, `${suffix}.png`) : base;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, img.toPNG());
      log('screenshot saved', out);
    };
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        await shot('');
        if (!ARGS.demo && !ARGS.autostart && !ARGS.replay) return app.quit();
        if (ARGS.autostart || ARGS.replay) return;
        // второй снимок — через 700 мс после первого закрытия тезиса (виден Степаныч), выход через 14 с
        pendingShot = () => setTimeout(async () => {
          await shot('-2');
          setTimeout(() => send('demo', 'finish'), 9000);
          pendingShot3 = () => setTimeout(async () => { await shot('-3'); app.quit(); }, 2800);
        }, 700);
        setTimeout(() => app.quit(), 70000);
      }, 1500);
    });
  }
}

app.whenReady().then(() => {
  cfg = config.load(app.getPath('userData'));
  if (!cfg.MODELS_DIR) cfg.MODELS_DIR = path.join(app.getPath('userData'), 'models');
  if (ARGS.stt) cfg.STT_PROVIDER = ARGS.stt;
  else if (ARGS.demo) cfg.STT_PROVIDER = 'mock';

  // Системный звук: WASAPI loopback через штатный Electron API (Windows).
  esession.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    }).catch((e) => { log('display media handler failed', e.message); callback({}); });
  }, { useSystemPicker: false });

  createWindow();
});

app.on('window-all-closed', () => app.quit());

// ---- IPC -------------------------------------------------------------------
ipcMain.handle('args', () => ARGS);
ipcMain.handle('config:get', () => config.publicView(cfg));
ipcMain.handle('config:set', (_e, patch) => {
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in config.DEFAULTS)) continue;
    if (typeof v === 'string' && v.includes('…')) continue; // маска из UI — не перезаписываем ключ
    clean[k] = v;
  }
  config.save(app.getPath('userData'), clean);
  cfg = config.load(app.getPath('userData'));
  if (!cfg.MODELS_DIR) cfg.MODELS_DIR = path.join(app.getPath('userData'), 'models');
  if (ARGS.stt) cfg.STT_PROVIDER = ARGS.stt;
  return config.publicView(cfg);
});

function newSession({ title, theses, sttProvider, replay: isReplay, callType }) {
  current = new Session({ title, theses, config: cfg, sttProvider, log, replay: !!isReplay, callType });
  current.on('transcript', (ev) => send('transcript', ev));
  current.on('thesis', (ev) => send('thesis', ev));
  current.on('match', (ev) => {
    log('match', { ms: ev.ms, applied: ev.applied, closed: ev.closed });
    send('match', ev);
    if (pendingShot && ev.applied.length) { pendingShot(); pendingShot = null; }
  });
  current.on('transcript', (ev) => { if (ev.kind === 'final') log('final', ev.channel, ev.text); });
  current.on('status', (ev) => send('status', ev));
  current.on('nudge', (ev) => { log('nudge', ev); send('nudge', ev); });
  current.on('finished', (ev) => { send('finished', ev); if (pendingShot3) { pendingShot3(); pendingShot3 = null; } });
  current.start();
  if (cfg.LLM_PROVIDER === 'local') localLlm.warmup(cfg, log);
  const statsTimer = setInterval(() => {
    if (!current || current.finished) return clearInterval(statsTimer);
    log('audio', current.audioStats());
  }, 5000);
  return current.snapshot();
}

ipcMain.handle('session:start', (_e, { title, theses, replay: isReplay, callType }) => {
  if (current && !current.finished) return { error: 'сессия уже идёт' };
  return newSession({ title, theses, sttProvider: cfg.STT_PROVIDER, replay: isReplay, callType });
});

// ---- прогон записи по спикерам --------------------------------------------
ipcMain.handle('replay:diarize', async (_e, p) => {
  const r = await replay.diarize(p, cfg, log);
  diarizeCache.set(p, r);
  return { path: p, duration: r.duration, segments: r.segments.length, speakers: replay.speakers(r.segments) };
});
ipcMain.handle('replay:start', (_e, { path: p, title, theses, meSpeaker, speed }) => {
  if (current && !current.finished) return { error: 'сессия уже идёт' };
  const r = diarizeCache.get(p);
  if (!r) return { error: 'сначала диаризация' };
  const snap = newSession({ title, theses, sttProvider: 'mock', replay: true });
  replayStop = replay.scheduleTranscript(current, r.segments, meSpeaker, speed || 1, () => send('replay-done', {}));
  return snap;
});

ipcMain.on('audio', (_e, channel, buf) => {
  if (current && !current.finished) current.pushAudio(channel, Buffer.from(buf));
});

ipcMain.handle('session:toggle', (_e, id) => (current ? current.toggleThesis(id) : null));
ipcMain.handle('session:mock-say', (_e, { channel, text }) => { if (current) current.mockSay(channel, text); });
ipcMain.handle('session:finish', async () => {
  if (!current) return null;
  if (replayStop) { replayStop(); replayStop = null; }
  const paths = await current.finish();
  return { ...current.snapshot(), paths };
});
ipcMain.handle('session:snapshot', () => (current ? current.snapshot() : null));
ipcMain.handle('history:list', () => history.list(cfg.SESSIONS_DIR));
ipcMain.handle('history:load', (_e, folder) => history.load(folder));
ipcMain.handle('history:best', () => history.best(cfg.SESSIONS_DIR));
ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));
ipcMain.handle('shell:show', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('app:quit', () => app.quit());
ipcMain.handle('shell:url', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

// ---- онбординг: проверка ключей живыми запросами ----------------------------
ipcMain.handle('keys:check', async (_e, { provider, key }) => {
  const k = String(key || '').trim();
  if (!k) return { ok: false, error: 'пустой ключ' };
  try {
    if (provider === 'aitunnel') {
      const r = await fetch(`${cfg.AITUNNEL_BASE_URL}/aitunnel/balance`, { headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const j = await r.json();
      return { ok: true, info: `баланс ${Math.round(Number(j.balance) || 0)} ₽` };
    }
    if (provider === 'nexara') {
      const wav = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'check.wav'));
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'check.wav');
      form.append('model', cfg.NEXARA_MODEL || 'nexara-ru');
      form.append('language', 'ru');
      form.append('response_format', 'json');
      const r = await fetch(`${cfg.NEXARA_BASE_URL}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${k}` }, body: form, signal: AbortSignal.timeout(30000) });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const j = await r.json();
      return { ok: true, info: `распознано: «${(j.text || '').trim().slice(0, 60)}»` };
    }
    return { ok: false, error: 'неизвестный провайдер' };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'нет ответа за отведённое время' : e.message };
  }
});
// Прогон записи созвона: выбрать файл и отдать его байты в renderer (декодирует WebAudio: wav/mp3/m4a/ogg/webm)
ipcMain.handle('replay:load', (_e, p) => {
  const bytes = fs.readFileSync(p);
  return { path: p, name: path.basename(p), bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
});
ipcMain.handle('replay:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Запись созвона', properties: ['openFile'],
    filters: [{ name: 'Аудио', extensions: ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'webm', 'flac', 'mp4'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  const bytes = fs.readFileSync(p);
  return { path: p, name: path.basename(p), bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
});
ipcMain.handle('window:top', (_e, flag) => { if (win) win.setAlwaysOnTop(!!flag, 'floating'); return !!flag; });

// ---- типы созвонов и сохранённые списки ------------------------------------
ipcMain.handle('types:list', () => callTypes.list());

// ---- модели для режима «без ключа» ------------------------------------------
let dlAbort = null;
ipcMain.handle('models:status', () => models.status(cfg.MODELS_DIR));
ipcMain.handle('models:download', async (_e, ids) => {
  if (dlAbort) return { error: 'загрузка уже идёт' };
  dlAbort = new AbortController();
  try {
    for (const id of ids) {
      await models.download(cfg.MODELS_DIR, id, {
        mirror: cfg.MODELS_MIRROR, signal: dlAbort.signal,
        onProgress: (bytes) => send('models-progress', { id, bytes }),
      });
    }
    return { ok: true, status: models.status(cfg.MODELS_DIR) };
  } catch (e) {
    log('models download', e.message);
    return { error: e.message, status: models.status(cfg.MODELS_DIR) };
  } finally {
    dlAbort = null;
  }
});
ipcMain.handle('models:cancel', () => { if (dlAbort) dlAbort.abort(); return true; });
ipcMain.handle('models:check', async () => {
  // короткая проверка локальной сверки: загрузить модель и ответить на тестовый вопрос
  const t0 = Date.now();
  try {
    const { complete } = require('./llm/chat');
    const r = await complete({ ...cfg, LLM_PROVIDER: 'local' }, { system: 'Отвечай только JSON.', user: 'Верни {"ok":true}', maxTokens: 20, schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, log });
    return { ok: /true/.test(r.text), ms: Date.now() - t0 };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('templates:list', () => templates.read(app.getPath('userData')));
ipcMain.handle('templates:save', (_e, t) => templates.save(app.getPath('userData'), t));
ipcMain.handle('templates:remove', (_e, id) => templates.remove(app.getPath('userData'), id));

// ---- компактный режим: узкая полоска поверх созвона ------------------------
let normalBounds = null;
const COMPACT_H = 132;
ipcMain.handle('window:compact', (_e, flag) => {
  if (!win) return false;
  if (flag) {
    if (!normalBounds) normalBounds = win.getBounds();
    win.setMinimumSize(300, COMPACT_H);
    const b = win.getBounds();
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: COMPACT_H });
  } else if (normalBounds) {
    const b = win.getBounds();
    win.setMinimumSize(340, 480);
    win.setBounds({ x: b.x, y: b.y, width: normalBounds.width, height: normalBounds.height });
    normalBounds = null;
  }
  return !!flag;
});
