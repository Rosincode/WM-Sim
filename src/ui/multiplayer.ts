import * as THREE from 'three';
import { START } from '../sim/layout';
import { createRoom, type Peer } from '../sim/multiplayer/room';
import type { SharedState } from '../sim/warehouse';
import { CHAT_MAX, createChat } from './chat';
import { createFacePicker, decodeFace, faceVersion, loadFace, saveFace, validFace } from './facePhoto';
import { menu } from './menu';
import { createCharacter, type HandTarget } from './scene/character';
import type { ForkliftState } from './scene/forklift';
import type { JackState } from './scene/palletJack';
import type { Solid } from './scene/warehouse';
import { CARRY_AHEAD, dropLoad } from './warehouseView';

// Multiplayer: iedereen die de game opent komt in dezelfde kamer en deelt één magazijn.
// - Elke speler stuurt ~10× per seconde zijn positie; de anderen tekenen daar een figuur.
// - De gedeelde wereld (voorraad, orders, banen, vrachtwagens, heftruck) gaat als geheel over de lijn
//   zodra iemand er iets aan verandert. De hoogste revisie wint; bij gelijke stand beslist het speler-id.
// - Eén speler is host (wie het langst binnen is): alleen daar ontstaan nieuwe vrachtwagens en orders.
// - De host bewaart de wereld op de broker: wie later als eerste binnenkomt gaat verder met die stand.
// - Chat: Enter (of T) opent het chatvenster; een bericht staat daar én als wolkje boven wie het zegt.
// WMS-acties blijven lokaal: wie een handeling doet, meldt die zelf bij zijn WMS.

const TICK_MS = 100;
const HEARTBEAT_MS = 1000;
const HOST_RESEND_MS = 10_000;
/** Hoe vaak de host de wereld hooguit op de broker bewaart (ms). */
const SAVE_MS = 3000;
const NAME_KEY = 'wm-sim.name';
const VEST_COLORS = ['#1e88e5', '#43a047', '#8e24aa', '#00acc1', '#d81b60', '#6d4c41', '#3949ab', '#c0ca33'];

type Pose = {
  /** Naam */ n: string;
  x: number; y: number; z: number;
  /** Draaiing */ r: number;
  /** Rijdt in de heftruck */ d: 0 | 1;
  /** Zit op een stoel (aan een bureau in het kantoor) */ s?: 1;
  /** Draagt: '' of de omschrijving van de pallet (zie carryLabel) */ c: string;
  /** Stand van de heftruck, alleen als deze speler rijdt */ f?: ForkliftState;
  /** Kijkrichting: omhoog/omlaag */ p: number;
  /** Kijkrichting opzij t.o.v. het lichaam (vanaf de stoel van de heftruck) */ ly: number;
  /** In de hand: 0 niets, 1 scanner, 2 tablet */ t: 0 | 1 | 2;
  /** Aantal keer gescand (teller) */ sc: number;
  /** Aantal piepjes van de scanner (teller) */ b: number;
  /** Laatste piep was een goede scan */ bo: 0 | 1;
  /** Stuuruitslag -1..1, als deze speler rijdt */ w: number;
  /** Staat op de heftruck: plek t.o.v. de truck; y = hoogte boven de vorken als hij op de vorken of de last staat */
  v?: { x: number; z: number; y?: number };
  /** Los van de grond (springen, vallen) */ j: 0 | 1;
  /** Toetert (als deze speler rijdt) */ k: 0 | 1;
  /** Stand van de pompwagen, alleen als deze speler hem vasthoudt */ pj?: JackState;
  /** Versie van de foto op het hoofd ('' = geen foto); de foto zelf gaat apart over de lijn */ fv: string;
};
type StateMsg = { rev: number; w: string; sim: SharedState; fork: ForkliftState; jack?: JackState };

interface Options {
  scene: THREE.Scene;
  player: THREE.Object3D;
  /** Foto op het hoofd van het eigen figuur zetten (null = geen foto). */
  setFace(image: HTMLImageElement | null): void;
  /** Naam van de kamer; iedereen met dezelfde naam speelt samen. */
  room: string;
  /** apply: saved = de wereld komt van de broker (niemand draagt nog iets), niet van een medespeler. */
  shared: { state(): SharedState; apply(s: SharedState, saved?: boolean): void; setAuthority(on: boolean): void };
  /** Wat deze speler draagt, als tekst ('' = niets); carryMesh bouwt daar bij elke speler dezelfde pallet met dozen van. */
  carryLabel(): string;
  carryMesh(label: string): THREE.Object3D | null;
  forklift: {
    getState(): ForkliftState;
    applyState(s: ForkliftState, withLoose?: boolean): void;
    applyLoose(list: ForkliftState['loose']): void;
    setRemoteDriven(on: boolean): void;
    readonly steer: number;
    setRemoteSteer(v: number): void;
    readonly honking: boolean;
    setRemoteHorn(volume: number): void;
    steeringGrip(point: THREE.Vector3, normal: THREE.Vector3): void;
    readonly group: THREE.Object3D;
    readonly forkHeight: number;
  };
  /** De pompwagen: wie hem vasthoudt stuurt de stand mee met zijn positie. */
  jack: { getState(): JackState; applyState(s: JackState): void; grip(side: 1 | -1, point: THREE.Vector3): unknown; held(): boolean; /** Twee spelers pakten hem tegelijk. */ release(): void };
  /** De radio in de hal: de gekozen zender (-1 = uit) en het volume (0 t/m 10) gelden voor alle spelers. */
  radio: { readonly station: number; readonly volume: number; setStation(i: number): void; setVolume(l: number): void; onChange(l: () => void): void };
  /** Staat deze speler op de heftruck? Dan zijn plek t.o.v. de truck (y: hoogte boven de vorken), anders null. */
  rider(): { x: number; z: number; y?: number } | null;
  /** Is deze speler los van de grond (springen, vallen)? */
  airborne(): boolean;
  /** Kijkrichting van deze speler (first person), anders nul. */
  look(): { yaw: number; pitch: number };
  /** Wat deze speler in de hand heeft: 0 niets, 1 scanner, 2 tablet. */
  tool(): 0 | 1 | 2;
  /** Aantal keer dat deze speler gescand heeft. */
  scans(): number;
  /** Piepjes van de scanner van deze speler: de teller, en of de laatste een goede scan was. */
  beeps(): { count: number; ok: boolean };
  /** De scanner van een andere speler piept, op deze plek in de hal. */
  scanBeep(ok: boolean, at: THREE.Vector3): void;
  /** Hoogte van de heupen van iemand die in de heftruck zit. */
  seatHipY: number;
  /** Hoogte van de heupen van iemand die op een stoel zit. */
  chairHipY: number;
  /** Zit deze speler op een stoel (aan een bureau)? */
  isSitting(): boolean;
  isDriving(): boolean;
  /** Twee spelers stapten tegelijk in: deze speler moet er weer uit. */
  leaveForklift(): void;
}

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const round = (n: number, f = 100) => Math.round(n * f) / f;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

// De broker is publiek: controleer de vorm van wat binnenkomt voordat we het gebruiken.
function validFork(f: unknown): f is ForkliftState {
  return isObj(f) && [f.x, f.z, f.r, f.h].every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    (f.load === null || isObj(f.load)) && Array.isArray(f.loose) && f.loose.every(isObj);
}
function validJack(k: unknown): k is JackState {
  return isObj(k) && [k.x, k.z, k.r].every((v) => typeof v === 'number' && Number.isFinite(v)) && (k.load === null || isObj(k.load));
}
/**
 * Waar de heftruck en de pompwagen begonnen voordat de parkeerplaats er was (bij de pc). Een bewaarde hal van
 * toen heeft ze daar nog staan zonder dat iemand ze er heeft neergezet.
 */
const OLD_STARTS = { forklift: { x: -12.6, z: 2.5 }, palletJack: { x: -13.4, z: 5.4 } };
/**
 * De stand van een voertuig uit een gedeelde of bewaarde hal. Staat het leeg en onaangeroerd op zijn oude
 * startplek, dan hoort het in zijn eigen vak op de parkeerplaats; elke andere plek is een plek waar iemand het
 * heeft neergezet, en daar blijft het.
 */
function parked<S extends { x: number; z: number; r: number; load: unknown }>(s: S, old: { x: number; z: number }, home: { x: number; z: number; r: number }): S {
  const untouched = !s.load && Math.hypot(s.x - old.x, s.z - old.z) < 0.05 && Math.abs(Math.sin(s.r) - 1) < 0.01;
  return untouched ? { ...s, x: home.x, z: home.z, r: home.r } : s;
}

function validState(m: unknown): m is StateMsg {
  if (!isObj(m) || typeof m.rev !== 'number' || typeof m.w !== 'string' || !validFork(m.fork) || !isObj(m.sim)) return false;
  const s = m.sim;
  return Array.isArray(s.stock) && Array.isArray(s.orders) && Array.isArray(s.laneIn) && Array.isArray(s.laneOut) &&
    isObj(s.trucks) && isObj(s.seq) && typeof s.outDock === 'number';
}

/** Naambordje boven een speler; kijkt altijd naar de camera. */
function nameTag() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.set(1.4, 0.35, 1);
  sprite.renderOrder = 10;
  let current: string | null = null;
  return {
    sprite,
    set(text: string, color: string) {
      if (text === current) return;
      current = text;
      ctx.clearRect(0, 0, 256, 64);
      ctx.fillStyle = 'rgba(0,0,0,.65)';
      ctx.beginPath();
      ctx.roundRect(2, 2, 252, 60, 14);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(28, 32, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 28px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 138, 34, 196);
      texture.needsUpdate = true;
    },
  };
}

/** Tekstwolkje boven een speler die iets zegt in de chat; verdwijnt vanzelf weer. */
function speechBubble() {
  const W = 512;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.center.set(0.5, 0); // onderkant (de punt van het wolkje) op de plek van de sprite
  sprite.scale.set(2.4, 1.2, 1);
  sprite.renderOrder = 11;
  sprite.visible = false;
  let left = 0;
  return {
    sprite,
    say(text: string) {
      ctx.clearRect(0, 0, W, H);
      ctx.font = 'bold 30px system-ui, sans-serif';
      // Afbreken op woorden; te lange woorden op letters
      const lines: string[] = [];
      let line = '';
      const fits = (s: string) => ctx.measureText(s).width <= W - 60;
      for (let word of text.split(/\s+/).filter(Boolean)) {
        if (line && fits(`${line} ${word}`)) {
          line += ` ${word}`;
          continue;
        }
        if (line) lines.push(line);
        while (!fits(word)) {
          let n = word.length - 1;
          while (n > 1 && !fits(word.slice(0, n))) n--;
          lines.push(word.slice(0, n));
          word = word.slice(n);
        }
        line = word;
      }
      if (line) lines.push(line);
      if (lines.length > 4) {
        lines.length = 4;
        lines[3] = `${lines[3].slice(0, -1)}…`;
      }
      const lineH = 38;
      const w = Math.max(80, ...lines.map((l) => ctx.measureText(l).width)) + 44;
      const h = lines.length * lineH + 24;
      const tail = 20;
      const x = (W - w) / 2;
      const y = H - tail - h - 2;
      ctx.fillStyle = 'rgba(255,255,255,.96)';
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 18);
      ctx.moveTo(W / 2 - 14, y + h - 1);
      ctx.lineTo(W / 2, y + h + tail);
      ctx.lineTo(W / 2 + 14, y + h - 1);
      ctx.stroke();
      ctx.fill();
      ctx.fillStyle = '#14181c';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      lines.forEach((l, i) => ctx.fillText(l, W / 2, y + 12 + lineH * (i + 0.5) + 1));
      texture.needsUpdate = true;
      left = Math.min(10, 4 + text.length * 0.06);
      sprite.visible = true;
    },
    update(dt: number) {
      if (left <= 0) return;
      left -= dt;
      material.opacity = Math.min(1, Math.max(0, left / 0.4));
      if (left <= 0) sprite.visible = false;
    },
  };
}

/** Elke speler een eigen kleur (hesje, naambordje, naam in de chat), zodat je elkaar uit elkaar houdt. */
const peerColor = (id: string) => VEST_COLORS[(parseInt(id.slice(0, 4), 16) || 0) % VEST_COLORS.length];
// De broker is publiek: stuurtekens eruit en de lengte begrenzen.
const cleanChat = (v: unknown) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, CHAT_MAX);

export function mountMultiplayer(o: Options) {
  const room = createRoom(o.room);
  let stored = '';
  try {
    stored = (localStorage.getItem(NAME_KEY) ?? '').trim().slice(0, 20);
  } catch {
    // geen opslag beschikbaar
  }
  let name = stored || `Speler ${room.id.slice(0, 3).toUpperCase()}`;

  // ---------- Foto op het hoofd ----------
  // Elke speler meldt in zijn positiebericht welke versie van zijn foto hij heeft; wie die versie nog
  // niet kent vraagt erom ('fq'), waarna de eigenaar de foto zelf rondstuurt ('f').
  let face = loadFace();
  let faceVer = faceVersion(face);
  let faceSentAt = -1e9;
  function showOwnFace() {
    const shown = face;
    if (!shown) return o.setFace(null);
    decodeFace(shown).then((img) => shown === face && o.setFace(img), () => o.setFace(null));
  }
  showOwnFace();
  function sendFace() {
    if (!face || room.status !== 'online') return;
    faceSentAt = performance.now();
    room.send('f', { v: faceVer, img: face });
  }

  // ---------- Andere spelers ----------
  type Avatar = {
    character: ReturnType<typeof createCharacter>;
    tag: ReturnType<typeof nameTag>;
    bubble: ReturnType<typeof speechBubble>;
    /** De pallet die deze speler draagt, met zijn dozen. */
    load: THREE.Object3D | null;
    loadKey: string;
    color: string;
    target: THREE.Vector3;
    pose: Pose;
    placed: boolean;
    /** Gladgestreken kijkrichting. */
    look: { yaw: number; pitch: number };
    /** Resterende tijd van de scanflits. */
    scanT: number;
    /** Linkerhand op het stuur, als deze speler rijdt. */
    wheelHand: HandTarget;
    /** Beide handen op de handgreep van de pompwagen, als deze speler hem vasthoudt. */
    jackHands: HandTarget[];
    /** Gladgestreken plek op de heftruck, als deze speler erop staat. */
    ride: { x: number; z: number } | null;
    /** Versie van de foto die nu op het hoofd staat, en wanneer we er voor het laatst om vroegen. */
    faceVer: string;
    faceAskedAt: number;
  };
  const avatars = new Map<string, Avatar>();

  function addAvatar(peer: Peer): Avatar {
    const color = peerColor(peer.id);
    const character = createCharacter(undefined, { vest: color });
    const tag = nameTag();
    tag.sprite.position.y = 2.2;
    const bubble = speechBubble();
    bubble.sprite.position.y = 2.42; // net boven het naambordje
    character.group.add(tag.sprite, bubble.sprite);
    o.scene.add(character.group);
    const avatar: Avatar = {
      character, tag, bubble, load: null, loadKey: '', color,
      target: new THREE.Vector3(),
      pose: { n: '', x: 0, y: 0, z: 0, r: 0, d: 0, c: '', p: 0, ly: 0, t: 0, sc: 0, b: 0, bo: 1, w: 0, j: 0, k: 0, fv: '' },
      placed: false,
      look: { yaw: 0, pitch: 0 },
      scanT: 0,
      wheelHand: { point: new THREE.Vector3(), normal: new THREE.Vector3() },
      jackHands: [{ point: new THREE.Vector3() }, { point: new THREE.Vector3() }],
      ride: null,
      faceVer: '',
      faceAskedAt: -1e9,
    };
    avatars.set(peer.id, avatar);
    return avatar;
  }

  room.onLeave((peer) => {
    const a = avatars.get(peer.id);
    if (!a) return;
    a.character.setFace(null); // textuur van de foto vrijgeven
    if (a.load) dropLoad(a.load);
    a.character.group.removeFromParent();
    avatars.delete(peer.id);
    refreshChip();
  });

  const remoteDriver = () => [...avatars.values()].find((a) => a.pose.d === 1);

  // ---------- Chat ----------
  // Een bericht staat in het chatvenster en als wolkje boven wie het zegt. Net als de rest gaat het over
  // de publieke broker: iedereen in de kamer leest mee.
  const ownBubble = speechBubble();
  ownBubble.sprite.position.y = 2.2; // boven je eigen figuur (te zien in third person en overzicht)
  o.player.add(ownBubble.sprite);
  const chat = createChat({
    onSend(raw) {
      const text = cleanChat(raw);
      if (!text) return;
      chat.add(name, '#ffd54f', text);
      ownBubble.say(text);
      if (room.status === 'online') room.send('c', { n: name, m: text });
      else chat.system('Geen verbinding: andere spelers zien dit bericht niet.');
    },
  });
  /** Laatste chatbericht per speler, tegen een stortvloed aan berichten. */
  const lastChatAt = new Map<string, number>();

  // ---------- Gedeelde wereld ----------
  let rev = 0;
  let writer = room.id;
  // De rijpositie van vrachtwagens (t) verandert elke frame en telt niet als wijziging: iedereen rijdt ze zelf.
  const simKey = () => JSON.stringify(o.shared.state(), (k, v) => (k === 't' ? 0 : v));
  // Tijdens het rijden gaat de stand van de heftruck mee met de positie van de bestuurder, niet als wijziging.
  const forkNow = () => JSON.stringify({ ...o.forklift.getState(), loose: 0 });
  const forkKey = () => (o.isDriving() || remoteDriver() ? lastForkKey : forkNow());
  let lastForkKey = forkNow();
  // Losse pallets op de vloer gaan altijd als wijziging mee, ook als er iemand rijdt: de pompwagen zet ze ook neer.
  const looseKey = () => JSON.stringify(o.forklift.getState().loose);
  let lastLooseKey = looseKey();
  // Net als de heftruck: wie de pompwagen vasthoudt stuurt de stand mee met zijn positie.
  const remoteHolder = () => [...avatars.values()].find((a) => a.pose.pj);
  const jackKey = () => (o.jack.held() || remoteHolder() ? lastJackKey : JSON.stringify(o.jack.getState()));
  let lastJackKey = JSON.stringify(o.jack.getState());
  let lastSimKey = simKey();
  let lastStateAt = 0;

  const stateMsg = (): StateMsg => ({ rev, w: writer, sim: o.shared.state(), fork: o.forklift.getState(), jack: o.jack.getState() });
  function sendState() {
    lastStateAt = performance.now();
    room.send('s', stateMsg());
  }

  /** Neemt een wereld over: van een medespeler, of (saved) de bewaarde wereld van de broker. */
  function applyState(data: StateMsg, saved = false) {
    adopted = true;
    o.shared.apply(data.sim, saved);
    if (!o.isDriving() && !remoteDriver()) o.forklift.applyState(parked(data.fork, OLD_STARTS.forklift, START.forklift));
    else o.forklift.applyLoose(data.fork.loose);
    if (!o.jack.held() && !remoteHolder() && validJack(data.jack)) o.jack.applyState(parked(data.jack, OLD_STARTS.palletJack, START.palletJack));
    rev = data.rev;
    writer = data.w;
    lastSimKey = simKey();
    lastForkKey = forkNow();
    lastLooseKey = looseKey();
    lastJackKey = JSON.stringify(o.jack.getState());
  }

  // ---------- De wereld bewaren: de hal begint met de laatste stand ----------
  let savedRev = 0;
  let savedAt = 0;
  /** Heeft deze speler al een wereld van een medespeler of van de broker overgenomen? */
  let adopted = false;
  /** Sinds wanneer we verbonden zijn (0 = nog niet). */
  let onlineSince = 0;
  /** Zo lang na het verbinden gaat de bewaarde wereld altijd voor op de eigen, net begonnen wereld (ms). */
  const ADOPT_MS = 10_000;
  function saveWorld() {
    savedRev = rev;
    savedAt = performance.now();
    room.saveWorld(stateMsg());
  }
  room.onWorld((data) => {
    if (!validState(data)) return;
    // Net binnen en nog niets overgenomen: de bewaarde wereld gaat voor op de eigen, net begonnen wereld, ook
    // als die intussen al een paar revisies heeft. Daarna alleen als hij verder is dan wat we hebben (spelen
    // er anderen, dan is hun wereld minstens zo ver).
    const fresh = !adopted && performance.now() - onlineSince < ADOPT_MS;
    if (fresh || data.rev > rev || (data.rev === rev && data.w > writer)) {
      const ahead = Math.max(rev, data.rev);
      applyState(data, true);
      rev = ahead; // nooit terug in revisie: anders zou een medespeler onze volgende wijziging als verouderd zien
    }
    savedRev = Math.max(savedRev, data.rev);
  });

  let lastPose = '';
  let lastPoseAt = 0;
  /** Sinds het vorige bericht getoeterd: ook een korte tik op de toeter gaat zo mee naar de anderen. */
  let honked = false;
  /** Tot wanneer de toeter van de andere bestuurder minstens doorklinkt. */
  let hornUntil = 0;
  function sendPose(force = false) {
    const p = o.player.position;
    const look = o.look();
    const beeps = o.beeps();
    const pose: Pose = {
      n: name,
      x: round(p.x), y: round(p.y), z: round(p.z),
      r: round(o.player.rotation.y, 1000),
      d: o.isDriving() ? 1 : 0,
      c: o.carryLabel(),
      p: round(look.pitch), ly: round(look.yaw),
      t: o.tool(),
      sc: o.scans(),
      b: beeps.count, bo: beeps.ok ? 1 : 0,
      w: o.isDriving() ? round(o.forklift.steer, 10) : 0,
      j: o.airborne() ? 1 : 0,
      k: o.forklift.honking || honked ? 1 : 0,
      fv: faceVer,
    };
    if (pose.d) pose.f = o.forklift.getState();
    else if (o.isSitting()) pose.s = 1;
    if (o.jack.held()) pose.pj = o.jack.getState();
    const on = pose.d ? null : o.rider();
    if (on) pose.v = { x: round(on.x), z: round(on.z), ...(on.y !== undefined && { y: round(on.y) }) };
    const json = JSON.stringify(pose);
    const now = performance.now();
    if (!force && json === lastPose && now - lastPoseAt < HEARTBEAT_MS) return;
    if (room.congested && !force) return;
    lastPose = json;
    lastPoseAt = now;
    honked = false;
    room.send('p', pose);
  }

  // ---------- Radio: de laatst gekozen zender geldt voor iedereen ----------
  let radioRev = 0;
  let radioWriter = room.id;
  const sendRadio = () => room.send('r', { rev: radioRev, w: radioWriter, s: o.radio.station, v: o.radio.volume });
  o.radio.onChange(() => {
    radioRev++;
    radioWriter = room.id;
    sendRadio();
  });

  room.on((kind, from, data) => {
    if (kind === 'r' && isObj(data) && typeof data.rev === 'number' && typeof data.w === 'string') {
      if (data.rev > radioRev || (data.rev === radioRev && data.w > radioWriter)) {
        radioRev = data.rev;
        radioWriter = data.w;
        o.radio.setStation(num(data.s, -1));
        o.radio.setVolume(num(data.v, o.radio.volume));
      } else if (data.rev < radioRev) {
        sendRadio(); // de afzender loopt achter (schakelde voordat hij verbonden was): stuur de actuele stand terug
      }
      return;
    }
    if (kind === 'hi') {
      if (radioRev > 0) sendRadio(); // nieuwe speler: laat horen wat er op staat
      // Nieuwe speler: laat direct zien waar je staat; de host stuurt de wereld mee.
      // Een tabblad op de achtergrond speelt niet mee (de game staat daar stil): geen figuur laten zien.
      if (!document.hidden) sendPose(true);
      if (room.isHost) sendState();
    } else if (kind === 'p' && isObj(data)) {
      const a = avatars.get(from.id) ?? addAvatar(from);
      const wasNew = !a.placed;
      const prevScans = a.pose.sc;
      const prevBeeps = a.pose.b;
      a.pose = {
        n: String(data.n ?? '').slice(0, 20) || 'Speler',
        x: num(data.x), y: num(data.y), z: num(data.z), r: num(data.r),
        d: data.d === 1 ? 1 : 0,
        c: String(data.c ?? '').slice(0, 20),
        p: THREE.MathUtils.clamp(num(data.p), -1.6, 1.6),
        ly: THREE.MathUtils.clamp(num(data.ly), -2.5, 2.5),
        t: data.t === 1 || data.t === 2 ? data.t : 0,
        sc: num(data.sc),
        b: num(data.b), bo: data.bo === 0 ? 0 : 1,
        w: THREE.MathUtils.clamp(num(data.w), -1, 1),
        j: data.j === 1 ? 1 : 0,
        k: data.k === 1 && data.d === 1 ? 1 : 0,
        fv: String(data.fv ?? '').slice(0, 12),
      };
      if (a.pose.fv !== a.faceVer) {
        if (!a.pose.fv) {
          a.faceVer = '';
          a.character.setFace(null); // foto verwijderd
        } else if (performance.now() - a.faceAskedAt > 3000) {
          a.faceAskedAt = performance.now();
          room.send('fq', { to: from.id });
        }
      }
      if (data.s === 1 && data.d !== 1) a.pose.s = 1;
      if (isObj(data.v) && data.d !== 1) {
        const { x, z, y } = data.v;
        a.pose.v = { x: THREE.MathUtils.clamp(num(x), -4, 4), z: THREE.MathUtils.clamp(num(z), -4, 4) };
        if (typeof y === 'number' && Number.isFinite(y)) a.pose.v.y = THREE.MathUtils.clamp(y, -1, 3);
      }
      if (!wasNew && a.pose.sc !== prevScans) a.scanT = 0.4; // heeft net gescand: laser tonen
      if (a.pose.k) hornUntil = performance.now() + 250;
      a.target.set(a.pose.x, a.pose.y, a.pose.z);
      // Zijn scanner piepte: dat hoor je hier ook (niet op een tabblad op de achtergrond)
      if (!wasNew && a.pose.b !== prevBeeps && !document.hidden) o.scanBeep(a.pose.bo === 1, a.target);
      if (a.pose.d && validFork(data.f)) {
        if (o.isDriving()) {
          if (from.id < room.id) o.leaveForklift(); // tegelijk ingestapt: het laagste id mag blijven
        } else {
          o.forklift.applyState(data.f, false);
          lastForkKey = forkNow();
        }
      }
      if (validJack(data.pj)) {
        a.pose.pj = data.pj;
        if (o.jack.held()) {
          if (from.id < room.id) o.jack.release(); // tegelijk gepakt: het laagste id mag hem houden
        } else {
          o.jack.applyState(data.pj);
          lastJackKey = JSON.stringify(o.jack.getState());
        }
      }
      if (wasNew) refreshChip();
    } else if (kind === 'fq' && isObj(data)) {
      // Iemand mist onze foto; meerdere vragen tegelijk beantwoorden we met één bericht.
      if (data.to === room.id && performance.now() - faceSentAt > 2000) sendFace();
    } else if (kind === 'f' && isObj(data)) {
      const a = avatars.get(from.id);
      const v = String(data.v ?? '').slice(0, 12);
      const img = data.img;
      if (!a || !v || v === a.faceVer || !validFace(img)) return;
      a.faceVer = v;
      decodeFace(img).then((image) => a.faceVer === v && a.character.setFace(image), () => {});
    } else if (kind === 'c' && isObj(data)) {
      const text = cleanChat(data.m);
      const now = performance.now();
      if (!text || now - (lastChatAt.get(from.id) ?? -1e9) < 400) return;
      lastChatAt.set(from.id, now);
      const a = avatars.get(from.id);
      chat.add(a?.pose.n || String(data.n ?? '').trim().slice(0, 20) || 'Speler', a?.color ?? peerColor(from.id), text);
      a?.bubble.say(text);
    } else if (kind === 's' && validState(data)) {
      const newer = data.rev > rev || (data.rev === rev && data.w > writer);
      const older = data.rev < rev || (data.rev === rev && data.w < writer);
      if (newer) {
        applyState(data);
      } else if (older && performance.now() - lastStateAt > 1000) {
        sendState(); // de afzender loopt achter: stuur de actuele wereld terug
      }
    }
  });

  // ---------- Spelers: onderdeel van het menu rechtsboven ----------
  const chip = document.createElement('div');
  chip.style.cssText = 'line-height:1.6';
  const chipTitle = document.createElement('div');
  chipTitle.style.fontWeight = '600';
  const chipNames = document.createElement('div');
  const chipRoom = document.createElement('div');
  chipRoom.style.cssText = 'color:#9aa0a6;font-size:12px';
  const rename = document.createElement('button');
  rename.textContent = 'Naam en foto wijzigen';
  rename.style.cssText = 'margin-top:8px;padding:6px 10px;border:0;border-radius:4px;background:#3b6ea5;color:#fff;font:inherit;cursor:pointer';
  rename.addEventListener('click', () => askName(false));
  chip.append(chipTitle, chipNames, chipRoom, rename);
  menu.addSection('players', 'Spelers', chip, 1);

  // ---------- Naam opgeven ----------
  // Bij de eerste keer spelen vragen we om een naam; die blijft in deze browser bewaard (localStorage).
  let nameDialog: HTMLDivElement | null = null;
  function askName(first: boolean) {
    if (nameDialog) return;
    document.exitPointerLock?.();
    const overlay = document.createElement('div');
    nameDialog = overlay;
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);font:14px system-ui,sans-serif';
    const form = document.createElement('form');
    form.style.cssText =
      'width:min(600px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:20px;border-radius:12px;background:#1f2429;color:#fff;box-shadow:0 12px 40px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:12px';
    const title = document.createElement('div');
    title.textContent = first ? 'Welkom! Hoe heet je?' : 'Je naam en foto wijzigen';
    title.style.cssText = 'font-size:18px;font-weight:600';
    const info = document.createElement('div');
    info.textContent = 'Je naam en foto zijn zichtbaar voor andere spelers en worden op deze pc onthouden.';
    info.style.cssText = 'color:#b9c0c7;line-height:1.45';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 20;
    input.placeholder = 'Jouw naam';
    input.autocomplete = 'off';
    input.value = first ? '' : name;
    input.style.cssText =
      'padding:9px 11px;border-radius:8px;border:1px solid #47505a;background:#12161a;color:#fff;font:inherit;font-size:16px;outline:none';
    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    const button = (text: string, primary: boolean) => {
      const b = document.createElement('button');
      b.type = primary ? 'submit' : 'button';
      b.textContent = text;
      b.style.cssText = `padding:8px 14px;border-radius:8px;border:0;font:inherit;cursor:pointer;color:#fff;background:${primary ? '#1e88e5' : '#3a424a'}`;
      return b;
    };
    const cancel = button(first ? 'Overslaan' : 'Annuleren', false);
    const save = button('Opslaan', true);
    buttons.append(cancel, save);
    const picker = createFacePicker(face);
    form.append(title, info, input, picker.el, buttons);
    overlay.appendChild(form);
    document.body.appendChild(overlay);

    const close = () => {
      picker.stop();
      overlay.remove();
      nameDialog = null;
    };
    const syncSave = () => {
      save.disabled = !input.value.trim();
      save.style.opacity = save.disabled ? '.5' : '1';
    };
    syncSave();
    input.addEventListener('input', syncSave);
    cancel.addEventListener('click', close);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const next = input.value.trim().slice(0, 20);
      if (!next) return;
      name = next;
      try {
        localStorage.setItem(NAME_KEY, name);
      } catch {
        // geen opslag beschikbaar: de naam geldt dan alleen voor deze sessie
      }
      if (picker.value !== face) {
        face = picker.value;
        faceVer = faceVersion(face);
        saveFace(face);
        showOwnFace();
        sendFace();
      }
      sendPose(true);
      refreshChip();
      close();
    });
    // Toetsen in het venster mogen de speler niet laten lopen of de camera wisselen.
    for (const type of ['keydown', 'keyup', 'keypress'] as const) {
      overlay.addEventListener(type, (e) => {
        if (type === 'keydown' && e.key === 'Escape') close();
        e.stopPropagation();
      });
    }
    input.focus();
    input.select();
  }
  if (!stored) askName(true);

  let chipText = '';
  function refreshChip() {
    const online = room.status === 'online';
    const others = [...avatars.values()].map((a) => a.pose.n);
    const title = online
      ? `● Samen spelen · ${others.length + 1} speler${others.length ? 's' : ''}`
      : room.status === 'connecting' ? '○ Verbinden met andere spelers…' : '○ Geen verbinding · je speelt alleen';
    const names = `Jij: ${name}${others.length ? ` · ${others.join(', ')}` : ''}${online && room.isHost && others.length ? ' · jij bent host' : ''}`;
    if (title + names + room.links === chipText) return;
    chipText = title + names + room.links;
    chipTitle.textContent = title;
    chipTitle.style.color = online ? '#a5d6a7' : '#ffcc80';
    chipNames.textContent = names;
    chipRoom.textContent = `Kamer "${room.room}" · verbindingen ${room.links} · je naam en foto zijn zichtbaar voor andere spelers`;
  }
  refreshChip();

  window.addEventListener('pagehide', () => {
    if (room.isHost && rev !== savedRev) saveWorld(); // de laatste wijzigingen nog meegeven
    room.leave();
  });

  let tickAt = 0;
  let chipAt = 0;

  return {
    /** Naam van de speler die nu met de heftruck rijdt, of null. */
    forkliftDriver: () => remoteDriver()?.pose.n ?? null,
    /** Waar deze speler tegenaan loopt: de andere spelers (wie in de heftruck of op een stoel zit hoort daarbij). */
    solids(): Solid[] {
      const out: Solid[] = [];
      for (const a of avatars.values()) {
        if (!a.placed || a.pose.d === 1 || a.pose.s === 1) continue;
        const p = a.character.group.position;
        out.push({ minX: p.x - 0.28, maxX: p.x + 0.28, minZ: p.z - 0.28, maxZ: p.z + 0.28, minY: p.y, maxY: p.y + 1.8 });
      }
      return out;
    },
    /** Waar robots en chauffeurs voor stoppen: de andere spelers. */
    obstacles() {
      const out: { x: number; z: number; rad: number }[] = [];
      for (const a of avatars.values()) {
        if (!a.placed || a.pose.d === 1) continue;
        const p = a.character.group.position;
        out.push({ x: p.x, z: p.z, rad: 0.4 });
      }
      return out;
    },
    /** Naam van de speler die nu de pompwagen vasthoudt, of null. */
    jackHolder: () => remoteHolder()?.pose.n ?? null,
    update(dt: number) {
      room.start(); // pas verbinden als de eerste beelden lopen
      room.update();
      o.shared.setAuthority(room.isHost);
      const driver = remoteDriver();
      o.forklift.setRemoteDriven(!o.isDriving() && !!driver);
      o.forklift.setRemoteSteer(driver ? driver.pose.w : 0);
      // Toeter van de andere bestuurder: zachter naarmate de truck verder weg is
      const hornDist = o.player.position.distanceTo(o.forklift.group.position);
      if (o.forklift.honking) honked = true;
      o.forklift.setRemoteHorn(driver && (driver.pose.k || performance.now() < hornUntil) ? Math.max(0.15, Math.min(1, 8 / Math.max(hornDist, 1))) : 0);

      ownBubble.update(dt);

      // Figuren van de andere spelers soepel naar hun laatste positie bewegen
      const k = 1 - Math.exp(-dt * 12);
      for (const a of avatars.values()) {
        const g = a.character.group;
        let walk: number | undefined; // eigen loopsnelheid; alleen nodig als de heftruck de speler meeneemt
        if (!a.placed || g.position.distanceTo(a.target) > 8) {
          g.position.copy(a.target);
          g.rotation.y = a.pose.r;
          a.placed = true;
          a.ride = null;
        } else if (a.pose.v) {
          // Staat op de heftruck: aan de truck vastmaken zoals die hier te zien is, zodat hij niet achterblijft
          const v = a.pose.v;
          const f = o.forklift.group;
          const c = Math.cos(f.rotation.y);
          const n = Math.sin(f.rotation.y);
          if (!a.ride) {
            const dx = g.position.x - f.position.x;
            const dz = g.position.z - f.position.z;
            a.ride = { x: dx * c - dz * n, z: dx * n + dz * c };
          }
          const mx = (v.x - a.ride.x) * k;
          const mz = (v.z - a.ride.z) * k;
          a.ride.x += mx;
          a.ride.z += mz;
          // Alleen wat hij zelf over de truck loopt telt als lopen; staat hij stil, dan blijft hij staan.
          const along = (mx * c + mz * n) * Math.sin(g.rotation.y) + (-mx * n + mz * c) * Math.cos(g.rotation.y);
          walk = (Math.hypot(mx, mz) / Math.max(dt, 1e-4)) * (along < -1e-5 ? -1 : 1);
          g.position.x = f.position.x + a.ride.x * c + a.ride.z * n;
          g.position.z = f.position.z - a.ride.x * n + a.ride.z * c;
          g.position.y += ((v.y !== undefined ? o.forklift.forkHeight + v.y : a.target.y) - g.position.y) * (v.y !== undefined ? Math.min(1, k * 3) : k);
          g.rotation.y += Math.atan2(Math.sin(a.pose.r - g.rotation.y), Math.cos(a.pose.r - g.rotation.y)) * k;
        } else {
          a.ride = null;
          g.position.lerp(a.target, k);
          g.rotation.y += Math.atan2(Math.sin(a.pose.r - g.rotation.y), Math.cos(a.pose.r - g.rotation.y)) * k;
        }
        // Hoofd, handen en wat de speler vasthoudt
        a.look.yaw += (a.pose.ly - a.look.yaw) * k;
        a.look.pitch += (a.pose.p - a.look.pitch) * k;
        a.scanT = Math.max(0, a.scanT - dt);
        const driving = a.pose.d === 1;
        const seated = driving || a.pose.s === 1;
        if (driving) o.forklift.steeringGrip(a.wheelHand.point, a.wheelHand.normal!);
        const pushing = !seated && !!a.pose.pj; // duwt de pompwagen: beide handen op de handgreep
        if (pushing) {
          o.jack.grip(1, a.jackHands[0].point);
          o.jack.grip(-1, a.jackHands[1].point);
        }
        a.character.update(dt, {
          seated,
          seatHipY: driving ? o.seatHipY : o.chairHipY,
          carrying: !!a.pose.c,
          look: a.look,
          tool: a.pose.t === 1 ? 'scanner' : a.pose.t === 2 ? 'tablet' : undefined,
          scan: a.scanT / 0.4,
          walk,
          airborne: a.pose.j === 1,
          leftHand: driving ? a.wheelHand : pushing ? a.jackHands[0] : undefined,
          rightHand: pushing ? a.jackHands[1] : undefined,
        });
        a.tag.set(a.pose.n, a.color);
        a.bubble.update(dt);
        // Wat de speler draagt: dezelfde pallet met dozen als hij zelf ziet, voor hem uit
        const loadKey = a.pose.d ? '' : a.pose.c;
        if (loadKey !== a.loadKey) {
          a.loadKey = loadKey;
          if (a.load) dropLoad(a.load);
          a.load = loadKey ? o.carryMesh(loadKey) : null;
          if (a.load) {
            a.load.traverse((c) => (c.castShadow = false)); // loopt mee: geen schaduw
            a.load.position.set(0, 0.03, CARRY_AHEAD);
            g.add(a.load);
          }
        }
      }

      // Echte tijd, niet de (afgekapte) frametijd: ook bij een lage framerate blijft het netwerk op tempo.
      const now = performance.now();
      if (now - chipAt > 500) {
        chipAt = now;
        refreshChip();
      }
      if (now - tickAt < TICK_MS) return;
      tickAt = now;
      if (room.status !== 'online') return;
      onlineSince ||= now;

      sendPose();

      // Lokale wijziging aan de gedeelde wereld: nieuwe revisie naar iedereen
      const sim = simKey();
      const fork = forkKey();
      const looseNow = looseKey();
      const jackNow = jackKey();
      if (sim !== lastSimKey || fork !== lastForkKey || looseNow !== lastLooseKey || jackNow !== lastJackKey) {
        lastLooseKey = looseNow;
        lastJackKey = jackNow;
        lastSimKey = sim;
        lastForkKey = fork;
        rev++;
        writer = room.id;
        sendState();
      } else if (room.isHost && avatars.size && performance.now() - lastStateAt > HOST_RESEND_MS) {
        sendState();
      }
      if (room.isHost && rev !== savedRev && now - savedAt > SAVE_MS && !room.congested) saveWorld();
    },
  };
}
