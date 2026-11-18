// Maakt de stilstaande beelden van de rondleidingsvideo (src/sim/videoscan/beelden/*.jpg).
// Gebruik: start eerst een dev-server (npx vite --port 5189 --strictPort) en dan:
//   node src/ui/videoscan/capture.mjs [http://localhost:5189] [F09a,F10]
// Headless Edge met GPU; de pagina ?videoscan bouwt het koelhuis en zet per beeld de camera neer.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const base = process.argv[2] ?? 'http://localhost:5189';
const only = process.argv[3]?.split(',');
const out = resolve('src/sim/videoscan/beelden');
mkdirSync(out, { recursive: true });
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9341;
const profile = join(tmpdir(), 'wm-sim-videoscan-edge');

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--window-size=1280,720',
  '--no-first-run', '--disable-extensions', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(path, method = 'GET') {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
      if (r.ok) return r.json();
    } catch {}
    await sleep(200);
  }
  throw new Error('Edge reageert niet');
}

try {
  const target = await json(`/json/new?about:blank`, 'PUT');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

  await send('Page.enable');
  await send('Page.bringToFront');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${base}/?videoscan` });
  for (let i = 0; i < 600 && !(await evaluate('!!window.videoscan?.ready')); i++) await sleep(250);
  const shots = only ?? (await evaluate('window.videoscan.shots'));
  for (const shot of shots) {
    await evaluate(`window.videoscan.show(${JSON.stringify(shot)}).id`);
    await sleep(150);
    const { result } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
    writeFileSync(join(out, `${shot}.jpg`), Buffer.from(result.data, 'base64'));
    console.log('beeld', shot);
  }
  ws.close();
} finally {
  edge.kill();
}
