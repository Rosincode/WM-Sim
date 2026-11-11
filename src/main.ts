import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { startWmsBridge, wms } from './integrations/wms';
import { createPlayerView, type ViewMode } from './ui/playerView';
import { createHandheld } from './ui/handheld';
import { createWarehouse, HALL } from './ui/scene/warehouse';
import { createForklift } from './ui/scene/forklift';
import { createCharacter } from './ui/scene/character';
import { mountWarehouse } from './ui/warehouse';

startWmsBridge(); // aanmelden bij het WMS gebeurt op de pc in het magazijn (src/ui/pcScreen.ts)

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


// --- Speler (zichtbaar in third person en overzicht) ---
const character = createCharacter();
const player = character.group;
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

let driving = false;

function applyMode(mode: ViewMode) {
  const overview = mode === 'overview';
  hall.roof.visible = !overview; // dak weg zodat je van boven naar binnen kijkt
  scene.fog = overview ? null : HAZE;
  scene.background = overview ? OUTSIDE : INSIDE;
  handheld.setActive(mode === 'first' && !driving); // in de heftruck heb je je handen aan het stuur
}

const BOUNDS = { minX: -HALL.w / 2 + 0.6, maxX: HALL.w / 2 - 0.6, minZ: -HALL.d / 2 + 0.6, maxZ: HALL.d / 2 - 0.6 };
const view = createPlayerView({
  camera,
  canvas: renderer.domElement,
  controls,
  player,
  hud,
  bounds: BOUNDS,
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
  const t = e.target;
  if (e.code === 'KeyR' && !e.repeat && !(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)) {
    if (driving) setDriving(false);
    else if (nearForklift()) setDriving(true);
  }
  if (e.code === 'KeyP' && !e.repeat && !(e.target instanceof HTMLInputElement)) postFx = !postFx;
});

// Processim (vrachtwagens, banen, taken). De voorraad in de stellingen tekent de hal zelf.
const warehouse = mountWarehouse({ scene, player, rackStock: false });
const refreshHall = () => hall.setStock(warehouse.stockList().filter((s) => !s.locationId.startsWith('DOCK')));
setInterval(refreshHall, 500);

// --- Heftruck: instappen met R, rijden met W/A/S/D, vorken met pijl omhoog/omlaag ---
const forklift = createForklift({
  hall,
  colliders: hall.colliders,
  bounds: BOUNDS,
  take: warehouse.forkliftTake,
  place: warehouse.forkliftPlace,
  onStockChange: refreshHall,
});
forklift.group.position.set(-10, 0, 3.5);
forklift.group.rotation.y = Math.PI / 2;
scene.add(forklift.group, forklift.marker);
if (import.meta.env.DEV) Object.assign(window, { wmDebug: { forklift, hall, setDriving: (on: boolean) => setDriving(on) } });

const driveHint = document.createElement('div');
driveHint.style.cssText =
  'position:fixed;left:50%;top:16px;transform:translateX(-50%);max-width:560px;padding:8px 14px;border-radius:8px;background:rgba(0,0,0,.65);color:#fff;font:14px system-ui,sans-serif;line-height:1.4;text-align:center;pointer-events:none;display:none';
document.body.appendChild(driveHint);

const nearForklift = () => player.position.distanceTo(forklift.group.position) < 2.8;

function setDriving(on: boolean) {
  if (on === driving) return;
  driving = on;
  forklift.setDriving(on);
  if (!on) {
    // uitstappen: links naast de truck, of rechts als daar iets in de weg staat
    const f = forklift.group;
    const side = (dir: number) => new THREE.Vector3(f.position.x + Math.cos(f.rotation.y) * 1.5 * dir, 0, f.position.z - Math.sin(f.rotation.y) * 1.5 * dir);
    const free = (p: THREE.Vector3) =>
      p.x > BOUNDS.minX && p.x < BOUNDS.maxX && p.z > BOUNDS.minZ && p.z < BOUNDS.maxZ &&
      !hall.colliders.some((c) => p.x > c.minX - 0.45 && p.x < c.maxX + 0.45 && p.z > c.minZ - 0.45 && p.z < c.maxZ + 0.45);
    const spot = [side(1), side(-1)].find(free) ?? side(1);
    view.setVehicle(null);
    player.position.copy(spot);
    player.rotation.y = f.rotation.y;
  } else {
    view.setVehicle({ object: forklift.group, seat: forklift.seat });
  }
}

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
    // de fout staat al in het API-log; de weergave houdt de laatste stand
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

  forklift.update(dt, now / 1000);
  view.update(dt);
  // heupen net boven de zitting; forklift.seat is de plek van het hoofd
  if (player.visible) character.update(dt, { seated: driving, seatHipY: forklift.seat.y - 0.56, carrying: warehouse.carrying() });

  const hintText = driving ? forklift.hint : view.mode !== 'overview' && nearForklift() ? '<b>R</b>: in de heftruck stappen' : '';
  if (driveHint.innerHTML !== hintText) driveHint.innerHTML = hintText;
  driveHint.style.display = hintText ? 'block' : 'none';
  warehouse.update(dt);
  handheld.update(dt, view.moving);

  if (postFx) composer.render(dt);
  else renderer.render(scene, camera);
});
