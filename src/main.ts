import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { startWmsBridge } from './integrations/wms';
import { mountWmsPanel } from './ui/wmsPanel';

startWmsBridge();
mountWmsPanel();

// Tijdelijke placeholder-scène: wordt vervangen door src/ui zodra die er is.

// --- Renderer, scène, camera ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.querySelector<HTMLDivElement>('#app')!.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#1e1e1e');
scene.fog = new THREE.Fog('#1e1e1e', 60, 120);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);

scene.add(new THREE.HemisphereLight('#ffffff', '#444444', 1.2));
const sun = new THREE.DirectionalLight('#ffffff', 2);
sun.position.set(15, 30, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30 });
scene.add(sun);

// --- Hulpfunctie ---
function box(w: number, h: number, d: number, color: string, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color }));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// --- Vloer (40 x 30) ---
const FLOOR_W = 40;
const FLOOR_D = 30;
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(FLOOR_W, FLOOR_D),
  new THREE.MeshStandardMaterial({ color: '#3a3d41' }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const grid = new THREE.GridHelper(FLOOR_W, FLOOR_W, '#4a4d51', '#4a4d51');
grid.scale.z = FLOOR_D / FLOOR_W;
grid.position.y = 0.01;
scene.add(grid);

// --- Dock (links) ---
scene.add(box(0.4, 5, 10, '#555a60', -FLOOR_W / 2, 2.5, 0)); // muur
for (const z of [-3, 3]) {
  scene.add(box(0.2, 3.5, 3, '#c58a2b', -FLOOR_W / 2 + 0.3, 1.75, z)); // dockdeur
  scene.add(box(4, 0.02, 3, '#e0b84a', -FLOOR_W / 2 + 2.3, 0.01, z)); // laadvak
}

// --- Stellingen: 4 rijen x 5 secties ---
function rack(x: number, z: number) {
  const g = new THREE.Group();
  for (const dx of [-1.75, 1.75]) for (const dz of [-0.55, 0.55]) g.add(box(0.1, 4, 0.1, '#d9822b', dx, 2, dz));
  for (const y of [0.15, 1.5, 2.85]) {
    g.add(box(3.6, 0.08, 1.2, '#3b6ea5', 0, y, 0));
    for (const px of [-1.1, 0, 1.1]) {
      if (Math.random() < 0.7) g.add(box(0.9, 0.8, 0.9, '#a5784a', px, y + 0.45, 0)); // pallet met goederen
    }
  }
  g.position.set(x, 0, z);
  return g;
}
for (const z of [-9, -4, 1, 6]) for (const x of [-4, 0, 4, 8, 12]) scene.add(rack(x, z));

// --- Heftruck die door de gangpaden rijdt ---
const forklift = new THREE.Group();
forklift.add(box(1.2, 1, 1.8, '#f2b134', 0, 0.6, 0));
forklift.add(box(1.1, 0.1, 1, '#222222', 0, 1.65, -0.3)); // dak
forklift.add(box(0.1, 2.2, 0.1, '#333333', -0.4, 1.1, 0.95)); // mast
forklift.add(box(0.1, 2.2, 0.1, '#333333', 0.4, 1.1, 0.95));
forklift.add(box(0.15, 0.06, 1, '#333333', -0.3, 0.1, 1.5)); // vorken
forklift.add(box(0.15, 0.06, 1, '#333333', 0.3, 0.1, 1.5));
scene.add(forklift);
const route = [[-10, -1.5], [16, -1.5], [16, 3.5], [-10, 3.5]].map(([x, z]) => new THREE.Vector3(x, 0, z));
let routeSeg = 0;
let routeT = 0;

// --- Speler (third person) ---
const player = new THREE.Group();
const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.9), new THREE.MeshStandardMaterial({ color: '#4caf50' }));
body.position.y = 0.8;
body.castShadow = true;
player.add(body, box(0.5, 0.15, 0.2, '#ffffff', 0, 1.35, 0.3)); // vizier = kijkrichting
player.position.set(-12, 0, 10);
player.rotation.y = Math.PI / 2;
scene.add(player);

// --- Camera-modi ---
type Mode = 'overview' | 'third';
let mode: Mode = 'overview';
const controls = new OrbitControls(camera, renderer.domElement);
controls.maxPolarAngle = Math.PI / 2.2;
controls.enableDamping = true;

const hud = document.createElement('div');
hud.style.cssText =
  'position:fixed;left:16px;top:16px;padding:10px 14px;border-radius:8px;background:rgba(0,0,0,.6);color:#fff;font:14px system-ui,sans-serif;line-height:1.5;pointer-events:none';
document.body.appendChild(hud);

function setMode(m: Mode) {
  mode = m;
  controls.enabled = m === 'overview';
  if (m === 'overview') {
    camera.position.set(0, 32, 28);
    controls.target.set(0, 0, 0);
    hud.innerHTML = '<b>WM-Sim — Overzicht</b><br>Slepen: draaien · Scroll: zoom · Rechts slepen: schuiven<br><b>C</b>: third person';
  } else {
    hud.innerHTML = '<b>WM-Sim — Third person</b><br>W/S: lopen · A/D: draaien · Shift: rennen<br><b>C</b>: overzicht';
  }
}
setMode('overview');

const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return; // typen in formulier ≠ besturing
  if (e.code === 'KeyC' && !e.repeat) setMode(mode === 'overview' ? 'third' : 'overview');
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Loop ---
const forward = new THREE.Vector3();
const camTarget = new THREE.Vector3();
let last = performance.now();

renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  // Heftruck
  const a = route[routeSeg];
  const b = route[(routeSeg + 1) % route.length];
  routeT += (dt * 3) / a.distanceTo(b);
  if (routeT >= 1) {
    routeT = 0;
    routeSeg = (routeSeg + 1) % route.length;
  }
  forklift.position.lerpVectors(a, b, Math.min(routeT, 1));
  forklift.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);

  if (mode === 'third') {
    const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 9 : 5;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) player.rotation.y += 2.5 * dt;
    if (keys.has('KeyD') || keys.has('ArrowRight')) player.rotation.y -= 2.5 * dt;
    forward.set(Math.sin(player.rotation.y), 0, Math.cos(player.rotation.y));
    const move = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    player.position.addScaledVector(forward, move * speed * dt);
    player.position.x = THREE.MathUtils.clamp(player.position.x, -FLOOR_W / 2 + 1, FLOOR_W / 2 - 0.5);
    player.position.z = THREE.MathUtils.clamp(player.position.z, -FLOOR_D / 2 + 0.5, FLOOR_D / 2 - 0.5);

    // Camera achter en boven de speler, soepel volgend
    camTarget.copy(player.position).addScaledVector(forward, -6).setY(3.5);
    camera.position.lerp(camTarget, 1 - Math.exp(-dt * 6));
    camera.lookAt(player.position.x, 1.5, player.position.z);
  } else {
    controls.update();
  }

  renderer.render(scene, camera);
});
