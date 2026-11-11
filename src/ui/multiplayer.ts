import * as THREE from 'three';
import { createRoom, type Peer } from '../sim/multiplayer/room';
import type { SharedState } from '../sim/warehouse';
import { createCharacter } from './scene/character';
import type { ForkliftState } from './scene/forklift';
import { SKU_COLORS } from './warehouseView';

// Multiplayer: iedereen die de game opent komt in dezelfde kamer en deelt één magazijn.
// - Elke speler stuurt ~10× per seconde zijn positie; de anderen tekenen daar een figuur.
// - De gedeelde wereld (voorraad, orders, banen, vrachtwagens, heftruck) gaat als geheel over de lijn
//   zodra iemand er iets aan verandert. De hoogste revisie wint; bij gelijke stand beslist het speler-id.
// - Eén speler is host (wie het langst binnen is): alleen daar ontstaan nieuwe vrachtwagens en orders.
// WMS-acties blijven lokaal: wie een handeling doet, meldt die zelf bij zijn WMS.

const TICK_MS = 100;
const HEARTBEAT_MS = 1000;
const HOST_RESEND_MS = 10_000;
const NAME_KEY = 'wm-sim.name';
const VEST_COLORS = ['#1e88e5', '#43a047', '#8e24aa', '#00acc1', '#d81b60', '#6d4c41', '#3949ab', '#c0ca33'];

type Pose = {
  /** Naam */ n: string;
  x: number; y: number; z: number;
  /** Draaiing */ r: number;
  /** Rijdt in de heftruck */ d: 0 | 1;
  /** Draagt: '' | 'order' | artikel van de pallet */ c: string;
  /** Stand van de heftruck, alleen als deze speler rijdt */ f?: ForkliftState;
};
type StateMsg = { rev: number; w: string; sim: SharedState; fork: ForkliftState };

interface Options {
  scene: THREE.Scene;
  player: THREE.Object3D;
  /** Naam van de kamer; iedereen met dezelfde naam speelt samen. */
  room: string;
  shared: { state(): SharedState; apply(s: SharedState): void; setAuthority(on: boolean): void };
  carryLabel(): string;
  forklift: { getState(): ForkliftState; applyState(s: ForkliftState): void; setRemoteDriven(on: boolean): void };
  /** Hoogte van de heupen van iemand die in de heftruck zit. */
  seatHipY: number;
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

export function mountMultiplayer(o: Options) {
  const room = createRoom(o.room);
  let name = '';
  try {
    name = localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    // geen opslag beschikbaar
  }
  if (!name) name = `Speler ${room.id.slice(0, 3).toUpperCase()}`;

  // ---------- Andere spelers ----------
  type Avatar = {
    character: ReturnType<typeof createCharacter>;
    tag: ReturnType<typeof nameTag>;
    load: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
    color: string;
    target: THREE.Vector3;
    pose: Pose;
    placed: boolean;
  };
  const avatars = new Map<string, Avatar>();

  function addAvatar(peer: Peer): Avatar {
    // Elke speler een eigen kleur hesje, zodat je elkaar uit elkaar houdt.
    const color = VEST_COLORS[(parseInt(peer.id.slice(0, 4), 16) || 0) % VEST_COLORS.length];
    const character = createCharacter(undefined, { vest: color });
    const tag = nameTag();
    tag.sprite.position.y = 2.2;
    const load = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.8 }));
    load.castShadow = true;
    load.visible = false;
    character.group.add(tag.sprite, load);
    o.scene.add(character.group);
    const avatar: Avatar = {
      character, tag, load, color,
      target: new THREE.Vector3(),
      pose: { n: '', x: 0, y: 0, z: 0, r: 0, d: 0, c: '' },
      placed: false,
    };
    avatars.set(peer.id, avatar);
    return avatar;
  }

  room.onLeave((peer) => {
    const a = avatars.get(peer.id);
    if (!a) return;
    a.character.group.removeFromParent();
    avatars.delete(peer.id);
    refreshChip();
  });

  const remoteDriver = () => [...avatars.values()].find((a) => a.pose.d === 1);

  // ---------- Gedeelde wereld ----------
  let rev = 0;
  let writer = room.id;
  // De rijpositie van vrachtwagens (t) verandert elke frame en telt niet als wijziging: iedereen rijdt ze zelf.
  const simKey = () => JSON.stringify(o.shared.state(), (k, v) => (k === 't' ? 0 : v));
  // Tijdens het rijden gaat de stand van de heftruck mee met de positie van de bestuurder, niet als wijziging.
  const forkKey = () => (o.isDriving() || remoteDriver() ? lastForkKey : JSON.stringify(o.forklift.getState()));
  let lastForkKey = JSON.stringify(o.forklift.getState());
  let lastSimKey = simKey();
  let lastStateAt = 0;

  function sendState() {
    lastStateAt = performance.now();
    room.send('s', { rev, w: writer, sim: o.shared.state(), fork: o.forklift.getState() } satisfies StateMsg);
  }

  let lastPose = '';
  let lastPoseAt = 0;
  function sendPose(force = false) {
    const p = o.player.position;
    const pose: Pose = {
      n: name,
      x: round(p.x), y: round(p.y), z: round(p.z),
      r: round(o.player.rotation.y, 1000),
      d: o.isDriving() ? 1 : 0,
      c: o.carryLabel(),
    };
    if (pose.d) pose.f = o.forklift.getState();
    const json = JSON.stringify(pose);
    const now = performance.now();
    if (!force && json === lastPose && now - lastPoseAt < HEARTBEAT_MS) return;
    if (room.congested && !force) return;
    lastPose = json;
    lastPoseAt = now;
    room.send('p', pose);
  }

  room.on((kind, from, data) => {
    if (kind === 'hi') {
      // Nieuwe speler: laat direct zien waar je staat; de host stuurt de wereld mee.
      sendPose(true);
      if (room.isHost) sendState();
    } else if (kind === 'p' && isObj(data)) {
      const a = avatars.get(from.id) ?? addAvatar(from);
      const wasNew = !a.placed;
      a.pose = {
        n: String(data.n ?? '').slice(0, 20) || 'Speler',
        x: num(data.x), y: num(data.y), z: num(data.z), r: num(data.r),
        d: data.d === 1 ? 1 : 0,
        c: String(data.c ?? '').slice(0, 20),
      };
      a.target.set(a.pose.x, a.pose.y, a.pose.z);
      if (a.pose.d && validFork(data.f)) {
        if (o.isDriving()) {
          if (from.id < room.id) o.leaveForklift(); // tegelijk ingestapt: het laagste id mag blijven
        } else {
          o.forklift.applyState(data.f);
          lastForkKey = JSON.stringify(o.forklift.getState());
        }
      }
      if (wasNew) refreshChip();
    } else if (kind === 's' && validState(data)) {
      const newer = data.rev > rev || (data.rev === rev && data.w > writer);
      const older = data.rev < rev || (data.rev === rev && data.w < writer);
      if (newer) {
        o.shared.apply(data.sim);
        if (!o.isDriving() && !remoteDriver()) o.forklift.applyState(data.fork);
        rev = data.rev;
        writer = data.w;
        lastSimKey = simKey();
        lastForkKey = JSON.stringify(o.forklift.getState());
      } else if (older && performance.now() - lastStateAt > 1000) {
        sendState(); // de afzender loopt achter: stuur de actuele wereld terug
      }
    }
  });

  // ---------- Statusblokje rechtsboven ----------
  const chip = document.createElement('div');
  chip.style.cssText =
    'position:fixed;right:16px;top:16px;max-width:300px;padding:8px 12px;border-radius:8px;background:rgba(0,0,0,.6);color:#fff;font:13px system-ui,sans-serif;line-height:1.45;cursor:pointer;user-select:none';
  chip.title = 'Klik om je naam te wijzigen (zichtbaar voor andere spelers)';
  const chipTitle = document.createElement('div');
  const chipNames = document.createElement('div');
  chipNames.style.color = '#b9c0c7';
  chip.append(chipTitle, chipNames);
  document.body.appendChild(chip);
  chip.addEventListener('click', () => {
    const next = prompt('Jouw naam (zichtbaar voor andere spelers):', name)?.trim().slice(0, 20);
    if (!next) return;
    name = next;
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      // geen opslag beschikbaar
    }
    sendPose(true);
    refreshChip();
  });

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
    chip.title = `Klik om je naam te wijzigen (zichtbaar voor andere spelers) · kamer "${room.room}" · verbindingen ${room.links}`;
  }
  refreshChip();

  window.addEventListener('pagehide', () => room.leave());

  let tickAt = 0;
  let chipAt = 0;

  return {
    /** Naam van de speler die nu met de heftruck rijdt, of null. */
    forkliftDriver: () => remoteDriver()?.pose.n ?? null,
    update(dt: number) {
      room.start(); // pas verbinden als de eerste beelden lopen
      room.update();
      o.shared.setAuthority(room.isHost);
      o.forklift.setRemoteDriven(!o.isDriving() && !!remoteDriver());

      // Figuren van de andere spelers soepel naar hun laatste positie bewegen
      const k = 1 - Math.exp(-dt * 12);
      for (const a of avatars.values()) {
        const g = a.character.group;
        if (!a.placed || g.position.distanceTo(a.target) > 8) {
          g.position.copy(a.target);
          g.rotation.y = a.pose.r;
          a.placed = true;
        } else {
          g.position.lerp(a.target, k);
          g.rotation.y += Math.atan2(Math.sin(a.pose.r - g.rotation.y), Math.cos(a.pose.r - g.rotation.y)) * k;
        }
        a.character.update(dt, { seated: a.pose.d === 1, seatHipY: o.seatHipY, carrying: !!a.pose.c });
        a.tag.set(a.pose.n, a.color);
        a.load.visible = !!a.pose.c && !a.pose.d;
        if (a.load.visible) {
          const order = a.pose.c === 'order';
          a.load.scale.set(order ? 0.7 : 0.9, order ? 0.9 : 0.7, order ? 0.6 : 0.9);
          a.load.position.set(0, order ? 0.55 : 0.75, 0.9);
          a.load.material.color.set(order ? '#b0bec5' : (SKU_COLORS[a.pose.c] ?? '#a5784a'));
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

      sendPose();

      // Lokale wijziging aan de gedeelde wereld: nieuwe revisie naar iedereen
      const sim = simKey();
      const fork = forkKey();
      if (sim !== lastSimKey || fork !== lastForkKey) {
        lastSimKey = sim;
        lastForkKey = fork;
        rev++;
        writer = room.id;
        sendState();
      } else if (room.isHost && avatars.size && performance.now() - lastStateAt > HOST_RESEND_MS) {
        sendState();
      }
    },
  };
}
