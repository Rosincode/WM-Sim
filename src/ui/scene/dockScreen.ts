import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { STYLE, onTop } from './style';

// Het aanraakscherm naast elke dockdeur: de chauffeur meldt zich er aan en meldt er dat hij klaar is met
// lossen of laden. Het scherm kijkt naar +z. Alleen weergave; de stand komt uit src/sim/drivers.ts.

export type DockScreenState = {
  dock: string;
  /** Het nummer van de vrachtwagen aan het dock, of '' als het dock vrij is. */
  truck: string;
  /** Wat de wagen komt doen. */
  job: 'lossen' | 'laden';
  status: string;
  /** De twee knoppen: aangemeld, en klaar met lossen of laden. */
  checkedIn: boolean;
  done: boolean;
};

const housing = new RoundedBoxGeometry(0.42, 0.32, 0.05, 3, 0.02);
const glass = new THREE.PlaneGeometry(0.38, 0.28);
const W = 512;
const H = 376;

export function createDockScreen() {
  const group = new THREE.Group();
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const back = new THREE.Mesh(housing, STYLE.black);
  back.receiveShadow = true;
  // een scherm geeft zelf licht en mag een (canvas)texture hebben
  const face = new THREE.Mesh(glass, onTop(new THREE.MeshBasicMaterial({ map: texture })));
  face.position.z = 0.0255;
  group.add(back, face);

  function button(x: number, text: string, on: boolean) {
    g.fillStyle = on ? '#2e9d57' : '#263445';
    g.beginPath();
    g.roundRect(x, 250, 228, 104, 16);
    g.fill();
    g.fillStyle = on ? '#ffffff' : '#9fb0c3';
    g.font = 'bold 30px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const lines = text.split('\n');
    lines.forEach((line, i) => g.fillText(line, x + 114, 302 + (i - (lines.length - 1) / 2) * 34, 210));
  }

  let current = '';
  return {
    group,
    /** Tekent het scherm alleen opnieuw als de stand verandert. */
    set(s: DockScreenState) {
      const key = JSON.stringify(s);
      if (key === current) return;
      current = key;
      g.fillStyle = '#0f1722';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#17346b';
      g.fillRect(0, 0, W, 78);
      g.fillStyle = '#ffffff';
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      g.font = 'bold 44px system-ui, sans-serif';
      g.fillText(s.dock, 24, 42);
      g.textAlign = 'right';
      g.font = 'bold 34px system-ui, sans-serif';
      g.fillText(s.truck ? `${s.truck} · ${s.job}` : 'vrij', W - 24, 42, 290);
      g.textAlign = 'center';
      g.fillStyle = s.truck ? '#e8eef5' : '#7d8b9a';
      g.font = '32px system-ui, sans-serif';
      const words = s.status.split(' ');
      const lines: string[] = [''];
      for (const w of words) {
        const next = lines[lines.length - 1] ? `${lines[lines.length - 1]} ${w}` : w;
        if (g.measureText(next).width > W - 60 && lines[lines.length - 1]) lines.push(w);
        else lines[lines.length - 1] = next;
      }
      lines.slice(0, 3).forEach((line, i) => g.fillText(line, W / 2, 162 + (i - (Math.min(lines.length, 3) - 1) / 2) * 42));
      if (s.truck) {
        button(20, s.checkedIn ? 'Aangemeld ✓' : 'Aanmelden', s.checkedIn);
        button(264, s.done ? `Klaar met\n${s.job} ✓` : `Klaar met\n${s.job}`, s.done);
      }
      texture.needsUpdate = true;
    },
  };
}
