import * as THREE from 'three';
import type { Item, Location, Order } from '../shared/contract';
import type { ScanTarget } from './scene/warehouse';

// Wat de speler in first person vasthoudt: 1 = handscanner, 2 = tablet met WMS-overzicht.
// Alleen weergave: leest de WMS-gegevens die via setData() binnenkomen.

export type Tool = 'scanner' | 'tablet';
export type WmsSnapshot = { mode: 'live' | 'mock'; locations: Location[]; stock: Item[]; orders: Order[] };

interface Options {
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /** Wortel waartegen de laser wordt geraycast (de scène). */
  world: THREE.Object3D;
  scanTargets: ScanTarget[];
  /** F met de tablet in de hand: de WMS-app openen. Zonder deze optie haalt F de tablet dichterbij. */
  onOpenApp?: () => void;
}

const TABS = ['Voorraad', 'Orders', 'Locaties'] as const;
const SCAN_RANGE = 8;
const SCAN_CONE = 0.075; // rad: hoe nauwkeurig je op een label moet richten

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.frustumCulled = false;
  return m;
}

function screen(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return { g: c.getContext('2d')!, texture, w, h };
}

/** Onderarm (hesje met reflectiestrook) van pols naar buiten beeld. */
function forearm(from: THREE.Vector3, to: THREE.Vector3, sleeve: THREE.Material, band: THREE.Material) {
  const g = new THREE.Group();
  const len = from.distanceTo(to);
  g.add(mesh(new THREE.CylinderGeometry(0.034, 0.05, len, 16), sleeve));
  g.add(mesh(new THREE.CylinderGeometry(0.039, 0.041, 0.035, 16), band, 0, len * 0.22, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.02, 16), band, 0, len * 0.5 - 0.01, 0));
  g.position.copy(from).add(to).multiplyScalar(0.5);
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), from.clone().sub(to).normalize());
  return g;
}

export function createHandheld({ camera, canvas, world, scanTargets, onOpenApp }: Options) {
  const root = new THREE.Group();
  camera.add(root);

  const shell = new THREE.MeshStandardMaterial({ color: '#25272b', roughness: 0.55, metalness: 0.1 });
  const rubberMat = new THREE.MeshStandardMaterial({ color: '#111214', roughness: 0.9 });
  const accent = new THREE.MeshStandardMaterial({ color: '#f2b705', roughness: 0.5 });
  const glove = new THREE.MeshStandardMaterial({ color: '#2d3035', roughness: 0.92 });
  const sleeve = new THREE.MeshStandardMaterial({ color: '#ee5a12', roughness: 0.85 });
  const band = new THREE.MeshStandardMaterial({ color: '#cfd3d6', roughness: 0.35, metalness: 0.6 });

  // ---------- Scanner ----------
  const scannerRig = new THREE.Group();
  scannerRig.rotation.order = 'YXZ';
  root.add(scannerRig);
  const scanScreen = screen(320, 420);
  const windowMat = new THREE.MeshBasicMaterial({ color: '#3a0606' });
  {
    const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
    scannerRig.add(mesh(box(0.078, 0.034, 0.17), shell));
    scannerRig.add(mesh(box(0.07, 0.042, 0.034), shell, 0, 0.004, -0.096));
    scannerRig.add(mesh(box(0.054, 0.02, 0.002), windowMat, 0, 0.004, -0.114));
    scannerRig.add(mesh(box(0.083, 0.039, 0.012), accent, 0, 0, 0.082));
    scannerRig.add(mesh(box(0.083, 0.039, 0.01), accent, 0, 0, -0.074));

    const display = mesh(new THREE.PlaneGeometry(0.064, 0.084), new THREE.MeshBasicMaterial({ map: scanScreen.texture, fog: false }), 0, 0.0176, -0.022);
    display.rotation.x = -Math.PI / 2;
    scannerRig.add(display);
    scannerRig.add(mesh(box(0.07, 0.002, 0.09), rubberMat, 0, 0.0165, -0.022));

    // toetsenblok
    const keys = new THREE.Group();
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 4; c++)
        keys.add(mesh(box(0.012, 0.003, 0.009), r === 0 && c === 3 ? accent : rubberMat, -0.0225 + c * 0.015, 0.018, 0.034 + r * 0.013));
    scannerRig.add(keys);

    // pistoolgreep met hand
    const grip = new THREE.Group();
    grip.position.set(0, -0.072, 0.03);
    grip.rotation.x = 0.28;
    grip.add(mesh(box(0.036, 0.125, 0.046), rubberMat));
    grip.add(mesh(box(0.012, 0.032, 0.014), accent, 0, 0.036, -0.028));
    const finger = new THREE.CapsuleGeometry(0.0118, 0.05, 6, 12);
    [0.032, 0.008, -0.016, -0.04].forEach((y, i) => {
      const f = mesh(finger, glove, 0.004, y, -0.03 - (i === 0 ? 0.006 : 0));
      f.rotation.z = Math.PI / 2;
      grip.add(f);
    });
    const palm = mesh(new THREE.SphereGeometry(1, 20, 14), glove, 0.022, -0.008, 0.034);
    palm.scale.set(0.044, 0.058, 0.04);
    grip.add(palm);
    const thumb = mesh(new THREE.CapsuleGeometry(0.0125, 0.046, 6, 12), glove, -0.027, 0.03, 0.004);
    thumb.rotation.x = -1.0;
    grip.add(thumb);
    grip.add(forearm(new THREE.Vector3(0.03, -0.05, 0.06), new THREE.Vector3(0.13, -0.3, 0.4), sleeve, band));
    scannerRig.add(grip);
  }

  // Laser (in cameraruimte)
  const laserMat = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  laserMat.color.setRGB(5, 0.25, 0.2);
  const beam = mesh(new THREE.BoxGeometry(0.0025, 0.0025, 1), laserMat);
  const line = mesh(new THREE.PlaneGeometry(1, 1), laserMat);
  beam.visible = line.visible = false;
  root.add(beam, line);

  // ---------- Tablet ----------
  const tabletRig = new THREE.Group();
  root.add(tabletRig);
  const tabScreen = screen(1280, 800);
  {
    const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
    tabletRig.add(mesh(box(0.272, 0.182, 0.012), shell));
    for (const x of [-0.13, 0.13]) for (const y of [-0.085, 0.085]) tabletRig.add(mesh(box(0.03, 0.03, 0.017), rubberMat, x, y, 0));
    tabletRig.add(mesh(new THREE.PlaneGeometry(0.256, 0.166), rubberMat, 0, 0, 0.0062));
    tabletRig.add(mesh(new THREE.PlaneGeometry(0.2368, 0.148), new THREE.MeshBasicMaterial({ map: tabScreen.texture, fog: false }), 0, 0, 0.0065));
    for (const s of [-1, 1]) {
      const thumb = mesh(new THREE.CapsuleGeometry(0.011, 0.03, 6, 12), glove, s * 0.133, -0.04, 0.015);
      thumb.rotation.z = s * 0.3;
      const palm = mesh(new THREE.SphereGeometry(1, 20, 14), glove, s * 0.156, -0.062, -0.008);
      palm.scale.set(0.028, 0.05, 0.028);
      tabletRig.add(thumb, palm);
      tabletRig.add(forearm(new THREE.Vector3(s * 0.16, -0.09, 0), new THREE.Vector3(s * 0.26, -0.36, 0.3), sleeve, band));
    }
  }

  // Richtpunt
  const crosshair = document.createElement('div');
  crosshair.style.cssText =
    'position:fixed;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:rgba(255,255,255,.75);box-shadow:0 0 0 1px rgba(0,0,0,.5);pointer-events:none;display:none';
  document.body.appendChild(crosshair);

  // ---------- Toestand ----------
  let tool: Tool = 'scanner';
  let active = false;
  let tab = 0;
  let focus = false;
  let data: WmsSnapshot = { mode: 'mock', locations: [], stock: [], orders: [] };
  let lastScan: { code: string | null; time: string } | null = null;
  let scanTimer = 0;
  let bobPhase = 0;
  const raise = { scanner: 0, tablet: 0 };

  const stockAt = (id: string) => data.stock.filter((s) => s.locationId === id);
  const clock = () => new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });

  // ---------- Schermen tekenen ----------
  function drawScanner() {
    const { g, w, h, texture } = scanScreen;
    g.fillStyle = '#0d1b2a';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#1b4f9c';
    g.fillRect(0, 0, w, 54);
    g.fillStyle = '#fff';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.font = 'bold 26px Arial';
    g.fillText('WMS Scan', 14, 28);
    g.textAlign = 'right';
    g.font = '22px Arial';
    g.fillText(clock(), w - 14, 28);
    g.textAlign = 'left';

    if (!lastScan) {
      g.fillStyle = '#9fb3c8';
      g.font = '26px Arial';
      g.fillText('Richt op een', 20, 150);
      g.fillText('locatielabel', 20, 186);
      g.fillText('en klik om te', 20, 222);
      g.fillText('scannen.', 20, 258);
    } else if (!lastScan.code) {
      g.fillStyle = '#ff8a80';
      g.font = 'bold 34px Arial';
      g.fillText('Geen barcode', 20, 150);
      g.fillStyle = '#9fb3c8';
      g.font = '24px Arial';
      g.fillText('Richt dichter op', 20, 200);
      g.fillText('het label.', 20, 232);
    } else {
      const loc = data.locations.find((l) => l.id === lastScan!.code);
      g.fillStyle = '#7fd38a';
      g.font = '22px Arial';
      g.fillText(`✓ Gescand ${lastScan.time}`, 20, 86);
      g.fillStyle = '#fff';
      g.font = 'bold 50px Arial';
      g.fillText(lastScan.code, 20, 134, w - 40);
      g.fillStyle = '#9fb3c8';
      g.font = '22px Arial';
      const kind = loc ? { dock: 'Dock', rack: 'Bulklocatie', pick: 'Picklocatie' }[loc.type] : 'Onbekend in WMS';
      g.fillText(kind, 20, 178);
      g.fillStyle = '#24384d';
      g.fillRect(20, 198, w - 40, 2);
      const lines = stockAt(lastScan.code);
      if (lines.length === 0) {
        g.fillStyle = '#9fb3c8';
        g.font = '26px Arial';
        g.fillText('Locatie is leeg', 20, 240);
      }
      lines.slice(0, 5).forEach((s, i) => {
        const y = 234 + i * 38;
        g.fillStyle = '#fff';
        g.font = '26px Arial';
        g.textAlign = 'left';
        g.fillText(s.sku, 20, y);
        g.textAlign = 'right';
        g.font = 'bold 26px Arial';
        g.fillText(`${s.qty} st`, w - 20, y);
        g.textAlign = 'left';
      });
    }
    texture.needsUpdate = true;
  }

  function drawTablet() {
    const { g, w, h, texture } = tabScreen;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillStyle = '#f2f4f7';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#17346b';
    g.fillRect(0, 0, w, 84);
    g.fillStyle = '#fff';
    g.font = 'bold 36px Arial';
    g.fillText('WM-Sim · Warehouse Management', 32, 43);
    const live = data.mode === 'live';
    g.fillStyle = live ? '#2e9e57' : '#e0a100';
    g.beginPath();
    g.roundRect(w - 330, 22, 170, 40, 20);
    g.fill();
    g.fillStyle = '#fff';
    g.font = 'bold 22px Arial';
    g.textAlign = 'center';
    g.fillText(live ? 'LIVE' : 'MOCK-MODUS', w - 245, 43);
    g.textAlign = 'right';
    g.font = '28px Arial';
    g.fillText(clock(), w - 32, 43);

    // tabbladen
    TABS.forEach((name, i) => {
      const x = 32 + i * 220;
      g.fillStyle = i === tab ? '#17346b' : '#dfe4ea';
      g.beginPath();
      g.roundRect(x, 104, 204, 52, 10);
      g.fill();
      g.fillStyle = i === tab ? '#fff' : '#39424e';
      g.font = 'bold 26px Arial';
      g.textAlign = 'center';
      g.fillText(name, x + 102, 131);
    });
    g.textAlign = 'right';
    g.fillStyle = '#7a8594';
    g.font = '20px Arial';
    g.fillText(onOpenApp ? 'Q: tabblad · F: WMS-app' : 'Q: tabblad · F: dichterbij', w - 32, 131);
    g.textAlign = 'left';

    const shelves = data.locations.filter((l) => l.type !== 'dock');
    const filled = new Set(data.stock.map((s) => s.locationId));

    const header = (cols: [string, number][], y: number) => {
      g.fillStyle = '#e3e8ef';
      g.fillRect(32, y - 24, 780, 48);
      g.fillStyle = '#39424e';
      g.font = 'bold 24px Arial';
      cols.forEach(([t, x]) => g.fillText(t, x, y));
    };
    const card = (x: number, y: number, title: string, value: string) => {
      g.fillStyle = '#fff';
      g.beginPath();
      g.roundRect(x, y, 370, 120, 12);
      g.fill();
      g.fillStyle = '#4d5866';
      g.font = 'bold 24px Arial';
      g.fillText(title, x + 22, y + 34);
      g.fillStyle = '#17346b';
      g.font = 'bold 48px Arial';
      g.fillText(value, x + 22, y + 82);
    };

    if (tab === 0) {
      header([['Locatie', 52], ['Artikel', 300], ['Aantal', 620]], 204);
      const rows = [...data.stock].sort((a, b) => a.locationId.localeCompare(b.locationId) || a.sku.localeCompare(b.sku));
      rows.slice(0, 10).forEach((s, i) => {
        const y = 260 + i * 50;
        if (i % 2) {
          g.fillStyle = '#e3e8ef';
          g.fillRect(32, y - 25, 780, 50);
        }
        g.fillStyle = '#0b1016';
        g.font = 'bold 30px Arial';
        g.fillText(s.locationId, 52, y);
        g.fillText(s.sku, 300, y);
        g.fillText(String(s.qty), 620, y);
      });
      if (rows.length > 10) {
        g.fillStyle = '#4d5866';
        g.font = 'bold 24px Arial';
        g.fillText(`+ ${rows.length - 10} regels meer`, 52, 260 + 10 * 50);
      }
      if (rows.length === 0) {
        g.fillStyle = '#7a8594';
        g.font = '26px Arial';
        g.fillText('Geen voorraad.', 52, 256);
      }
      card(860, 180, 'Totaal stuks', String(data.stock.reduce((n, s) => n + s.qty, 0)));
      card(860, 320, 'Artikelen', String(new Set(data.stock.map((s) => s.sku)).size));
      card(860, 460, 'Bezette locaties', `${shelves.filter((l) => filled.has(l.id)).length} / ${shelves.length}`);
      card(860, 600, 'Open orders', String(data.orders.length));
    } else if (tab === 1) {
      header([['Order', 52], ['Regels', 260], ['Status', 620]], 204);
      data.orders.slice(0, 10).forEach((o, i) => {
        const y = 260 + i * 50;
        g.fillStyle = '#0b1016';
        g.font = 'bold 28px Arial';
        g.fillText(o.id, 52, y);
        g.fillText(o.lines.map((l) => `${l.qty}× ${l.sku}`).join(', '), 260, y, 340);
        g.fillStyle = o.status === 'picking' ? '#c77700' : '#17346b';
        g.font = 'bold 28px Arial';
        g.fillText(o.status === 'picking' ? 'Wordt gepickt' : 'Open', 620, y);
      });
      if (data.orders.length === 0) {
        g.fillStyle = '#7a8594';
        g.font = '26px Arial';
        g.fillText('Geen open orders.', 52, 256);
      }
      card(860, 180, 'Open orders', String(data.orders.length));
      card(860, 320, 'In behandeling', String(data.orders.filter((o) => o.status === 'picking').length));
    } else {
      // plattegrond: per stellingrij de vakken per niveau, gekleurd naar voorraad
      const qtyAt = new Map<string, number>();
      for (const s of data.stock) qtyAt.set(s.locationId, (qtyAt.get(s.locationId) ?? 0) + s.qty);
      const rows = new Map<string, Location[]>();
      for (const l of shelves) {
        const key = l.id.split('-')[0];
        rows.set(key, [...(rows.get(key) ?? []), l]);
      }
      let y = 190;
      for (const [name, locs] of [...rows].slice(0, 5)) {
        g.fillStyle = '#17346b';
        g.font = 'bold 30px Arial';
        g.fillText(name, 40, y + 56);
        const bays = [...new Set(locs.map((l) => l.id.split('-')[1]))].sort();
        const levels = [...new Set(locs.map((l) => l.id.split('-')[2]))].sort().reverse();
        const cw = Math.min(150, 1080 / Math.max(1, bays.length));
        const ch = 108 / Math.max(1, levels.length);
        bays.forEach((b, bi) =>
          levels.forEach((lv, li) => {
            const q = qtyAt.get(`${name}-${b}-${lv}`) ?? 0;
            g.fillStyle = q === 0 ? '#dfe4ea' : q < 20 ? '#9cc5f0' : q < 40 ? '#4f8fd6' : '#1f5fae';
            g.beginPath();
            g.roundRect(120 + bi * cw, y + li * ch, cw - 8, ch - 6, 6);
            g.fill();
            g.fillStyle = q === 0 ? '#8b95a3' : '#fff';
            g.font = '20px Arial';
            g.textAlign = 'center';
            g.fillText(q === 0 ? `${b}-${lv}` : `${b}-${lv} · ${q}`, 120 + bi * cw + (cw - 8) / 2, y + li * ch + (ch - 6) / 2);
            g.textAlign = 'left';
          }),
        );
        y += 136;
      }
      g.fillStyle = '#7a8594';
      g.font = '22px Arial';
      const docks = data.locations.filter((l) => l.type === 'dock');
      g.fillText(docks.map((d) => `${d.id}: ${qtyAt.get(d.id) ?? 0} st`).join('   ·   '), 40, 760);
    }
    texture.needsUpdate = true;
  }

  // ---------- Scannen ----------
  let audio: AudioContext | null = null;
  function beep(ok: boolean) {
    try {
      audio ??= new AudioContext();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'square';
      osc.frequency.value = ok ? 2700 : 320;
      gain.gain.value = 0.06;
      osc.connect(gain).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + (ok ? 0.09 : 0.22));
    } catch {
      // geen geluid beschikbaar: stil doorgaan
    }
  }

  const raycaster = new THREE.Raycaster();
  const camPos = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const NOSE = new THREE.Vector3(0.115, -0.14, -0.5);

  function scan() {
    camera.getWorldPosition(camPos);
    camera.getWorldDirection(camDir);

    // afstand tot het eerste oppervlak, voor de laserlijn
    raycaster.set(camPos, camDir);
    raycaster.far = 40;
    let dist = 12;
    for (const hit of raycaster.intersectObject(world, true)) {
      let o: THREE.Object3D | null = hit.object;
      while (o && o !== camera) o = o.parent;
      if (o === camera) continue; // eigen handen/apparaat
      dist = hit.distance;
      break;
    }

    let best: ScanTarget | null = null;
    let bestAngle = SCAN_CONE;
    for (const t of scanTargets) {
      tmp.copy(t.position).sub(camPos);
      const d = tmp.length();
      if (d > SCAN_RANGE || d > dist + 0.3) continue; // te ver of iets ervoor
      const angle = tmp.divideScalar(d).angleTo(camDir);
      if (angle < bestAngle) {
        bestAngle = angle;
        best = t;
      }
    }

    lastScan = { code: best ? best.code : null, time: clock() };
    scanTimer = 0.4;
    beep(!!best);
    drawScanner();

    // laserstraal van de scannerneus naar het richtpunt, plus de lijn op het oppervlak
    const end = tmp.set(0, 0, -(dist - 0.01));
    beam.position.copy(NOSE).add(end).multiplyScalar(0.5);
    beam.scale.z = NOSE.distanceTo(end);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), end.clone().sub(NOSE).normalize());
    line.position.copy(end);
    line.scale.set(dist * 0.09, dist * 0.0022, 1);
  }

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !active || tool !== 'scanner') return;
    scan();
  });

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    if (!active || e.repeat) return;
    if (e.code === 'Digit1' || e.code === 'Numpad1') setTool('scanner');
    if (e.code === 'Digit2' || e.code === 'Numpad2') setTool('tablet');
    if (tool !== 'tablet') return;
    if (e.code === 'KeyF') {
      if (onOpenApp) onOpenApp();
      else focus = !focus;
    }
    if (e.code === 'KeyQ') {
      tab = (tab + 1) % TABS.length; // E is de actietoets van de processim
      drawTablet();
    }
  });

  const listeners: ((t: Tool) => void)[] = [];
  function setTool(t: Tool) {
    if (t === tool) return;
    tool = t;
    focus = false;
    listeners.forEach((l) => l(t));
  }

  drawScanner();
  drawTablet();
  setInterval(() => {
    // klokje bijwerken
    drawScanner();
    drawTablet();
  }, 20000);

  const tabletPos = new THREE.Vector3();

  return {
    get tool() {
      return tool;
    },
    setTool,
    onToolChange(l: (t: Tool) => void) {
      listeners.push(l);
    },
    /** Alleen zichtbaar in first person. */
    setActive(on: boolean) {
      active = on;
      if (!on) {
        raise.scanner = raise.tablet = 0;
        focus = false;
      }
    },
    setData(d: WmsSnapshot) {
      data = d;
      drawScanner();
      drawTablet();
    },
    /** @param moving 0..1: hoe hard de speler loopt (voor de loopbeweging). */
    update(dt: number, moving: number) {
      const k = 1 - Math.exp(-dt * 12);
      raise.scanner += ((active && tool === 'scanner' ? 1 : 0) - raise.scanner) * k;
      raise.tablet += ((active && tool === 'tablet' ? 1 : 0) - raise.tablet) * k;
      scannerRig.visible = raise.scanner > 0.02;
      tabletRig.visible = raise.tablet > 0.02;
      crosshair.style.display = active && tool === 'scanner' ? 'block' : 'none';

      bobPhase += dt * 9 * moving;
      const bobX = Math.sin(bobPhase) * 0.006 * moving;
      const bobY = -Math.abs(Math.cos(bobPhase)) * 0.008 * moving;

      // scanner: schuin omhoog zodat je het schermpje ziet; bij scannen even naar voren richten
      scanTimer = Math.max(0, scanTimer - dt);
      const aim = Math.min(1, scanTimer / 0.15);
      scannerRig.position.set(0.16 + bobX - aim * 0.03, -0.185 + bobY - (1 - raise.scanner) * 0.4 + aim * 0.03, -0.44 - aim * 0.05);
      scannerRig.rotation.set(0.78 - aim * 0.6, 0.3 - aim * 0.12, 0);
      beam.visible = line.visible = scanTimer > 0 && active;
      laserMat.opacity = Math.min(1, scanTimer / 0.12);
      windowMat.color.setRGB(scanTimer > 0 ? 5 : 0.23, 0.03, 0.03);

      // tablet: laag voor de borst, met F dichterbij om te lezen
      tabletPos.set(bobX, focus ? -0.02 : -0.135, focus ? -0.235 : -0.38);
      tabletPos.y += bobY - (1 - raise.tablet) * 0.45;
      tabletRig.position.lerp(tabletPos, 1 - Math.exp(-dt * 14));
      tabletRig.rotation.x += ((focus ? -0.06 : -0.42) - tabletRig.rotation.x) * k;
    },
  };
}
