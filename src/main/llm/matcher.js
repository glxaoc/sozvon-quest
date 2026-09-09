'use strict';
// LLM-сверка: «какие из открытых тезисов пользователь только что явно озвучил?»
// Claude через AiTunnel (OpenAI-совместимый chat/completions). Ответ — строго JSON.

const SYSTEM = `Ты — ассистент на деловом созвоне. У пользователя есть список тезисов — что он должен успеть сделать в разговоре: сказать, спросить, узнать, предложить, договориться.
Тебе дают его речь за последние ~30 секунд (автоматическое распознавание: могут быть ошибки, обрывки, «а-а», «вот», повторы) и список ещё не закрытых тезисов. Речь разбита на реплики; НОВЫЕ реплики помечены ►, остальные — контекст, но тезис может закрываться и совокупностью старых и новых реплик (одна мысль часто разрезана на 2–3 реплики).

Задача: определить, какие тезисы пользователь уже выполнил.

Как судить:
- Тезис вида «узнать / спросить / уточнить X» закрыт, если пользователь поднял вопрос X перед собеседником в ЛЮБОЙ форме — прямым вопросом, косвенным («важно понимать, сколько у вас отделов»), просьбой рассказать.
- Тезис вида «сказать / назвать / рассказать X» закрыт, если смысл X донесён своими словами. Дословность не нужна.
- Тезис вида «готовы ли они / договориться о X» закрыт, если пользователь вынес X на обсуждение с собеседником: спросил, предложил, обозначил срок или условие. Формулировка может быть утвердительной, а не вопросительной.
- Относительное время («в этом месяце», «на этой неделе») сверяй с сегодняшней датой, она указана ниже.
- Составной тезис («кто принимает решение и кто будет пользоваться») закрыт, если поднята его главная часть; недостающую половину отрази пониженной уверенностью, а не отказом.
- Тезис «какую задачу хотят решить» закрывают вопросы про боль, проблему, что беспокоит, что хотят изменить — это одно и то же.
- НЕ закрывай, если тезис лишь анонсирован на будущее («потом расскажу про цену», «следующая задача…») или озвучена явно меньшая часть составного тезиса.
- НЕ закрывай по соседству темы. Закрывает только речь, в которой есть КОНКРЕТНОЕ содержание тезиса: для «предложить пилот» нужно само предложение пилота, а не «давайте мелкие задачи отбросим»; для «договориться о следующем шаге» нужен следующий шаг или дата, а не любой вопрос собеседнику; для «рассказать кейс с цифрами» нужен рассказ о результате у другого клиента, а не описание текущего процесса; для «по каким цифрам поймём, что сработало» нужен вопрос о метрике успеха, а не описание проблемы.
- Если в тезисе есть конкретика — сумма, число, срок, название, — она должна прозвучать. «Сколько это будет стоить» не закрывает «назвать стоимость 120 000 ₽»; рассказ о другом проекте без результата в цифрах не закрывает «кейс: возврат 1,9 млн ₽ за 2 месяца»; «сдвину встречу на следующую неделю» не закрывает «предложить пилот на 2 недели».
- Одна реплика обычно закрывает один тезис. Второй тезис из той же реплики включай, только если он выражен так же явно, а не задет мимоходом («смотрим на цифры» не закрывает «спросить, по каким цифрам они поймут, что сработало»).
- Если сомневаешься, считается ли это тем самым тезисом, — НЕ включай его в ответ. Ошибка «закрыл лишнее» хуже ошибки «не закрыл»: пользователь может закрыть тезис рукой, а лишнее закрытие он не заметит.
- Реплики собеседника не засчитываются, они даны только для понимания контекста.

Для каждого закрытого тезиса дай matched_phrase — короткую цитату из речи пользователя (как есть, можно склеить две соседние реплики) и confidence 0–1.
Шкала confidence: 0.9–1 — сказано прямо; 0.75–0.85 — своими словами, косвенно или главная часть составного тезиса, но содержание тезиса присутствует однозначно; ниже 0.7 — не включай вовсе. Незакрытые тезисы в ответ не включай.

Отвечай ТОЛЬКО JSON без пояснений и без markdown:
{"closed":[{"id":"<id>","matched_phrase":"<цитата>","confidence":0.0}]}
Если ничего не закрыто: {"closed":[]}`;

function buildUser({ theses, recentMe, newMe, recentThem, contextMe }) {
  const list = theses.map((t) => `- [${t.id}] ${t.text}`).join('\n');
  const today = new Date();
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const parts = [];
  parts.push(`СЕГОДНЯ: ${today.getDate()} ${months[today.getMonth()]} ${today.getFullYear()}`);
  parts.push(`ОТКРЫТЫЕ ТЕЗИСЫ:\n${list}`);
  if (recentThem) parts.push(`ПОСЛЕДНИЕ РЕПЛИКИ СОБЕСЕДНИКА (контекст, не засчитывать):\n${recentThem}`);
  // recentMe — массив {text, isNew}; contextMe/newMe — совместимость со старым вызовом
  const lines = Array.isArray(recentMe)
    ? recentMe.map((r) => `${r.isNew ? '► ' : '  '}${r.text}`)
    : [...(contextMe ? [`  ${contextMe}`] : []), `► ${newMe}`];
  parts.push(`РЕЧЬ ПОЛЬЗОВАТЕЛЯ ЗА ПОСЛЕДНИЕ ~30 СЕКУНД (► — новые реплики):\n${lines.join('\n')}`);
  return parts.join('\n\n');
}

function extractJson(text) {
  if (!text) return null;
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < 0) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

class Matcher {
  constructor(config, log) {
    this.config = config;
    this.log = log || (() => {});
    this.usage = { calls: 0, prompt_tokens: 0, completion_tokens: 0, errors: 0 };
  }

  async check(input) {
    if (!this.config.AITUNNEL_API_KEY) throw new Error('нет AITUNNEL_API_KEY');
    const hasNew = Array.isArray(input.recentMe) ? input.recentMe.some((r) => r.isNew) : !!(input.newMe && input.newMe.trim());
    if (!input.theses.length || !hasNew) return { closed: [], raw: null };
    const body = {
      model: this.config.LLM_MODEL || 'claude-sonnet-5',
      temperature: 0,
      max_tokens: 700,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildUser(input) },
      ],
    };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    const started = Date.now();
    try {
      const r = await fetch(`${this.config.AITUNNEL_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.AITUNNEL_API_KEY}` },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content || '';
      this.usage.calls++;
      this.usage.prompt_tokens += j.usage?.prompt_tokens || 0;
      this.usage.completion_tokens += j.usage?.completion_tokens || 0;
      const parsed = extractJson(text);
      if (!parsed || !Array.isArray(parsed.closed)) {
        this.log('matcher: unparseable answer', text.slice(0, 200));
        return { closed: [], raw: text, ms: Date.now() - started };
      }
      const ids = new Set(input.theses.map((t) => String(t.id)));
      const closed = parsed.closed
        .filter((c) => c && ids.has(String(c.id)))
        .map((c) => ({ id: String(c.id), matched_phrase: String(c.matched_phrase || ''), confidence: Math.max(0, Math.min(1, Number(c.confidence) || 0)) }));
      return { closed, raw: text, ms: Date.now() - started };
    } catch (e) {
      this.usage.errors++;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

const DEBRIEF_SYSTEM = `Ты — Степаныч, корги-ассистент на деловых созвонах. Разбираешь только что закончившийся созвон пользователя.
Тебе дают список тезисов (что пользователь должен был сделать на созвоне) с их статусом и полный транскрипт с таймкодами: «Я» — пользователь, «Собеседник» — вторая сторона.

Задачи:
1. Для каждого тезиса определи kind: "ask" (узнать / спросить / уточнить / выяснить — цель получить информацию), "tell" (сказать / рассказать / назвать / предложить — цель донести), "agree" (договориться / зафиксировать).
2. Для тезисов kind="ask", которые пользователь озвучил: определи answered — "full" (собеседник ответил по существу), "partial" (ответил уклончиво или частично), "none" (не ответил, ушёл от темы). И answer — краткий пересказ ответа собеседника в 1–2 предложениях (факты, цифры, имена). Для неозвученных — answered:"none", answer:"".
3. Для тезисов со статусом miss или partial: missed_at — таймкод момента разговора (мм:сс), где это было бы уместно поднять, и missed_hint — одна фраза, как это можно было сказать. Если уместного момента не было — null.
4. comment — твоя реплика на весь созвон: 1–2 коротких предложения, обращение на «ты», дерзкий тон, как у тренера, который в тебя верит, но не даст расслабиться. Обязательно конкретика из ЭТОГО созвона: таймкод, цифра, цитата. Без мата и без «молодец». Примеры тона:
   «Бюджет спросил на 41-й минуте из 44. Это смелость или паника?»
   «Клиент рассказал про команду сам, а ты так и не спросил, сколько их. Он тебе интервью давал, а не ты ему.»
   «Монолог на 4 минуты в 18:20. Я успел поспать.»
   «Следующий шаг с датой — есть. Редкий зверь, уважаю.»
5. highlight — одна фраза: лучший момент созвона пользователя (цитата или пересказ).

Отвечай ТОЛЬКО JSON без markdown:
{"theses":[{"id":"t1","kind":"ask","answered":"full","answer":"...","missed_at":null,"missed_hint":""}],"comment":"...","highlight":"..."}`;

function mmss(sec) { const s = Math.max(0, Math.round(sec || 0)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }

// Разбор созвона по завершении: один запрос на весь транскрипт
async function debrief(config, { theses, transcript, log = () => {} }) {
  if (!config.AITUNNEL_API_KEY) throw new Error('нет AITUNNEL_API_KEY');
  const list = theses.map((t) => `- [${t.id}] ${t.text}${t.critical ? ' (критичный)' : ''} — ${t.status === 'closed' ? `озвучен в ${mmss(t.closedAt)}: «${t.matchedPhrase}»` : (t.suspect ? `частично: «${t.suspect.phrase}»` : 'НЕ озвучен')}`).join('\n');
  let lines = transcript.map((e) => `[${mmss(e.wall)}] ${e.channel === 'me' ? 'Я' : 'Собеседник'}: ${e.text}`);
  // страховка по объёму: ~40 тыс. символов (≈ 60 минут речи)
  let text = lines.join('\n');
  if (text.length > 40000) text = text.slice(0, 20000) + '\n[…пропущена середина…]\n' + text.slice(-20000);
  const body = {
    model: config.LLM_MODEL || 'claude-haiku-4.5', temperature: 0.4, max_tokens: 1800,
    messages: [
      { role: 'system', content: DEBRIEF_SYSTEM },
      { role: 'user', content: `ТЕЗИСЫ:\n${list}\n\nТРАНСКРИПТ:\n${text}` },
    ],
  };
  const t0 = Date.now();
  const r = await fetch(`${config.AITUNNEL_BASE_URL}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.AITUNNEL_API_KEY}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const parsed = extractJson(j.choices?.[0]?.message?.content || '');
  log(`debrief: ${Date.now() - t0} ms, ${j.usage?.prompt_tokens || 0}+${j.usage?.completion_tokens || 0} tok`);
  if (!parsed || !Array.isArray(parsed.theses)) return { theses: [], comment: '', highlight: '', usage: j.usage };
  return { ...parsed, usage: j.usage };
}

module.exports = { Matcher, SYSTEM, buildUser, extractJson, debrief, DEBRIEF_SYSTEM };
