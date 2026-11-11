import * as THREE from 'three';

// Werkplek met pc (bureau, monitor, toetsenbord, muis, kast). Het beeldscherm is een canvas-textuur
// zodat de aanmeldstatus in de 3D-wereld te lezen is. De voorkant (waar je staat) is de -Z-kant.

const SCREEN_W = 512;
const SCREEN_H = 320;

export type PcScreenState = { loggedIn: boolean; subtitle: string; lines: string[] };

export function createPcMesh() {
  const group = new THREE.Group();
  const mat = (color: string, roughness = 0.7, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const add = (w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };

  const steel = mat('#4a5560', 0.5, 0.6);
  const plastic = mat('#1c1f23', 0.55);

  // Bureau: blad op 0,95 m (sta-werkplek), poten en een achterschot
  add(1.5, 0.05, 0.75, 0, 0.95, 0, mat('#b9a58a', 0.8));
  for (const x of [-0.7, 0.7]) for (const z of [-0.32, 0.32]) add(0.05, 0.93, 0.05, x, 0.465, z, steel);
  add(1.4, 0.5, 0.03, 0, 0.6, 0.33, steel);

  // Kast onder het bureau met aan-lampje
  add(0.2, 0.45, 0.45, 0.5, 0.225, 0.05, plastic);
  add(0.02, 0.02, 0.01, 0.5, 0.36, -0.18, new THREE.MeshBasicMaterial({ color: '#4caf50' }));

  // Monitor: voet, arm, behuizing en beeld
  add(0.26, 0.02, 0.18, 0, 0.985, 0.2, plastic);
  add(0.05, 0.22, 0.04, 0, 1.09, 0.24, plastic);
  add(0.74, 0.47, 0.035, 0, 1.4, 0.21, plastic);

  const canvas = document.createElement('canvas');
  canvas.width = SCREEN_W;
  canvas.height = SCREEN_H;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.7, 0.7 * (SCREEN_H / SCREEN_W)),
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
  );
  screen.position.set(0, 1.4, 0.19);
  screen.rotation.y = Math.PI; // beeld naar de -Z-kant
  group.add(screen);

  // Toetsenbord en muis
  add(0.42, 0.02, 0.14, -0.05, 0.985, -0.14, plastic);
  add(0.06, 0.025, 0.1, 0.3, 0.9875, -0.14, plastic);

  let current = '';
  function setScreen(s: PcScreenState) {
    const key = JSON.stringify(s);
    if (key === current) return;
    current = key;

    ctx.fillStyle = '#10243a';
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    ctx.fillStyle = '#1b3a5c';
    ctx.fillRect(0, 0, SCREEN_W, 54);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = 'bold 28px system-ui, sans-serif';
    ctx.fillText('WMS-werkstation', 18, 28);

    ctx.fillStyle = s.loggedIn ? '#4caf50' : '#f2b134';
    ctx.beginPath();
    ctx.arc(34, 100, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 30px system-ui, sans-serif';
    ctx.fillText(s.loggedIn ? 'Aangemeld' : 'Niet aangemeld', 58, 101, SCREEN_W - 76);
    ctx.fillStyle = '#9fb3c8';
    ctx.font = '22px system-ui, sans-serif';
    ctx.fillText(s.subtitle, 18, 144, SCREEN_W - 36);

    ctx.fillStyle = '#e3edf7';
    ctx.font = '24px system-ui, sans-serif';
    s.lines.slice(0, 3).forEach((line, i) => ctx.fillText(line, 18, 196 + i * 34, SCREEN_W - 36));

    ctx.fillStyle = '#80deea';
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillText('Druk op E om de pc te gebruiken', 18, SCREEN_H - 24, SCREEN_W - 36);
    texture.needsUpdate = true;
  }

  return { group, setScreen };
}
