import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { STYLE, onTop } from './style';
import { canvasTexture } from './textures';

// Brandblusser (poeder, 6 kg) aan een vrijstaande standaard met pictogrambord.
// Op ware grootte in meters, oorsprong op de vloer, voorkant naar +Z. Opgebouwd in de huisstijl:
// effen materialen uit STYLE, alleen het etiket en het bord hebben een (canvas)texture.

/** Onderkant van de blusser boven de vloer: hij hangt aan de standaard. */
const Y0 = 0.55;
/** Hartlijn van de blusser, vóór de paal van de standaard. */
const Z0 = -0.02;
/** Ruimte die de standaard op de vloer inneemt (voor de botsing met de speler). */
export const EXTINGUISHER_SIZE = { w: 0.36, d: 0.36, h: 1.15 };

function labelTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#f4f4f2';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#c8231c';
    g.fillRect(0, 0, w, 52);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.font = 'bold 27px Arial';
    g.fillText('BRANDBLUSSER', w / 2, 28, w - 16);
    g.fillStyle = '#1b1c1e';
    g.font = 'bold 30px Arial';
    g.fillText('POEDER 6 KG', w / 2, 80, w - 20);
    // brandklassen
    ['A', 'B', 'C'].forEach((c, i) => {
      const x = 28 + i * 72;
      g.fillStyle = '#1b1c1e';
      g.fillRect(x, 108, 56, 56);
      g.fillStyle = '#ffffff';
      g.font = 'bold 40px Arial';
      g.fillText(c, x + 28, 138);
    });
    // gebruiksaanwijzing: regels tekst die je van een afstand niet leest
    g.fillStyle = '#8a9097';
    for (let i = 0; i < 5; i++) g.fillRect(24, 182 + i * 13, i === 4 ? 120 : w - 48, 5);
  });
}

function signTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#c8231c';
    g.fillRect(0, 0, w, h);
    g.fillStyle = g.strokeStyle = '#ffffff';
    // blusser: romp, hals, hendel en slang
    g.beginPath();
    g.arc(108, 122, 40, Math.PI, 0);
    g.lineTo(148, 222);
    g.lineTo(68, 222);
    g.closePath();
    g.fill();
    g.fillRect(96, 62, 24, 28);
    g.fillRect(88, 46, 74, 13);
    g.lineWidth = 9;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(98, 72);
    g.quadraticCurveTo(44, 72, 44, 128);
    g.stroke();
    // vlam
    g.beginPath();
    g.moveTo(204, 112);
    g.bezierCurveTo(244, 156, 240, 222, 202, 222);
    g.bezierCurveTo(164, 222, 166, 176, 184, 154);
    g.bezierCurveTo(188, 172, 198, 166, 204, 112);
    g.fill();
  });
}

/**
 * De onderdelen van één brandblusser met standaard, per materiaal samengevoegd tot één vorm.
 * De aanroeper zet ze neer (als InstancedMesh: alle blussers samen één tekenopdracht per materiaal).
 */
export function extinguisherParts(): { geometry: THREE.BufferGeometry; material: THREE.Material; shadows: boolean }[] {
  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  const cyl = (rTop: number, rBottom: number, h: number, x: number, y: number, z: number) =>
    new THREE.CylinderGeometry(rTop, rBottom, h, 24).translate(x, y, z);
  /** Zet een onderdeel van de blusser zelf op zijn plek aan de standaard. */
  const hung = (g: THREE.BufferGeometry) => g.translate(0, Y0, Z0);

  // Romp: rechte cilinder met een ronde schouder naar de hals
  const R = 0.08;
  const shoulder = Array.from({ length: 9 }, (_, i) => {
    const a = (i / 8) * (Math.PI / 2);
    return new THREE.Vector2(0.03 + 0.05 * Math.cos(a), 0.38 + 0.05 * Math.sin(a));
  });
  const body = new THREE.LatheGeometry(
    [new THREE.Vector2(0, 0.02), new THREE.Vector2(R, 0.02), ...shoulder, new THREE.Vector2(0.03, 0.445), new THREE.Vector2(0, 0.445)],
    24,
  );

  // Slang: uit de kop opzij, met een bocht omlaag langs de romp naar de spuitmond in de klemband
  const hose = new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.018, 0.515, 0),
      new THREE.Vector3(-0.07, 0.522, 0),
      new THREE.Vector3(-0.1, 0.46, 0.004),
      new THREE.Vector3(-0.099, 0.3, 0.008),
      new THREE.Vector3(-0.097, 0.17, 0.008),
    ]),
    28,
    0.009,
    10,
  );

  const red = mergeGeometries([
    hung(body),
    box(0.24, 0.24, 0.012, 0, 1.75, -0.109), // bord boven aan de paal
  ]);
  const dark = mergeGeometries([
    box(EXTINGUISHER_SIZE.w, 0.02, EXTINGUISHER_SIZE.d, 0, 0.01, 0), // voetplaat
    box(0.05, 1.88, 0.03, 0, 0.96, -0.13), // paal
  ]);
  const black = mergeGeometries([
    hung(box(0.044, 0.06, 0.036, 0, 0.515, 0)), // kop van de afsluiter
    hung(box(0.12, 0.012, 0.028, 0.045, 0.494, 0)), // draagbeugel
    hung(new THREE.BoxGeometry(0.14, 0.012, 0.028).translate(0.07, 0, 0).rotateZ(0.2).translate(-0.015, 0.546, 0)), // knijphendel
    hung(cyl(R + 0.003, R + 0.003, 0.02, 0, 0.12, 0)), // klemband
    hung(cyl(0.011, 0.016, 0.06, -0.097, 0.14, 0.008)), // spuitmond
  ]);
  const rubber = mergeGeometries([
    hung(cyl(R + 0.003, R + 0.003, 0.03, 0, 0.015, 0)), // voetring
    hung(hose),
  ]);
  const steel = mergeGeometries([
    hung(cyl(0.022, 0.022, 0.05, 0, 0.465, 0)), // afsluiter
    hung(new THREE.CylinderGeometry(0.016, 0.016, 0.012, 20).rotateX(Math.PI / 2).translate(0, 0.515, 0.024)), // manometer
    box(0.03, 0.02, 0.03, 0, Y0 + 0.33, -0.105), // ophanghaak
  ]);
  const white = hung(new THREE.CylinderGeometry(0.012, 0.012, 0.004, 20).rotateX(Math.PI / 2).translate(0, 0.515, 0.031)); // wijzerplaat

  // Etiket om de voorkant van de romp, bord met pictogram op de plaat: vlakken op een vlak, dus laag +1
  const label = hung(new THREE.CylinderGeometry(R + 0.001, R + 0.001, 0.16, 16, 1, true, -0.9, 1.8).translate(0, 0.28, 0));
  const sign = new THREE.PlaneGeometry(0.22, 0.22).translate(0, 1.75, -0.102);

  return [
    { geometry: red, material: STYLE.paint, shadows: true },
    { geometry: dark, material: STYLE.dark, shadows: true },
    { geometry: black, material: STYLE.black, shadows: true },
    { geometry: rubber, material: STYLE.rubber, shadows: true },
    { geometry: steel, material: STYLE.steel, shadows: true },
    { geometry: white, material: STYLE.white, shadows: false },
    { geometry: label, material: onTop(new THREE.MeshStandardMaterial({ map: labelTexture(), roughness: 0.7 })), shadows: false },
    { geometry: sign, material: onTop(new THREE.MeshStandardMaterial({ map: signTexture(), roughness: 0.7 })), shadows: false },
  ];
}
