import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createPlayerView, type ViewMode } from './ui/playerView';
import { createHandheld } from './ui/handheld';
import { createTabletApp } from './ui/tabletApp';
import { createWarehouse, HALL } from './ui/scene/warehouse';
import { createForklift } from './ui/scene/forklift';
import { createPalletJack } from './ui/scene/palletJack';
import { createRadio } from './ui/radio';
import { POINTS } from './sim/layout';
import { createExterior } from './ui/scene/exterior';
import { createCharacter, type HandTarget } from './ui/scene/character';
import { wms } from './integrations/wms';
import { mountWarehouse } from './ui/warehouse';
import { mountMultiplayer } from './ui/multiplayer';
import { SceneRenderPass } from './ui/sceneRenderPass';
import { menu } from './ui/menu';
import { createPrompts, esc, type Prompt } from './ui/prompts';

// De WMS-koppeling loopt via de poort van de sim (src/sim/wms.ts, ingevuld in src/ui/wmsGateway.ts):
// elke handeling wacht op het antwoord van de WMS. De bridge op de bus (startWmsBridge) start daarom
// niet meer; die zou dezelfde stappen een tweede keer boeken.

const params = new URLSearchParams(location.search);

// --- Renderer, scène, camera ---
// Renderschaal (pixels per CSS-pixel): past zich tijdens het spelen aan de framerate aan, zie tuneScale().
// Testen: ?scale=1 zet hem vast, ?msaa=0..4, ?ao=0 (uit) of 1 (volle resolutie), ?nobloom, ?nofx.
const SCALES = [0.6, 0.75, 0.9, 1, 1.25, 1.5].filter((s) => s <= window.devicePixelRatio + 0.01);
const fixedScale = Number(params.get('scale')) || 0;
let scaleLevel = Math.min(SCALES.length - 1, SCALES.indexOf(1));
const renderScale = () => fixedScale || SCALES[scaleLevel];
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(renderScale());
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
document.querySelector<HTMLDivElement>('#app')!.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;
// Mist en achtergrond hebben per modus exact dezelfde kleur: anders tekent de plek waar
// het terrein in de mist oplost (of op camera.far wordt afgekapt) zich af als een rand.
const INSIDE = new THREE.Color('#c3c8cb');
const HAZE = new THREE.FogExp2(INSIDE, 0.0045);
const OUTSIDE = new THREE.Color('#b9d4ee'); // lucht boven het buitenterrein
const DISTANCE_HAZE = new THREE.Fog(OUTSIDE, 170, 520);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.05, 600);
scene.add(camera); // nodig omdat scanner/tablet aan de camera hangen

// --- Magazijn ---
const hall = createWarehouse(scene);
createExterior(scene);


// --- Speler (zichtbaar in third person en overzicht) ---
const character = createCharacter();
const player = character.group;
player.position.set(-14.8, 0, 2.5);
player.rotation.y = Math.PI / 2;
scene.add(player);

// --- Nabewerking: omgevingsschaduw (GTAO), gloed rond lampen, tonemapping ---
// Dit is het duurste deel van een frame, daarom zuinig ingesteld: de omgevingsschaduw rekent op halve
// resolutie (hij is toch zacht) en alleen de scène zelf krijgt kantafvlakking (MSAA), zie SceneRenderPass.
const MSAA = params.has('msaa') ? Number(params.get('msaa')) || 0 : 4;
const AO_SCALE = params.has('ao') ? Number(params.get('ao')) || 0 : 0.5;
const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { type: THREE.HalfFloatType }),
);
composer.addPass(MSAA > 0 ? new SceneRenderPass(scene, camera, MSAA) : new RenderPass(scene, camera));
const gtao = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
gtao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1.4, thickness: 1.2, scale: 1.15, samples: 8 });
const gtaoSetSize = gtao.setSize.bind(gtao);
gtao.setSize = (w: number, h: number) => gtaoSetSize(Math.ceil(w * AO_SCALE), Math.ceil(h * AO_SCALE));
gtao.enabled = AO_SCALE > 0;
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
if (!params.has('nobloom')) composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.14, 0.6, 1.8));
composer.addPass(new OutputPass());
composer.setPixelRatio(renderScale()); // zet ook alle passes op de juiste maat
let postFx = !params.has('nofx');

// Dynamische resolutie: zakt de framerate in, dan rendert de game op een lagere schaal (iets minder scherp,
// wel vloeiend); is er ruimte over, dan gaat de schaal weer omhoog.
function setScaleLevel(level: number) {
  scaleLevel = level;
  renderer.setPixelRatio(renderScale());
  composer.setPixelRatio(renderScale());
}
const tune = { ms: 0, frames: 0, calm: 0, raisedAt: -1e9, blocked: Infinity, blockedUntil: 0 };
function tuneScale(frameMs: number, now: number) {
  if (fixedScale || frameMs > 250 || document.hidden) return; // haperingen en een verborgen tabblad tellen niet mee
  tune.ms += frameMs;
  tune.frames++;
  if (tune.ms < 1000) return;
  const avg = tune.ms / tune.frames;
  tune.ms = tune.frames = 0;
  if (avg > 26 && scaleLevel > 0) {
    // onder ~38 beelden per seconde: omlaag. Kwam dat door een verhoging van zojuist, dan die stap een tijd niet meer proberen.
    if (now - tune.raisedAt < 8000) {
      tune.blocked = scaleLevel;
      tune.blockedUntil = now + 60_000;
    }
    tune.calm = 0;
    setScaleLevel(scaleLevel - 1);
  } else if (avg < 17.5 && scaleLevel < SCALES.length - 1) {
    const next = scaleLevel + 1;
    if (++tune.calm >= 4 && !(next >= tune.blocked && now < tune.blockedUntil)) {
      tune.calm = 0;
      tune.raisedAt = now;
      setScaleLevel(next);
    }
  } else {
    tune.calm = 0;
  }
}

// --- Camera-modi (overzicht / first person / third person) ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.maxPolarAngle = Math.PI / 2.2;
controls.maxDistance = 260;
controls.enableDamping = true;

// De uitleg van de besturing staat in het menu rechtsboven (Tab); de tekst komt uit playerView.
const hud = document.createElement('div');
hud.style.cssText = 'font-size:14px;line-height:1.65';
menu.addSection('help', 'Besturing', hud, 0);
// Midden-onder in beeld: welke toets je bij een object in de buurt kunt indrukken.
const prompts = createPrompts();
/** Aanwijzing van een voorwerp ("<b>M</b>: radio aanzetten") als prompt: begint hij met een toets, dan wordt dat de toets in beeld. */
function hintPrompt(html: string): Prompt {
  const m = /^<b>([^<]{1,5})<\/b>: (.*)$/.exec(html);
  return m ? { key: m[1], html: m[2] } : { html };
}

const handheld = createHandheld({
  camera,
  canvas: renderer.domElement,
  world: scene,
  scanTargets: hall.scanTargets,
  onScan: (code) => warehouse.scan(code), // de scan gaat naar de WMS; het antwoord komt op het scannerscherm
});
// De echte WMS-app op het scherm van de tablet (2); F haalt hem dichtbij om te bedienen.
const tabletApp = createTabletApp({ camera, display: handheld.tabletDisplay, onClose: () => handheld.setFocus(false) });

let driving = false;

/** Loopt de speler met de pompwagen? */
let pushing = false;

function applyMode(mode: ViewMode) {
  const overview = mode === 'overview';
  hall.roof.visible = !overview; // dak weg zodat je van boven naar binnen kijkt
  scene.fog = overview ? DISTANCE_HAZE : HAZE;
  scene.background = overview ? OUTSIDE : INSIDE;
  // In de heftruck: linkerhand op het stuur, scanner/tablet in de rechterhand, eigen lichaam (zonder hoofd) in beeld
  // Met de pompwagen: beide handen op de handgreep, dus geen scanner of tablet in beeld
  handheld.setActive(mode === 'first' && !pushing);
  handheld.setSeated(driving);
  character.setFirstPerson(mode === 'first' && (driving || pushing));
}

const BOUNDS = { minX: -HALL.w / 2 + 0.6, maxX: HALL.w / 2 - 0.6, minZ: -HALL.d / 2 + 0.6, maxZ: HALL.d / 2 - 0.6 };
const view = createPlayerView({
  camera,
  canvas: renderer.domElement,
  controls,
  player,
  hud,
  bounds: BOUNDS,
  solids: [hall.solids, () => forklift.solids(), () => jack.solids()],
  initialMode: params.get('view') === 'overview' ? 'overview' : params.get('view') === 'third' ? 'third' : 'first',
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
    // R: uitstappen of loslaten; anders pakken wat het dichtst bij is (heftruck of pompwagen)
    if (driving) setDriving(false);
    else if (jack.held) holdJack(false);
    else if (nearJack() && !(nearForklift() && forkliftDistance() < jackDistance())) {
      if (!multiplayer?.jackHolder()) holdJack(true);
    } else if (nearForklift() && !multiplayer?.forkliftDriver()) setDriving(true);
  }
  if (e.code === 'KeyP' && !e.repeat && !(e.target instanceof HTMLInputElement)) postFx = !postFx;
});

// Processim (vrachtwagens, banen, taken). De voorraad in de stellingen tekent de hal zelf.
const warehouse = mountWarehouse({ scene, camera, player, rackStock: false });
warehouse.onWmsData((data) => handheld.setData(data)); // wat de scanner over een locatie laat zien komt uit de WMS
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
forklift.group.position.set(-12.6, 0, 2.5); // voor de stellingen, in het middelste gangpad; de speler start er vlak achter
forklift.group.rotation.y = Math.PI / 2;
scene.add(forklift.group, forklift.marker);
if (import.meta.env.DEV) Object.assign(window, { wmDebug: { forklift, hall, warehouse, wms, setDriving: (on: boolean) => setDriving(on) } });

// --- Radio op het bureau naast de pc: M schakelt tussen de live zenders ---
const radio = createRadio();
radio.group.position.set(POINTS.terminal.x - 0.55, 0.975, POINTS.terminal.z + 0.08);
scene.add(radio.group);

if (import.meta.env.DEV) Object.assign((window as unknown as { wmDebug: object }).wmDebug, { radio });

const forkliftDistance = () => player.position.distanceTo(forklift.group.position);
const nearForklift = () => forkliftDistance() < 2.8;

// --- Pompwagen: pakken met R, vorken omhoog/omlaag met Q; voor pallets op de vloer ---
const jack = createPalletJack({
  hall,
  bounds: BOUNDS,
  take: warehouse.forkliftTake,
  place: warehouse.forkliftPlace,
  onStockChange: refreshHall,
  loose: forklift.loose,
});
jack.group.position.set(-13.4, 0, 5.4); // naast het looppad, bij de rolcontainers
jack.group.rotation.y = Math.PI / 2;
scene.add(jack.group);
/** Pompwagen pakken of loslaten; in first person zie je dan je eigen handen op de handgreep. */
function holdJack(on: boolean) {
  jack.setHeld(on);
  pushing = on;
  view.setBody(on); // roept ook applyMode aan
}
const jackDistance = () => Math.hypot(player.position.x - jack.group.position.x, player.position.z - jack.group.position.z);
const nearJack = () => jackDistance() < 2.2 && player.position.y < 1;
if (import.meta.env.DEV) Object.assign((window as unknown as { wmDebug: object }).wmDebug, { jack });

// --- Multiplayer: iedereen speelt samen in één magazijn (?room=naam voor een eigen kamer, ?solo om alleen te spelen) ---
const multiplayer = params.has('solo')
  ? null
  : mountMultiplayer({
      scene,
      player,
      room: params.get('room') ?? 'main',
      shared: warehouse.shared,
      carryLabel: warehouse.carryLabel,
      forklift,
      jack: { getState: jack.getState, applyState: jack.applyState, grip: jack.grip, held: () => jack.held, release: () => holdJack(false) },
      radio,
      airborne: () => view.airborne,
      rider: () => {
        const on = view.standingOn;
        if (!on || on.pose !== forklift.pose) return null;
        return { x: on.x, z: on.z, y: on.lift ? player.position.y - forklift.forkHeight : undefined };
      },
      seatHipY: forklift.seat.y - 0.56,
      isDriving: () => driving,
      look: () => (view.mode === 'first' ? view.look : { yaw: 0, pitch: 0 }),
      tool: () => (view.mode !== 'first' ? 0 : handheld.tool === 'scanner' ? 1 : 2),
      scans: () => handheld.scans,
      leaveForklift: () => setDriving(false),
    });

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
    view.setVehicle({ object: forklift.group, seat: forklift.seat, eye: forklift.eye });
  }
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// --- Schaduwkaart alleen opnieuw tekenen als er iets is verplaatst ---
// Het licht staat stil en bijna alles in de hal ook; elke frame de hele hal opnieuw in de schaduwkaart
// tekenen is dan verspilling. Per frame wordt een som gemaakt van de stand van alles wat schaduw werpt
// (plus de voorraad in de stellingen); verandert die, dan wordt de schaduwkaart ververst.
renderer.shadowMap.autoUpdate = false;
let shadowState = NaN;
function refreshShadows() {
  let state = 0;
  let n = 0;
  scene.traverseVisible((o) => {
    const m = o as THREE.InstancedMesh;
    if (!m.isMesh || !m.castShadow) return;
    const e = m.matrixWorld.elements;
    n++;
    state += (e[12] * 1.31 + e[13] * 2.17 + e[14] * 3.59 + e[0] * 5.3 + e[5] * 7.1 + e[10] * 11.9 + e[2] * 13.7) * (1 + (n % 17));
    if (m.isInstancedMesh) state += m.count * 0.77 + m.instanceMatrix.version * 1.93;
  });
  state += n * 1000;
  if (state === shadowState) return;
  shadowState = state;
  renderer.shadowMap.needsUpdate = true;
}

// --- Loop ---
let last = performance.now();
const wheelHand: HandTarget = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
const toolHand: HandTarget = { point: new THREE.Vector3(), hideHand: true };
const jackHands: HandTarget[] = [{ point: new THREE.Vector3() }, { point: new THREE.Vector3() }];

renderer.setAnimationLoop((now) => {
  const dt = THREE.MathUtils.clamp((now - last) / 1000, 0, 0.1); // eerste frame kan een tijdstip vóór het laden hebben
  tuneScale(now - last, now);
  last = now;

  forklift.update(dt, now / 1000);
  view.update(dt);
  jack.update(dt, player);
  // heupen net boven de zitting; forklift.seat is de plek van het hoofd
  handheld.update(dt, view.moving, driving ? view.look : undefined);
  if (player.visible) {
    // Rijdend: linkerhand plat op het stuur; in first person houdt de rechterhand de scanner of tablet vast
    let leftHand: HandTarget | undefined;
    let rightHand: HandTarget | undefined;
    if (driving) {
      forklift.steeringGrip(wheelHand.point, wheelHand.normal!);
      leftHand = wheelHand;
      if (handheld.wristWorld(toolHand.point)) rightHand = toolHand;
    } else if (jack.held) {
      // Met de pompwagen: beide handen op de handgreep
      jack.grip(1, jackHands[0].point);
      jack.grip(-1, jackHands[1].point);
      [leftHand, rightHand] = jackHands;
    }
    character.update(dt, { seated: driving, seatHipY: forklift.seat.y - 0.56, carrying: warehouse.carrying(), leftHand, rightHand, walk: view.walk, airborne: view.airborne });
  }

  multiplayer?.update(dt);

  radio.update(player.position);
  warehouse.update(dt);

  // Toetsprompts: wat kun je hier doen, en met welke toets
  const list: Prompt[] = [];
  if (view.mode !== 'overview') {
    if (driving && forklift.hint) list.push(hintPrompt(forklift.hint));
    if (jack.held && jack.hint) list.push(hintPrompt(jack.hint));
    const action = warehouse.action();
    if (action) list.push({ key: 'E', html: esc(action.label), off: !action.enabled });
    if (handheld.aimed) list.push({ key: 'Klik', html: `Label <b>${esc(handheld.aimed)}</b> scannen` });
    if (driving) {
      list.push({ key: 'R', html: 'Uitstappen' });
    } else if (jack.held) {
      // loslaten (R) staat al in de aanwijzing van de pompwagen
    } else if (nearJack() && !(nearForklift() && forkliftDistance() < jackDistance())) {
      const holder = multiplayer?.jackHolder();
      list.push(holder ? { html: `De pompwagen is in gebruik door ${esc(holder)}`, off: true } : { key: 'R', html: 'Pompwagen pakken' });
    } else if (nearForklift()) {
      const otherDriver = multiplayer?.forkliftDriver();
      list.push(otherDriver ? { html: `De heftruck is bezet door ${esc(otherDriver)}`, off: true } : { key: 'R', html: 'In de heftruck stappen' });
    }
  }
  if (radio.hint) list.push(hintPrompt(radio.hint));
  prompts.set(list);

  refreshShadows();
  if (postFx) composer.render(dt);
  else renderer.render(scene, camera);
  tabletApp.update(handheld.tabletVisible, handheld.focus);
});
