import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { startWmsBridge, wms } from './integrations/wms';
import { mountWmsPanel } from './ui/wmsPanel';
import { createPlayerView, type ViewMode } from './ui/playerView';
import { createHandheld } from './ui/handheld';
import { createWarehouse, HALL } from './ui/scene/warehouse';
import { createForklift } from './ui/scene/forklift';
import { mountWarehouse } from './ui/warehouse';

startWmsBridge();
mountWmsPanel();

const params = new URLSearchParams(location.search);

// --- Renderer, scène, camera ---
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
document.querySelector<HTMLDivElement>('#app')!.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;
const HAZE = new THREE.FogExp2('#b4babd', 0.0045);
const OUTSIDE = new THREE.Color('#16181b');
const INSIDE = new THREE.Color('#c3c8cb');

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.05, 200);
scene.add(camera); // nodig omdat scanner/tablet aan de camera hangen

// --- Magazijn ---
const hall = createWarehouse(scene);

// --- Heftruck die door de gangpaden rijdt ---
const forklift = createForklift();
scene.add(forklift.group);
const FORKLIFT_SPEED = 3;
const route = [[-10, -1.5], [16, -1.5], [16, 3.5], [-10, 3.5]].map(([x, z]) => new THREE.Vector3(x, 0, z));
let routeSeg = 0;
let routeT = 0;

// --- Speler (zichtbaar in third person en overzicht) ---
const player = new THREE.Group();
const body = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.3, 1.0, 8, 16),
  new THREE.MeshStandardMaterial({ color: '#ee5a12', roughness: 0.85 }),
);
body.position.y = 0.8;
body.castShadow = true;
const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 14), new THREE.MeshStandardMaterial({ color: '#f2c200', roughness: 0.4 }));
head.position.y = 1.62;
head.castShadow = true;
player.add(body, head);
player.position.set(-12, 0, 10);
player.rotation.y = Math.PI / 2;
scene.add(player);

// --- Nabewerking: omgevingsschaduw (GTAO), gloed rond lampen, tonemapping ---
const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { type: THREE.HalfFloatType, samples: 4 }),
);
composer.addPass(new RenderPass(scene, camera));
const gtao = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
gtao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1.4, thickness: 1.2, scale: 1.15, samples: 12 });
// Tekstlabels (sprites) horen niet in de diepte/normaal-pass van GTAO: daar worden ze
// als massieve vlakken getekend en verschijnen ze als zwarte balken in beeld.
const gtaoRender = gtao.render.bind(gtao);
gtao.render = (...args: Parameters<GTAOPass['render']>) => {
  const hidden: THREE.Object3D[] = [];
  scene.traverseVisible((o) => {
    if ((o as THREE.Sprite).isSprite) hidden.push(o);
  });
  for (const o of hidden) o.visible = false;
  try {
    gtaoRender(...args);
  } finally {
    for (const o of hidden) o.visible = true;
  }
};
composer.addPass(gtao);
composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.14, 0.6, 1.8));
composer.addPass(new OutputPass());
let postFx = !params.has('nofx');

// --- Camera-modi (overzicht / first person / third person) ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.maxPolarAngle = Math.PI / 2.2;
controls.enableDamping = true;

const hud = document.createElement('div');
hud.style.cssText =
  'position:fixed;left:16px;top:16px;padding:10px 14px;border-radius:8px;background:rgba(0,0,0,.6);color:#fff;font:14px system-ui,sans-serif;line-height:1.5;pointer-events:none';
document.body.appendChild(hud);

const handheld = createHandheld({ camera, canvas: renderer.domElement, world: scene, scanTargets: hall.scanTargets });

function applyMode(mode: ViewMode) {
  const overview = mode === 'overview';
  hall.roof.visible = !overview; // dak weg zodat je van boven naar binnen kijkt
  scene.fog = overview ? null : HAZE;
  scene.background = overview ? OUTSIDE : INSIDE;
  handheld.setActive(mode === 'first');
}

const view = createPlayerView({
  camera,
  canvas: renderer.domElement,
  controls,
  player,
  hud,
  bounds: { minX: -HALL.w / 2 + 0.6, maxX: HALL.w / 2 - 0.6, minZ: -HALL.d / 2 + 0.6, maxZ: HALL.d / 2 - 0.6 },
  colliders: hall.colliders,
  initialMode: params.get('view') === 'overview' ? 'overview' : 'first',
  onModeChange: applyMode,
});

// Handig bij testen: ?at=x,z,draaiing(graden) en ?tool=2
const at = params.get('at')?.split(',').map(Number);
if (at && at.length >= 2 && at.every(Number.isFinite)) {
  player.position.set(at[0], 0, at[1]);
  player.rotation.y = THREE.MathUtils.degToRad(at[2] ?? 0);
}
if (params.get('tool') === '2') handheld.setTool('tablet');

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyP' && !e.repeat && !(e.target instanceof HTMLInputElement)) postFx = !postFx;
});

// Processim (vrachtwagens, banen, taken). De voorraad in de stellingen tekent de hal zelf.
const warehouse = mountWarehouse({ scene, player, rackStock: false });
setInterval(() => hall.setStock(warehouse.stockList().filter((s) => !s.locationId.startsWith('DOCK'))), 500);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// --- WMS-gegevens ophalen voor de weergave op scanner en tablet ---
let lastSnapshot = '';
async function refreshWms() {
  const client = wms.client;
  try {
    const [locations, stock, orders] = await Promise.all([client.getLocations(), client.getStock(), client.getOpenOrders()]);
    const snapshot = JSON.stringify([client.mode, locations.length, stock, orders]);
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;
    handheld.setData({ mode: client.mode, locations, stock, orders });
  } catch {
    // de fout staat al in het WMS-paneel; de weergave houdt de laatste stand
  }
}
void refreshWms();
setInterval(refreshWms, 3000);
wms.onChange(() => void refreshWms());

// --- Loop ---
let last = performance.now();

renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  // Heftruck
  const a = route[routeSeg];
  const b = route[(routeSeg + 1) % route.length];
  routeT += (dt * FORKLIFT_SPEED) / a.distanceTo(b);
  if (routeT >= 1) {
    routeT = 0;
    routeSeg = (routeSeg + 1) % route.length;
  }
  forklift.group.position.lerpVectors(a, b, Math.min(routeT, 1));
  forklift.group.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
  forklift.update(dt, FORKLIFT_SPEED, now / 1000);

  view.update(dt);
  warehouse.update(dt);
  handheld.update(dt, view.moving);

  if (postFx) composer.render(dt);
  else renderer.render(scene, camera);
});
