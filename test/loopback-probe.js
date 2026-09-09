// Пробник WASAPI loopback: перебирает варианты setDisplayMediaRequestHandler и печатает результат.
const { app, BrowserWindow, session, desktopCapturer } = require('electron');
const path = require('path');
let mode = 'loopback';
app.whenReady().then(async () => {
  session.defaultSession.setDisplayMediaRequestHandler(async (req, cb) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      console.log('[probe] sources:', sources.length, 'mode:', mode);
      if (mode === 'loopback') cb({ video: sources[0], audio: 'loopback' });
      else if (mode === 'loopbackWithMute') cb({ video: sources[0], audio: 'loopbackWithMute' });
      else if (mode === 'novideo') cb({ audio: 'loopback' });
    } catch (e) { console.log('[probe] handler error', e.message); cb({}); }
  }, { useSystemPicker: false });
  const win = new BrowserWindow({ width: 300, height: 200, show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  win.webContents.on('console-message', (_e, _l, msg) => console.log('[renderer]', msg));
  await win.loadFile(path.join(__dirname, 'loopback-probe.html'));
  for (const m of ['loopback', 'loopbackWithMute', 'novideo']) {
    mode = m;
    const r = await win.webContents.executeJavaScript(`probe(${JSON.stringify(m)})`);
    console.log('[probe] result', m, JSON.stringify(r));
  }
  app.quit();
});
