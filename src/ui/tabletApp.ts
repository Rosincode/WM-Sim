import * as THREE from 'three';
import { TABLET_SCREEN } from './handheld';
import { createAppFrame } from './wmsApp';

// De echte WMS-app op het scherm van de tablet. Een iframe kan niet als textuur in WebGL, dus het ligt als
// HTML-laag over het beeldvlak van de 3D-tablet. De tablet wordt recht naar de camera gehouden, waardoor
// het scherm op beeld een rechthoek is: het iframe wordt alleen verschoven en geschaald (2D, geen 3D-transform).
// In de hand is het alleen kijken; met F komt de tablet dichtbij en kun je de app bedienen.

/** Schermresolutie van de tablet in CSS-pixels (zelfde verhouding als het beeldvlak). */
const W = 1024;
const H = Math.round(W * (TABLET_SCREEN.h / TABLET_SCREEN.w));

const css = `
.tab2d { position: fixed; left: 0; top: 0; z-index: 5; display: none; flex-direction: column; width: ${W}px; height: ${H}px;
  transform-origin: 0 0; background: #fff; overflow: hidden; pointer-events: none; font: 13px system-ui, sans-serif; }
.tab2d.focus { pointer-events: auto; }
.tab2d-bar { display: none; align-items: center; gap: 10px; padding: 4px 8px; background: #25272b; color: #cfd3d6; }
.tab2d.focus .tab2d-bar { display: flex; }
.tab2d-bar span { flex: 1; }
.tab2d-bar button { border: 0; border-radius: 4px; padding: 2px 10px; background: #c62828; color: #fff; font: inherit; cursor: pointer; }
.tab2d .wms-app { flex: 1; }
.tab2d:not(.focus) .wms-app form, .tab2d:not(.focus) .wms-app .note { display: none; }
`;

interface Options {
  camera: THREE.PerspectiveCamera;
  /** Het beeldvlak van de tablet in de 3D-scène. */
  display: THREE.Object3D;
  /** De speler legt de tablet weg via het kruisje of Esc. */
  onClose: () => void;
}

export function createTabletApp({ camera, display, onClose }: Options) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.className = 'tab2d';
  el.innerHTML = `<div class="tab2d-bar"><span>Tablet · WMS — F of Esc: wegleggen</span><button title="Wegleggen">✕</button></div>`;
  const app = createAppFrame();
  el.appendChild(app.el);
  document.body.appendChild(el);

  const blur = () => {
    if (document.activeElement instanceof HTMLElement && el.contains(document.activeElement)) document.activeElement.blur();
  };
  let focused = false;
  let shown = false;
  let lastTransform = '';
  function close() {
    blur();
    onClose();
  }
  el.querySelector('button')!.addEventListener('click', close);
  window.addEventListener('keydown', (e) => {
    if (focused && e.code === 'Escape') close();
  });

  const corner = new THREE.Vector3();

  return {
    /** Na het renderen van de scène aanroepen. @param focus tablet dichtbij (F): app is dan te bedienen. */
    update(tabletVisible: boolean, focus: boolean) {
      if (focus !== focused) {
        focused = focus;
        el.classList.toggle('focus', focus);
        if (focus) document.exitPointerLock?.(); // muis vrij voor de app
        else blur(); // toetsen weer naar de game
      }
      if (tabletVisible !== shown) {
        shown = tabletVisible;
        el.style.display = shown ? 'flex' : 'none';
        if (shown) app.show();
      }
      if (!shown) return;

      // Hoeken van het beeldvlak naar schermpixels; de omhullende rechthoek bepaalt plaats en schaal.
      display.updateWorldMatrix(true, false);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) {
        corner.set(sx * TABLET_SCREEN.w, sy * TABLET_SCREEN.h, 0).applyMatrix4(display.matrixWorld).project(camera);
        const x = (corner.x * 0.5 + 0.5) * window.innerWidth;
        const y = (-corner.y * 0.5 + 0.5) * window.innerHeight;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      // Op hele pixels en kleine schaalstappen afronden: geen trillend beeld tijdens het lopen
      const t = `translate(${Math.round(minX)}px,${Math.round(minY)}px) scale(${((maxX - minX) / W).toFixed(3)},${((maxY - minY) / H).toFixed(3)})`;
      if (t !== lastTransform) {
        lastTransform = t;
        el.style.transform = t;
      }
    },
  };
}
