import * as THREE from 'three';
import { createRoom, type Peer } from '../sim/multiplayer/room';
import type { SharedState } from '../sim/warehouse';
import { createCharacter, type HandTarget } from './scene/character';
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
  /** Kijkrichting: omhoog/omlaag */ p: number;
  /** Kijkrichting opzij t.o.v. het lichaam (vanaf de stoel van de heftruck) */ ly: number;
  /** In de hand: 0 niets, 1 scanner, 2 tablet */ t: 0 | 1 | 2;
  /** Aantal keer gescand (teller) */ sc: number;
  /** Stuuruitslag -1..1, als deze speler rijdt */ w: number;
};
type StateMsg = { rev: number; w: string; sim: SharedState; fork: ForkliftState };

interface Options {
  scene: THREE.Scene;
  player: THREE.Object3D;
  /** Naam van de kamer; iedereen met dezelfde naam speelt samen. */
  room: string;
  shared: { state(): SharedState; apply(s: SharedState): void; setAuthority(on: boolean): void };
  carryLabel(): string;
  forklift: {
    getState(): ForkliftState;
    applyState(s: ForkliftState): void;
    setRemoteDriven(on: boolean): void;
    readonly steer: number;
    setRemoteSteer(v: number): void;
    steeringGrip(point: THREE.Vector3, normal: THREE.Vector3): void;
  };
  /** Kijkrichting van deze speler (first person), anders nul. */
  look(): { yaw: number; pitch: number };
  /** Wat deze speler in de hand heeft: 0 niets, 1 scanner, 2 tablet. */
  tool(): 0 | 1 | 2;
  /** Aantal keer dat deze speler gescand heeft. */
  scans(): number;
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
  let stored = '';
  try {
    stored = (localStorage.getItem(NAME_KEY) ?? '').trim().slice(0, 20);
  } catch {
    // geen opslag beschikbaar
  }
  let name = stored || `Speler ${room.id.slice(0, 3).toUpperCase()}`;

  // ---------- Andere spelers ----------
  type Avatar = {
    character: ReturnType<typeof createCharacter>;
    tag: ReturnType<typeof nameTag>;
    load: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
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
      pose: { n: '', x: 0, y: 0, z: 0, r: 0, d: 0, c: '', p: 0, ly: 0, t: 0, sc: 0, w: 0 },
      placed: false,
      look: { yaw: 0, pitch: 0 },
      scanT: 0,
      wheelHand: { point: new THREE.Vector3(), normal: new THREE.Vector3() },
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
    const look = o.look();
    const pose: Pose = {
      n: name,
      x: round(p.x), y: round(p.y), z: round(p.z),
      r: round(o.player.rotation.y, 1000),
      d: o.isDriving() ? 1 : 0,
      c: o.carryLabel(),
      p: round(look.pitch), ly: round(look.yaw),
      t: o.tool(),
      sc: o.scans(),
      w: o.isDriving() ? round(o.forklift.steer, 10) : 0,
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
      const prevScans = a.pose.sc;
      a.pose = {
        n: String(data.n ?? '').slice(0, 20) || 'Speler',
        x: num(data.x), y: num(data.y), z: num(data.z), r: num(data.r),
        d: data.d === 1 ? 1 : 0,
        c: String(data.c ?? '').slice(0, 20),
        p: THREE.MathUtils.clamp(num(data.p), -1.6, 1.6),
        ly: THREE.MathUtils.clamp(num(data.ly), -2.5, 2.5),
        t: data.t === 1 || data.t === 2 ? data.t : 0,
        sc: num(data.sc),
        w: THREE.MathUtils.clamp(num(data.w), -1, 1),
      };
      if (!wasNew && a.pose.sc !== prevScans) a.scanT = 0.4; // heeft net gescand: laser tonen
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
  chip.addEventListener('click', () => askName(false));

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
      'width:min(340px,calc(100vw - 32px));padding:20px;border-radius:12px;background:#1f2429;color:#fff;box-shadow:0 12px 40px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:12px';
    const title = document.createElement('div');
    title.textContent = first ? 'Welkom! Hoe heet je?' : 'Je naam wijzigen';
    title.style.cssText = 'font-size:18px;font-weight:600';
    const info = document.createElement('div');
    info.textContent = 'Je naam is zichtbaar voor andere spelers en wordt op deze pc onthouden.';
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
    form.append(title, info, input, buttons);
    overlay.appendChild(form);
    document.body.appendChild(overlay);

    const close = () => {
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
      const driver = remoteDriver();
      o.forklift.setRemoteDriven(!o.isDriving() && !!driver);
      o.forklift.setRemoteSteer(driver ? driver.pose.w : 0);

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
        // Hoofd, handen en wat de speler vasthoudt
        a.look.yaw += (a.pose.ly - a.look.yaw) * k;
        a.look.pitch += (a.pose.p - a.look.pitch) * k;
        a.scanT = Math.max(0, a.scanT - dt);
        const seated = a.pose.d === 1;
        if (seated) o.forklift.steeringGrip(a.wheelHand.point, a.wheelHand.normal!);
        a.character.update(dt, {
          seated,
          seatHipY: o.seatHipY,
          carrying: !!a.pose.c,
          look: a.look,
          tool: a.pose.t === 1 ? 'scanner' : a.pose.t === 2 ? 'tablet' : undefined,
          scan: a.scanT / 0.4,
          leftHand: seated ? a.wheelHand : undefined,
        });
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
