'use strict';
// Сессия созвона: два STT-канала → скользящий транскрипт → LLM-сверка тезисов → экспорт.
const { EventEmitter } = require('events');
const { createStt } = require('./stt');
const { Matcher, debrief } = require('./llm/matcher');
const score = require('./score');
const callTypes = require('./call-types');
const { exportSession } = require('./export');

const DEBOUNCE_MS = 400;       // ждём, не договорит ли пользователь
const WINDOW_S = 30;           // окно моей речи, которое видит модель (разорванные фразы склеиваются)
const THEM_ENTRIES = 3;
const BLEED_WINDOW_S = 8;     // «протекание»: если моя реплика почти дословно повторяет собеседника — это динамики в микрофоне
const BLEED_SIMILARITY = 0.6;
const MIN_WORDS_FOR_CHECK = 3;  // «Ага.», «Да. Ну.» не отправляем на сверку сами по себе — подождём содержательной реплики

function meaningfulWords(text) {
  return String(text).toLowerCase().replace(/[^a-zа-яё0-9\s-]/gi, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !/^(а+|э+|м+|хм+|ага|угу|вот|так|да|ну|итак|ладно|окей|хорошо|значит|соответственно|целом)$/.test(w.replace(/-/g, '')));
}

function tokens(s) {
  return new Set(String(s).toLowerCase().replace(/[^a-zа-яё0-9\s]/gi, ' ').split(/\s+/).filter((w) => w.length > 2));
}
function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

function slug(s) {
  return (s || 'session').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
}

class Session extends EventEmitter {
  constructor({ title, theses, config, sttProvider, log, replay, callType }) {
    super();
    this.callType = callTypes.get(callType).id;
    this.id = new Date().toISOString().replace(/[:.]/g, '-');
    this.title = title || 'Созвон';
    this.config = config;
    this.log = log || (() => {});
    this.sttProviderName = sttProvider || config.STT_PROVIDER;
    // «*» в начале или в конце строки — критичный тезис (вес ×2, промах ставит потолок ранга A)
    this.theses = theses.map((raw, i) => {
      let text = String(raw).trim();
      const critical = /^\*|\*$/.test(text);
      text = text.replace(/^\*\s*|\s*\*$/g, '').trim();
      return { id: `t${i + 1}`, text, critical, status: 'open', grade: 'miss', closedAt: null, matchedPhrase: '', confidence: null, closedBy: null };
    });
    this.score = null;
    this.debrief = null;
    this.streak = 0;
    this.lastCloseAt = 0;
    this.lastNudgeAt = 0;
    this.monoStart = null;   // начало текущего монолога «me»
    this.monoEnd = null;
    this.nudgeTimer = null;
    this.transcript = [];      // {channel,text,t0,t1,wall,checked,finalIndex}
    this.partials = { me: '', them: '' };
    this.matches = [];         // лог сверок
    this.startedAt = null;
    this.endedAt = null;
    this.matcher = new Matcher(config, log);
    this.stt = {};
    this.audioBytes = {};
    this.checkTimer = null;
    this.firstPendingAt = 0;
    this.inflight = false;
    this.finished = false;
    this.exportPaths = null;
    this.replay = !!replay;      // прогон записи: таймстампы по аудио
    this.audioClock = 0;
  }

  // ---- lifecycle -------------------------------------------------------
  start() {
    this.startedAt = Date.now();
    for (const channel of ['me', 'them']) {
      const p = createStt(this.sttProviderName, { channel, config: this.config, log: this.log });
      p.on('partial', (ev) => this._onPartial(ev));
      p.on('final', (ev) => this._onFinal(ev));
      p.on('refine', (ev) => this._onRefine(ev));
      p.on('status', (ev) => this.emit('status', ev));
      p.on('error', (err) => this.emit('status', { channel, state: 'error', detail: err.message }));
      this.stt[channel] = p;
      p.start();
    }
    this.emit('state', this.snapshot());
    this.nudgeTimer = setInterval(() => this._nudgeTick(), 15000);
  }

  pushAudio(channel, pcm) {
    const p = this.stt[channel];
    if (!p) return;
    this.audioBytes[channel] = (this.audioBytes[channel] || 0) + pcm.length;
    p.push(pcm);
  }

  // диагностика: сколько аудио дошло до main и что видит VAD
  audioStats() {
    const out = {};
    for (const ch of ['me', 'them']) {
      const p = this.stt[ch];
      out[ch] = { sec: +((this.audioBytes[ch] || 0) / 32000).toFixed(1), rms: p && p.vad ? Math.round(p.vad.lastRms) : null, noise: p && p.vad ? Math.round(p.vad.noise) : null };
    }
    return out;
  }

  mockSay(channel, text) {
    const p = this.stt[channel];
    if (p && typeof p.say === 'function') p.say(text);
  }

  elapsed() { return this.replay ? this.audioClock : (Date.now() - this.startedAt) / 1000; }

  // Прогон по спикерам: реплики уже распознаны и размечены, STT не нужен
  injectPartial(channel, text, t) { this._onPartial({ channel, text, t }); }
  injectFinal(channel, text, t0, t1) { this._onFinal({ channel, text, t0, t1 }); }

  async finish() {
    if (this.finished) return this.exportPaths;
    this.finished = true;
    clearTimeout(this.checkTimer);
    clearInterval(this.nudgeTimer);
    for (const p of Object.values(this.stt)) { try { p.stop(); } catch (e) { this.log('stt stop', e.message); } }
    // даём чанковому STT дослать хвост (до 8 с)
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const busy = Object.values(this.stt).some((p) => (p.inflight || 0) > 0 || (p.queue && p.queue.length));
      if (!busy) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // дожидаемся сверки, которая уже в полёте, потом финальная сверка хвоста
    const llmDeadline = Date.now() + 30000;
    while (this.inflight && Date.now() < llmDeadline) await new Promise((r) => setTimeout(r, 200));
    try { await this._runCheck(true); } catch (e) { this.log('final check failed', e.message); }
    this.endedAt = Date.now();
    await this.computeScore();
    this.exportPaths = exportSession(this, this.config.SESSIONS_DIR, slug(this.title));
    this.emit('finished', { ...this.snapshot(), paths: this.exportPaths });
    return this.exportPaths;
  }

  // ---- transcript ------------------------------------------------------
  _onPartial(ev) {
    if (this.finished) return;
    this.partials[ev.channel] = ev.text || '';
    this.emit('transcript', { kind: 'partial', channel: ev.channel, text: this.partials[ev.channel], t: ev.t });
  }

  _onFinal(ev) {
    if (this.finished) return;
    if (this.replay) this.audioClock = Math.max(this.audioClock, ev.t1 || 0);
    const entry = {
      channel: ev.channel, text: ev.text.trim(), t0: ev.t0, t1: ev.t1,
      wall: this.replay ? ev.t1 : this.elapsed(), checked: ev.channel !== 'me', finalIndex: ev.finalIndex,
    };
    if (!entry.text) return;
    if (ev.channel === 'me' && this._isBleed(entry)) {
      this.log('bleed dropped', entry.text.slice(0, 60));
      this.emit('transcript', { kind: 'bleed', channel: 'me', text: entry.text, wall: entry.wall });
      return;
    }
    // монолог: подряд идущие «me» с паузами < 3 с
    if (entry.channel === 'me') {
      if (this.monoEnd != null && (entry.t0 || 0) - this.monoEnd < 3) this.monoEnd = entry.t1 || 0;
      else { this.monoStart = entry.t0 || 0; this.monoEnd = entry.t1 || 0; }
    } else { this.monoStart = null; this.monoEnd = null; }
    this.transcript.push(entry);
    this.partials[ev.channel] = '';
    this.emit('transcript', { kind: 'final', ...entry });
    if (ev.channel === 'me') this._scheduleCheck();
    else this._dropBleedBefore(entry);
  }

  // Микрофон без гарнитуры слышит динамики: «моя» реплика совпадает с недавней репликой собеседника
  _isBleed(entry) {
    for (let i = this.transcript.length - 1; i >= 0 && i >= this.transcript.length - 6; i--) {
      const e = this.transcript[i];
      if (e.channel !== 'them' || Math.abs(e.wall - entry.wall) > BLEED_WINDOW_S) continue;
      if (similarity(e.text, entry.text) >= BLEED_SIMILARITY) return true;
    }
    return false;
  }

  // Обратный случай: реплика собеседника пришла позже, чем её же «эхо» из микрофона — выкидываем эхо задним числом
  _dropBleedBefore(themEntry) {
    for (let i = this.transcript.length - 2; i >= 0 && i >= this.transcript.length - 8; i--) {
      const e = this.transcript[i];
      if (e.channel !== 'me' || Math.abs(e.wall - themEntry.wall) > BLEED_WINDOW_S) continue;
      if (similarity(e.text, themEntry.text) >= BLEED_SIMILARITY) {
        this.transcript.splice(i, 1);
        this.log('bleed dropped (late)', e.text.slice(0, 60));
        this.emit('transcript', { kind: 'bleed', channel: 'me', text: e.text, wall: e.wall });
      }
    }
  }

  _onRefine(ev) {
    // Yandex присылает нормализованный текст для уже выданного final — подменяем
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const e = this.transcript[i];
      if (e.channel === ev.channel && e.finalIndex === ev.finalIndex) {
        e.text = ev.text;
        this.emit('transcript', { kind: 'refine', channel: e.channel, text: e.text, t0: e.t0, t1: e.t1, wall: e.wall });
        return;
      }
    }
  }

  // ---- подсказки Степаныча по времени -------------------------------------
  _nudgeTick() {
    if (this.finished) return;
    const now = this.elapsed();
    if (now - this.lastNudgeAt < 180) return;               // не чаще раза в 3 минуты
    const open = this.theses.filter((t) => t.status === 'open');
    const monoLen = this.monoStart != null ? this.monoEnd - this.monoStart : 0;
    if (monoLen >= 75 && now - this.monoEnd < 20) {
      this.lastNudgeAt = now;
      this.emit('nudge', { kind: 'monologue', text: `Ты говоришь уже ${Math.round(monoLen / 60 * 10) / 10 > 1.5 ? Math.round(monoLen / 60) + ' мин' : Math.round(monoLen) + ' с'} подряд. Дай ему сказать.` });
      return;
    }
    const since = now - Math.max(this.lastCloseAt, 0);
    if (open.length && now > 240 && since >= 300) {
      this.lastNudgeAt = now;
      const next = open.find((t) => t.critical) || open[0];
      this.emit('nudge', { kind: 'idle', text: `${Math.round(since / 60)} мин без закрытий. ${next.text}?` });
    }
  }

  // ---- matching --------------------------------------------------------
  _scheduleCheck() {
    const now = Date.now();
    if (!this.firstPendingAt) this.firstPendingAt = now;
    clearTimeout(this.checkTimer);
    const maxWaitLeft = this.firstPendingAt + this.config.CHECK_INTERVAL_MS - now;
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, maxWaitLeft));
    this.checkTimer = setTimeout(() => this._runCheck().catch((e) => {
      this.log('check failed', e.message);
      this.emit('status', { channel: 'llm', state: 'error', detail: e.message });
    }), delay);
  }

  async _runCheck(isFinal = false) {
    if (this.inflight) { if (!isFinal) this._scheduleCheck(); return; }
    const open = this.theses.filter((t) => t.status === 'open');
    const pending = this.transcript.filter((e) => e.channel === 'me' && !e.checked);
    if (!open.length || !pending.length) { this.firstPendingAt = 0; return; }
    if (!isFinal && meaningfulWords(pending.map((e) => e.text).join(' ')).length < MIN_WORDS_FOR_CHECK) {
      this.firstPendingAt = 0; // оставляем непроверенными — уйдут вместе со следующей содержательной репликой
      return;
    }
    this.inflight = true;
    this.firstPendingAt = 0;
    this.emit('status', { channel: 'llm', state: 'checking' });
    const newMe = pending.map((e) => e.text).join(' ');
    const now = this.elapsed();
    const recentMe = this.transcript
      .filter((e) => e.channel === 'me' && (!e.checked || now - e.wall <= WINDOW_S))
      .slice(-8)
      .map((e) => ({ text: e.text, isNew: !e.checked }));
    const recentThem = this.transcript.filter((e) => e.channel === 'them').slice(-THEM_ENTRIES).map((e) => e.text).join(' ');
    pending.forEach((e) => { e.checked = true; });
    try {
      const res = await this.matcher.check({ theses: open, recentMe, newMe, recentThem });
      const record = { at: this.elapsed(), newMe, closed: res.closed, ms: res.ms, applied: [] };
      for (const c of res.closed) {
        const th = this.theses.find((t) => t.id === c.id && t.status === 'open');
        if (!th) continue;
        if (c.confidence >= this.config.CONFIDENCE_THRESHOLD) {
          this._close(th, { by: 'ai', phrase: c.matched_phrase, confidence: c.confidence });
          record.applied.push(c.id);
        } else {
          th.suspect = { phrase: c.matched_phrase, confidence: c.confidence };
          th.grade = score.gradeOf(th);
          this.emit('thesis', { ...th, event: 'suspect' });
        }
      }
      this.matches.push(record);
      this.emit('match', record);
      this.emit('status', { channel: 'llm', state: 'idle', detail: `${res.ms} мс` });
    } catch (e) {
      // вернём в очередь — проверим в следующий раз
      pending.forEach((x) => { x.checked = false; });
      this.emit('status', { channel: 'llm', state: 'error', detail: e.message });
      throw e;
    } finally {
      this.inflight = false;
      if (!isFinal && this.transcript.some((e) => e.channel === 'me' && !e.checked)) this._scheduleCheck();
    }
  }

  _close(th, { by, phrase, confidence }) {
    th.status = 'closed';
    th.closedAt = this.elapsed();
    th.matchedPhrase = phrase || '';
    th.confidence = confidence ?? null;
    th.closedBy = by;
    th.suspect = null;
    th.grade = score.gradeOf(th);
    // серия: закрытия подряд в пределах 25 с
    this.streak = th.closedAt - this.lastCloseAt <= 25 ? this.streak + 1 : 1;
    this.lastCloseAt = th.closedAt;
    this.emit('thesis', { ...th, event: 'closed', streak: this.streak });
  }

  toggleThesis(id) {
    const th = this.theses.find((t) => t.id === id);
    if (!th) return null;
    if (th.status === 'open') this._close(th, { by: 'manual', phrase: '', confidence: null });
    else {
      th.status = 'open'; th.closedAt = null; th.matchedPhrase = ''; th.confidence = null; th.closedBy = null;
      th.grade = score.gradeOf(th);
      this.emit('thesis', { ...th, event: 'reopened' });
    }
    return th;
  }

  // ---- итог: разбор + балл ----------------------------------------------
  async computeScore() {
    const durationSec = this.replay ? this.audioClock : (this.endedAt - this.startedAt) / 1000;
    this.emit('status', { channel: 'llm', state: 'checking', detail: 'разбор созвона' });
    try {
      this.debrief = await debrief(this.config, { theses: this.theses, transcript: this.transcript, context: callTypes.get(this.callType).context, log: this.log });
      if (this.debrief.usage) { this.matcher.usage.calls++; this.matcher.usage.prompt_tokens += this.debrief.usage.prompt_tokens || 0; this.matcher.usage.completion_tokens += this.debrief.usage.completion_tokens || 0; }
    } catch (e) {
      this.log('debrief failed', e.message);
      this.debrief = { theses: [], comment: '', highlight: '' };
    }
    this.score = score.compute({ theses: this.theses, transcript: this.transcript, durationSec, debrief: this.debrief, callType: this.callType });
    this.emit('status', { channel: 'llm', state: 'idle' });
    return this.score;
  }

  // ---- snapshot --------------------------------------------------------
  snapshot() {
    return {
      id: this.id, title: this.title, callType: this.callType, startedAt: this.startedAt, endedAt: this.endedAt,
      theses: this.theses, transcript: this.transcript, matches: this.matches,
      stt: this.sttProviderName, llm: this.config.LLM_PROVIDER === 'local' ? 'на компьютере' : 'облако', usage: this.matcher.usage, replay: this.replay,
      score: this.score, debrief: this.debrief ? { comment: this.debrief.comment, highlight: this.debrief.highlight } : null,
      elapsed: this.elapsed(),
    };
  }
}

module.exports = { Session };
