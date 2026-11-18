import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { DRIVER_DOORS } from '../sim/drivers';
import { AISLE_Z, HALL, ROW_FACE, ROW_Z, SECTION_PITCH, SECTION_X, SLOT_DX, WALKWAY_X, location, shelfLocations, type Point } from '../sim/layout';
import { menu } from './menu';
import { createCharacter, type HandTarget } from './scene/character';
import { STYLE } from './scene/style';
import { EXIT_X } from './scene/warehouse';

// Boeven (menu › Boeven): waves van boeven in boevenpak en bivakmuts die binnenstormen (door de nooduitgang of een
// chauffeursdeur), een doos van een pallet in de stelling grissen en ermee wegrennen, door een willekeurige deur. Pak
// ze door ertegenaan te lopen (of met de raketwerper); staat er iemand vlak voor ze, dan proberen ze uit te wijken.
// - Een wave is gehaald als er niets gestolen is: dan komt de volgende, met een boef meer. Komt er één met buit
//   buiten, dan is de wave verloren en begint het weer bij wave 1.
// - Alleen beeld: de voorraad in de sim en de WMS merken er niets van.
// - Iedereen in de kamer ziet hetzelfde: de host laat de boeven lopen en stuurt de stand rond (net/follow, net als de
//   kantoormedewerkers); wie geen host is stuurt zijn knoppen en raketvoltreffers als verzoek naar de host
//   (connect/request). Pakken door ertegenaan lopen ziet de host zelf, aan de posities van alle spelers.

/** Zo lang (ms) na het laatste bericht van de host volgen we hem nog; daarna laten we ze zelf lopen. */
const FOLLOW_MS = 3000;
/** Zo dichtbij (m) moet een speler komen om een boef te pakken. */
const CATCH = 0.9;
/** Aftellen (s) voor een wave begint, en hoe lang de uitslag in beeld blijft. */
const COUNTDOWN = 5;
const RESULT = 6;
/** Zo lang (s) staat een gepakte boef met zijn handen omhoog voor hij verdwijnt. */
const SURRENDER = 2.5;
/** Zo lang (s) doet een boef over het grissen van een doos. */
const GRAB = 1.6;

/** Zo ver (m) stapt een boef opzij voor een speler die vlak voor hem staat. */
const DODGE = 1.2;

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const DOOR_Z = HALL.d / 2;
const WALL_X = -HALL.w / 2;
/**
 * Het netwerk waarlangs de boeven lopen: de paden tussen de stellingen (AISLE_Z), twee lengteroutes (x) aan weerszijden
 * van de stellingen (het looppad aan de dockkant en een route langs de oostkant) en een dwarspad (z) achter de laatste
 * rij langs, tussen de stellingen en de kamers.
 */
const LANES = [WALKWAY_X, SECTION_X[SECTION_X.length - 1] + SECTION_PITCH / 2 + 1.5];
const CROSS_Z = ROW_Z[ROW_Z.length - 1] + 1.75;

/** Een deur naar buiten: de route van buiten naar binnen; het laatste punt ligt net binnen. spawn: waar hij begint. */
type Door = (spawn: boolean) => Point[];
const DOORS: Door[] = [
  // de nooduitgang in de zuidwand
  (spawn) => [{ x: EXIT_X + rnd(-5, 5), z: DOOR_Z + (spawn ? rnd(10, 14) : 12) }, { x: EXIT_X, z: DOOR_Z + 1.4 }, { x: EXIT_X, z: DOOR_Z - 1.6 }],
  // de chauffeursdeuren in de dockwand
  ...DRIVER_DOORS.map(
    (z): Door =>
      (spawn) => [{ x: WALL_X - (spawn ? rnd(7, 10) : 9), z: z + (z < 0 ? -1 : 1) * rnd(1, 4) }, { x: WALL_X - 1.4, z }, { x: WALL_X + 1.6, z }],
  ),
];

type Phase = 'idle' | 'countdown' | 'active' | 'result';
/** in: op weg naar de stelling · grab: pakt een doos · out: rent weg · caught: gepakt, handen omhoog. */
type Mode = 'in' | 'grab' | 'out' | 'caught';
type Thief = {
  id: number;
  x: number;
  z: number;
  r: number;
  /** Waar hij op zijn route is; x/z ligt daar `off` m rechts van (uitwijken). */
  bx: number;
  bz: number;
  off: number;
  mode: Mode;
  loot: boolean;
  /** Seconden tot hij binnenkomt (nog buiten beeld), of tijd in de huidige stand (grab, caught). */
  wait: number;
  path: Point[];
  /** Waar hij staat om te grissen, en welke kant de stelling op is. */
  stand: Point & { r: number };
  speed: number;
};
type View = {
  character: ReturnType<typeof createCharacter>;
  box: THREE.Mesh;
  left: HandTarget;
  right: HandTarget;
  /** Waar hij volgens de host staat (alleen bij volgen). */
  target: { x: number; z: number; r: number };
  placed: boolean;
};

interface Options {
  scene: THREE.Scene;
  /** Waar de spelers staan die een boef kunnen pakken: deze speler en de anderen in de kamer. */
  catchers: () => { x: number; z: number; y?: number }[];
  /** De pallets in de stellingen: daar gaan de boeven op af. */
  pallets: () => { locationId: string; slot: number }[];
}

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function mountThieves({ scene, catchers, pallets }: Options) {
  // ---------- Spelstand (de host is de baas) ----------
  let wave = 1;
  let phase: Phase = 'idle';
  let timer = 0;
  let caught = 0;
  let stolen = 0;
  let total = 0;
  /** Uitslag van de laatste wave: 'won' (gehaald), 'lost' (er is iets gestolen). */
  let result: 'won' | 'lost' | '' = '';
  let thieves: Thief[] = [];
  let nextId = 1;

  let followedAt = -Infinity;
  const following = () => performance.now() - followedAt < FOLLOW_MS;
  let send: ((d: unknown) => void) | null = null;

  // ---------- Routes ----------
  /** Het pad (z) waar een plek in de hal op uitkomt: het dichtstbijzijnde pad tussen de stellingen, of het dwarspad. */
  const corridor = (p: Point) => (p.z > CROSS_Z - 1 ? CROSS_Z : AISLE_Z.reduce((a, b) => (Math.abs(b - p.z) < Math.abs(a - p.z) ? b : a)));
  /** Over het netwerk van de ene plek in de hal naar de andere: het pad op, zo nodig via een lengteroute, het pad af. */
  function route(from: Point, to: Point): Point[] {
    const za = corridor(from);
    const zb = corridor(to);
    const out: Point[] = [{ x: from.x, z: za }];
    if (Math.abs(za - zb) > 0.1) {
      const cost = (lane: number) => Math.abs(from.x - lane) + Math.abs(to.x - lane);
      const lane = LANES.reduce((a, b) => (cost(b) < cost(a) ? b : a));
      out.push({ x: lane, z: za }, { x: lane, z: zb });
    }
    out.push({ x: to.x, z: zb }, { x: to.x, z: to.z });
    return out;
  }
  const anyDoor = () => DOORS[Math.floor(Math.random() * DOORS.length)];
  /** Met de buit naar buiten, door een willekeurige deur. */
  function outPath(from: Point): Point[] {
    const door = anyDoor()(false).reverse();
    return [...route(from, door[0]), ...door.slice(1)];
  }
  /** De punten bij de deuren (binnen en buiten): daar kan een boef niet opzij. */
  const doorPoints = DOORS.flatMap((d) => d(false).slice(1));
  const nearDoor = (x: number, z: number) => doorPoints.some((q) => Math.hypot(q.x - x, q.z - z) < 2.6);

  /** Een palletplek op de vloer (niveau 1) om te beroven; liefst een die nog niemand anders in deze wave heeft. */
  function pickStand(): Thief['stand'] {
    const taken = new Set(thieves.map((t) => `${t.stand.x.toFixed(1)},${t.stand.z.toFixed(1)}`));
    const spots: Thief['stand'][] = [];
    for (const p of pallets()) {
      const loc = location(p.locationId);
      if (loc?.level === 1) spots.push(standAt(loc, p.slot));
    }
    if (!spots.length) for (const loc of shelfLocations()) if (loc.level === 1) spots.push(standAt(loc, 1));
    const free = spots.filter((s) => !taken.has(`${s.x.toFixed(1)},${s.z.toFixed(1)}`));
    const list = free.length ? free : spots;
    return list[Math.floor(Math.random() * list.length)];
  }
  function standAt(loc: Point, slot: number): Thief['stand'] {
    const row = ROW_Z.findIndex((z) => Math.abs(z - loc.z) < 0.01);
    const face = ROW_FACE[Math.max(0, row)];
    return { x: loc.x + (SLOT_DX[slot] ?? 0), z: loc.z + face * 1.15, r: face > 0 ? Math.PI : 0 };
  }

  function spawn(i: number): Thief {
    const stand = pickStand();
    const door = anyDoor()(true);
    const { x, z } = door[0];
    return {
      id: nextId++,
      x, z, r: Math.PI, bx: x, bz: z, off: 0,
      mode: 'in',
      loot: false,
      wait: i * Math.max(1, 3 - wave * 0.2) + rnd(0, 0.8),
      path: [...door.slice(1), ...route(door[door.length - 1], stand).slice(1)],
      stand,
      speed: Math.min(6.5, 4 + wave * 0.18) * rnd(0.92, 1.08),
    };
  }

  // ---------- Spelregels (alleen waar de boeven lopen: bij de host, of alleen) ----------
  function start() {
    wave = Math.max(1, wave);
    beginCountdown();
  }
  function stop() {
    phase = 'idle';
    thieves = [];
    wave = 1;
    result = '';
  }
  function beginCountdown() {
    hits.clear();
    phase = 'countdown';
    timer = COUNTDOWN;
    thieves = [];
    caught = stolen = total = 0;
  }
  function catchThief(t: Thief) {
    if (t.mode === 'caught') return;
    t.mode = 'caught';
    t.wait = 0;
    t.path = [];
    caught++;
  }
  function finish(won: boolean) {
    result = won ? 'won' : 'lost';
    phase = 'result';
    timer = RESULT;
    wave = won ? wave + 1 : 1;
    // wie nog binnen is maakt zich uit de voeten
    if (!won) for (const t of thieves) if (t.mode !== 'caught') Object.assign(t, { mode: 'out', path: outPath({ x: t.bx, z: t.bz }), wait: Math.min(t.wait, 0) });
  }
  function request(d: unknown) {
    if (typeof d !== 'object' || d === null) return;
    const { a, id } = d as Record<string, unknown>;
    if (a === 'start' && phase === 'idle') start();
    if (a === 'stop') stop();
    if (a === 'hit') {
      const t = thieves.find((x) => x.id === id);
      if (t && t.wait <= 0 && phase === 'active') catchThief(t);
    }
  }
  /** Knop of voltreffer van deze speler: bij een host als verzoek over de lijn, anders meteen. */
  function act(d: { a: string; id?: number }) {
    if (following() && send) send(d);
    else request(d);
  }

  /** Over de route verder, en opzij voor wie vlak voor hem staat. */
  const step = (t: Thief, dt: number, speed: number, hunters: Point[]) => {
    let left = speed * dt;
    while (left > 0 && t.path.length) {
      const p = t.path[0];
      const dx = p.x - t.bx;
      const dz = p.z - t.bz;
      const d = Math.hypot(dx, dz);
      if (d <= left) {
        t.bx = p.x;
        t.bz = p.z;
        left -= d;
        t.path.shift();
      } else {
        t.bx += (dx / d) * left;
        t.bz += (dz / d) * left;
        left = 0;
      }
      if (d > 1e-3) t.r = Math.atan2(dx, dz);
    }
    // rechts van de looprichting (sin r, cos r) is (-cos r, sin r)
    const rx = -Math.cos(t.r);
    const rz = Math.sin(t.r);
    let want = 0;
    if (t.path.length && !nearDoor(t.bx, t.bz)) {
      for (const h of hunters) {
        const hx = h.x - t.x;
        const hz = h.z - t.z;
        const ahead = hx * Math.sin(t.r) + hz * Math.cos(t.r);
        if (ahead > -0.3 && ahead < 4 && Math.hypot(hx, hz) < 4) want = hx * rx + hz * rz > 0 ? -DODGE : DODGE;
      }
    }
    // niet opzij aan het eind van de route (bij de pallet), en geleidelijk terug als er niemand meer is
    t.off += THREE.MathUtils.clamp(want - t.off, -3 * dt, 3 * dt);
    t.x = t.bx + rx * t.off;
    t.z = t.bz + rz * t.off;
  };

  function simulate(dt: number) {
    if (phase === 'countdown') {
      if ((timer -= dt) <= 0) {
        phase = 'active';
        total = wave + 1;
        thieves = Array.from({ length: total }, (_, i) => spawn(i));
      }
      return;
    }
    if (phase === 'result' && (timer -= dt) <= 0) {
      beginCountdown();
      return;
    }
    const hunters = catchers();
    for (const t of thieves) {
      if (t.wait > 0 && t.mode !== 'caught') {
        t.wait -= dt;
        continue;
      }
      if (t.mode === 'caught') {
        t.wait += dt;
        continue;
      }
      if (phase === 'active' && hunters.some((h) => (h.y ?? 0) < 1.5 && Math.hypot(h.x - t.x, h.z - t.z) < CATCH)) {
        catchThief(t);
        continue;
      }
      if (t.mode === 'in') {
        step(t, dt, t.speed, hunters);
        if (!t.path.length && Math.abs(t.off) < 0.05) {
          t.mode = 'grab';
          t.wait = -GRAB; // telt op naar 0
          t.r = t.stand.r;
        }
      } else if (t.mode === 'grab') {
        t.r = t.stand.r;
        if ((t.wait += dt) >= 0) {
          t.loot = true;
          t.mode = 'out';
          t.wait = 0;
          t.path = outPath({ x: t.bx, z: t.bz });
        }
      } else if (t.mode === 'out') {
        step(t, dt, t.speed * 1.12, hunters);
        if (!t.path.length) {
          t.wait = 1e9; // weg
          if (t.loot && phase === 'active') {
            stolen++;
            finish(false);
          }
        }
      }
    }
    // weg = buiten beeld: gepakt en klaar met handen omhoog, of ontsnapt
    thieves = thieves.filter((t) => !(t.mode === 'caught' && t.wait > SURRENDER) && t.wait < 1e8);
    if (phase === 'active' && caught === total && !thieves.length) finish(true);
  }

  // ---------- Beeld ----------
  const boxGeo = new RoundedBoxGeometry(0.42, 0.3, 0.32, 2, 0.02);
  const pool: View[] = [];
  const views = new Map<number, View>();
  /** Voltreffers die al gemeld zijn (niet elke frame opnieuw over de lijn). */
  const hits = new Set<number>();
  function takeView(): View {
    const v = pool.pop();
    if (v) {
      v.character.group.scale.setScalar(1);
      v.placed = false;
      scene.add(v.character.group);
      return v;
    }
    const character = createCharacter(undefined, { outfit: 'thief' });
    const box = new THREE.Mesh(boxGeo, STYLE.carton);
    box.castShadow = box.receiveShadow = true;
    box.position.set(0, 1.02, 0.36);
    character.group.add(box);
    character.group.traverse((o) => (o.receiveShadow = true));
    scene.add(character.group);
    return { character, box, left: { point: new THREE.Vector3() }, right: { point: new THREE.Vector3() }, target: { x: 0, z: 0, r: 0 }, placed: false };
  }
  function dropView(id: number) {
    const v = views.get(id);
    if (!v) return;
    views.delete(id);
    scene.remove(v.character.group);
    pool.push(v);
  }

  const ease = (cur: number, target: number, k: number) => cur + Math.atan2(Math.sin(target - cur), Math.cos(target - cur)) * k;

  function draw(dt: number, follow: boolean) {
    const live = new Set<number>();
    for (const t of thieves) {
      if (t.wait > 0 && t.mode !== 'caught') continue; // nog niet binnen
      live.add(t.id);
      let v = views.get(t.id);
      if (!v) views.set(t.id, (v = takeView()));
      const g = v.character.group;
      // een raket heeft hem geraakt (src/ui/rocketLauncher.ts maakt hem dan piepklein): gepakt
      if (g.scale.x < 0.01 && t.mode !== 'caught' && !hits.has(t.id)) {
        hits.add(t.id);
        act({ a: 'hit', id: t.id });
      }
      v.target = { x: t.x, z: t.z, r: t.r };
      const k = follow ? 1 - Math.exp(-dt * 12) : 1;
      if (!v.placed || Math.hypot(g.position.x - t.x, g.position.z - t.z) > 6) {
        g.position.set(t.x, 0, t.z);
        g.rotation.y = t.r;
        v.placed = true;
      } else {
        g.position.x += (t.x - g.position.x) * k;
        g.position.z += (t.z - g.position.z) * k;
        g.rotation.y = ease(g.rotation.y, t.r, follow ? k : 1 - Math.exp(-dt * 14));
      }
      v.box.visible = t.loot && t.mode !== 'caught';
      // Handen: grissen = naar de pallet reiken, gepakt = handen omhoog
      const fx = Math.sin(g.rotation.y);
      const fz = Math.cos(g.rotation.y);
      let left: HandTarget | undefined;
      let right: HandTarget | undefined;
      if (t.mode === 'grab' || t.mode === 'caught') {
        const up = t.mode === 'caught';
        const f = up ? 0.08 : 0.62;
        const y = up ? 2.05 : 0.95;
        const s = up ? 0.26 : 0.2;
        v.left.point.set(g.position.x + fx * f + fz * s, y, g.position.z + fz * f - fx * s);
        v.right.point.set(g.position.x + fx * f - fz * s, y, g.position.z + fz * f + fx * s);
        left = v.left;
        right = v.right;
      }
      v.character.update(dt, { carrying: v.box.visible, leftHand: left, rightHand: right });
    }
    for (const id of [...views.keys()]) if (!live.has(id)) dropView(id);
  }

  // ---------- In beeld: stand van de wave ----------
  const style = document.createElement('style');
  style.textContent = `
.thief-banner { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); z-index: 55; display: none; padding: 8px 16px;
  border-radius: 8px; background: rgba(0,0,0,.65); color: #fff; font: 600 15px system-ui, sans-serif; text-align: center; pointer-events: none; }
.thief-banner.on { display: block; }
.thief-banner .big { display: block; font-size: 22px; }
.thief-banner .won { color: #7ee081; } .thief-banner .lost { color: #ff7a6b; }
.thief-panel p { margin: 0 0 8px; }
.thief-panel button { padding: 5px 12px; margin-right: 6px; border: 0; border-radius: 5px; background: #3b6ea5; color: #fff; font: inherit; cursor: pointer; }
.thief-panel button.stop { background: #8a3a32; }
.thief-panel button:disabled { opacity: .45; cursor: default; }
`;
  document.head.appendChild(style);
  const banner = document.createElement('div');
  banner.className = 'thief-banner';
  document.body.appendChild(banner);

  const panel = document.createElement('div');
  panel.className = 'thief-panel';
  panel.innerHTML = `<p>Boeven in boevenpak en bivakmuts stormen in waves binnen via de nooduitgang of een chauffeursdeur en proberen een doos van een pallet
    te stelen. <b>Loop ertegenaan</b> om ze te pakken (rennen met Shift), of schiet ze neer met de raketwerper (3).</p>
    <p>Niets gestolen: wave gehaald en de volgende komt, met een boef meer. Komt er één met buit buiten, dan begin je weer bij wave 1.
    Iedereen in de kamer speelt mee; de voorraad en de WMS merken er niets van.</p>
    <p class="status"></p><button class="go">Starten</button><button class="stop">Stoppen</button>`;
  const status = panel.querySelector('.status') as HTMLElement;
  const goBtn = panel.querySelector('.go') as HTMLButtonElement;
  const stopBtn = panel.querySelector('.stop') as HTMLButtonElement;
  goBtn.addEventListener('click', () => {
    act({ a: 'start' });
    menu.close();
  });
  stopBtn.addEventListener('click', () => act({ a: 'stop' }));
  menu.addSection('thieves', 'Boeven', panel, 10);

  let shown = '';
  function refreshText() {
    const inside = thieves.filter((t) => t.mode !== 'caught' && t.wait <= 0 && t.z < DOOR_Z).length;
    let html = '';
    if (phase === 'countdown') html = `<span class="big">Wave ${wave}</span>${wave + 1} boeven komen eraan… ${Math.ceil(timer)}`;
    else if (phase === 'active') html = `Wave ${wave} · gepakt ${caught}/${total}${inside ? ` · ${inside} binnen` : ''}`;
    else if (phase === 'result')
      html =
        result === 'won'
          ? `<span class="big won">Wave ${wave - 1} gehaald!</span>Niets gestolen. Wave ${wave} komt eraan…`
          : `<span class="big lost">Gestolen!</span>Er is een boef ontsnapt met buit. Terug naar wave 1…`;
    if (html !== shown) {
      shown = html;
      banner.innerHTML = html;
      banner.classList.toggle('on', !!html);
    }
    status.textContent =
      phase === 'idle' ? `Klaar voor wave ${wave}.` : phase === 'active' ? `Bezig: wave ${wave}, ${caught} van ${total} gepakt.` : phase === 'countdown' ? `Wave ${wave} begint zo.` : 'Uitslag in beeld.';
    goBtn.disabled = phase !== 'idle';
    stopBtn.disabled = phase === 'idle';
  }

  const MODES: Mode[] = ['in', 'grab', 'out', 'caught'];
  const PHASES: Phase[] = ['idle', 'countdown', 'active', 'result'];

  return {
    update(dt: number) {
      const follow = following();
      if (!follow) simulate(dt);
      draw(dt, follow);
      refreshText();
    },
    /** Waar de boeven lopen: de nooduitgang gaat voor ze open. */
    walkers: (): Point[] => thieves.filter((t) => t.wait <= 0 || t.mode === 'caught').map((t) => ({ x: t.x, z: t.z })),
    /** Speelt er een wave (dan stuurt de host vaker de stand rond)? */
    get busy() {
      return phase !== 'idle';
    },
    /** De stand voor de andere spelers (alleen de host stuurt die rond). */
    net() {
      return {
        w: wave, p: PHASES.indexOf(phase), tm: Math.round(timer * 10) / 10, c: caught, s: stolen, n: total, res: result,
        t: thieves.map((t) => [t.id, Math.round(t.x * 100) / 100, Math.round(t.z * 100) / 100, Math.round(t.r * 100) / 100, MODES.indexOf(t.mode), t.loot ? 1 : 0, Math.round(t.wait * 10) / 10]),
      };
    },
    /** Stand van de host overnemen. */
    follow(d: unknown) {
      if (typeof d !== 'object' || d === null) return;
      const o = d as Record<string, unknown>;
      followedAt = performance.now();
      wave = Math.max(1, Math.floor(num(o.w, 1)));
      phase = PHASES[num(o.p)] ?? 'idle';
      timer = num(o.tm);
      caught = num(o.c);
      stolen = num(o.s);
      total = num(o.n);
      result = o.res === 'won' || o.res === 'lost' ? o.res : '';
      const list = Array.isArray(o.t) ? o.t.slice(0, 50) : [];
      const prev = new Map(thieves.map((t) => [t.id, t]));
      thieves = [];
      for (const row of list) {
        if (!Array.isArray(row)) continue;
        const id = num(row[0]);
        const old = prev.get(id);
        const t: Thief = old ?? { id, x: 0, z: 0, r: 0, bx: 0, bz: 0, off: 0, mode: 'in', loot: false, wait: 0, path: [], stand: { x: 0, z: 0, r: 0 }, speed: 4 };
        t.bx = t.x = THREE.MathUtils.clamp(num(row[1]), -200, 200);
        t.bz = t.z = THREE.MathUtils.clamp(num(row[2]), -200, 200);
        t.off = 0;
        t.r = num(row[3]);
        t.mode = MODES[num(row[4])] ?? 'in';
        t.loot = row[5] === 1;
        t.wait = num(row[6]);
        if (t.mode === 'grab') t.stand.r = t.r;
        thieves.push(t);
        nextId = Math.max(nextId, id + 1);
      }
    },
    /**
     * Wij zijn host geworden: niet meer volgen maar zelf laten lopen, vanaf de laatst ontvangen stand. De routes
     * kwamen niet mee over de lijn: die worden opnieuw uitgezet vanaf waar elke boef nu staat.
     */
    lead() {
      if (!following()) return;
      followedAt = -Infinity;
      for (const t of thieves) {
        // wie nog buiten loopt gaat eerst door de dichtstbijzijnde deur naar binnen
        const outside = t.z > DOOR_Z - 0.5 || t.x < WALL_X + 0.5;
        const dist = (p: Point[]) => Math.hypot(p[0].x - t.x, p[0].z - t.z);
        const entry = outside ? DOORS.map((d) => d(false).slice(1)).reduce((a, b) => (dist(b) < dist(a) ? b : a)) : [];
        const from = entry.length ? entry[entry.length - 1] : t;
        if (t.mode === 'in') {
          t.stand = pickStand();
          t.path = [...entry, ...route(from, t.stand)];
        } else if (t.mode === 'out') {
          t.path = outside ? entry.reverse() : outPath(t);
        } else if (t.mode === 'grab') {
          t.stand = { x: t.x, z: t.z, r: t.r };
        }
      }
    },
    /** Verzoek van een andere speler (knop of voltreffer); alleen de host voert het uit. */
    request,
    /** Hoe deze speler een verzoek naar de host stuurt. */
    connect(fn: (d: unknown) => void) {
      send = fn;
    },
  };
}
