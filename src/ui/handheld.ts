import * as THREE from 'three';
import type { Item, Location, Order } from '../shared/contract';
import type { ScanTarget } from './scene/warehouse';

// Wat de speler in first person vasthoudt: 1 = handscanner, 2 = tablet met de WMS-app.
// De scanner legt elke scan voor aan de WMS (onScan) en toont het antwoord; wat er op een locatie ligt
// leest hij uit de WMS-gegevens die via setData() binnenkomen. Het beeld van de tablet is de WMS-app zelf.

export type Tool = 'scanner' | 'tablet';
export type WmsSnapshot = { mode: 'live' | 'mock'; locations: Location[]; stock: Item[]; orders: Order[] };

interface Options {
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /** Wortel waartegen de laser wordt geraycast (de scène). */
  world: THREE.Object3D;
  scanTargets: ScanTarget[];
  /** Een label is gelezen: leg de scan voor aan de WMS. null = er hoeft niets te gebeuren (alleen kijken). */
  onScan?: (code: string) => Promise<ScanReply | null>;
}

/** Breekt tekst af op de breedte van het scherm. */
function wrap(g: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && g.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** Antwoord van de WMS op een scan. */
export type ScanReply = { ok: boolean; text: string };
type Scan = { code: string | null; time: string; reply?: ScanReply | 'wait' };
/** Afmetingen van het tabletscherm in meters. */
export const TABLET_SCREEN = { w: 0.2368, h: 0.148 };
const SCAN_RANGE = 8;
const SCAN_CONE = 0.075; // rad: hoe nauwkeurig je op een label moet richten
const SEAT_SHIFT = 0.08; // zittend houd je de scanner iets verder naar rechts, naast het stuur

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

export function createHandheld({ camera, canvas, world, scanTargets, onScan }: Options) {
  const root = new THREE.Group();
  camera.add(root);

  const shell = new THREE.MeshStandardMaterial({ color: '#25272b', roughness: 0.55, metalness: 0.1 });
  const rubberMat = new THREE.MeshStandardMaterial({ color: '#111214', roughness: 0.9 });
  const accent = new THREE.MeshStandardMaterial({ color: '#f2b705', roughness: 0.5 });
  const glove = new THREE.MeshStandardMaterial({ color: '#4a4d52', roughness: 0.92 }); // zelfde handschoen als het personage
  const sleeve = new THREE.MeshStandardMaterial({ color: '#ee5a12', roughness: 0.85 });
  const band = new THREE.MeshStandardMaterial({ color: '#cfd3d6', roughness: 0.35, metalness: 0.6 });

  // Zittend (heftruck) houd je het apparaat in één hand, de rechter; die arm is dan van het eigen lichaam.
  const seatedHidden: THREE.Object3D[] = []; // onderarmen en de linkerhand aan de tablet
  const scannerWrist = new THREE.Object3D(); // waar de pols van de rechterhand zit
  const tabletWrist = new THREE.Object3D();

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
    const arm = forearm(new THREE.Vector3(0.03, -0.05, 0.06), new THREE.Vector3(0.13, -0.3, 0.4), sleeve, band);
    scannerWrist.position.set(0.03, -0.05, 0.06);
    grip.add(arm, scannerWrist);
    seatedHidden.push(arm);
    scannerRig.add(grip);
  }

  // Laser (in cameraruimte)
  const laserMat = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  laserMat.color.setRGB(5, 0.25, 0.2);
  const beam = mesh(new THREE.BoxGeometry(0.0025, 0.0025, 1), laserMat);
  const line = mesh(new THREE.PlaneGeometry(1, 1), laserMat);
  beam.visible = line.visible = false;
  camera.add(beam, line); // niet aan root: die draait zittend los van de kijkrichting

  // ---------- Tablet ----------
  const tabletRig = new THREE.Group();
  root.add(tabletRig);
  // Het beeld zelf is de WMS-app (iframe), die er als HTML-laag overheen ligt: zie src/ui/tabletApp.ts.
  const tabletDisplay = mesh(new THREE.PlaneGeometry(TABLET_SCREEN.w, TABLET_SCREEN.h), new THREE.MeshBasicMaterial({ color: '#0b0d10', fog: false }), 0, 0, 0.0065);
  {
    const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
    tabletRig.add(mesh(box(0.272, 0.182, 0.012), shell));
    for (const x of [-0.13, 0.13]) for (const y of [-0.085, 0.085]) tabletRig.add(mesh(box(0.03, 0.03, 0.017), rubberMat, x, y, 0));
    tabletRig.add(mesh(new THREE.PlaneGeometry(0.256, 0.166), rubberMat, 0, 0, 0.0062));
    tabletRig.add(tabletDisplay);
    for (const s of [-1, 1]) {
      const thumb = mesh(new THREE.CapsuleGeometry(0.011, 0.03, 6, 12), glove, s * 0.133, -0.04, 0.015);
      thumb.rotation.z = s * 0.3;
      const palm = mesh(new THREE.SphereGeometry(1, 20, 14), glove, s * 0.156, -0.062, -0.008);
      palm.scale.set(0.028, 0.05, 0.028);
      const arm = forearm(new THREE.Vector3(s * 0.16, -0.09, 0), new THREE.Vector3(s * 0.26, -0.36, 0.3), sleeve, band);
      tabletRig.add(thumb, palm, arm);
      seatedHidden.push(arm);
      if (s < 0) seatedHidden.push(thumb, palm); // links
    }
    tabletWrist.position.set(0.16, -0.09, 0);
    tabletRig.add(tabletWrist);
  }

  // Richtpunt
  const crosshair = document.createElement('div');
  crosshair.style.cssText =
    'position:fixed;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:rgba(255,255,255,.75);box-shadow:0 0 0 1px rgba(0,0,0,.5);pointer-events:none;display:none';
  document.body.appendChild(crosshair);

  // ---------- Toestand ----------
  let tool: Tool = 'scanner';
  let active = false;
  let focus = false;
  let data: WmsSnapshot = { mode: 'mock', locations: [], stock: [], orders: [] };
  let lastScan: Scan | null = null;
  let scanTimer = 0;
  let bobPhase = 0;
  let seated = false;
  let scans = 0;
  let seatK = 0; // 0..1 overgang naar de eenhandige houding
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
      const reply = lastScan.reply;
      lines.slice(0, reply ? 2 : 5).forEach((s, i) => {
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
      if (reply) {
        // Antwoord van de WMS op deze scan
        g.fillStyle = reply === 'wait' ? '#24384d' : reply.ok ? '#1e6b35' : '#8c1d18';
        g.beginPath();
        g.roundRect(12, 304, w - 24, 106, 10);
        g.fill();
        g.fillStyle = '#fff';
        g.font = 'bold 20px Arial';
        wrap(g, reply === 'wait' ? 'De WMS verwerkt de scan…' : reply.text, w - 48)
          .slice(0, 4)
          .forEach((t, i) => g.fillText(t, 24, 324 + i * 23));
      }
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
  const nose = new THREE.Vector3();

  function scan() {
    camera.getWorldPosition(camPos);
    camera.getWorldDirection(camDir);

    // afstand tot het eerste oppervlak, voor de laserlijn
    raycaster.set(camPos, camDir);
    raycaster.far = 40;
    let dist = 12;
    raycaster.camera = camera; // verplicht zodra er sprites (naam- en taaklabels) in de scène staan
    for (const hit of raycaster.intersectObject(world, true)) {
      if ((hit.object as THREE.Sprite).isSprite) continue; // zwevende labels houden de laser niet tegen
      let o: THREE.Object3D | null = hit.object;
      let hidden = false;
      while (o && o !== camera) {
        if (!o.visible) hidden = true; // de raycaster raakt ook onzichtbare objecten (eigen lichaam, lasers van anderen)
        o = o.parent;
      }
      if (o === camera || hidden) continue; // eigen handen/apparaat
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

    const current: Scan = { code: best ? best.code : null, time: clock() };
    lastScan = current;
    scans++;
    scanTimer = 0.4;
    beep(!!best);
    if (best && onScan) {
      // De scan gaat naar de WMS; het antwoord verschijnt op het schermpje.
      current.reply = 'wait';
      const show = (reply: ScanReply | null) => {
        current.reply = reply ?? undefined;
        if (lastScan !== current) return; // er is alweer iets anders gescand
        if (reply && !reply.ok) beep(false);
        drawScanner();
      };
      onScan(best.code).then(show, (err: unknown) => show({ ok: false, text: err instanceof Error ? err.message : String(err) }));
    }
    drawScanner();

    // laserstraal van de scannerneus naar het richtpunt, plus de lijn op het oppervlak
    const end = tmp.set(0, 0, -(dist - 0.01));
    nose.copy(NOSE);
    nose.x += SEAT_SHIFT * seatK;
    nose.applyQuaternion(root.quaternion);
    beam.position.copy(nose).add(end).multiplyScalar(0.5);
    beam.scale.z = nose.distanceTo(end);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), end.clone().sub(nose).normalize());
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
    if (e.code === 'KeyF') focus = !focus;
  });

  const listeners: ((t: Tool) => void)[] = [];
  function setTool(t: Tool) {
    if (t === tool) return;
    tool = t;
    focus = false;
    listeners.forEach((l) => l(t));
  }

  drawScanner();
  setInterval(drawScanner, 20000); // klokje bijwerken

  const tabletPos = new THREE.Vector3();
  const AXIS_X = new THREE.Vector3(1, 0, 0);
  const AXIS_Y = new THREE.Vector3(0, 1, 0);
  const qTmp = new THREE.Quaternion();

  return {
    /** Aantal keer gescand (voor andere spelers: die zien de laser). */
    get scans() {
      return scans;
    },
    get tool() {
      return tool;
    },
    setTool,
    /** Het beeldvlak van de tablet (voor de WMS-app die er als iframe overheen ligt). */
    tabletDisplay,
    /** Is de tablet nu in beeld? */
    get tabletVisible() {
      return active && tabletRig.visible;
    },
    /** Tablet dichtbij gehouden (F) om te lezen en te bedienen. */
    get focus() {
      return focus;
    },
    setFocus(on: boolean) {
      focus = on && active && tool === 'tablet';
    },
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
    /** Zittend in de heftruck: apparaat in de rechterhand, zonder eigen onderarmen (die tekent het lichaam). */
    setSeated(on: boolean) {
      seated = on;
      for (const o of seatedHidden) o.visible = !on;
    },
    /** Wereldpositie van de pols van de hand die het apparaat vasthoudt; false als er niets in beeld is. */
    wristWorld(out: THREE.Vector3) {
      const rig = tool === 'scanner' ? scannerRig : tabletRig;
      if (!active || !rig.visible) return false;
      (tool === 'scanner' ? scannerWrist : tabletWrist).getWorldPosition(out);
      return true;
    },
    setData(d: WmsSnapshot) {
      data = d;
      drawScanner();
    },
    /**
     * @param moving 0..1: hoe hard de speler loopt (voor de loopbeweging).
     * @param look kijkrichting vanaf de stoel (zittend): het apparaat blijft dan binnen armbereik.
     */
    update(dt: number, moving: number, look?: { yaw: number; pitch: number }) {
      const k = 1 - Math.exp(-dt * 12);
      seatK += ((seated ? 1 : 0) - seatK) * k;
      if (seated && look) {
        // De hand volgt je blik alleen zover de arm reikt; kijk je verder weg, dan schuift het apparaat uit beeld.
        const yaw = THREE.MathUtils.clamp(look.yaw, -1.2, 0.15);
        const pitch = THREE.MathUtils.clamp(look.pitch, -0.45, 0.35);
        root.quaternion
          .setFromAxisAngle(AXIS_X, -look.pitch)
          .multiply(qTmp.setFromAxisAngle(AXIS_Y, yaw - look.yaw))
          .multiply(qTmp.setFromAxisAngle(AXIS_X, pitch));
      } else {
        root.quaternion.identity();
      }
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
      scannerRig.position.set(0.16 + SEAT_SHIFT * seatK + bobX - aim * 0.03, -0.185 + bobY - (1 - raise.scanner) * 0.4 + aim * 0.03, -0.44 - aim * 0.05);
      scannerRig.rotation.set(0.78 - aim * 0.6, 0.3 - aim * 0.12, 0);
      beam.visible = line.visible = scanTimer > 0 && active;
      laserMat.opacity = Math.min(1, scanTimer / 0.12);
      windowMat.color.setRGB(scanTimer > 0 ? 5 : 0.23, 0.03, 0.03);

      // tablet: recht naar je toe (het iframe ligt er plat overheen), met F dichterbij om te bedienen
      tabletPos.set(bobX + 0.2 * seatK, focus ? 0 : -0.075, focus ? -0.175 : -0.3);
      tabletPos.y += bobY - (1 - raise.tablet) * 0.45;
      tabletRig.position.lerp(tabletPos, 1 - Math.exp(-dt * 14));
      tabletRig.rotation.y = -0.3 * seatK; // in één hand rechts: scherm naar je toe gedraaid
    },
  };
}
