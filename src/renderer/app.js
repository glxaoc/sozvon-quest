/* CallQuest renderer: setup → live → result, история, захват аудио, «сок» закрытия тезисов. */
(() => {
  const $ = (id) => document.getElementById(id);
  const S = {
    cfg: null, args: null, session: null, theses: [], transcriptLines: [],
    timerId: null, audio: null, levels: { me: 0, them: 0 }, partials: { me: '', them: '' },
    dogTimer: null, praise: 0, summary: null, best: null,
    types: [], type: 'sales', userTpl: [], compact: false,
  };
  const PRAISE = {
    perfect: ['Чисто!', 'В точку', 'Идеально', 'Вот это да', 'Красиво'],
    good: ['Есть!', 'Закрыл', 'Принято', 'Дальше', 'Так держать'],
    streak2: ['Серия ×2', 'Разогнался', 'Пошло дело'],
    streak3: ['Серия ×3!', 'Не останавливайся', 'Огонь'],
  };
  const GRADE_LABEL = { perfect: 'PERFECT', good: 'GOOD', partial: 'PARTIAL?', miss: '' };
  const mmss = (sec) => { const s = Math.max(0, Math.round(sec)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const stripQ = (s) => String(s ?? '').replace(/^[«"'\s]+|[»"'\s]+$/g, '');

  // ---------- screens ----------
  function show(name) {
    document.querySelectorAll('.screen').forEach((el) => el.classList.toggle('active', el.id === `screen-${name}`));
  }

  // ---------- setup ----------
  function renderSetupChips() {
    const c = S.cfg; const box = $('setup-chips'); box.innerHTML = '';
    const chip = (text, ok) => { const el = document.createElement('span'); el.className = 'chip' + (ok ? '' : ' bad'); el.innerHTML = `<span class="dot ${ok ? 'listening' : 'error'}"></span>${esc(text)}`; box.appendChild(el); };
    const sttName = { nexara: 'Nexara', yandex: 'Yandex SpeechKit', aitunnel: `AiTunnel · ${c.STT_MODEL}`, local: 'на компьютере', mock: 'Mock STT' }[c.STT_PROVIDER] || c.STT_PROVIDER;
    const sttOk = c.STT_PROVIDER === 'mock' || c.STT_PROVIDER === 'local' || ({ nexara: c.hasNexaraKey, yandex: c.hasYandexKey, aitunnel: c.hasAitunnelKey })[c.STT_PROVIDER];
    chip(`Слух: ${sttName}`, sttOk);
    chip(c.LLM_PROVIDER === 'local' ? 'Сверка: на компьютере' : 'Сверка: AiTunnel', c.LLM_PROVIDER === 'local' || c.hasAitunnelKey);
  }

  async function renderBest() {
    S.best = await window.api.historyBest().catch(() => null);
    const pill = $('best-pill');
    if (!S.best) { pill.hidden = true; return; }
    pill.hidden = false;
    pill.innerHTML = `Рекорд <b>${S.best.score}</b>/100 · ${esc(S.best.rank)} «${esc(S.best.title || '')}»`;
    pill.onclick = () => openHistory();
  }

  function parseTheses() {
    return $('in-theses').value.split(/\r?\n/).map((s) => s.replace(/^\s*(?:[-•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
  }

  async function startSession(replay = null) {
    const theses = parseTheses();
    if (!theses.length) { $('in-theses').focus(); return; }
    const title = replay ? `Запись · ${replay.name}` : ($('in-title').value.trim() || 'Созвон');
    try { localStorage.setItem(`cq.theses.${S.type}`, $('in-theses').value); localStorage.setItem('cq.title', title); } catch (e) { /* noop */ }
    $('btn-start').disabled = true;
    const snap = await window.api.startSession({ title, theses, replay: !!replay, callType: S.type });
    $('btn-start').disabled = false;
    if (snap.error) { alert(snap.error); return; }
    enterLive(snap, replay);
    if (replay) startReplay(replay).catch((e) => { showLiveError(`Запись: ${e.message}`); });
    else if (S.cfg.STT_PROVIDER !== 'mock') startCapture().catch((e) => { showLiveError(`Аудио: ${e.message}`); });
  }

  function enterLive(snap, replay) {
    S.session = snap; S.theses = snap.theses; S.transcriptLines = []; S.partials = { me: '', them: '' }; S.praise = 0;
    renderTheses(); renderTranscript(); updateProgress(false);
    $('mock-bar').hidden = !!replay || S.cfg.STT_PROVIDER !== 'mock';
    $('live-err').hidden = true;
    $('streak-stamp').hidden = true;
    show('live');
    $('dog').hidden = false; dogState('idle'); S.lastSpeechAt = Date.now(); dogSleepLoop(); markNext();
    $('btn-compact').hidden = false;
    let wantCompact = false; try { wantCompact = localStorage.getItem('cq.compact') === '1'; } catch (e) { /* noop */ }
    if (wantCompact) setCompact(true);
    startTimer(snap.startedAt);
    $('replay-badge').hidden = !replay;
    $('rec-dot').classList.toggle('replay', !!replay);
    if (replay) $('replay-badge').textContent = `${replay.name} · ${replay.speed}×`;
  }

  function showLiveError(msg) { const el = $('live-err'); el.textContent = msg; el.hidden = false; }

  // ---------- replay (скрытый тестовый режим) ----------
  async function pickAndReplay() {
    const f = await window.api.pickReplay();
    if (f) await replayFile(f);
  }

  async function replayFile(f, meSpeaker = null) {
    const theses = parseTheses();
    if (!theses.length) { $('in-theses').focus(); return; }
    const speed = (S.args && S.args.speed) || Number($('replay-speed').value) || 1;
    const ctx = new AudioContext({ sampleRate: 16000 });
    const buf = await ctx.decodeAudioData(f.bytes.slice(0));
    let stereo = buf.numberOfChannels > 1;
    if (stereo) { const L = buf.getChannelData(0), R = buf.getChannelData(1); let diff = 0; for (let i = 0; i < L.length; i += 997) diff += Math.abs(L[i] - R[i]); stereo = diff / (L.length / 997) >= 1e-4; }
    ctx.close().catch(() => {});
    if (stereo) return startSession({ name: f.name, bytes: f.bytes, speed });
    let d;
    try { d = await window.api.diarizeReplay(f.path); } catch (e) { alert(`Диаризация не удалась: ${e.message}`); return; }
    const me = meSpeaker || await pickSpeaker(d.speakers);
    if (!me) return;
    const snap = await window.api.startTranscriptReplay({ path: f.path, title: `Запись · ${f.name}`, theses, meSpeaker: me, speed });
    if (snap.error) { alert(snap.error); return; }
    enterLive(snap, { name: f.name, speed });
  }

  function pickSpeaker(list) {
    return new Promise((resolve) => {
      const box = $('speakers'); box.innerHTML = '';
      list.forEach((sp, i) => {
        const b = document.createElement('button'); b.className = 'speaker';
        b.innerHTML = `<div class="sp-head"><span>Спикер ${i + 1}</span><span>${mmss(sp.seconds)} · ${sp.count} реплик</span></div>` + sp.samples.map((t) => `<div class="sp-sample">«${esc(t)}»</div>`).join('');
        b.addEventListener('click', () => { $('modal-speaker').hidden = true; resolve(sp.id); });
        box.appendChild(b);
      });
      $('btn-speaker-close').onclick = () => { $('modal-speaker').hidden = true; resolve(null); };
      $('modal-speaker').hidden = false;
    });
  }

  async function startReplay({ bytes, speed }) {
    const ctx = new AudioContext({ sampleRate: 16000 });
    const buf = await ctx.decodeAudioData(bytes.slice(0));
    const L = buf.getChannelData(0);
    let R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    if (R) { let diff = 0; for (let i = 0; i < L.length; i += 997) diff += Math.abs(L[i] - R[i]); if (diff / (L.length / 997) < 1e-4) R = null; }
    const chans = R ? [['me', L], ['them', R]] : [['me', L]];
    const CH = 1600; let pos = 0;
    S.audio = { ctx, streams: [], replay: true };
    vuLoop();
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        if (!S.audio || !S.audio.replay || pos >= L.length) { clearInterval(iv); return resolve(); }
        for (const [ch, data] of chans) {
          const out = new Int16Array(CH); let sq = 0;
          for (let i = 0; i < CH; i++) { const v = Math.max(-1, Math.min(1, data[pos + i] || 0)); out[i] = v < 0 ? v * 0x8000 : v * 0x7fff; sq += v * v; }
          S.levels[ch] = Math.sqrt(sq / CH);
          window.api.pushAudio(ch, out.buffer);
        }
        pos += CH;
      }, 100 / speed);
    });
    if (S.audio && S.audio.replay) { await FX.wait(2500); finishSession(); }
  }

  // ---------- audio capture ----------
  async function startCapture() {
    const ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule('worklet.js');
    const streams = [];
    const attach = (stream, channel) => {
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'pcm-capture');
      node.port.onmessage = (e) => { S.levels[channel] = e.data.rms; window.api.pushAudio(channel, e.data.pcm); };
      src.connect(node); node.connect(ctx.destination);
      streams.push(stream);
    };
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
    attach(mic, 'me');
    try {
      const loop = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      loop.getVideoTracks().forEach((t) => t.stop());
      if (!loop.getAudioTracks().length) throw new Error('loopback не дал аудио-дорожку');
      attach(loop, 'them');
    } catch (e) {
      showLiveError(`Системный звук не захвачен (${e.message}). Слушаю только микрофон.`);
    }
    S.audio = { ctx, streams };
    vuLoop();
  }

  function stopCapture() {
    if (!S.audio) return;
    if (!S.audio.replay) S.audio.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    S.audio.ctx.close().catch(() => {});
    S.audio = null;
  }

  function vuLoop() {
    if (!S.audio) return;
    const draw = (id, v) => { $(id).style.width = `${Math.min(100, Math.round(v * 300))}%`; };
    draw('vu-me', S.levels.me); draw('vu-them', S.levels.them);
    S.levels.me *= 0.85; S.levels.them *= 0.85;
    requestAnimationFrame(vuLoop);
  }

  function startTimer(startedAt) {
    clearInterval(S.timerId);
    const tick = () => { const t = mmss((Date.now() - startedAt) / 1000); $('timer').textContent = t; $('cb-timer').textContent = t; };
    tick(); S.timerId = setInterval(tick, 1000);
  }

  // ---------- theses (live) ----------
  function renderTheses() {
    const ol = $('theses'); ol.innerHTML = '';
    S.theses.forEach((t, i) => {
      const li = document.createElement('li');
      li.className = 'thesis' + (t.status === 'closed' ? ' closed' : '') + (t.suspect ? ' suspect' : '') + (t.critical ? ' critical' : '');
      li.dataset.id = t.id;
      li.title = t.text;
      li.innerHTML = `<div class="check"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 8"/></svg></div>
        <div class="body"><div class="text">${esc(t.text)}</div><div class="meta">${metaHtml(t)}</div></div>
        <span class="grade-badge" data-grade="${t.grade || ''}">${GRADE_LABEL[t.grade] || ''}</span>
        <span class="num">${t.critical ? '★' : String(i + 1).padStart(2, '0')}</span>`;
      li.addEventListener('click', () => window.api.toggleThesis(t.id));
      ol.appendChild(li);
    });
    $('progress-total').textContent = S.theses.length;
  }

  function metaHtml(t) {
    if (t.status === 'closed') {
      if (t.closedBy === 'manual') return `<b>${mmss(t.closedAt)}</b> · вручную`;
      return `<b>${mmss(t.closedAt)}</b> · «${esc(t.matchedPhrase)}»`;
    }
    if (t.suspect) return `возможно: «${esc(t.suspect.phrase)}» — нажми, если да`;
    return '';
  }

  function setBadge(li, grade) {
    const b = li.querySelector('.grade-badge');
    b.dataset.grade = grade || '';
    b.textContent = GRADE_LABEL[grade] || '';
    if (grade && grade !== 'miss') { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
  }

  async function onThesis(ev) {
    const idx = S.theses.findIndex((t) => t.id === ev.id);
    if (idx < 0) return;
    const { event, streak, ...t } = ev;
    S.theses[idx] = t;
    const li = document.querySelector(`.thesis[data-id="${t.id}"]`);
    if (!li) return;
    li.querySelector('.meta').innerHTML = metaHtml(t);
    li.classList.toggle('suspect', !!t.suspect);
    if (event === 'closed') await closeJuice(li, t, streak || 1);
    else if (event === 'reopened') { li.classList.remove('closed'); setBadge(li, t.grade); updateProgress(false); }
    else if (event === 'suspect') setBadge(li, 'partial');
    markNext();
  }

  // Хореография закрытия: замах → удар (вспышка, галочка, частицы) → подпись → успокоение. ~600 мс, без звука.
  async function closeJuice(li, t, streak) {
    const grade = t.grade || 'good';
    li.classList.add('anticipate');
    await FX.wait(70);
    li.classList.remove('anticipate');
    li.classList.add('closed');
    li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash');
    const r = li.querySelector('.check').getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const strong = grade === 'perfect';
    FX.burst(cx, cy, { count: strong ? 26 : 16, speed: strong ? 5 : 4, size: strong ? 6 : 5, colors: strong ? ['#D7A832', '#101012', '#F1D27A'] : ['#4F9A72', '#101012', '#D7A832'] });
    await FX.wait(120);
    setBadge(li, grade);
    FX.floatLabel(cx + 34, cy - 6, grade === 'perfect' ? '+PERFECT' : '+GOOD', grade);
    updateProgress(true);
    if (S.compact) compactClosed(t, grade, streak);
    if (streak >= 2) streakStamp(streak, cx, cy);
    if (t.closedBy === 'ai') {
      const phrase = streak >= 3 ? pick(PRAISE.streak3) : streak === 2 ? pick(PRAISE.streak2) : pick(PRAISE[grade] || PRAISE.good);
      dog(`<em>${esc(phrase)}</em> ${esc(shorten(t.text, 30))}`);
    }
  }

  function streakStamp(n, cx, cy) {
    const st = $('streak-stamp');
    st.textContent = `×${Math.min(n, 9)}`;
    st.hidden = false; st.classList.remove('pop'); void st.offsetWidth; st.classList.add('pop');
    const bar = $('progress-fill').getBoundingClientRect();
    if (n >= 3) FX.burst(bar.left + bar.width, bar.top + 3, { count: 30, angle: 250, spread: 90, speed: 6, size: 6, colors: ['#D7A832', '#F1D27A', '#101012'] });
    clearTimeout(S.streakTimer); S.streakTimer = setTimeout(() => { st.hidden = true; }, 25000);
  }

  function shorten(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function updateProgress(bump) {
    const closed = S.theses.filter((t) => t.status === 'closed').length;
    const el = $('progress-closed'); el.textContent = closed;
    if (bump) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
    const fill = $('progress-fill');
    fill.style.width = `${S.theses.length ? (closed / S.theses.length) * 100 : 0}%`;
    $('cb-closed').textContent = closed; $('cb-total').textContent = S.theses.length;
    $('cb-fill').style.width = fill.style.width;
    if (bump) { fill.classList.remove('over'); void fill.offsetWidth; fill.classList.add('over'); }
  }

  // ---------- Степаныч в углу: состояния idle / me / them / sleepy / cheer ----------
  function dogState(state) {
    const d = $('dog');
    if (d.dataset.state === 'cheer' && state !== 'cheer' && Date.now() - (S.dogCheerAt || 0) < 1200) return; // не сбивать прыжок
    d.dataset.state = state;
    $('dog-img').src = state === 'them' ? '../../assets/stepanych-e.png' : state === 'me' ? '../../assets/stepanych-se.png' : '../../assets/stepanych.png';
  }
  function dogSay(html, ms = 2200, kind = 'praise') {
    const b = $('dog-bubble'); b.innerHTML = html; b.dataset.kind = kind;
    b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
    clearTimeout(S.dogTimer); S.dogTimer = setTimeout(() => b.classList.remove('show'), ms);
  }
  function dog(html) {
    S.dogCheerAt = Date.now();
    dogState('cheer');
    dogSay(html, 2200, 'praise');
    setTimeout(() => { if ($('dog').dataset.state === 'cheer') dogState('idle'); }, 1300);
  }
  function dogTouch(channel) {
    S.lastSpeechAt = Date.now();
    dogState(channel);
    clearTimeout(S.dogIdleTimer);
    S.dogIdleTimer = setTimeout(() => dogState('idle'), 2500);
  }
  function dogSleepLoop() {
    clearInterval(S.dogSleepIv);
    S.dogSleepIv = setInterval(() => {
      if (!S.session || S.session.finished) return;
      const quiet = Date.now() - (S.lastSpeechAt || Date.now()) > 45000;
      const d = $('dog');
      if (quiet && d.dataset.state === 'idle') d.dataset.state = 'sleepy';
      if (!quiet && d.dataset.state === 'sleepy') d.dataset.state = 'idle';
    }, 5000);
  }
  function onNudge(ev) {
    dogState('idle');
    dogSay(`<em>Степаныч:</em> ${esc(ev.text)}`, 5000, 'hint');
    if (S.compact) compactFlash('степаныч', ev.text, 'hint', 6000);
  }
  // подсветка «следующий» — первый открытый тезис (критичный в приоритете)
  function markNext() {
    document.querySelectorAll('.thesis.next').forEach((el) => el.classList.remove('next'));
    const open = S.theses.filter((t) => t.status === 'open');
    const next = open.find((t) => t.critical) || open[0];
    if (next) document.querySelector(`.thesis[data-id="${next.id}"]`)?.classList.add('next');
    renderCompactLine();
  }

  // ---------- transcript strip ----------
  function onTranscript(ev) {
    if (ev.kind === 'partial' || ev.kind === 'final') dogTouch(ev.channel);
    if (ev.kind === 'partial') { S.partials[ev.channel] = ev.text; }
    else if (ev.kind === 'final') { S.partials[ev.channel] = ''; S.transcriptLines.push({ channel: ev.channel, text: ev.text, wall: ev.wall }); if (S.transcriptLines.length > 200) S.transcriptLines.shift(); }
    else if (ev.kind === 'refine') { for (let i = S.transcriptLines.length - 1; i >= 0; i--) { if (S.transcriptLines[i].channel === ev.channel && S.transcriptLines[i].wall === ev.wall) { S.transcriptLines[i].text = ev.text; break; } } }
    renderTranscript();
  }

  function renderTranscript() {
    const box = $('transcript');
    const lines = S.transcriptLines.slice(-3).map((l) => `<div class="line ${l.channel}"><span class="who">${l.channel === 'me' ? 'Я:' : 'Собеседник:'}</span>${esc(l.text)}</div>`);
    for (const ch of ['them', 'me']) if (S.partials[ch]) lines.push(`<div class="line ${ch} partial"><span class="who">${ch === 'me' ? 'Я:' : 'Собеседник:'}</span>${esc(S.partials[ch])}</div>`);
    box.innerHTML = lines.length ? lines.join('') : '<div class="empty">Слушаю… реплики появятся здесь</div>';
  }

  // ---------- status dots ----------
  function onStatus(ev) {
    if (ev.channel === 'llm') {
      const el = $('llm-state'); const d = el.querySelector('.dot');
      d.className = 'dot ' + (ev.state === 'checking' ? 'checking' : ev.state === 'error' ? 'error' : 'listening');
      el.title = ev.detail || ev.state;
      if (ev.state === 'error') showLiveError(`Сверка: ${ev.detail}`);
      return;
    }
    if (ev.state === 'speech' && (ev.channel === 'me' || ev.channel === 'them')) dogTouch(ev.channel);
    const d = $(`dot-${ev.channel}`); if (!d) return;
    d.className = 'dot ' + ({ listening: 'listening', speech: 'speech', connecting: 'connecting', error: 'error', stopped: '' }[ev.state] || '');
    d.title = ev.detail || ev.state;
    if (ev.state === 'error' && ev.detail) showLiveError(`${ev.channel === 'me' ? 'Микрофон' : 'Собеседник'}: ${ev.detail}`);
  }

  // ---------- finish / result ----------
  async function finishSession() {
    if (S.compact) await setCompact(false, false);
    $('btn-compact').hidden = true;
    const btn = $('btn-finish');
    btn.disabled = true; btn.textContent = 'Дослушиваю и разбираю…';
    stopCapture(); clearInterval(S.timerId);
    const prevBest = S.best ? S.best.score : null;
    const snap = await window.api.finishSession();
    btn.disabled = false; btn.textContent = 'Завершить созвон';
    if (!snap) return;
    const isRecord = !snap.replay && snap.score && (prevBest == null || snap.score.total > prevBest);
    await showResult(snap, { animate: true, isRecord });
    renderBest();
  }

  // Финал в порядке ритм-игр: число докручивается → ранг штампом → чипы → Степаныч → «Новый рекорд»
  async function showResult(snap, { animate = true, isRecord = false } = {}) {
    S.summary = snap;
    const sc = snap.score;
    const hero = $('result-hero');
    hero.className = 'result-hero';
    $('summary-scroll').scrollTop = 0;
    $('sum-sub').textContent = `${esc(snap.title)} · ${mmss(((snap.endedAt || Date.now()) - snap.startedAt) / 1000)}`;
    $('record-pill').hidden = true;
    $('dog-say').hidden = true;
    $('rank-letter').textContent = '';
    $('sum-rank-title').textContent = '';
    show('summary');
    $('dog').hidden = true; clearInterval(S.dogSleepIv);

    if (!sc) { $('sum-score').textContent = '—'; $('sum-rank-title').textContent = 'Балл не посчитан'; renderResultLists(snap); return; }
    hero.classList.add(`rank-${sc.rank}`);
    ['perfect', 'good', 'partial', 'miss'].forEach((g) => { $(`cnt-${g}`).textContent = sc.counts[g]; });
    renderParts(sc);
    renderResultLists(snap);

    if (!animate || FX.reduced()) {
      $('sum-score').textContent = sc.total; $('rank-letter').textContent = sc.rank; $('sum-rank-title').textContent = sc.title;
      if (sc.comment) { $('dog-comment').textContent = sc.comment; $('dog-say').hidden = false; }
      $('record-pill').hidden = !isRecord;
      return;
    }
    await FX.wait(300);
    await FX.countUp($('sum-score'), sc.total, { duration: 1200 });
    await FX.wait(150);
    const rl = $('rank-letter'); rl.textContent = sc.rank; rl.classList.remove('stamp'); void rl.offsetWidth; rl.classList.add('stamp');
    const tt = $('sum-rank-title'); tt.textContent = sc.title; tt.classList.remove('rise'); void tt.offsetWidth; tt.classList.add('rise');
    if (['SS', 'S', 'A'].includes(sc.rank)) FX.cannons(sc.rank === 'A' ? 0.8 : 1.2);
    await FX.wait(500);
    if (sc.comment) { $('dog-comment').textContent = sc.comment; const ds = $('dog-say'); ds.hidden = false; ds.classList.remove('rise'); void ds.offsetWidth; ds.classList.add('rise'); }
    await FX.wait(400);
    if (isRecord) { const p = $('record-pill'); p.hidden = false; p.classList.remove('pop'); void p.offsetWidth; p.classList.add('pop'); }
  }

  function renderParts(sc) {
    const rows = [
      ['Покрытие тезисов', sc.parts.coverage, sc.weights.coverage],
      ['Собранная информация', sc.parts.info, sc.weights.info],
      ['Тайминг', sc.parts.timing, 10],
    ].filter((r) => r[1] != null && r[2] > 0);
    $('parts').innerHTML = rows.map(([name, v, w]) => `<div class="part"><div class="part-head"><span>${name}</span><span><b>${v}%</b> · вес ${w}</span></div><div class="part-bar"><div style="width:${v}%"></div></div></div>`).join('')
      + (sc.criticalMiss ? '<div class="part-note">Пропущен критичный тезис — потолок ранга A</div>' : '');
  }

  function renderResultLists(snap) {
    const sc = snap.score;
    const graded = sc ? sc.graded : snap.theses.map((t) => ({ ...t, grade: t.status === 'closed' ? 'good' : 'miss' }));
    const missed = graded.filter((g) => g.grade === 'miss' || g.grade === 'partial');
    $('h-missed').hidden = !missed.length; $('sum-missed').hidden = !missed.length;
    $('sum-missed').innerHTML = missed.map((g) => `<li><span class="mark ${g.grade}">${g.grade === 'partial' ? '½' : '✕'}</span><span><span>${esc(g.text)}</span>${g.missedHint ? `<span class="q">${g.missedAt ? `<b>${esc(g.missedAt)}</b> · ` : ''}«${esc(stripQ(g.missedHint))}»</span>` : ''}</span></li>`).join('');
    const learned = graded.filter((g) => g.kind === 'ask' && g.answer);
    $('h-learned').hidden = !learned.length; $('sum-learned').hidden = !learned.length;
    $('sum-learned').innerHTML = learned.map((g) => `<li><span class="mark ${g.answered === 'partial' ? 'partial' : 'good'}">${g.answered === 'partial' ? '≈' : '✓'}</span><span><span class="q-title">${esc(g.text)}</span><span class="q">${esc(g.answer)}</span></span></li>`).join('');
    const h = sc ? sc.hygiene : null;
    $('hygiene').innerHTML = h ? [
      h.talkRatio != null ? chipH(`Говорил ${h.talkRatio}%`, h.talkRatio >= (h.talkNorm || [40, 55])[0] && h.talkRatio <= (h.talkNorm || [40, 55])[1], `норма для этого типа созвона: ${(h.talkNorm || [40, 55]).join('–')}%`) : '',
      chipH(`Монолог ${mmss(h.longestMonologueSec)}`, h.longestMonologueSec < 90, 'норма до 1:30'),
      h.fillersPerMin != null ? chipH(`Паразиты ${h.fillersPerMin}/мин`, h.fillersPerMin < 3, '«ну», «вот», «э-э»') : '',
      h.switchesPerMin != null ? chipH(`Диалог ${h.switchesPerMin} смен/мин`, h.switchesPerMin >= 2, 'живой разговор — от 2') : '',
    ].join('') : '<span class="chip">нет данных</span>';
    $('sum-theses').innerHTML = snap.theses.map((t) => {
      const g = graded.find((x) => x.id === t.id) || {};
      const q = t.status === 'closed' ? (t.closedBy === 'manual' ? 'вручную' : `«${t.matchedPhrase}»`) : (t.suspect ? `возможно: «${t.suspect.phrase}»` : '');
      return `<li><span class="mark ${g.grade || 'miss'}">${{ perfect: '★', good: '✓', partial: '½', miss: '✕' }[g.grade] || '✕'}</span><span><span>${t.critical ? '★ ' : ''}${esc(t.text)}</span>${q ? `<span class="q">${t.closedAt != null ? `<b>${mmss(t.closedAt)}</b> · ` : ''}${esc(q)}</span>` : ''}</span></li>`;
    }).join('');
    $('sum-transcript').innerHTML = snap.transcript.length
      ? snap.transcript.map((e) => `<div class="line ${e.channel}"><span class="t">${mmss(e.wall)}</span>${e.channel === 'me' ? 'Я' : 'Собеседник'}: ${esc(e.text)}</div>`).join('')
      : '<div class="none">Транскрипт пуст</div>';
  }

  function chipH(text, ok, hint) { return `<span class="chip ${ok ? 'ok' : 'warn'}" title="${esc(hint)}"><span class="dot ${ok ? 'listening' : 'error'}"></span>${esc(text)}</span>`; }

  // ---------- history ----------
  async function openHistory() {
    const list = await window.api.historyList();
    const box = $('history-list');
    if (!list.length) { box.innerHTML = '<div class="none">Пока ни одного созвона</div>'; show('history'); return; }
    const best = S.best;
    box.innerHTML = list.map((s) => {
      const d = new Date(s.startedAt);
      const date = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const isBest = best && best.folder === s.folder;
      return `<button class="hist ${isBest ? 'best' : ''}" data-folder="${esc(s.folder)}">
        <span class="hist-score ${s.rank ? 'rank-' + s.rank : ''}">${s.score != null ? s.score : '—'}</span>
        <span class="hist-body"><span class="hist-title">${esc(s.title)}${s.isReplay ? ' <i>запись</i>' : ''}<span class="hist-type">${esc((S.types.find((x) => x.id === s.callType) || {}).name || '')}</span></span><span class="hist-sub">${date} · ${s.durationSec != null ? mmss(s.durationSec) : '—'} · ${s.closed}/${s.total}${s.rank ? ` · ${esc(s.rank)}` : ''}${isBest ? ' · рекорд' : ''}</span></span></button>`;
    }).join('');
    box.querySelectorAll('.hist').forEach((b) => b.addEventListener('click', async () => {
      const snap = await window.api.historyLoad(b.dataset.folder);
      if (snap) await showResult(snap, { animate: true, isRecord: false });
    }));
    show('history');
  }

  // ---------- onboarding ----------
  const ABOUT = { author: 'https://t.me/ivandrobitko', repo: 'https://github.com/glxaoc/sozvon-quest' };
  const OB = { aitunnel: false, nexara: false };
  const OB_STEP = { choice: 1, local: 2, key: 2, done: 3 };
  function obPane(name) {
    document.querySelectorAll('.ob-pane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
    const n = OB_STEP[name] || 1;
    document.querySelectorAll('.ob-step').forEach((s) => { const k = Number(s.dataset.step); s.classList.toggle('active', k === n); s.classList.toggle('done', k < n); });
    if (name === 'local') refreshModels();
  }
  const mb = (b) => `${Math.round(b / 1048576)} МБ`;
  async function refreshModels() {
    const st = await window.api.modelsStatus();
    S.models = st;
    for (const id of ['stt', 'llm']) {
      const m = st[id]; if (!m) continue;
      const item = document.querySelector(`.dl-item[data-id="${id}"]`);
      item.classList.toggle('ready', m.ready);
      $(`dl-bar-${id}`).style.width = `${Math.round((m.bytes / m.total) * 100)}%`;
      $(`dl-num-${id}`).textContent = m.ready ? 'готово' : `${mb(m.bytes)} из ${mb(m.total)}`;
    }
    const all = st.stt?.ready && st.llm?.ready;
    $('ob-next-local').disabled = !all;
    $('ob-dl-start').hidden = !!all;
    return st;
  }
  function onModelsProgress({ id, bytes }) {
    const m = S.models && S.models[id]; if (!m) return;
    $(`dl-bar-${id}`).style.width = `${Math.round((bytes / m.total) * 100)}%`;
    const now = Date.now(); const prev = S.dlSpeed || {};
    if (prev.id === id && now - prev.t > 1500) { S.dlRate = (bytes - prev.b) / ((now - prev.t) / 1000); S.dlSpeed = { id, t: now, b: bytes }; }
    else if (prev.id !== id) S.dlSpeed = { id, t: now, b: bytes };
    const rate = S.dlRate ? ` · ${(S.dlRate / 1048576).toFixed(1)} МБ/с, осталось ~${Math.max(1, Math.round((m.total - bytes) / S.dlRate / 60))} мин` : '';
    $(`dl-num-${id}`).textContent = `${mb(bytes)} из ${mb(m.total)}${rate}`;
  }
  async function startModelsDownload() {
    const st = await refreshModels();
    const ids = ['stt', 'llm'].filter((id) => !st[id].ready);
    if (!ids.length) return;
    $('ob-dl-start').disabled = true; $('ob-dl-start').textContent = 'Скачиваю…';
    $('ob-status-local').className = 'ob-status'; $('ob-status-local').textContent = '';
    const r = await window.api.modelsDownload(ids);
    $('ob-dl-start').disabled = false; $('ob-dl-start').textContent = 'Продолжить';
    await refreshModels();
    if (r.error) { $('ob-status-local').className = 'ob-status bad'; $('ob-status-local').textContent = `Загрузка прервалась: ${r.error}. Нажми «Продолжить», скачанное не пропадёт.`; return; }
    $('ob-status-local').className = 'ob-status'; $('ob-status-local').textContent = 'Проверяю модель…';
    const c = await window.api.modelsCheck();
    $('ob-status-local').className = c.ok ? 'ob-status ok' : 'ob-status bad';
    $('ob-status-local').textContent = c.ok ? `Работает · первый ответ за ${(c.ms / 1000).toFixed(1)} с` : `Модель не запустилась: ${c.error || 'нет ответа'}`;
  }
  async function pickMode(mode) {
    if (mode === 'local') { S.cfg = await window.api.saveConfig({ LLM_PROVIDER: 'local', STT_PROVIDER: 'local' }); obPane('local'); }
    else { S.cfg = await window.api.saveConfig({ LLM_PROVIDER: 'aitunnel', STT_PROVIDER: 'aitunnel' }); obPane('key'); }
  }
  function obStep(n) {
    document.querySelectorAll('.ob-pane').forEach((p) => { p.hidden = Number(p.dataset.pane) !== n; });
    document.querySelectorAll('.ob-step').forEach((s) => { const k = Number(s.dataset.step); s.classList.toggle('active', k === n); s.classList.toggle('done', k < n); });
  }
  async function obCheck(provider) {
    const input = $(`ob-${provider}`); const st = $(`ob-status-${provider}`); const btn = $(`ob-check-${provider}`);
    st.className = 'ob-status'; st.textContent = 'Проверяю…'; btn.disabled = true;
    const r = await window.api.checkKey(provider, input.value);
    btn.disabled = false;
    if (r.ok) {
      st.className = 'ob-status ok'; st.textContent = `Работает · ${r.info}`;
      OB[provider] = true;
      S.cfg = await window.api.saveConfig({ AITUNNEL_API_KEY: input.value.trim() });
      $('ob-next-1').disabled = false;
    } else {
      st.className = 'ob-status bad'; st.textContent = `Не сработало: ${r.error}`;
    }
  }
  function openOnboarding(step = 1) {
    OB.aitunnel = !!S.cfg.hasAitunnelKey;
    $('ob-next-1').disabled = !OB.aitunnel;
    $('ob-status-aitunnel').textContent = OB.aitunnel ? 'Ключ уже сохранён — можно проверить заново или идти дальше' : '';
    $('modal-settings').hidden = true;
    obPane(step === 3 ? 'done' : 'choice'); show('onboarding');
  }
  function bindOnboarding() {
    $('ob-check-aitunnel').addEventListener('click', () => obCheck('aitunnel'));
    $('ob-aitunnel').addEventListener('keydown', (e) => { if (e.key === 'Enter') obCheck('aitunnel'); });
    $('ob-next-1').addEventListener('click', () => obPane('done'));
    $('ob-back-3').addEventListener('click', () => obPane(S.cfg.LLM_PROVIDER === 'local' ? 'local' : 'key'));
    $('ob-pick-local').addEventListener('click', () => pickMode('local'));
    $('ob-pick-key').addEventListener('click', () => pickMode('key'));
    $('ob-back-local').addEventListener('click', () => obPane('choice'));
    $('ob-back-key').addEventListener('click', () => obPane('choice'));
    $('ob-dl-start').addEventListener('click', startModelsDownload);
    $('ob-next-local').addEventListener('click', () => obPane('done'));
    window.api.on('models-progress', onModelsProgress);
    $('ob-finish').addEventListener('click', () => { try { localStorage.setItem('cq.onboarded', '1'); } catch (e) { /* noop */ } renderSetupChips(); show('setup'); });
    document.querySelectorAll('[data-url]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); window.api.openUrl(a.dataset.url); }));
    $('about-link').addEventListener('click', (e) => { e.preventDefault(); window.api.openUrl(ABOUT.author); });
    $('about-repo').addEventListener('click', (e) => { e.preventDefault(); window.api.openUrl(ABOUT.repo); });
    $('btn-settings-wizard').addEventListener('click', () => openOnboarding(1));
  }

  // ---------- типы созвонов и списки ----------
  function typeById(id) { return S.types.find((t) => t.id === id) || S.types[0]; }

  function renderTypeTabs() {
    const box = $('type-tabs'); box.innerHTML = '';
    S.types.forEach((t) => {
      const b = document.createElement('button');
      b.className = 'type-tab'; b.textContent = t.name; b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(t.id === S.type));
      b.addEventListener('click', () => switchType(t.id));
      box.appendChild(b);
    });
    $('type-hint').textContent = typeById(S.type).hint;
  }

  function saveDraft() { try { localStorage.setItem(`cq.theses.${S.type}`, $('in-theses').value); } catch (e) { /* noop */ } }

  function loadDraft(typeId) {
    let v = null;
    try { v = localStorage.getItem(`cq.theses.${typeId}`); } catch (e) { /* noop */ }
    if (v == null && typeId === 'sales') { try { v = localStorage.getItem('cq.theses'); } catch (e) { /* noop */ } }
    if (v == null) { const tpl = typeById(typeId).templates[0]; v = tpl ? tpl.theses.join('\n') : ''; }
    $('in-theses').value = v;
  }

  function switchType(id) {
    if (id === S.type) return;
    saveDraft();
    S.type = id;
    try { localStorage.setItem('cq.type', id); } catch (e) { /* noop */ }
    loadDraft(id);
    renderTypeTabs();
    renderTplSelect();
  }

  function renderTplSelect(selectValue = '') {
    const sel = $('tpl-select'); const t = typeById(S.type);
    const mine = S.userTpl.filter((u) => u.type === S.type);
    sel.innerHTML = '<option value="">Выбрать список…</option>'
      + (t.templates.length ? `<optgroup label="Готовые">${t.templates.map((x) => `<option value="b:${esc(x.id)}">${esc(x.name)}</option>`).join('')}</optgroup>` : '')
      + (mine.length ? `<optgroup label="Мои">${mine.map((x) => `<option value="u:${esc(x.id)}">${esc(x.name)}</option>`).join('')}</optgroup>` : '');
    sel.value = selectValue;
    $('tpl-del').hidden = !sel.value.startsWith('u:');
  }

  function applyTpl(value) {
    if (!value) return;
    const [kind, id] = [value.slice(0, 1), value.slice(2)];
    let text = null;
    if (kind === 'b') { const tpl = typeById(S.type).templates.find((x) => x.id === id); if (tpl) text = tpl.theses.join('\n'); }
    else { const u = S.userTpl.find((x) => x.id === id); if (u) text = u.text; }
    if (text != null) { $('in-theses').value = text; saveDraft(); }
  }

  function bindTemplates() {
    $('tpl-select').addEventListener('change', (e) => { applyTpl(e.target.value); $('tpl-del').hidden = !e.target.value.startsWith('u:'); });
    $('tpl-save').addEventListener('click', () => {
      $('tpl-save-row').hidden = false;
      const sel = $('tpl-select').value; const u = sel.startsWith('u:') ? S.userTpl.find((x) => x.id === sel.slice(2)) : null;
      $('tpl-name').value = u ? u.name : ($('in-title').value.trim() || '');
      $('tpl-name').focus(); $('tpl-name').select();
    });
    const doSave = async () => {
      const name = $('tpl-name').value.trim(); const text = $('in-theses').value.trim();
      if (!name || !text) { $('tpl-name').focus(); return; }
      S.userTpl = await window.api.templatesSave({ type: S.type, name, text });
      const saved = S.userTpl.find((x) => x.type === S.type && x.name.toLowerCase() === name.toLowerCase());
      $('tpl-save-row').hidden = true;
      renderTplSelect(saved ? `u:${saved.id}` : '');
    };
    $('tpl-save-ok').addEventListener('click', doSave);
    $('tpl-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); if (e.key === 'Escape') $('tpl-save-row').hidden = true; });
    $('tpl-save-cancel').addEventListener('click', () => { $('tpl-save-row').hidden = true; });
    $('tpl-del').addEventListener('click', async () => {
      const sel = $('tpl-select').value; if (!sel.startsWith('u:')) return;
      S.userTpl = await window.api.templatesRemove(sel.slice(2));
      renderTplSelect('');
    });
    $('in-theses').addEventListener('input', () => { clearTimeout(S.draftTimer); S.draftTimer = setTimeout(saveDraft, 400); });
  }

  // ---------- компактный режим ----------
  async function setCompact(flag, remember = true) {
    S.compact = !!flag;
    document.body.classList.toggle('compact', S.compact);
    $('btn-compact').setAttribute('aria-pressed', String(S.compact));
    $('btn-compact').title = S.compact ? 'Развернуть' : 'Компактный режим';
    await window.api.setCompact(S.compact);
    if (remember) { try { localStorage.setItem('cq.compact', S.compact ? '1' : '0'); } catch (e) { /* noop */ } }
    renderCompactLine();
  }

  function renderCompactLine() {
    if (S.cbFlashUntil && Date.now() < S.cbFlashUntil) return;
    const line = $('cb-line'); line.className = 'cb-line';
    const open = S.theses.filter((t) => t.status === 'open');
    const next = open.find((t) => t.critical) || open[0];
    if (next) { line.querySelector('.cb-label').textContent = next.critical ? 'дальше ★' : 'дальше'; $('cb-text').textContent = next.text; line.title = next.text; }
    else { line.classList.add('all'); line.querySelector('.cb-label').textContent = 'всё'; $('cb-text').textContent = 'Все пункты закрыты — можно завершать'; line.title = ''; }
  }

  function compactFlash(label, text, cls, ms) {
    const line = $('cb-line');
    line.className = `cb-line ${cls}`; void line.offsetWidth; line.classList.add('flash');
    line.querySelector('.cb-label').textContent = label; $('cb-text').textContent = text; line.title = text;
    S.cbFlashUntil = Date.now() + ms;
    clearTimeout(S.cbTimer); S.cbTimer = setTimeout(() => { S.cbFlashUntil = 0; renderCompactLine(); }, ms);
  }

  function compactClosed(t, grade, streak) {
    compactFlash(grade === 'perfect' ? 'perfect' : 'good', t.text, 'done', 2600);
    const r = $('cb-line').getBoundingClientRect();
    FX.burst(r.left + 18, r.top + r.height / 2, { count: grade === 'perfect' ? 22 : 14, speed: 4, size: 5, angle: 300, spread: 80,
      colors: grade === 'perfect' ? ['#D7A832', '#101012', '#F1D27A'] : ['#4F9A72', '#101012', '#D7A832'] });
    if (streak >= 2) { const st = $('cb-streak'); st.textContent = `×${Math.min(streak, 9)}`; st.hidden = false; st.classList.remove('pop'); void st.offsetWidth; st.classList.add('pop'); clearTimeout(S.cbStreakTimer); S.cbStreakTimer = setTimeout(() => { st.hidden = true; }, 25000); }
  }

  // ---------- settings ----------
  function openSettings() {
    const m = $('modal-settings');
    m.querySelectorAll('[data-k]').forEach((el) => { el.value = S.cfg[el.dataset.k] ?? ''; });
    m.hidden = false;
  }
  async function saveSettings() {
    const patch = {};
    $('modal-settings').querySelectorAll('[data-k]').forEach((el) => { patch[el.dataset.k] = el.type === 'number' ? Number(el.value) : el.value; });
    S.cfg = await window.api.saveConfig(patch);
    $('modal-settings').hidden = true;
    renderSetupChips();
  }

  // ---------- init ----------
  async function init() {
    S.cfg = await window.api.getConfig();
    S.args = await window.api.args();
    S.types = await window.api.callTypes();
    S.userTpl = await window.api.templatesList().catch(() => []);
    try { S.type = localStorage.getItem('cq.type') || 'sales'; } catch (e) { S.type = 'sales'; }
    if (!S.types.some((t) => t.id === S.type)) S.type = 'sales';
    loadDraft(S.type);
    try { $('in-title').value = localStorage.getItem('cq.title') || ''; } catch (e) { /* noop */ }
    renderTypeTabs(); renderTplSelect(); bindTemplates();
    $('btn-compact').addEventListener('click', () => setCompact(!S.compact));
    renderSetupChips();
    renderBest();
    bindOnboarding();

    $('btn-start').addEventListener('click', () => startSession());
    $('btn-replay').addEventListener('click', pickAndReplay);
    $('btn-finish').addEventListener('click', finishSession);
    $('btn-new').addEventListener('click', () => { S.session = null; $('dog').hidden = true; show('setup'); });
    $('btn-history-new').addEventListener('click', () => show('setup'));
    $('btn-history').addEventListener('click', openHistory);
    $('btn-open-md').addEventListener('click', () => S.summary?.paths && window.api.openPath(S.summary.paths.md));
    $('btn-open-folder').addEventListener('click', () => S.summary?.paths && window.api.showInFolder(S.summary.paths.md));
    $('btn-settings').addEventListener('click', openSettings);
    $('btn-settings-close').addEventListener('click', () => { $('modal-settings').hidden = true; });
    $('btn-settings-save').addEventListener('click', saveSettings);
    $('btn-top').addEventListener('click', async () => {
      const b = $('btn-top'); const next = b.getAttribute('aria-pressed') !== 'true';
      await window.api.setAlwaysOnTop(next); b.setAttribute('aria-pressed', String(next));
    });
    const mockSend = () => { const t = $('mock-text').value.trim(); if (!t) return; window.api.mockSay($('mock-channel').value, t); $('mock-text').value = ''; };
    $('mock-send').addEventListener('click', mockSend);
    $('mock-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') mockSend(); });

    window.api.on('transcript', onTranscript);
    window.api.on('thesis', onThesis);
    window.api.on('status', onStatus);
    window.api.on('finished', (snap) => { S.summary = snap; });
    window.api.on('log', (line) => console.log(line));
    window.api.on('demo', (cmd) => { if (cmd === 'finish') finishSession(); });
    window.api.on('replay-done', () => finishSession());
    window.api.on('nudge', onNudge);

    let onboarded = false; try { onboarded = localStorage.getItem('cq.onboarded') === '1'; } catch (e) { /* noop */ }
    let needKeys = !S.cfg.hasAitunnelKey;
    if (S.cfg.LLM_PROVIDER === 'local') { const st = await window.api.modelsStatus().catch(() => ({})); needKeys = !(st.stt?.ready && st.llm?.ready); }
    if (S.args.onboarding || (!S.args.demo && !S.args.replay && !S.args.autostart && !S.args.screenshot && (needKeys || !onboarded))) openOnboarding(needKeys || S.args.onboarding ? 1 : 3);

    const DEMO = ['* Назвать стоимость пилота — 120 000 ₽', 'Спросить, кто принимает решение', 'Рассказать кейс: возврат 1,9 млн ₽ за 2 месяца', 'Предложить пилот на 2 недели', 'Договориться о следующем шаге и дате'];
    if (S.args.replay) {
      if (S.args.thesesText) $('in-theses').value = S.args.thesesText;
      if (!parseTheses().length) $('in-theses').value = DEMO.join('\n');
      const f = await window.api.loadReplay(S.args.replay);
      window.api.on('finished', () => setTimeout(() => window.api.quit(), 1500));
      await replayFile(f, S.args.me);
      return;
    }
    if (S.args.autostart) {
      $('in-title').value = 'Автотест'; $('in-theses').value = DEMO.join('\n');
      await startSession();
      setTimeout(async () => { await finishSession(); setTimeout(() => window.api.quit(), 800); }, S.args.autostart * 1000);
      return;
    }
    if (S.args.demo) {
      $('in-title').value = 'Демо для Ромашки'; $('in-theses').value = DEMO.join('\n');
      await startSession();
      if (S.args.compact) await setCompact(true, false);
      setTimeout(() => window.api.mockSay('them', 'Расскажите, сколько это стоит и как быстро можно начать?'), 400);
      setTimeout(() => window.api.mockSay('me', 'Пилот на две недели стоит сто двадцать тысяч рублей, начать можем со следующего понедельника'), 900);
      setTimeout(() => window.api.mockSay('them', 'Понял. А есть примеры, где это уже сработало?'), 6000);
      setTimeout(() => window.api.mockSay('me', 'У одного клиента наш агент вернул один и девять миллиона рублей за два месяца. Кстати, а кто у вас принимает решение по таким проектам?'), 6500);
    }
  }

  init();
})();
