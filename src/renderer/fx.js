/* Эффекты без библиотек: частицы на оверлей-канвасе, докрутка чисел, штамп ранга.
   Всё только transform/opacity + один canvas, чтобы не грузить always-on-top окно. */
(() => {
  const canvas = document.getElementById('fx');
  const ctx = canvas.getContext('2d');
  let parts = [];
  let raf = null;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() { canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio; ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); }
  addEventListener('resize', resize); resize();

  function loop() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const now = performance.now();
    parts = parts.filter((p) => now - p.born < p.life);
    for (const p of parts) {
      const t = (now - p.born) / p.life;
      p.vy += p.g; p.x += p.vx; p.y += p.vy; p.vx *= 0.96; p.vy *= 0.96; p.rot += p.vr;
      ctx.globalAlpha = 1 - t * t;
      ctx.fillStyle = p.color;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      if (p.shape === 'rect') ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      else { ctx.beginPath(); ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    if (parts.length) raf = requestAnimationFrame(loop); else { raf = null; ctx.clearRect(0, 0, innerWidth, innerHeight); }
  }

  // Взрыв частиц из точки. spread — угол сектора, angle — направление (градусы, 270 = вверх)
  function burst(x, y, { count = 18, colors = ['#D7A832', '#101012', '#4F9A72'], speed = 4.2, spread = 70, angle = 270, life = 700, size = 5, gravity = 0.18, shapes = ['circle', 'rect'] } = {}) {
    if (reduced()) return;
    for (let i = 0; i < count; i++) {
      const a = ((angle + (Math.random() - 0.5) * spread) * Math.PI) / 180;
      const v = speed * (0.55 + Math.random() * 0.8);
      parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: gravity, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
        color: colors[i % colors.length], size: size * (0.6 + Math.random() * 0.8), life: life * (0.8 + Math.random() * 0.5), born: performance.now(), shape: shapes[i % shapes.length] });
    }
    if (!raf) raf = requestAnimationFrame(loop);
  }

  // Две «пушки» с боков — финальный экран, ранг A и выше
  function cannons(strength = 1) {
    if (reduced()) return;
    const y = innerHeight * 0.55;
    burst(0, y, { count: Math.round(45 * strength), angle: 300, spread: 55, speed: 9, life: 1500, size: 7, gravity: 0.22, shapes: ['rect', 'rect', 'circle'] });
    burst(innerWidth, y, { count: Math.round(45 * strength), angle: 240, spread: 55, speed: 9, life: 1500, size: 7, gravity: 0.22, shapes: ['rect', 'rect', 'circle'] });
  }

  // Докрутка числа: easeOutExpo, целые значения
  function countUp(el, to, { duration = 1200, from = 0, suffix = '' } = {}) {
    return new Promise((resolve) => {
      if (reduced()) { el.textContent = to + suffix; return resolve(); }
      const t0 = performance.now();
      const tick = () => {
        const t = Math.min(1, (performance.now() - t0) / duration);
        const e = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
        el.textContent = Math.round(from + (to - from) * e) + suffix;
        if (t < 1) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  // Плавающая подпись («+PERFECT», «×2») из точки, уходит вверх и тает
  function floatLabel(x, y, text, cls = '') {
    const el = document.createElement('div');
    el.className = `float-label ${cls}`; el.textContent = text;
    el.style.left = `${x}px`; el.style.top = `${y}px`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  window.FX = { burst, cannons, countUp, floatLabel, wait, reduced };
})();
