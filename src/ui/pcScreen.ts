import * as THREE from 'three';
import { createAppFrame } from './wmsApp';

// Het scherm van de pc in het magazijn: alleen de echte WMS-app (iframe). Eén HTML-element in twee standen:
// - in de wereld: het ligt perspectivisch over het beeldvlak van de 3D-monitor, zodat je de app al ziet
//   als je langsloopt (alleen kijken; verborgen als er iets voor staat of je achter het scherm staat);
// - geopend (E bij de pc): groot midden in beeld en te bedienen. Sluit met Esc, E, het kruisje of weglopen.
// Een iframe kan niet als textuur in WebGL; daarom een HTML-laag bovenop het canvas.

/** Schermresolutie van de pc in CSS-pixels: full HD, zoals een gewone monitor (beeldvlak 0,7 m breed, 16:9). */
const W = 1920;
const H = 1080;
const SCREEN = { w: 0.7, h: 0.7 * (9 / 16) };
/** Verder weg dan dit (m) tonen we de app niet in de wereld. */
const MAX_DISTANCE = 14;

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
.pc-frame:not(.open) .wms-app form, .pc-frame:not(.open) .wms-app .note { display: none; }
`;

interface Options {
  camera: THREE.PerspectiveCamera;
  /** Het beeldvlak van de monitor in de 3D-scène. */
  display: THREE.Object3D;
  /** Wortel voor de zichtlijn-controle (de scène). */
  world: THREE.Object3D;
}

export function createPcScreen({ camera, display, world }: Options) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'pc-backdrop';
  const frame = document.createElement('div');
  frame.className = 'pc-frame';
  frame.innerHTML = `<div class="pc-bar"><span>Pc · WMS — Esc: verlaten</span><button title="Sluiten (Esc)">✕</button></div>`;
  const app = createAppFrame();
  frame.appendChild(app.el);
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
  const target = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();
  raycaster.camera = camera; // nodig voor sprites in de scène
  // linksboven, rechtsboven, rechtsonder, linksonder (gezien vanaf de voorkant)
  const CORNERS: [number, number][] = [[-0.5, 0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]];
  const px = [0, 0, 0, 0];
  const py = [0, 0, 0, 0];
  let blocked = false;
  let sightTimer = 0;

  /** Telt dit object als obstakel? Niet: onzichtbaar (eigen lichaam in first person), labels, doorzichtige
   *  markeringen, wat de speler vasthoudt en de pc zelf. */
  function solid(object: THREE.Object3D) {
    if ((object as THREE.Sprite).isSprite) return false;
    const mat = (object as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (mat && !Array.isArray(mat) && mat.transparent && mat.opacity < 0.6) return false;
    for (let o: THREE.Object3D | null = object; o; o = o.parent) {
      if (!o.visible || o === camera || o === display.parent) return false;
    }
    return true;
  }

  /** Staat er iets tussen de camera en het scherm? (midden en beide zijkanten) */
  function sightBlocked() {
    for (const sx of [0, -0.4, 0.4]) {
      target.set(sx * SCREEN.w, 0, 0).applyMatrix4(display.matrixWorld);
      const far = dir.copy(target).sub(camPos).length();
      raycaster.set(camPos, dir.divideScalar(far));
      raycaster.far = far - 0.05;
      for (const hit of raycaster.intersectObject(world, true)) {
        if (solid(hit.object)) return true;
      }
    }
    return false;
  }

  /** Legt het frame over het beeldvlak; false als het scherm niet (goed) in beeld is. */
  function placeInWorld(dt: number) {
    camera.updateWorldMatrix(true, false);
    display.updateWorldMatrix(true, false);
    camPos.setFromMatrixPosition(camera.matrixWorld);
    center.setFromMatrixPosition(display.matrixWorld);
    const distance = camPos.distanceTo(center);
    if (distance > MAX_DISTANCE) return false;
    normal.set(0, 0, 1).transformDirection(display.matrixWorld);
    if (normal.dot(dir.copy(camPos).sub(center)) < 0.2 * distance) return false; // achter of te schuin

    viewProj.copy(camera.matrixWorld).invert().premultiply(camera.projectionMatrix);
    for (let i = 0; i < 4; i++) {
      v.set(CORNERS[i][0] * SCREEN.w, CORNERS[i][1] * SCREEN.h, 0, 1).applyMatrix4(display.matrixWorld).applyMatrix4(viewProj);
      if (v.w < 0.05) return false; // hoek achter de camera
      px[i] = (v.x / v.w * 0.5 + 0.5) * window.innerWidth;
      py[i] = (-v.y / v.w * 0.5 + 0.5) * window.innerHeight;
    }

    if ((sightTimer -= dt) <= 0) {
      sightTimer = 0.2;
      blocked = sightBlocked();
    }
    if (blocked) return false;

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
    return true;
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
        setShown(true);
      } else {
        setShown(placeInWorld(dt));
      }
    },
  };
}
