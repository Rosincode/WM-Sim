import * as THREE from 'three';
import { AISLE_Z, CANTEEN, DESK, DOCKS, HALL, ROOMS, SECTION_X, START, WALKWAY_X } from '../sim/layout';
import { truckPoseOf } from '../sim/yard';
import logoUrl from './assets/fizor-logo-wit.svg?url';
import wmsUrl from './assets/wms-voorbeeld.png';
import type { createHandheld } from './handheld';
import { menu } from './menu';
import type { createRadio } from './radio';
import type { createRocketLauncher } from './rocketLauncher';
import { onTop } from './scene/style';
import type { Hall } from './scene/warehouse';
import type { mountThieves } from './thieves';
import type { mountWarehouse } from './warehouse';

// De trailer van WM-Sim (?trailer): een ouderwetse voorlichtingsfilm met een verteller die de tekst voorleest
// (spraaksynthese van de browser) en ondertitels. Eerst serieus, in sepia: alles wat de sim kan. Dan stopt de film,
// en in kleur komt de rest: boeven, de raketwerper en de kernbom. Afsluiter: fizor. Overal op voorbereid.
// De trailer stuurt de camera zelf aan en speelt alles af in de echte sim (solo: niets gaat naar andere spelers).
// Toetsen: Esc stopt (terug naar de game), pijl rechts slaat een scène over. Testen: ?trailer&auto&from=12.
// ?trailer&loop: na de eindkaart begint de film vanzelf opnieuw (voor een scherm op een beurs of in de kantine).

type Rocket = ReturnType<typeof createRocketLauncher>;
type Thieves = ReturnType<typeof mountThieves>;
type Warehouse = ReturnType<typeof mountWarehouse>;
type Radio = ReturnType<typeof createRadio>;
type Handheld = ReturnType<typeof createHandheld>;

interface Options {
  camera: THREE.PerspectiveCamera;
  hall: Hall;
  warehouse: Warehouse;
  thieves: Thieves;
  rocket: Rocket;
  radio: Radio;
  handheld: Handheld;
  player: THREE.Object3D;
  /** Dak aan of uit (uit: je kijkt van boven de hal in, met de lucht eromheen). */
  setRoof: (on: boolean) => void;
}

/** Een regel van de verteller: de ondertitel, en eventueel hoe hij uitgesproken moet worden. */
type Line = string | { text: string; say: string };
type Cam = { pos: THREE.Vector3; look: THREE.Vector3 };
type Shot = (c: Cam, t: number, k: number) => void;
type Tool = 'scanner' | 'rocket' | null;
type CardStyle = 'old' | 'action' | 'plain' | 'fizor';

interface Scene {
  /** Kaart over het hele beeld in plaats van (of over) de camera. */
  card?: { style: CardStyle; html: string };
  lines?: Line[];
  /** Minimale duur (s). */
  min?: number;
  /** Zo lang (s) na de laatste regel blijft de scène nog staan. */
  hold?: number;
  shot?: Shot;
  /** Volgcamera: hoe snel de camera zijn doel bijhoudt (zonder: precies op het doel). */
  smooth?: number;
  /** Is er nu te zien wat de verteller gaat zeggen (een chauffeur die lost, een robot die telt)? Zo niet, dan wacht de
   * scène hooguit `wait` seconden met praten, terwijl de sim even sneller loopt. */
  ready?: () => boolean;
  wait?: number;
  /** Volgcamera: binnen de muren houden (zie contain). */
  contain?: boolean;
  /** In kleur (het tweede deel) in plaats van sepia. */
  color?: boolean;
  tool?: Tool;
  /** Aftelfilm (5-4-3-2-1) aan het begin. */
  leader?: boolean;
  enter?: () => void;
  exit?: () => void;
  /** Gebeurtenissen op een tijdstip (s) in de scène. */
  at?: [number, () => void][];
  /** Gebeurtenissen bij het begin van een regel (index). */
  onLine?: Record<number, () => void>;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const ease = (k: number) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
const clamp01 = (k: number) => Math.min(1, Math.max(0, k));

function dolly(p0: THREE.Vector3, p1: THREE.Vector3, l0: THREE.Vector3, l1: THREE.Vector3 = l0): Shot {
  return (c, _t, k) => {
    c.pos.lerpVectors(p0, p1, ease(k));
    c.look.lerpVectors(l0, l1, ease(k));
  };
}
function orbit(center: THREE.Vector3, r: number, y: number, a0: number, a1: number, lookY = 0): Shot {
  return (c, _t, k) => {
    const a = a0 + (a1 - a0) * k;
    c.pos.set(center.x + Math.sin(a) * r, y, center.z + Math.cos(a) * r);
    c.look.set(center.x, lookY, center.z);
  };
}
/** Iets om te volgen: waar het is, en (als bekend) zijn rijrichting: vooruit = (sin r, cos r). */
type Subject = () => { x: number; z: number; r?: number } | null;
/**
 * Camera die iets volgt op afstand dist en hoogte up. Met een rijrichting kijkt hij van achteren mee (yaw = hoek
 * opzij daarvan), zodat hij in hetzelfde pad blijft als wat hij volgt; de richting draait traag mee, zodat de camera
 * niet om de robot heen zwiept als die omkeert. Zonder rijrichting: vanuit wereldrichting yaw, langzaam draaiend.
 */
function follow(get: Subject, o: { dist: number; up: number; yaw: number; spin?: number; lookY?: number }, fallback: Shot): Shot {
  let heading: number | null = null;
  let last = 0;
  return (c, t, k) => {
    const p = get();
    if (!p) return fallback(c, t, k);
    const dt = Math.max(0, Math.min(0.2, t - last));
    last = t;
    let a: number;
    if (p.r !== undefined) {
      const want = p.r + Math.PI + o.yaw;
      if (heading === null || t < 0.05) heading = want;
      const diff = Math.atan2(Math.sin(want - heading), Math.cos(want - heading));
      heading += diff * (1 - Math.exp(-dt * 0.9));
      a = heading;
    } else a = o.yaw + (o.spin ?? 0.06) * t;
    c.pos.set(p.x + Math.sin(a) * o.dist, o.up, p.z + Math.cos(a) * o.dist);
    c.look.set(p.x, o.lookY ?? 0.9, p.z);
  };
}

const IN_HALL = (x: number, z: number) => Math.abs(x) < HALL.w / 2 && Math.abs(z) < HALL.d / 2;
const ROOMS_AREA = { minX: ROOMS.office.minX, maxX: ROOMS.canteen.maxX, minZ: ROOMS.office.minZ };
const IN_ROOMS = (x: number, z: number) => x > ROOMS_AREA.minX && x < ROOMS_AREA.maxX && z > ROOMS_AREA.minZ - 0.4;
/**
 * De camera nooit achter een muur: kijkt hij naar iets in de hal, dan blijft hij binnen de wanden, onder het dak en
 * buiten kantoor en kantine (tenzij hij daar juist naar kijkt); kijkt hij naar iets buiten, dan staat hij ook buiten.
 */
function contain(c: Cam) {
  const W = HALL.w / 2 - 0.6;
  const D = HALL.d / 2 - 0.6;
  if (IN_HALL(c.look.x, c.look.z)) {
    c.pos.x = THREE.MathUtils.clamp(c.pos.x, -W, W);
    c.pos.z = THREE.MathUtils.clamp(c.pos.z, -D, D);
    c.pos.y = Math.min(c.pos.y, HALL.h - 1);
    const lookInRooms = IN_ROOMS(c.look.x, c.look.z);
    if (lookInRooms && !IN_ROOMS(c.pos.x, c.pos.z)) c.pos.z = Math.max(c.pos.z, ROOMS_AREA.minZ + 0.6);
    if (!lookInRooms && IN_ROOMS(c.pos.x, c.pos.z)) c.pos.z = ROOMS_AREA.minZ - 0.8;
  } else if (Math.abs(c.pos.x) < HALL.w / 2 + 1 && Math.abs(c.pos.z) < HALL.d / 2 + 1) {
    // naar buiten de dichtstbijzijnde wand door
    const out = [HALL.w / 2 + 1 - c.pos.x, c.pos.x + HALL.w / 2 + 1, HALL.d / 2 + 1 - c.pos.z, c.pos.z + HALL.d / 2 + 1];
    const i = out.indexOf(Math.min(...out));
    if (i === 0) c.pos.x = HALL.w / 2 + 1;
    else if (i === 1) c.pos.x = -HALL.w / 2 - 1;
    else if (i === 2) c.pos.z = HALL.d / 2 + 1;
    else c.pos.z = -HALL.d / 2 - 1;
  }
}

const CSS = `
.wm-trailer > *:not(#app):not(.wm-trailer-ui):not([style*="z-index: 56"]) { visibility: hidden !important; }
.wm-trailer.wm-show-menu > .menu-panel.menu-panel.menu-panel:not(#app) { visibility: visible !important; right: auto; left: 50%; top: 16vh;
  transform: translateX(-50%) scale(1.2); transform-origin: top center; max-height: 52vh; }
.wm-trailer.wm-show-menu > .menu-panel:not(#app) .tabs { display: none; }
.wm-vintage > *:not(.wm-trailer-ui) { filter: sepia(.9) grayscale(.25) contrast(1.22) brightness(.9); }
.wm-trailer-ui { position: fixed; inset: 0; z-index: 900; pointer-events: none; overflow: hidden; font-family: Georgia, 'Times New Roman', serif; }
.wm-trailer-ui .bar { position: absolute; left: 0; right: 0; height: 9vh; background: #000; z-index: 6; }
.wm-trailer-ui .bar.top { top: 0; } .wm-trailer-ui .bar.bottom { bottom: 0; }
.wm-trailer-ui .grain, .wm-trailer-ui .vignette, .wm-trailer-ui .flicker, .wm-trailer-ui .scratches { position: absolute; inset: 0; z-index: 5; }
.wm-trailer-ui .grain { opacity: .2; mix-blend-mode: overlay; background-size: 256px 256px; }
.wm-trailer-ui .vignette { background: radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(20,12,0,.75) 100%); }
.wm-trailer-ui .flicker { background: #000; opacity: 0; }
.wm-trailer-ui .scratch { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(255,250,235,.55); }
.wm-trailer-ui .film { transition: opacity .8s; }
.wm-trailer-ui:not(.vintage) .film { opacity: 0; }
.wm-trailer-ui .sub { position: absolute; left: 8vw; right: 8vw; bottom: 11vh; z-index: 7; text-align: center; color: #f6eedb;
  font: italic 400 clamp(18px, 2.6vw, 34px)/1.35 Georgia, 'Times New Roman', serif; text-shadow: 0 0 4px #000, 0 2px 6px #000, 0 0 14px #000;
  opacity: 0; transition: opacity .3s; }
.wm-trailer-ui .sub.on { opacity: 1; }
.wm-trailer-ui:not(.vintage) .sub { font: 800 clamp(18px, 2.5vw, 32px)/1.3 system-ui, 'Segoe UI', sans-serif; font-style: normal; color: #fff; letter-spacing: .01em; }
.wm-trailer-ui .card { position: absolute; inset: 0; z-index: 4; display: flex; align-items: center; justify-content: center;
  opacity: 0; transition: opacity .7s; text-align: center; }
.wm-trailer-ui .card.on { opacity: 1; }
.wm-trailer-ui .card.old { background: #110d07; color: #efe4c8; }
.wm-trailer-ui .card.old .frame { padding: 5vh 7vw; border: 3px double #cdbb8f; outline: 1px solid #6e5f3f; outline-offset: 10px; max-width: 70vw; }
.wm-trailer-ui .card.old .frame::before, .wm-trailer-ui .card.old .frame::after { content: '❦'; display: block; font-size: 4vh; color: #cdbb8f; }
.wm-trailer-ui .card.old .frame::after { transform: rotate(180deg); }
.wm-trailer-ui .card.old .small { font: italic 2.6vh Georgia, serif; letter-spacing: .25em; text-transform: uppercase; margin: 1.5vh 0; }
.wm-trailer-ui .card.old .big { font: 700 10vh/1 Georgia, serif; letter-spacing: .08em; margin: 1vh 0; }
.wm-trailer-ui .card.old .mid { font: 400 4.6vh/1.3 Georgia, serif; margin: 1vh 0; }
.wm-trailer-ui .card.plain { background: #000; color: #fff; font: 300 6vh/1.3 system-ui, 'Segoe UI', sans-serif; letter-spacing: .04em; }
.wm-trailer-ui .card.action { background: rgba(0,0,0,.55); color: #fff; font: 900 9vh/1.05 Impact, 'Arial Black', system-ui, sans-serif;
  text-transform: uppercase; letter-spacing: .02em; text-shadow: 0 4px 0 #b3140a, 0 8px 24px #000; }
.wm-trailer-ui .card.action.on .t { animation: wm-slam .5s cubic-bezier(.2,1.6,.4,1) both; }
.wm-trailer-ui .card.action .y { color: #ffd21f; }
@keyframes wm-slam { from { transform: scale(2.4); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.wm-trailer-ui .card.fizor { z-index: 8; background: #fff; }
.wm-trailer-ui .card.fizor::before { content: ''; position: absolute; inset: 0;
  background: radial-gradient(circle at 28% 30%, #1b1d5b 0%, #624f81 42%, rgba(189,97,147,.8) 72%, rgba(239,192,218,.8) 100%); }
.wm-trailer-ui .card.fizor .t { position: relative; color: #fff; font: 700 5vh/1.2 Manrope, Helvetica, Arial, sans-serif; }
.wm-trailer-ui .card.fizor img { display: block; width: min(46vw, 70vh); margin: 0 auto 5vh; }
.wm-trailer-ui .card.fizor .tag { opacity: 0; transition: opacity 1.2s 1.2s; }
.wm-trailer-ui .card.fizor.on .tag { opacity: 1; }
.wm-trailer-ui .card.fizor .hint { position: absolute; left: 0; right: 0; bottom: 4vh; font: 400 1.8vh Manrope, Helvetica, Arial, sans-serif; color: rgba(255,255,255,.75); opacity: 0; transition: opacity 1s; }
.wm-trailer-ui .card.fizor .hint.on { opacity: 1; }
.wm-trailer-ui .leader { position: absolute; inset: 0; z-index: 4; background: #8b8170; display: none; align-items: center; justify-content: center; }
.wm-trailer-ui .leader.on { display: flex; }
.wm-trailer-ui .leader .ring { width: 56vh; height: 56vh; border-radius: 50%; border: 1vh solid #f4efe4; position: relative;
  background: conic-gradient(rgba(30,25,18,.55) calc(var(--p) * 1turn), rgba(0,0,0,0) 0); }
.wm-trailer-ui .leader .ring::before { content: ''; position: absolute; inset: 7vh; border-radius: 50%; border: .6vh solid #f4efe4; }
.wm-trailer-ui .leader .cross { position: absolute; inset: 0; background: linear-gradient(#f4efe4,#f4efe4) center/100% .4vh no-repeat, linear-gradient(#f4efe4,#f4efe4) center/.4vh 100% no-repeat; }
.wm-trailer-ui .leader .num { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font: 700 30vh Georgia, serif; color: #111; }
.wm-trailer-ui .burn { position: absolute; inset: 0; z-index: 7; opacity: 0;
  background: radial-gradient(circle at 62% 44%, #fff 0, #fff3c4 calc(var(--b) * 18%), #ff8a1e calc(var(--b) * 34%), #3a1200 calc(var(--b) * 52%), #000 calc(var(--b) * 70%), rgba(0,0,0,0) calc(var(--b) * 70% + 1%)); }
.wm-trailer-ui .wms { position: absolute; left: 50%; top: 47%; z-index: 3; width: min(78vw, 140vh); padding: 1.2vh; border-radius: 1.4vh;
  background: #15171b; box-shadow: 0 2vh 6vh rgba(0,0,0,.6); transform: translate(-50%, -50%) scale(.35); opacity: 0;
  transition: transform .9s cubic-bezier(.2,.9,.25,1), opacity .5s; }
.wm-trailer-ui .wms.on { transform: translate(-50%, -50%) scale(1); opacity: 1; }
.wm-trailer-ui .wms img { display: block; width: 100%; border-radius: .6vh; }
.wm-trailer-ui.vintage .wms { filter: sepia(.55) contrast(1.08) brightness(.93); } /* lichter dan de film: de app moet leesbaar blijven */
.wm-trailer-ui .whiteout { position: absolute; inset: 0; z-index: 7; background: #fff; opacity: 0; }
.wm-trailer-ui .start { position: absolute; inset: 0; z-index: 9; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 4vh; background: #0c0a06; color: #efe4c8; pointer-events: auto; }
.wm-trailer-ui .start h1 { margin: 0; font: 700 9vh/1 Georgia, serif; letter-spacing: .1em; }
.wm-trailer-ui .start p { margin: 0; font: italic 2.4vh Georgia, serif; opacity: .8; }
.wm-trailer-ui .start button { padding: 1.6vh 4vh; border: 2px solid #cdbb8f; border-radius: 0; background: transparent; color: #efe4c8;
  font: 700 2.8vh Georgia, serif; letter-spacing: .15em; text-transform: uppercase; cursor: pointer; }
.wm-trailer-ui .start button:hover { background: #cdbb8f; color: #0c0a06; }
`;

export function createTrailer({ camera, hall, warehouse, thieves, rocket, radio, handheld, player, setRoof }: Options) {
  const params = new URLSearchParams(location.search);
  const LOOP = params.has('loop');
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  document.body.classList.add('wm-trailer');

  // ---------- Beeld: filmlaag, ondertitels, kaarten ----------
  const ui = document.createElement('div');
  ui.className = 'wm-trailer-ui vintage';
  ui.innerHTML = `
    <div class="card"></div>
    <div class="leader"><div class="ring"><div class="cross"></div></div><div class="num"></div></div>
    <div class="grain film"></div><div class="vignette film"></div><div class="flicker film"></div><div class="scratches film"></div>
    <div class="bar top"></div><div class="bar bottom"></div>
    <div class="wms"><img alt="WMS"></div>
    <div class="sub"></div><div class="burn"></div><div class="whiteout"></div>
    <div class="start"><h1>WM-SIM</h1><p>Een voorlichtingsfilm in kleur en zwart-wit. Met geluid.</p><button>▶ Projector aan</button></div>`;
  document.body.appendChild(ui);
  const $ = <T extends HTMLElement>(s: string) => ui.querySelector(s) as T;
  const card = $<HTMLDivElement>('.card');
  const sub = $<HTMLDivElement>('.sub');
  const grain = $<HTMLDivElement>('.grain');
  const flicker = $<HTMLDivElement>('.flicker');
  const scratches = $<HTMLDivElement>('.scratches');
  const leader = $<HTMLDivElement>('.leader');
  const ring = $<HTMLDivElement>('.leader .ring');
  const leaderNum = $<HTMLDivElement>('.leader .num');
  const burn = $<HTMLDivElement>('.burn');
  const whiteout = $<HTMLDivElement>('.whiteout');
  const startScreen = $<HTMLDivElement>('.start');
  const wmsScreen = $<HTMLDivElement>('.wms');
  wmsScreen.querySelector('img')!.src = wmsUrl;
  const showWms = (on: boolean) => wmsScreen.classList.toggle('on', on);

  // De WMS-app op de monitoren (de pc in de hal en de bureaus op kantoor): een schermafdruk van de app als beeld,
  // passend in een 16:9-scherm. Zonder login (de app als iframe) zou het scherm anders leeg blijven.
  {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 1600;
      c.height = 900;
      const g = c.getContext('2d')!;
      g.fillStyle = '#f4f6f9';
      g.fillRect(0, 0, c.width, c.height);
      const h = (img.height / img.width) * c.width;
      g.drawImage(img, 0, (c.height - h) / 2, c.width, h);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const mat = onTop(new THREE.MeshBasicMaterial({ map: tex }));
      for (const s of [warehouse.pcDisplay, ...hall.desks.map((d) => d.display)]) if (s instanceof THREE.Mesh) s.material = mat;
    };
    img.src = wmsUrl;
  }

  // Filmkorrel: een vaste ruistextuur die elk beeld een stukje verspringt
  {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    const img = g.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    grain.style.backgroundImage = `url(${c.toDataURL()})`;
  }
  for (let i = 0; i < 3; i++) scratches.appendChild(Object.assign(document.createElement('div'), { className: 'scratch' }));

  function setVintage(on: boolean) {
    ui.classList.toggle('vintage', on);
    document.body.classList.toggle('wm-vintage', on);
  }
  setVintage(true);

  function showCard(c: Scene['card'] | undefined) {
    if (!c) {
      card.classList.remove('on');
      return;
    }
    card.className = `card ${c.style}`;
    card.innerHTML = c.html;
    void card.offsetWidth;
    card.classList.add('on');
  }

  // ---------- Geluid: projector, piepjes en een dreun (Web Audio) ----------
  let ac: AudioContext | null = null;
  let master: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  function initAudio() {
    try {
      ac = new AudioContext();
      master = ac.createGain();
      master.gain.value = 0.8;
      master.connect(ac.destination);
      noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    } catch {
      ac = null;
    }
  }
  function tone(freq: number, dur: number, { type = 'sine' as OscillatorType, vol = 0.2, slide = 0, delay = 0 } = {}) {
    if (!ac || !master) return;
    const t0 = ac.currentTime + delay;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }
  function hiss(dur: number, vol: number, freq: number, delay = 0) {
    if (!ac || !master || !noise) return;
    const t0 = ac.currentTime + delay;
    const s = ac.createBufferSource();
    s.buffer = noise;
    const f = ac.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = ac.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f).connect(g).connect(master);
    s.start(t0);
    s.stop(t0 + dur + 0.05);
  }
  const boom = (vol = 0.5) => {
    tone(80, 1.4, { vol, slide: 28 });
    hiss(0.8, vol * 0.6, 180);
  };
  /** Het ratelen van de filmprojector. */
  let projector: { stop: () => void } | null = null;
  function projectorOn() {
    if (!ac || !master || !noise || projector) return;
    const s = ac.createBufferSource();
    s.buffer = noise;
    s.loop = true;
    const f = ac.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2400;
    f.Q.value = 0.8;
    const g = ac.createGain();
    g.gain.value = 0.025;
    const lfo = ac.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 18;
    const depth = ac.createGain();
    depth.gain.value = 0.02;
    lfo.connect(depth).connect(g.gain);
    s.connect(f).connect(g).connect(master);
    s.start();
    lfo.start();
    projector = {
      stop() {
        if (!ac) return;
        const t = ac.currentTime;
        lfo.frequency.linearRampToValueAtTime(3, t + 1.2);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + 1.3);
        s.stop(t + 1.4);
        lfo.stop(t + 1.4);
      },
    };
  }
  function projectorOff() {
    projector?.stop();
    projector = null;
  }
  // ---------- De verteller (spraaksynthese) ----------
  const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
  let voice: SpeechSynthesisVoice | null = null;
  function pickVoice() {
    const want = params.get('voice')?.toLowerCase();
    const all = synth?.getVoices() ?? [];
    if (want) voice = all.find((v) => v.name.toLowerCase().includes(want)) ?? voice;
    if (want && voice) return;
    const score = (v: SpeechSynthesisVoice) =>
      (/maarten/i.test(v.name) ? 100 : 0) + (/natural|online/i.test(v.name) ? 50 : 0) + (/nl-nl/i.test(v.lang) ? 10 : 0) + (/frank/i.test(v.name) ? 5 : 0);
    voice = all.filter((v) => /^nl([-_]|$)/i.test(v.lang)).sort((a, b) => score(b) - score(a))[0] ?? null;
  }
  synth?.addEventListener('voiceschanged', pickVoice);
  pickVoice();

  const text = (l: Line) => (typeof l === 'string' ? l : l.text);
  /**
   * Zoals de verteller het moet uitspreken: 'pellet' (niet 'pallet'), en fizor. als 'fai-zor' (fonetisch 'Faaajzor';
   * een andere spelling proberen kan met ?fizor=..., zonder de code aan te passen).
   */
  const FIZOR = params.get('fizor') || 'Faaajzor';
  const pronounce = (s: string) => s.replace(/pallet/gi, (m) => (m[0] === 'P' ? 'Pellet' : 'pellet')).replace(/fizor/gi, FIZOR);
  const spoken = (l: Line) => pronounce(typeof l === 'string' ? l : l.say);
  const narration = { lines: [] as Line[], i: 0, done: true, token: 0, rate: 1, pitch: 1, onLine: undefined as Scene['onLine'] };
  const estimate = (s: string) => Math.max(1.1, s.length / 14 / narration.rate);
  let timers: number[] = [];
  /**
   * Leest de regels van een scène voor. Alle zinnen gaan in één keer in de wachtrij van de spraaksynthese: dan haalt
   * de (online) stem de volgende zin al op terwijl hij de vorige uitspreekt, zonder stilte ertussen. De ondertitel
   * wisselt op het begin van elke zin. Praat de browser niet (geen klik, geen stem), dan lopen de regels op een klok.
   */
  function narrate(lines: Line[], color: boolean, onLine?: Scene['onLine']) {
    narration.token++;
    const my = narration.token;
    synth?.cancel();
    timers.forEach(clearTimeout);
    timers = [];
    Object.assign(narration, { lines, i: -1, done: lines.length === 0, onLine, rate: color ? 1.04 : 0.97, pitch: color ? 0.8 : 0.9 });
    if (!lines.length) {
      sub.classList.remove('on');
      return;
    }
    const show = (i: number) => {
      if (my !== narration.token || i <= narration.i) return;
      narration.i = i;
      sub.textContent = text(lines[i]);
      sub.classList.add('on');
      onLine?.[i]?.();
    };
    const end = () => {
      if (my !== narration.token || narration.done) return;
      narration.done = true;
      // de laatste zin blijft staan tot de volgende scène (de ondertitel verdwijnt niet als de stem eerder klaar meldt)
      if (lines.length) show(lines.length - 1); // alle zinnen gehad? dan in elk geval de laatste
    };
    const later = (fn: () => void, s: number) => timers.push(window.setTimeout(fn, s * 1000));
    const byClock = (from: number) => {
      let t = 0;
      for (let i = from; i < lines.length; i++) {
        const at = t;
        later(() => show(i), at);
        t += estimate(spoken(lines[i])) + 0.1;
      }
      later(end, t);
    };
    if (!synth || muted) return byClock(0);
    let started = false;
    let failed = false;
    const fail = () => {
      if (failed || my !== narration.token) return;
      failed = true;
      synth.cancel();
      byClock(Math.max(0, narration.i + 1));
    };
    // De zinnen gaan in stukken van hooguit ~110 tekens naar de stem: per losse zin geeft de online stem telkens een
    // pauze, maar een lange tekst breekt hij soms halverwege af (en meldt dan nooit dat hij klaar is). De ondertitel
    // volgt binnen een stuk de woordgrenzen die de stem meldt, of anders de geschatte duur van elke zin.
    const parts = lines.map(spoken);
    const chunks: number[][] = [];
    for (let i = 0; i < parts.length; i++) {
      const last = chunks[chunks.length - 1];
      const len = last ? last.reduce((n, j) => n + parts[j].length + 1, 0) : Infinity;
      if (last && len + parts[i].length <= 110) last.push(i);
      else chunks.push([i]);
    }
    chunks.forEach((chunk, c) => {
      const starts: number[] = [];
      let all = '';
      for (const i of chunk) {
        if (all) all += ' ';
        starts.push(all.length);
        all += parts[i];
      }
      let boundaries = false;
      const guesses: number[] = [];
      const u = new SpeechSynthesisUtterance(all);
      u.lang = 'nl-NL';
      if (voice) u.voice = voice;
      u.rate = narration.rate;
      u.pitch = narration.pitch;
      u.onstart = () => {
        started = true;
        show(chunk[0]);
        let t = 0;
        chunk.forEach((i, k) => {
          if (k > 0) {
            const id = window.setTimeout(() => !boundaries && show(i), t * 1000);
            guesses.push(id);
            timers.push(id);
          }
          t += estimate(parts[i]) * 0.92;
        });
      };
      u.onboundary = (e) => {
        if (!boundaries) {
          boundaries = true;
          guesses.forEach(clearTimeout);
        }
        let k = 0;
        while (k + 1 < starts.length && e.charIndex >= starts[k + 1]) k++;
        show(chunk[k]);
      };
      if (c === chunks.length - 1) u.onend = end;
      u.onerror = (e) => e.error !== 'interrupted' && e.error !== 'canceled' && fail();
      synth.speak(u);
    });
    show(0);
    later(() => !started && fail(), 2.5); // de stem begint niet: dan op de klok
    // Waakhond: valt de stem stil zonder dat te melden, dan is de scène klaar (en loopt de film niet vast)
    let quiet = 0;
    const watch = window.setInterval(() => {
      if (my !== narration.token || narration.done) return clearInterval(watch);
      quiet = started && !synth.speaking && !synth.pending ? quiet + 1 : 0;
      if (quiet >= 3) {
        clearInterval(watch);
        end();
      }
    }, 250);
    timers.push(watch);
    const total = parts.reduce((n, p) => n + estimate(p), 0);
    later(end, total * 1.6 + 3); // uiterste grens
  }
  /** Zonder klik (testen met ?auto) mag de browser niet praten: dan lopen de regels op een klok. */
  let muted = params.has('mute'); // ?mute: zonder stem (testen)

  // ---------- Onderwerpen om te volgen ----------
  const drivers = warehouse.docks.drivers;
  function driverSubject(prefer: (d: (typeof drivers.drivers)[number]) => boolean): Subject {
    let id = '';
    let last: { x: number; z: number; r: number } | null = null;
    return () => {
      let d = drivers.drivers.find((x) => x.id === id);
      if (!d || (!prefer(d) && drivers.drivers.some(prefer))) {
        // (nog) niemand gekozen, of de gekozen chauffeur doet niet (meer) wat de verteller zegt en een ander wel
        last = null;
        d = drivers.drivers.find((x) => prefer(x) && IN_HALL(x.x, x.z)) ?? drivers.drivers.find(prefer) ?? drivers.drivers[0];
        id = d?.id ?? '';
      }
      if (!d) return null;
      // De volgcamera blijft in de hal: loopt de chauffeur de wagen in of naar buiten, dan wacht hij bij de deur
      if (IN_HALL(d.x, d.z) || !last) last = { x: d.x, z: d.z, r: d.r };
      return last;
    };
  }
  const UNLOADING = ['toCargo', 'lifting', 'toLane', 'dropping'];
  const LOADING = ['toStaged', 'lifting', 'toTrailer', 'dropping'];
  type Driver = (typeof drivers.drivers)[number];
  const unloads = (d: Driver) => d.direction === 'in' && UNLOADING.includes(d.phase);
  const loads = (d: Driver) => d.direction === 'out' && LOADING.includes(d.phase);
  const fleet = warehouse.robots.fleet;
  function robotSubject(): Subject {
    let id: string | number = '';
    return () => {
      let r = fleet.robots.find((x) => x.id === id && x.phase !== 'idle');
      if (!r) {
        r = fleet.robots.find((x) => x.phase !== 'idle' && x.kind !== 'count') ?? fleet.robots.find((x) => x.phase !== 'idle') ?? fleet.robots[0];
        id = r?.id ?? '';
      }
      return r ? { x: r.x, z: r.z, r: r.r } : null;
    };
  }
  /** Een vrachtwagen: het liefst een die op het terrein rijdt, anders een aan zijn dock, anders een die nog over de weg komt. */
  function truckSubject(): Subject {
    let id = '';
    return () => {
      const list = warehouse.docks.trucks();
      const yard = (t: (typeof list)[number]) => {
        const p = truckPoseOf(t);
        return p.x < -HALL.w / 2 && p.z < HALL.d / 2 + 14;
      };
      let t = list.find((x) => x.id === id);
      if (!t) {
        t = list.find((x) => (x.status === 'arriving' || x.status === 'parking') && yard(x)) ?? list.find((x) => x.t >= 1) ?? list.find(yard) ?? list[0]; // anders een die nog over de weg komt
        id = t?.id ?? '';
      }
      if (!t) return null;
      const p = truckPoseOf(t);
      // het midden van de wagen: het nulpunt is de achterkant, de cabine zit naar -x (in de draaiing r)
      return { x: p.x - Math.cos(p.r) * 5.5, z: p.z + Math.sin(p.r) * 5.5 };
    };
  }
  /** De boef die het dichtst bij de vorige staat, zodat de camera niet heen en weer springt. */
  function thiefSubject(): Subject {
    let last: { x: number; z: number; r?: number } | null = null;
    return () => {
      const list = thieves.walkers().filter((w) => IN_HALL(w.x, w.z));
      if (!list.length) return last;
      const ref = last;
      const best = ref ? list.reduce((a, b) => (Math.hypot(b.x - ref.x, b.z - ref.z) < Math.hypot(a.x - ref.x, a.z - ref.z) ? b : a)) : list[0];
      // Looprichting uit de verplaatsing (de boeven geven die niet mee)
      const moved = ref ? Math.hypot(best.x - ref.x, best.z - ref.z) : 0;
      const r = ref && moved > 0.02 && moved < 2 ? Math.atan2(best.x - ref.x, best.z - ref.z) : ref?.r;
      last = { x: best.x, z: best.z, r };
      return last;
    };
  }

  // ---------- Vaste plekken ----------
  const dock = DOCKS[1];
  let screenDock = dock;
  const aisle = AISLE_Z[Math.min(2, AISLE_Z.length - 1)];
  const nukeAisle = AISLE_Z[1] ?? AISLE_Z[0];
  const lastX = SECTION_X[SECTION_X.length - 1];
  const canteenX = (ROOMS.canteen.minX + ROOMS.canteen.maxX) / 2;
  const button = V(canteenX, 1.25, HALL.d / 2 - 0.37);
  /** Waar de speler staat als hij niet in beeld hoort: ver weg, waar niemand voor hem hoeft te stoppen. */
  const PARK = V(220, 0, 220);
  const label = hall.scanTargets.filter((s) => /^R4A-0[3-5]-\d$/.test(s.code)).sort((a, b) => Math.abs(a.position.y - 1.5) - Math.abs(b.position.y - 1.5))[0] ?? hall.scanTargets[0];
  const labelAisle = label ? AISLE_Z.reduce((a, b) => (Math.abs(b - label.position.z) < Math.abs(a - label.position.z) ? b : a)) : 0;
  const officeDesk = hall.desks[0];
  /** Waar de jetpack wordt gedemonstreerd: in het pad bij het label van de scanner. */
  const jetSpot = { x: label ? label.position.x : 0, rackZ: label ? label.position.z : 0 };
  /** De speler als figurant (de jetpack-demonstratie): in beeld, met de jetpack aan, zo hoog en zoveel stuwkracht. */
  const actor = { on: false, y: 0, thrust: 0 };
  const dockFallback = dolly(V(-19, 3, dock.z + 6), V(-20, 2.6, dock.z + 3), V(-27, 1, dock.z), V(-27, 1, dock.z - 2));
  const exitShot = dolly(V(15.5, 2.4, 27), V(17.5, 2, 30.5), V(20.5, 1.3, 38.5));

  // Raketwerper: vanaf het looppad het pad in dat bij de boef hoort, en de camera richt op de boef
  const shooter = { pos: V(WALKWAY_X - 1, 1.7, 0), thief: thiefSubject() };
  // Kernbom: door de kantine naar buiten kijken; de bom valt links voor de ramen
  const bombX = canteenX - 20;
  const strike = { at: Infinity };

  const scenes: Scene[] = [
    // ===== Deel 1: de voorlichtingsfilm =====
    { leader: true, min: 4.2, shot: dolly(V(-95, 55, -95), V(-95, 55, -95), V(-8, 0, -10)) },
    {
      card: { style: 'old', html: '<div class="frame"><div class="small">een productie van</div><div class="big">fizor.</div><div class="small">in samenwerking met de toekomst</div></div>' },
      lines: [{ text: 'Een productie van fizor.', say: 'Een productie van Fizor.' }],
      min: 4,
      hold: 0.35,
    },
    {
      card: { style: 'old', html: '<div class="frame"><div class="small">presenteert</div><div class="big">WM-SIM</div><div class="mid">Het magazijn van morgen.<br>Vandaag.</div></div>' },
      lines: [{ text: 'WM-Sim. Het magazijn van morgen. Vandaag.', say: 'WM Sim. Het magazijn van morgen. Vandaag.' }],
      min: 4.5,
      hold: 0.42,
    },
    {
      shot: dolly(V(-100, 60, -100), V(-85, 40, 75), V(-8, 0, -12), V(-8, 0, 5)),
      lines: ['Stelt u zich eens voor.', 'U bent Henk.', 'Henk verkoopt robots.', 'Stofzuigrobots. Robothonden. Dansrobots.', 'En Henk heeft een probleem.'],
      hold: 0.28,
    },
    {
      shot: dolly(V(-72, 9, -42), V(-52, 6, -14), V(-30, 3, -22), V(-30, 2, 0)),
      lines: ['Henk wil zijn proces in kaart brengen.', 'Van vrachtwagen tot klant.', 'Pallet voor pallet.', 'Doos voor doos.', 'Henk is, laten we zeggen... ambitieus.'],
      hold: 0.28,
    },
    { card: { style: 'old', html: '<div class="frame"><div class="small">hoofdstuk I</div><div class="mid">De ontvangst</div></div>' }, lines: ['Hoofdstuk één. De ontvangst.'], min: 2.3, hold: 0.25 },
    {
      shot: follow(truckSubject(), { dist: 17, up: 6, yaw: -2.2, spin: 0.05, lookY: 2 }, dolly(V(-45, 3.5, 34), V(-47, 3.5, 24), V(-36, 1.8, 2), V(-34, 1.8, -14))),
      smooth: 2,
      contain: true,
      lines: ['Om zes uur in de ochtend meldt de eerste vrachtwagen zich bij het dock.', 'Keurig op tijd.', 'Want in deze simulatie is iedereen keurig op tijd.'],
      hold: 0.17,
    },
    {
      shot: follow(driverSubject(unloads), { dist: 4.6, up: 2.3, yaw: 0.6 }, dockFallback),
      ready: () => drivers.drivers.some(unloads),
      wait: 7,
      smooth: 2.5,
      contain: true,
      lines: ['De chauffeur lost zelf, met de elektrische pompwagen.', 'Pallet na pallet rolt de hal in, naar de inslagbaan.'],
      hold: 0.17,
    },
    {
      shot: follow(() => warehouse.counter.robot, { dist: 3.8, up: 2, yaw: 0.7, lookY: 0.7 }, dockFallback),
      ready: () => warehouse.counter.robot.phase !== 'idle',
      wait: 5,
      smooth: 2.5,
      contain: true,
      lines: ['Dan komt de voorraadteller: een robot die elke doos natelt.', 'Want vertrouwen is goed.', 'Maar tellen is beter.'],
      hold: 0.17,
    },
    {
      enter: () => {
        const d = drivers.drivers.find((x) => !['toCanteen', 'coffee', 'toSeat', 'drinking', 'toTruck', 'boarding'].includes(x.phase)) ?? drivers.drivers[0];
        screenDock = DOCKS[d?.dock ?? 1] ?? DOCKS[1];
      },
      shot: (c, t, k) => {
        const z = screenDock.z;
        dolly(V(-26.3, 1.75, z - 1.2), V(-26.8, 1.6, z - 1.6), V(-28, 1.45, z - 1.95))(c, t, k);
      },
      lines: ['Op het dockscherm ziet iedereen wat er binnenkomt.', 'En waar het heen moet.'],
      hold: 0.17,
    },
    { card: { style: 'old', html: '<div class="frame"><div class="small">hoofdstuk II</div><div class="mid">Het systeem</div></div>' }, lines: ['Hoofdstuk twee. Het systeem.'], min: 2.3, hold: 0.25 },
    {
      shot: dolly(V(DESK.radio.x - 1.4, 2, DESK.radio.z - 2.6), V(DESK.radio.x - 0.5, 1.65, DESK.radio.z - 1.7), V(DESK.printer.x - 0.3, 1.1, DESK.printer.z)),
      onLine: {
        0: () => showWms(true),
        1: () => {
          showWms(false);
          // eerst het WMS-scherm weg, dan pas het log (anders staan ze even door elkaar)
          later(0.55, () => {
            menu.open('log');
            document.body.classList.add('wm-show-menu');
          });
        },
      },
      exit: () => {
        showWms(false);
        menu.close();
        document.body.classList.remove('wm-show-menu');
      },
      lines: [
        { text: 'En alles, werkelijk alles, wordt geboekt in de WMS.', say: 'En alles, werkelijk alles, wordt geboekt in de WMS.' },
        { text: 'Via een echte API-koppeling. Elke scan, elke pallet, elke doos.', say: 'Via een echte API-koppeling. Elke scan, elke pallet, elke doos.' },
        'Geen Excel. Geen briefjes.',
        'Geen Henk die het even onthoudt.',
      ],
      hold: 0.28,
    },
    {
      shot: officeDesk
        ? (c, _t, k) => {
            const p = officeDesk.display.getWorldPosition(new THREE.Vector3());
            const n = officeDesk.display.getWorldDirection(new THREE.Vector3());
            const side = new THREE.Vector3(n.z, 0, -n.x);
            c.pos.copy(p).addScaledVector(n, 1.6 - ease(k) * 0.5).addScaledVector(side, 0.7 - ease(k) * 0.3).setY(p.y + 0.45);
            c.look.copy(p);
          }
        : dolly(V(ROOMS.office.maxX - 1, 2.2, ROOMS.office.minZ + 1), V(ROOMS.office.maxX - 1.5, 2, ROOMS.office.minZ + 1.5), V(ROOMS.office.minX + 2, 0.9, ROOMS.office.maxZ - 2)),
      enter: () => {
        menu.open('stock');
        document.body.classList.add('wm-show-menu');
      },
      exit: () => {
        menu.close();
        document.body.classList.remove('wm-show-menu');
      },
      lines: [
        'Op kantoor draait dezelfde WMS-app.',
        'Voorraad, orders, leveringen en robotopdrachten.',
        'Eén waarheid.',
        { text: 'De WMS is leidend. De hal volgt vanzelf.', say: 'De WMS is leidend. De hal volgt vanzelf.' },
      ],
      hold: 0.28,
    },
    { card: { style: 'old', html: '<div class="frame"><div class="small">hoofdstuk III</div><div class="mid">De opslag</div></div>' }, lines: ['Hoofdstuk drie. De opslag.'], min: 2.3, hold: 0.25 },
    {
      shot: dolly(V(SECTION_X[0] - 6, 1.7, aisle), V(lastX + 1, 2.4, aisle), V(SECTION_X[0] + 2, 2, aisle), V(lastX + 12, 3.2, aisle)),
      lines: [
        'Tien paden. Twintig stellingen, rug aan rug.',
        'Elke locatie een code. Elk artikel een vaste plek.',
        { text: 'R1A-03-2.', say: 'R één A, nul drie, twee.' },
        'Poëzie, voor wie het ziet.',
      ],
      hold: 0.21,
    },
    {
      tool: 'scanner',
      shot: label
        ? dolly(
            V(label.position.x + 0.6, label.position.y + 0.25, labelAisle + Math.sign(labelAisle - label.position.z) * 0.4),
            V(label.position.x + 0.2, label.position.y + 0.15, label.position.z + Math.sign(labelAisle - label.position.z) * 1.5),
            label.position.clone(),
          )
        : dolly(V(0, 1.6, aisle), V(1, 1.6, aisle), V(4, 1.2, aisle - 1)),
      lines: [
        'Met de handscanner scant de medewerker elk label en elke palletsticker.',
        { text: 'De WMS beslist. Goed...', say: 'De WMS beslist. Goed...' },
        '...of fout.',
      ],
      hold: 0.17,
    },
    {
      // De jetpack: een medewerker vliegt langs de stelling omhoog naar de bovenste plank
      enter: () => (actor.on = true),
      exit: () => {
        actor.on = false;
        player.position.copy(PARK);
      },
      shot: (c, t) => {
        const side = Math.sign(labelAisle - jetSpot.rackZ) || 1; // vanaf de stelling naar het pad
        const rise = ease((t - 0.6) / 3.2);
        actor.y = 4.3 * rise + Math.sin(t * 2.2) * 0.05 * rise;
        actor.thrust = rise > 0 && rise < 1 ? 1 : rise >= 1 ? 0.5 : 0;
        player.position.set(jetSpot.x, actor.y, labelAisle - side * 0.2);
        player.rotation.y = side > 0 ? Math.PI : 0; // gezicht naar de stelling
        c.pos.set(jetSpot.x + 3.4, 1.3 + actor.y * 0.8, labelAisle + side * 0.9);
        c.look.set(jetSpot.x, actor.y + 1.1, labelAisle - side * 0.2);
      },
      lines: ['En voor de bovenste plank?', 'Daar is een jetpack voor.', 'Volledig verantwoord.'],
      min: 5.5,
      hold: 0.6,
    },
    {
      shot: follow(robotSubject(), { dist: 5, up: 7.4, yaw: 0.2, lookY: 0.4 }, dolly(V(lastX + 6, 3, aisle), V(lastX + 5, 3, aisle - 3), V(lastX - 4, 0.5, aisle))),
      smooth: 2,
      contain: true,
      lines: [
        'Waar mensen moe worden, rijden de robots gewoon door.',
        'Tilrobots. Robot-heftrucks. Pickrobots.',
        { text: 'Hun opdrachten halen ze rechtstreeks uit de WMS.', say: 'Hun opdrachten halen ze rechtstreeks uit de WMS.' },
        'En ze klagen nooit.',
      ],
      hold: 0.17,
    },
    {
      shot: dolly(V(START.forklift.x + 6, 2.4, START.forklift.z - 7), V(START.forklift.x + 3.5, 1.9, START.forklift.z - 5.5), V(START.forklift.x + 1, 1, START.forklift.z)),
      lines: ['Voor het echte handwerk: een heftruck en een pompwagen.', 'Met echte vorken.', 'En echte verantwoordelijkheid.'],
      hold: 0.17,
    },
    { card: { style: 'old', html: '<div class="frame"><div class="small">hoofdstuk IV</div><div class="mid">Orders en verzending</div></div>' }, lines: ['Hoofdstuk vier. Orders en verzending.'], min: 2.3, hold: 0.25 },
    {
      shot: dolly(V(DESK.printer.x - 1.4, 1.6, DESK.printer.z - 1), V(DESK.printer.x - 0.9, 1.4, DESK.printer.z - 0.7), V(DESK.printer.x, 1.02, DESK.printer.z)),
      at: [[0.6, () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', key: 'b' }))]],
      lines: ['Picklijsten komen gewoon uit de printer.', 'Op papier.', 'Zoals het hoort.'],
      hold: 0.28,
    },
    {
      shot: follow(driverSubject(loads), { dist: 5, up: 2.6, yaw: 0.6 }, dockFallback),
      ready: () => drivers.drivers.some(loads),
      wait: 7,
      smooth: 2.5,
      contain: true,
      lines: ['Orders worden gepickt, klaargezet en ingeladen.', 'De vrachtwagen vertrekt.', 'De klant is blij.', 'Henk is blij.'],
      hold: 0.17,
    },
    {
      shot: dolly(V(DESK.radio.x - 0.5, 1.4, DESK.radio.z - 1.1), V(DESK.radio.x - 0.2, 1.3, DESK.radio.z - 0.75), V(DESK.radio.x, 1.08, DESK.radio.z)),
      enter: () => {
        radioLevel = radio.volume;
        radio.setVolume(4);
        radio.setStation(0);
      },
      exit: () => {
        radio.setStation(-1);
        radio.setVolume(radioLevel);
      },
      lines: ['En omdat werk ook gezellig moet zijn: een radio.', 'Met echte zenders.'],
      hold: 0.77,
    },
    {
      shot: dolly(V(ROOMS.canteen.maxX - 0.45, 2.75, ROOMS.canteen.minZ + 0.45), V(ROOMS.canteen.maxX - 0.6, 2.6, ROOMS.canteen.minZ + 0.6), V(CANTEEN.tables[0]?.x ?? canteenX, 0.9, CANTEEN.tables[0]?.z ?? 36)),
      lines: ["Collega's komen met de auto, werken op kantoor en halen koffie in de kantine.", 'Precies volgens planning.', 'Meestal.'],
      hold: 0.21,
    },
    {
      shot: orbit(V(0, 0, 0), 72, 88, -0.7, 0.15),
      enter: () => setRoof(false),
      exit: () => setRoof(true),
      lines: [
        'Met multiplayer werkt het hele team in hetzelfde magazijn.',
        'Met de editor past u de indeling aan.',
        { text: 'En zonder WMS draait alles gewoon op een mock.', say: 'En zonder WMS draait alles gewoon op een mok.' },
        'Want een demo die het niet doet... is óók een proces.',
      ],
      hold: 0.28,
    },
    {
      card: { style: 'old', html: '<div class="frame"><div class="mid">Ontvangst. Opslag.<br>Orders. Verzending.</div><div class="small">alles in kaart</div></div>' },
      lines: ['Ontvangst. Opslag. Orders. Verzending.', 'Alles in kaart.', 'Henk is tevreden.', 'Henk slaapt eindelijk weer.'],
      hold: 0.42,
    },

    // ===== De film breekt =====
    {
      shot: dolly(V(-60, 22, 70), V(-58, 21, 68), V(-5, 0, 0)),
      min: 2.6,
      enter: () => {
        projectorOff();
        tone(240, 1.5, { type: 'sawtooth', vol: 0.12, slide: 30 });
        burnStart = clock;
      },
    },
    {
      card: { style: 'plain', html: 'Maar…' },
      color: true,
      lines: ['Maar.', 'We zijn er nog niet.'],
      min: 3,
      hold: 0.35,
      enter: () => {
        burnStart = -Infinity;
        burn.style.opacity = '0';
      },
    },

    // ===== Deel 2: in kleur =====
    {
      color: true,
      shot: exitShot,
      enter: () => {
        boom(0.5);
        pirateRadio(true); // de boeven komen binnen met PiratenRadio op de achtergrond
        thieves.request({ a: 'start' });
      },
      lines: ['Want wat als Henk...', '...wordt beroofd?'],
      min: 6.5,
      hold: 0.17,
    },
    {
      color: true,
      shot: follow(thiefSubject(), { dist: 4.2, up: 2.1, yaw: Math.PI - 0.5, lookY: 1 }, exitShot),
      smooth: 3,
      contain: true,
      lines: ['Boeven. In boevenpak. Met bivakmuts.', 'En ze komen voor de dansrobots.'],
      hold: 0.28,
    },
    {
      color: true,
      card: { style: 'action', html: '<div class="t">Gelukkig is<br>WM-Sim <span class="y">voorbereid</span></div>' },
      enter: () => boom(0.7),
      lines: [{ text: 'Gelukkig is WM-Sim voorbereid.', say: 'Gelukkig is WM Sim voorbereid.' }],
      min: 2.6,
      hold: 0.15,
    },
    {
      color: true,
      tool: 'rocket',
      smooth: 7,
      contain: true,
      enter: () => {
        const p = shooter.thief() ?? { x: 0, z: aisle };
        const az = AISLE_Z.reduce((a, b) => (Math.abs(b - p.z) < Math.abs(a - p.z) ? b : a));
        shooter.pos.set(WALKWAY_X - 1, 1.7, az);
      },
      shot: (c) => {
        const p = shooter.thief();
        c.pos.copy(shooter.pos);
        if (p) c.look.set(p.x, 1, p.z);
        else c.look.set(lastX, 1, shooter.pos.z);
      },
      at: [
        [1.8, () => rocket.shoot()],
        [3.4, () => rocket.shoot()],
        [5.0, () => rocket.shoot()],
      ],
      lines: ['Maak kennis met de raketwerper.', 'Volledig geïntegreerd in uw magazijnproces.', 'Voorraadverschil?', 'Opgelost.'],
      min: 7,
      hold: 0.35,
    },
    {
      color: true,
      tool: 'rocket',
      shot: dolly(V(lastX + 5, 1.75, nukeAisle + 0.4), V(lastX + 4.5, 1.7, nukeAisle), V(-HALL.w / 2, 1.5, nukeAisle)),
      enter: () => rocket.loadNuke(true),
      onLine: { 1: () => (pending = [clockScene + 1.2, () => rocket.shoot()]) },
      lines: ['En voor de écht grote voorraadverschillen...', '...de kernbom-optie.'],
      min: 6,
      hold: 4.5,
    },
    {
      color: true,
      enter: () => {
        player.position.set(canteenX, 0, HALL.d / 2 - 4.5);
        strike.at = Infinity;
      },
      exit: () => player.position.copy(PARK),
      shot: (c, t) => {
        const k = ease((t - strike.at) / 2.6);
        const near = V(canteenX, 1.4, button.z - 1);
        const far = V(canteenX - 2.2, 1.45, button.z - 1.6);
        c.pos.lerpVectors(near, far, k);
        c.look.lerpVectors(button, V(bombX, 30, HALL.d / 2 + 250), k);
      },
      onLine: {
        2: () => {
          strike.at = clockScene;
          rocket.airstrike(bombX, HALL.d / 2 + 250, true);
        },
      },
      lines: ['Komt de dreiging van buiten?', 'Daarvoor is er de rode knop in de kantine.', 'Wat die doet...', '...staat bewust niet in de handleiding.'],
      min: 8,
      hold: 9,
    },
    {
      color: true,
      shot: orbit(V(-4, 0, 0), 95, 55, 3.6, 4.3),
      onLine: {
        1: () => {
          flashStart = clock;
          rocket.restore();
          thieves.request({ a: 'stop' });
        },
      },
      lines: ['En daarna?', 'Eén klik op herstellen.', 'Alsof er nooit iets is gebeurd.'],
      hold: 0.42,
    },
    {
      color: true,
      card: { style: 'fizor', html: `<div class="t"><img src="${logoUrl}" alt="fizor."><div class="tag">Overal op voorbereid.</div></div><div class="hint">Esc: zelf spelen · ${LOOP ? 'de film begint zo opnieuw' : 'Enter: nog een keer'}</div>` },
      enter: () => {
        pirateRadio(false);
        [261.6, 329.6, 392, 523.3].forEach((f, i) => tone(f, 4.5, { type: 'triangle', vol: 0.07, delay: i * 0.06 }));
      },
      lines: [{ text: 'fizor. Overal op voorbereid.', say: 'Fizor. Overal op voorbereid.' }],
      min: 6,
      hold: Infinity,
      at: [
        [4, () => card.querySelector('.hint')?.classList.add('on')],
        [12, () => LOOP && restart()],
      ],
    },
  ];

  // ---------- Afspelen ----------
  /** Weer van voren af aan: de hal heel, geen boeven meer. */
  function restart() {
    pirateRadio(false);
    rocket.restore();
    thieves.request({ a: 'stop' });
    go(0);
  }
  let index = -1;
  let started = false;
  let clock = 0;
  let clockScene = 0;
  let speechEnd = Infinity;
  let fired = 0;
  let pending: [number, () => void] | null = null;
  let burnStart = -Infinity;
  let flashStart = -Infinity;
  let radioLevel = radio.volume;
  let pirate = false;
  /** PiratenRadio (zender 0) aan of uit; het volume gaat daarna terug naar waar het stond. */
  function pirateRadio(on: boolean) {
    if (on === pirate) return;
    pirate = on;
    if (on) {
      radioLevel = radio.volume;
      radio.setVolume(10);
      radio.setStation(0);
    } else {
      radio.setStation(-1);
      radio.setVolume(radioLevel);
    }
  }
  let leaderBeep = -1;
  let snap = true;
  /** De scène wacht tot er te zien is wat de verteller gaat zeggen (zie Scene.ready). */
  let holding = false;
  let covered = false;
  let coverTimer = 0;
  let lastFrame = 0;
  let hideLabels = 0;
  const want: Cam = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  const cam: Cam = { pos: V(-95, 55, -95), look: V(-8, 0, -10) };
  let tool: Tool = null;

  /** Iets later in dezelfde scène (vervalt als de scène voorbij is). */
  function later(s: number, fn: () => void) {
    const at = index;
    window.setTimeout(() => at === index && fn(), s * 1000);
  }
  function go(i: number) {
    scenes[index]?.exit?.();
    index = Math.max(0, Math.min(scenes.length - 1, i));
    const s = scenes[index];
    clockScene = 0;
    fired = 0;
    pending = null;
    speechEnd = Infinity;
    snap = true;
    tool = s.tool ?? null;
    if (tool === 'scanner') handheld.setTool('scanner');
    rocket.setEquipped(tool === 'rocket');
    setVintage(!s.color);
    if (!s.color) projectorOn();
    showCard(s.card);
    leader.classList.toggle('on', !!s.leader);
    // Een dichte kaart (of de aftelfilm) staat voor het hele beeld: dan hoeft de hal niet getekend te worden
    clearTimeout(coverTimer);
    covered = false;
    if (s.leader || (s.card && s.card.style !== 'action')) coverTimer = window.setTimeout(() => (covered = true), 900);
    leaderBeep = -1;
    s.enter?.();
    holding = !!s.ready && !s.ready();
    if (holding) narrate([], !!s.color);
    else narrate(s.lines ?? [], !!s.color, s.onLine);
  }

  function start() {
    if (started) return;
    started = true;
    startScreen.remove();
    initAudio();
    void ac?.resume();
    pickVoice();
    go(Number(params.get('from')) || 0);
  }
  const startButton = startScreen.querySelector('button')!;
  startButton.addEventListener('click', start);

  if (params.has('auto')) {
    muted = true;
    setTimeout(start, 300);
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      synth?.cancel();
      const p = new URLSearchParams(location.search);
      for (const k of ['trailer', 'auto', 'from', 'voice', 'loop']) p.delete(k);
      location.search = p.toString();
    } else if (e.code === 'ArrowRight' && started) go(index + 1);
    else if (e.code === 'Enter' && started && index === scenes.length - 1) restart();
  });

  player.position.copy(PARK);
  if (import.meta.env.DEV) Object.assign(window, { wmTrailer: { go, get index() { return index; }, scenes: scenes.length } });

  return {
    /** Staat er een dichte kaart voor het beeld? Dan hoeft de hal niet getekend te worden. */
    get covered() {
      return covered;
    },
    /** Hoe snel de sim loopt: op het startscherm, achter de eerste kaarten en als een scène op iets wacht sneller. */
    get simSpeed() {
      if (!started) return 4;
      if (holding) return 5; // even doorspoelen tot er iets te zien is
      return index <= 2 ? 6 : 1; // tijdens de aftelfilm en de titelkaarten (dan zie je de hal niet)
    },
    /** De speler als figurant met de jetpack (main.ts tekent de jetpack en de vliegende houding). */
    actor,
    /** Wat de camera in handen heeft: scanner, raketwerper of niets. */
    get tool() {
      return tool;
    },
    /** Waar de camera staat: daar luister je (radio, printer) en daarvan hangt de lucht af. */
    listener: cam.pos,
    /** Het voorvlak van de camera: verder weg kijken mag grover. */
    get near() {
      return THREE.MathUtils.clamp(cam.pos.distanceTo(cam.look) * 0.004, 0.05, 0.6);
    },
    update(frameDt: number) {
      // De film loopt op de klok van de muur (net als de verteller), niet op de begrensde tijd per beeld van de sim:
      // anders duurt een scène langer zodra de framerate even zakt.
      const now = performance.now();
      const dt = Math.min(0.25, lastFrame ? (now - lastFrame) / 1000 : frameDt);
      lastFrame = now;
      clock += dt;
      player.visible = actor.on;
      // Zwevende labels (taken, banen, namen) worden door muren heen getekend: in de film horen die niet
      if ((hideLabels -= dt) <= 0) {
        hideLabels = 0.5;
        camera.parent?.traverse((o) => {
          const m = (o as THREE.Sprite).material;
          if ((o as THREE.Sprite).isSprite && m && !m.depthTest) o.layers.set(31); // de camera kijkt alleen naar laag 0
        });
      }
      handheld.setActive(tool === 'scanner');
      rocket.setAllowed(tool === 'rocket');
      const s = scenes[index];
      if (s && holding && (s.ready?.() || clockScene >= (s.wait ?? 6))) {
        // nu is het te zien: de scène begint echt (de volgcamera zoekt opnieuw zijn onderwerp)
        holding = false;
        clockScene = 0;
        snap = true;
        speechEnd = Infinity;
        narrate(s.lines ?? [], !!s.color, s.onLine);
      }
      if (s) {
        clockScene += dt;
        if (narration.done && speechEnd === Infinity && !holding) speechEnd = clockScene;
        const span = Math.max(s.min ?? 0, (s.lines ?? []).reduce((n, l) => n + estimate(spoken(l)) + 0.28, 0) + (s.hold === Infinity ? 0 : (s.hold ?? 0)));
        const k = clamp01(clockScene / Math.max(span, 0.1));
        if (s.shot) {
          s.shot(want, clockScene, k);
          if (s.contain) contain(want);
          const f = snap || !s.smooth ? 1 : 1 - Math.exp(-dt * s.smooth);
          cam.pos.lerp(want.pos, f);
          cam.look.lerp(want.look, f);
          snap = false;
        }
        // Gebeurtenissen op tijd
        const events = s.at ?? [];
        while (fired < events.length && clockScene >= events[fired][0]) events[fired++][1]();
        if (pending && clockScene >= pending[0]) {
          const fn = pending[1];
          pending = null;
          fn();
        }
        // Aftelfilm
        if (s.leader) {
          const left = Math.max(0, 4 - clockScene);
          const n = Math.ceil(left);
          ring.style.setProperty('--p', String(1 - (left % 1)));
          leaderNum.textContent = n > 0 ? String(n) : '';
          if (n !== leaderBeep && n > 0) {
            leaderBeep = n;
            tone(n === 1 ? 1320 : 1000, 0.09, { vol: 0.12 });
          }
        }
        if (!holding && s.hold !== Infinity && narration.done && clockScene >= Math.max(s.min ?? 0, speechEnd + (s.hold ?? 0))) go(index + 1);
      }
      // Film: korrel, flikkering, krassen en een licht trillend beeld
      if (ui.classList.contains('vintage')) {
        grain.style.backgroundPosition = `${(Math.random() * 256) | 0}px ${(Math.random() * 256) | 0}px`;
        flicker.style.opacity = String(Math.random() * 0.07);
        for (const sc of scratches.children as HTMLCollectionOf<HTMLElement>) {
          sc.style.display = Math.random() < 0.25 ? 'block' : 'none';
          sc.style.left = `${Math.random() * 100}%`;
        }
      }
      const app = document.getElementById('app');
      if (app) app.style.transform = ui.classList.contains('vintage') && Math.random() < 0.08 ? `translateY(${Math.random() < 0.5 ? -2 : 2}px)` : '';
      // De film brandt door (het einde van deel 1) en de witte flits van het herstellen
      const b = clamp01((clock - burnStart) / 1.6);
      burn.style.opacity = clock - burnStart >= 0 && clock - burnStart < 3 ? '1' : '0';
      burn.style.setProperty('--b', String(0.15 + b * 2.2));
      const w = (clock - flashStart) / 1.4;
      whiteout.style.opacity = w >= 0 && w < 1 ? String(1 - w) : '0';

      if (!started) {
        // Voor de start: langzaam rond het gebouw, achter het startscherm
        cam.pos.set(Math.sin(clock * 0.05) * 110, 60, Math.cos(clock * 0.05) * 110);
        cam.look.set(-6, 0, 0);
      }
      camera.position.copy(cam.pos);
      camera.lookAt(cam.look);
    },
  };
}
