import * as THREE from 'three';
import { createAppFrame } from './wmsApp';

// Het scherm van de pc's (de werkplek in het magazijn en de bureaus in het kantoor): alleen de echte WMS-app (iframe).
// Er is één app voor alle schermen: hij ligt op de monitor die het dichtst bij de camera staat. Eén HTML-element in twee standen:
// - in de wereld: het ligt perspectivisch over het beeldvlak van de 3D-monitor, zodat je de app al ziet
//   als je langsloopt (alleen kijken; verborgen als er iets voor staat of je achter het scherm staat);
// - geopend (E bij de pc): groot midden in beeld en te bedienen. Sluit met Esc, E, het kruisje of weglopen.
// Een iframe kan niet als textuur in WebGL; daarom een HTML-laag bovenop het canvas.

/** Schermresolutie van de pc in CSS-pixels: full HD, zoals een gewone monitor (beeldvlak 16:9). */
const W = 1920;
const H = 1080;
/** Beeldvlak van een monitor in de 3D-scène: een vlak van w × h meter, het beeld naar zijn +z-kant. */
export type PcDisplay = { object: THREE.Object3D; w: number; h: number };
/** Verder weg dan dit (m) tonen we de app niet in de wereld. */
const MAX_DISTANCE = 40;
/** Zoveel losse uitsparingen kan het scherm hebben voor wat de speler voor zich houdt (elk een eigen laag om de app). */
const MAX_CUTS = 6;

// ---------- Vlakke meetkunde voor de uitsparingen (schermpixels) ----------
type Pt = [number, number];
const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
/** Convex omhulsel (monotone chain). */
function hull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
    upper.push(p[i]);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
/** Oppervlakte met teken (het teken hangt af van de draairichting). */
function signedArea(poly: Pt[]) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
/** Knipt een veelhoek bij tot binnen een convexe veelhoek (Sutherland–Hodgman). */
function clipTo(poly: Pt[], clip: Pt[]): Pt[] {
  const s = Math.sign(signedArea(clip)) || 1;
  let out = poly;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const inside = (p: Pt) => s * cross(a, b, p) >= 0;
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length];
      const pin = inside(p), qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) {
        const cp = cross(a, b, p), cq = cross(a, b, q);
        const t = cp / (cp - cq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out;
}

const css = `
.pc-backdrop { position: fixed; inset: 0; z-index: 50; display: none; background: rgba(0,0,0,.5); }
.pc-backdrop.open { display: block; }
.pc-frame { position: fixed; left: 0; top: 0; z-index: 4; display: none; flex-direction: column; width: ${W}px; height: ${H}px;
  transform-origin: 0 0; background: #fff; overflow: hidden; pointer-events: none; font: 13px system-ui, sans-serif; }
.pc-frame.open { z-index: 51; pointer-events: auto; overflow: visible; box-shadow: 0 0 0 22px #15171a, 0 30px 90px 22px rgba(0,0,0,.6); }
.pc-bar { display: none; align-items: center; gap: 10px; padding: 6px 12px; background: #25272b; color: #cfd3d6; font-size: 18px; }
.pc-frame.open .pc-bar { display: flex; }
.pc-bar span { flex: 1; }
.pc-bar button { border: 0; border-radius: 4px; padding: 2px 9px; background: #c62828; color: #fff; font: inherit; cursor: pointer; }
.pc-frame .wms-app { flex: 1; }
.pc-frame:not(.open) { background: none; }
.pc-cut { display: flex; flex-direction: column; flex: 1; min-height: 0; background: #fff; }
.pc-frame:not(.open) .wms-app form, .pc-frame:not(.open) .wms-app .note { display: none; }
`;

interface Options {
  camera: THREE.PerspectiveCamera;
  /** De beeldvlakken van de monitoren in de 3D-scène (minstens één). */
  displays: PcDisplay[];
  /** Wortel voor de zichtlijn-controle (de scène). */
  world: THREE.Object3D;
}

export function createPcScreen({ camera, displays, world }: Options) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'pc-backdrop';
  const frame = document.createElement('div');
  frame.className = 'pc-frame';
  frame.innerHTML = `<div class="pc-bar"><span>Pc · WMS — Esc: verlaten</span><button title="Sluiten (Esc)">✕</button></div>`;
  const app = createAppFrame();
  // Lagen om de app, elk met één uitsparing voor iets dat de speler voor het scherm houdt (samen: alles wat ervoor zit)
  const cuts: { el: HTMLDivElement; clip: string }[] = [];
  let inner: HTMLElement = frame;
  for (let i = 0; i < MAX_CUTS; i++) {
    const el = document.createElement('div');
    el.className = 'pc-cut';
    inner.appendChild(el);
    inner = el;
    cuts.push({ el, clip: '' });
  }
  inner.appendChild(app.el);
  document.body.append(backdrop, frame);

  let open = false;
  let shown = false;
  let lastTransform = '';

  function setShown(value: boolean) {
    if (shown === value) return;
    shown = value;
    frame.style.display = shown ? 'flex' : 'none';
    if (shown) app.show();
  }
  function setTransform(t: string) {
    if (t === lastTransform) return;
    lastTransform = t;
    frame.style.transform = t;
  }
  function setOpen(value: boolean) {
    if (open === value) return;
    open = value;
    backdrop.classList.toggle('open', open);
    frame.classList.toggle('open', open);
    app.setUsable(open);
    if (open) {
      document.exitPointerLock?.(); // muis vrij om te klikken en te typen
    } else if (document.activeElement instanceof HTMLElement && frame.contains(document.activeElement)) {
      document.activeElement.blur(); // anders blijft de besturing denken dat je typt
    }
  }

  frame.querySelector('button')!.addEventListener('click', () => setOpen(false));
  backdrop.addEventListener('mousedown', () => setOpen(false)); // klik naast de monitor
  window.addEventListener('keydown', (e) => {
    if (open && e.code === 'Escape') setOpen(false);
  });

  // ---------- Stand "in de wereld": beeldvlak → schermpixels ----------
  const viewProj = new THREE.Matrix4();
  const camPos = new THREE.Vector3();
  const center = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const v = new THREE.Vector4();
  const vtx = new THREE.Vector3();
  const camInv = new THREE.Matrix4();
  const toCamera = new THREE.Matrix4();
  /** Van schermpixels terug naar pixels in het frame (de omgekeerde projectie van het geplaatste beeldvlak). */
  const unproject = new THREE.Matrix3();
  const local = new THREE.Vector3();
  const target = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();
  raycaster.camera = camera; // nodig voor sprites in de scène
  // linksboven, rechtsboven, rechtsonder, linksonder (gezien vanaf de voorkant)
  const CORNERS: [number, number][] = [[-0.5, 0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]];
  const px = [0, 0, 0, 0];
  const py = [0, 0, 0, 0];
  /** Per monitor: afstand tot de camera en of er iets voor staat (dat laatste wordt niet elk beeld bepaald). */
  const screens = displays.map((d) => ({ ...d, distance: 0, blocked: false, sightTimer: 0 }));
  type Screen = (typeof screens)[number];

  /** Telt dit object als obstakel? Niet: onzichtbaar (eigen lichaam in first person), labels, doorzichtige
   *  markeringen, wat de speler vasthoudt en de pc zelf. */
  function solid(object: THREE.Object3D, s: Screen) {
    if ((object as THREE.Sprite).isSprite) return false;
    const mat = (object as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (mat && !Array.isArray(mat) && mat.transparent && mat.opacity < 0.6) return false;
    for (let o: THREE.Object3D | null = object; o; o = o.parent) {
      if (!o.visible || o === camera || o === s.object.parent) return false;
    }
    return true;
  }

  /** Staat er iets tussen de camera en het scherm? (midden en beide zijkanten) */
  function sightBlocked(s: Screen) {
    for (const sx of [0, -0.4, 0.4]) {
      target.set(sx * s.w, 0, 0).applyMatrix4(s.object.matrixWorld);
      const far = dir.copy(target).sub(camPos).length();
      raycaster.set(camPos, dir.divideScalar(far));
      raycaster.far = far - 0.05;
      for (const hit of raycaster.intersectObject(world, true)) {
        if (solid(hit.object, s)) return true;
      }
    }
    return false;
  }

  /** Legt het frame over het beeldvlak van deze monitor; false als die niet (goed) in beeld is. */
  function place(s: Screen, dt: number) {
    const display = s.object;
    center.setFromMatrixPosition(display.matrixWorld);
    if (s.distance > MAX_DISTANCE) return false;
    normal.set(0, 0, 1).transformDirection(display.matrixWorld);
    if (normal.dot(dir.copy(camPos).sub(center)) < 0.2 * s.distance) return false; // achter of te schuin

    for (let i = 0; i < 4; i++) {
      v.set(CORNERS[i][0] * s.w, CORNERS[i][1] * s.h, 0, 1).applyMatrix4(display.matrixWorld).applyMatrix4(viewProj);
      if (v.w < 0.05) return false; // hoek achter de camera
      px[i] = (v.x / v.w * 0.5 + 0.5) * window.innerWidth;
      py[i] = (-v.y / v.w * 0.5 + 0.5) * window.innerHeight;
    }
    // Helemaal buiten beeld: geen zichtlijn nodig
    if (Math.max(...px) < 0 || Math.min(...px) > window.innerWidth || Math.max(...py) < 0 || Math.min(...py) > window.innerHeight) return false;

    if ((s.sightTimer -= dt) <= 0) {
      s.sightTimer = 0.2;
      s.blocked = sightBlocked(s);
    }
    if (s.blocked) return false;

    // Projectieve afbeelding van de rechthoek W×H op de vier hoekpunten
    const dx1 = px[1] - px[2], dx2 = px[3] - px[2], sx = px[0] - px[1] + px[2] - px[3];
    const dy1 = py[1] - py[2], dy2 = py[3] - py[2], sy = py[0] - py[1] + py[2] - py[3];
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) < 1) return false; // te klein of van opzij
    const g = (sx * dy2 - dx2 * sy) / det;
    const h = (dx1 * sy - sx * dy1) / det;
    const m = [
      (px[1] - px[0] + g * px[1]) / W, (py[1] - py[0] + g * py[1]) / W, 0, g / W,
      (px[3] - px[0] + h * px[3]) / H, (py[3] - py[0] + h * py[3]) / H, 0, h / H,
      0, 0, 1, 0,
      px[0], py[0], 0, 1,
    ];
    setTransform(`matrix3d(${m.map((n) => +n.toFixed(7)).join(',')})`);
    unproject.set(m[0], m[4], m[12], m[1], m[5], m[13], m[3], m[7], 1).invert();
    return true;
  }

  function setCut(i: number, clip: string) {
    const c = cuts[i];
    if (c.clip === clip) return;
    c.clip = clip;
    c.el.style.clipPath = clip;
  }

  /** Omtrek op het scherm van wat de speler voor zich houdt (scanner, tablet, handen: hangt aan de camera), per onderdeel. */
  function heldOutlines(): Pt[][] {
    const groups = new Map<THREE.Object3D, Pt[]>();
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    camera.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material;
      if (Array.isArray(mat) || mat.transparent) return; // laserstraal
      const pos = mesh.geometry.getAttribute('position');
      if (!pos) return;
      toCamera.multiplyMatrices(camInv, mesh.matrixWorld);
      let pts = groups.get(mesh.parent!);
      if (!pts) groups.set(mesh.parent!, (pts = []));
      for (let i = 0; i < pos.count; i++) {
        vtx.fromBufferAttribute(pos, i).applyMatrix4(toCamera);
        if (vtx.z > -0.02) {
          // achter de camera (een onderarm): ver buiten beeld in die richting
          pts.push([cx + vtx.x * 1e5, cy - vtx.y * 1e5]);
          continue;
        }
        vtx.applyMatrix4(camera.projectionMatrix);
        pts.push([(vtx.x * 0.5 + 0.5) * window.innerWidth, (-vtx.y * 0.5 + 0.5) * window.innerHeight]);
      }
    });
    // Onderdelen die samen nauwelijks meer ruimte innemen dan los worden één uitsparing; nooit meer dan er lagen zijn
    const hulls = [...groups.values()].map(hull).filter((h) => h.length >= 3);
    const areas = hulls.map((h) => Math.abs(signedArea(h)));
    for (;;) {
      let best = Infinity, bi = -1, bj = -1;
      let bh: Pt[] = [];
      for (let i = 0; i < hulls.length; i++)
        for (let j = i + 1; j < hulls.length; j++) {
          const h = hull(hulls[i].concat(hulls[j]));
          const cost = Math.abs(signedArea(h)) - areas[i] - areas[j];
          if (cost < best) [best, bi, bj, bh] = [cost, i, j, h];
        }
      if (bi < 0 || (best > 0 && hulls.length <= MAX_CUTS)) break;
      hulls[bi] = bh;
      areas[bi] = Math.abs(signedArea(bh));
      hulls.splice(bj, 1);
      areas.splice(bj, 1);
    }
    return hulls;
  }

  /** Snijdt uit het scherm wat de speler ervoor houdt: dat zit in de 3D-scène, en de app ligt als HTML-laag óver het canvas. */
  function cutHeld() {
    const quad: Pt[] = [0, 1, 2, 3].map((i) => [px[i], py[i]]);
    let n = 0;
    for (const outline of heldOutlines()) {
      const part = clipTo(outline, quad);
      if (part.length < 3) continue;
      const d = part
        .map(([x, y], i) => {
          local.set(x, y, 1).applyMatrix3(unproject);
          return `${i ? 'L' : 'M'}${(local.x / local.z).toFixed(1)} ${(local.y / local.z).toFixed(1)}`;
        })
        .join('');
      setCut(n++, `path(evenodd, "M-10 -10H${W + 10}V${H + 10}H-10Z${d}Z")`);
    }
    while (n < MAX_CUTS) setCut(n++, '');
  }

  /** Legt het frame op de dichtstbijzijnde monitor die in beeld is; false als er geen te zien is. */
  function placeInWorld(dt: number) {
    camera.updateWorldMatrix(true, true); // ook wat de speler vasthoudt, voor de uitsparingen
    camPos.setFromMatrixPosition(camera.matrixWorld);
    camInv.copy(camera.matrixWorld).invert();
    viewProj.copy(camera.matrixWorld).invert().premultiply(camera.projectionMatrix);
    for (const s of screens) {
      s.object.updateWorldMatrix(true, false);
      s.distance = center.setFromMatrixPosition(s.object.matrixWorld).distanceTo(camPos);
    }
    screens.sort((a, b) => a.distance - b.distance);
    for (const s of screens)
      if (place(s, dt)) {
        cutHeld();
        return true;
      }
    return false;
  }

  return {
    get isOpen() {
      return open;
    },
    open: () => setOpen(true),
    close: () => setOpen(false),
    /** Elke frame aanroepen (na het bijwerken van de camera). */
    update(dt: number) {
      if (open) {
        const s = Math.min((window.innerWidth * 0.92) / W, (window.innerHeight * 0.86) / H, 1);
        const x = Math.round((window.innerWidth - W * s) / 2);
        const y = Math.round((window.innerHeight - H * s) / 2);
        setTransform(`translate(${x}px,${y}px) scale(${s.toFixed(4)})`);
        for (let i = 0; i < MAX_CUTS; i++) setCut(i, ''); // groot geopend ligt hij overal bovenop
        setShown(true);
      } else {
        setShown(placeInWorld(dt));
      }
    },
  };
}
