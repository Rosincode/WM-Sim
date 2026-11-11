import * as THREE from 'three';
import { CSS3DObject, CSS3DRenderer } from 'three/addons/renderers/CSS3DRenderer.js';
import { TABLET_SCREEN } from './handheld';
import { createAppFrame, getAppUrl } from './wmsApp';

// De echte WMS-app op het scherm van de tablet. Een iframe kan niet als textuur in WebGL, dus het ligt als
// HTML-laag precies over het beeldvlak van de 3D-tablet (CSS3D) en beweegt met de tablet mee.
// In de hand is het alleen kijken; met F komt de tablet dichtbij en kun je de app bedienen.

/** Schermresolutie van de tablet in CSS-pixels (zelfde verhouding als het beeldvlak). */
const W = 1024;
const H = Math.round(W * (TABLET_SCREEN.h / TABLET_SCREEN.w));

const css = `
.tab3d { display: flex; flex-direction: column; width: ${W}px; height: ${H}px; background: #fff; overflow: hidden;
  font: 13px system-ui, sans-serif; }
.tab3d-bar { display: none; align-items: center; gap: 10px; padding: 4px 8px; background: #25272b; color: #cfd3d6; }
.tab3d.focus .tab3d-bar { display: flex; }
.tab3d-bar span { flex: 1; }
.tab3d-bar button { border: 0; border-radius: 4px; padding: 2px 10px; background: #c62828; color: #fff; font: inherit; cursor: pointer; }
.tab3d .wms-app { flex: 1; }
.tab3d:not(.focus) .wms-app form, .tab3d:not(.focus) .wms-app .note { display: none; }
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
  el.className = 'tab3d';
  el.innerHTML = `<div class="tab3d-bar"><span>Tablet · WMS-app — F of Esc: wegleggen</span><button title="Wegleggen">✕</button></div>`;
  const app = createAppFrame();
  el.appendChild(app.el);

  const renderer = new CSS3DRenderer();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.domElement.style.cssText += ';position:fixed;inset:0;z-index:5;pointer-events:none';
  document.body.appendChild(renderer.domElement);
  window.addEventListener('resize', () => renderer.setSize(window.innerWidth, window.innerHeight));

  // Eigen mini-scène: de matrix van het object volgt elke frame het beeldvlak van de tablet.
  const scene = new THREE.Scene();
  scene.matrixWorldAutoUpdate = false;
  const object = new CSS3DObject(el);
  object.matrixAutoUpdate = false;
  scene.add(object);
  el.style.pointerEvents = 'none';
  const scale = new THREE.Vector3().setScalar(TABLET_SCREEN.w / W);

  let focused = false;
  function close() {
    if (document.activeElement instanceof HTMLElement && el.contains(document.activeElement)) document.activeElement.blur();
    onClose();
  }
  el.querySelector('button')!.addEventListener('click', close);
  window.addEventListener('keydown', (e) => {
    if (focused && e.code === 'Escape') close();
  });

  return {
    /** Na het renderen van de scène aanroepen. @param focus tablet dichtbij (F): app is dan te bedienen. */
    update(tabletVisible: boolean, focus: boolean) {
      // Zonder adres blijft het ingebouwde overzicht staan; dichtbij kun je het adres invullen.
      const show = tabletVisible && (focus || getAppUrl() !== '');
      if (focus !== focused) {
        focused = focus;
        el.classList.toggle('focus', focus);
        el.style.pointerEvents = focus ? 'auto' : 'none';
        if (focus) document.exitPointerLock?.(); // muis vrij voor de app
        else if (document.activeElement instanceof HTMLElement && el.contains(document.activeElement)) document.activeElement.blur();
      }
      if (!show && !object.visible) return;
      object.visible = show;
      if (show) {
        app.show();
        display.updateWorldMatrix(true, false);
        object.matrixWorld.copy(display.matrixWorld).scale(scale);
      }
      renderer.render(scene, camera);
    },
  };
}
