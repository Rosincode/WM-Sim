import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { STYLE } from './style';
import type { Collider, Hall, RackPallet, Slot, Solid } from './warehouse';

// Bestuurbare heftruck (elektrische contragewichttruck). Voorkant wijst naar +Z.
// Rijden: W/S, sturen: A/D, vorken: pijl omhoog/omlaag.
// Oppakken: steek de vorken onder een pallet en hef. Neerzetten: zak tot de pallet staat.

/** id = het nummer van de palletsticker; unlabeled = er zit nog geen sticker op. */
export type Load = { id: string; sku: string; qty: number; unlabeled?: boolean };

interface Options {
  hall: Hall;
  colliders: Collider[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Pallets uit en in de stellingen van de sim; slot = de palletplek op de locatie. */
  take: (palletId: string) => Load | null;
  place: (locId: string, load: Load, fromLocId: string, slot: number) => void;
  /** Aangeroepen na een mutatie zodat de hal de stellingen opnieuw tekent. */
  onStockChange: () => void;
}

/** key: bepaalt hoe de dozen op de pallet gestapeld zijn, zodat hij er bij elke speler hetzelfde uitziet. */
export type Carried = { load: Load; from: string; key: string; mesh: THREE.Group };
export type Loose = Carried & { x: number; z: number; r: number };

/** Stand van de heftruck zoals spelers die onderling delen (multiplayer). */
export type ForkliftState = {
  x: number;
  z: number;
  r: number;
  /** Hoogte van de vorken. */
  h: number;
  load: (Load & { from: string; key: string }) | null;
  /** Pallets die los op de vloer zijn gezet. */
  loose: (Load & { from: string; key: string; x: number; z: number; r: number })[];
};

const round = (n: number, f = 100) => Math.round(n * f) / f;
type Target = { x: number; y: number; z: number; rack?: RackPallet; loose?: Loose };

const RADIUS = 1.05; // botscirkel rond het chassis
const FORK_MIN = 0.06;
const FORK_MAX = 4.7;
const FORK_Z = 1.66; // midden van de vorken, vanaf het hart van de truck
const REACH = 0.45; // hoe nauwkeurig de vorken onder de pallet moeten zitten
const MAX_SPEED = 4.2;
const MAX_REVERSE = 2.6;

// ---------- Vormen ----------
/** Punt in het zijaanzicht: z (naar voren), y (omhoog) en eventueel de straal van de afgeronde hoek. */
type P = [z: number, y: number, r?: number];

/** Zijaanzicht met afgeronde hoeken, uitgetrokken over de breedte (x, rond het midden). */
function profile(pts: P[], width: number, bevel = 0.012) {
  const shape = new THREE.Shape();
  const n = pts.length;
  pts.forEach(([z, y, r = 0], i) => {
    const [pz, py] = pts[(i + n - 1) % n];
    const [nz, ny] = pts[(i + 1) % n];
    const lp = Math.hypot(pz - z, py - y);
    const ln = Math.hypot(nz - z, ny - y);
    const d = Math.min(r, lp / 2, ln / 2);
    const az = z + ((pz - z) / lp) * d;
    const ay = y + ((py - y) / lp) * d;
    if (i === 0) shape.moveTo(az, ay);
    else shape.lineTo(az, ay);
    if (d > 0) shape.quadraticCurveTo(z, y, z + ((nz - z) / ln) * d, y + ((ny - y) / ln) * d);
  });
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 2,
    curveSegments: 6,
  });
  geo.translate(0, 0, bevel - width / 2);
  geo.rotateY(-Math.PI / 2); // vorm-x wordt z, de uittrekrichting wordt x
  return toCreasedNormals(geo, 0.3); // bochten vloeiend, vlakke kanten en de afschuining strak
}

/** Punten op een cirkelboog in het zijaanzicht; hoek 0 wijst naar voren, een kwartslag is recht omhoog. */
function arc(cz: number, cy: number, r: number, from: number, to: number, steps = 14): P[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = from + ((to - from) * i) / steps;
    return [cz + Math.cos(a) * r, cy + Math.sin(a) * r] as P;
  });
}

/** Buis langs een reeks punten, met ronde bochten. */
function tube(pts: [number, number, number][], radius: number, corner: number) {
  const v = pts.map((p) => new THREE.Vector3(...p));
  const path = new THREE.CurvePath<THREE.Vector3>();
  let from = v[0];
  for (let i = 1; i < v.length - 1; i++) {
    const a = v[i].clone().add(v[i - 1].clone().sub(v[i]).setLength(corner));
    const c = v[i].clone().add(v[i + 1].clone().sub(v[i]).setLength(corner));
    path.add(new THREE.LineCurve3(from, a));
    path.add(new THREE.QuadraticBezierCurve3(a, v[i], c));
    from = c;
  }
  path.add(new THREE.LineCurve3(from, v[v.length - 1]));
  return new THREE.TubeGeometry(path, 90, radius, 10);
}

export function createForklift({ hall, colliders, bounds, take, place, onStockChange }: Options) {
  const g = new THREE.Group();
  // Materialen van de huisstijl, gedeeld met de pompwagen
  const { paint: red, dark, black, steel, rubber, seat } = STYLE;
  const tailLight = new THREE.MeshStandardMaterial({ color: '#7a0c08', emissive: '#ff2a1a', emissiveIntensity: 0.6 });

  const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, rx = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const b = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  const rb = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 3, r);
  const cyl = (r: number, len: number, seg = 16) => new THREE.CylinderGeometry(r, r, len, seg);
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  /** Ronde staaf tussen twee punten. */
  const rod = (parent: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, r: number, mat: THREE.Material) => {
    const m = add(parent, cyl(r, from.distanceTo(to), 12), mat);
    m.position.copy(from).add(to).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, to.clone().sub(from).normalize());
    return m;
  };

  // Onderstel, met daaroverheen de rode kap: motorkap onder de stoel en de vloer voor de voeten
  add(g, profile([[-0.6, 0.24], [-0.6, 0.75], [0.66, 0.75], [0.66, 0.24, 0.08]], 0.88), dark);
  add(g, profile([[-0.56, 0.3], [-0.72, 0.5], [-0.72, 1.18], [-0.12, 1.18, 0.08], [-0.06, 0.78, 0.04], [0.2, 0.78], [0.2, 0.3, 0.06]], 1.08, 0.02), red);
  add(g, rb(0.8, 0.05, 0.5, 0.012), rubber, 0, 0.77, 0.19);
  // Voorschot met het dashboard, schuin naar de bestuurder, en de hendels van de mast
  add(g, profile([[0.42, 0.75], [0.42, 1.2, 0.05], [0.58, 1.34, 0.04], [0.64, 1.34, 0.03], [0.64, 0.75]], 0.9, 0.02), red);
  for (const x of [0.24, 0.31, 0.38]) {
    add(g, cyl(0.008, 0.16, 8), steel, x, 1.4, 0.52, -0.3);
    add(g, new THREE.SphereGeometry(0.02, 12, 8), black, x, 1.476, 0.496);
  }
  // Spatborden over de voorwielen
  const fender = profile([...arc(0.55, 0.3, 0.4, 0.35, Math.PI), ...arc(0.55, 0.3, 0.345, Math.PI, 0.35)], 0.26, 0.008);
  for (const x of [-0.56, 0.56]) add(g, fender, red, x);

  // Contragewicht: rond aan de achterkant, met aan weerszijden een wang over het achterwiel
  const back: P[] = [[-0.72, 1.18], [-1.28, 1.18, 0.22], [-1.28, 0.36, 0.1]];
  add(g, profile([[-0.72, 0.28], ...back, [-1.2, 0.28]], 0.82, 0.02), dark);
  const cheek = profile([...back, [-1.2, 0.3], ...arc(-0.85, 0.24, 0.28, 2.926, 1.088)], 0.16, 0.02);
  for (const x of [-0.49, 0.49]) {
    add(g, cheek, dark, x);
    add(g, b(0.14, 0.05, 0.02), tailLight, x * 0.75, 0.74, -1.283).castShadow = false;
  }

  // Stoel
  add(g, rb(0.52, 0.12, 0.5, 0.04), seat, 0, 1.24, -0.45);
  add(g, rb(0.5, 0.56, 0.1, 0.04), seat, 0, 1.5, -0.71, -0.15);
  // Stuurkolom vanaf de vloer schuin naar de bestuurder; het stuur zit binnen handbereik boven de knieën.
  add(g, new THREE.CylinderGeometry(0.025, 0.03, 1.0, 10), black, 0, 1.19, 0.17, -0.5);
  const wheelRim = add(g, new THREE.TorusGeometry(0.16, 0.022, 10, 32), black, 0, 1.63, -0.07, Math.PI / 2 - 0.5);
  add(wheelRim, new THREE.CylinderGeometry(0.04, 0.04, 0.03, 16), black, 0, 0, 0, Math.PI / 2);
  for (const a of [Math.PI / 2, -Math.PI / 2, Math.PI]) add(wheelRim, b(0.024, 0.15, 0.012), black, Math.sin(a) * 0.08, Math.cos(a) * 0.08, 0, 0, -a);
  // Plek op de stuurrand (linksboven) waar de hand van de bestuurder ligt; draait mee met het stuur.
  const wheelGrip = new THREE.Object3D();
  wheelGrip.position.set(Math.sin(1.05) * 0.16, Math.cos(1.05) * 0.16, 0);
  wheelRim.add(wheelGrip);

  // Beschermkooi: per kant één gebogen buis van spatbord naar contragewicht, met een rooster als dak
  for (const x of [-0.5, 0.5]) add(g, tube([[x, 0.66, 0.55], [x, 2.22, 0.68], [x, 2.22, -0.97], [x, 1.12, -0.97]], 0.032, 0.14), black);
  for (const z of [0.6, -0.9]) rod(g, v(-0.5, 2.22, z), v(0.5, 2.22, z), 0.028, black);
  for (let z = -0.72; z < 0.5; z += 0.18) add(g, b(1.0, 0.02, 0.045), black, 0, 2.22, z);

  // Wielen: band met ronde schouders, velg en wielmoeren
  const wheels: { o: THREE.Object3D; r: number }[] = [];
  const wheel = (x: number, z: number, r: number, w: number) => {
    const o = new THREE.Group();
    o.position.set(x, r, z);
    g.add(o);
    const h = w / 2;
    const tyre = [[r * 0.56, -h], [r - 0.035, -h], [r - 0.008, -h + 0.02], [r, -h + 0.05], [r, h - 0.05], [r - 0.008, h - 0.02], [r - 0.035, h], [r * 0.56, h]];
    add(o, new THREE.LatheGeometry(tyre.map(([px, py]) => new THREE.Vector2(px, py)), 32), rubber, 0, 0, 0, 0, Math.PI / 2);
    add(o, cyl(r * 0.58, w * 0.72, 28), steel, 0, 0, 0, 0, Math.PI / 2);
    add(o, cyl(r * 0.2, w * 0.86, 16), red, 0, 0, 0, 0, Math.PI / 2);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      add(o, cyl(0.014, w * 0.8, 6), black, 0, Math.cos(a) * r * 0.38, Math.sin(a) * r * 0.38, 0, Math.PI / 2);
    }
    wheels.push({ o, r });
  };
  for (const side of [-1, 1]) {
    wheel(side * 0.56, 0.55, 0.3, 0.22);
    wheel(side * 0.5, -0.85, 0.24, 0.16);
  }

  // Mast: vast deel (met hef- en neigcilinders) + uitschuivend deel
  for (const x of [-0.36, 0.36]) {
    add(g, rb(0.09, 2.5, 0.12, 0.015), dark, x, 1.3, 0.98);
    add(g, cyl(0.035, 1.9, 12), steel, x * 0.55, 1.15, 0.955);
    rod(g, v(x * 0.85, 0.62, 0.6), v(x, 1.0, 0.93), 0.03, steel);
  }
  for (const y of [0.6, 1.55, 2.5]) add(g, b(0.82, 0.08, 0.1), dark, 0, y, 0.98);
  const innerMast = new THREE.Group();
  for (const x of [-0.28, 0.28]) add(innerMast, rb(0.07, 2.5, 0.09, 0.012), steel, x, 1.3, 1.0);
  add(innerMast, b(0.64, 0.07, 0.08), steel, 0, 2.52, 1.0);
  for (const x of [-0.1, 0.1]) add(innerMast, b(0.025, 2.4, 0.012), black, x, 1.3, 1.03); // hefkettingen
  g.add(innerMast);

  // Vorkenbord met lastrek en vorken (beweegt mee met de hefhoogte)
  const carriage = new THREE.Group();
  for (const y of [0.24, 0.6]) add(carriage, rb(0.95, 0.1, 0.06, 0.012), black, 0, y, 1.08);
  add(carriage, b(0.6, 0.3, 0.03), black, 0, 0.42, 1.065);
  for (const x of [-0.45, -0.225, 0, 0.225, 0.45]) add(carriage, b(0.03, 0.62, 0.03), black, x, 0.94, 1.08);
  add(carriage, b(0.93, 0.03, 0.03), black, 0, 1.24, 1.08);
  // Vork uit één stuk: rug, ronde hiel en een blad dat naar de punt dunner wordt
  const forkBlade = profile([[1.11, 0.62], [1.155, 0.62], [1.155, 0.133, 0.03], [2.21, 0.133], [2.21, 0.118], [1.85, 0.088], [1.11, 0.088, 0.04]], 0.11, 0.006);
  for (const x of [-0.3, 0.3]) add(carriage, forkBlade, steel, x);
  g.add(carriage);

  // Zwaailamp en koplampen
  const beacon = new THREE.MeshBasicMaterial();
  add(g, b(0.22, 0.015, 0.2), black, 0.38, 2.24, -0.8);
  add(g, cyl(0.06, 0.03), black, 0.4, 2.262, -0.8);
  add(g, cyl(0.045, 0.07, 14), beacon, 0.4, 2.31, -0.8);
  add(g, new THREE.SphereGeometry(0.045, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), beacon, 0.4, 2.345, -0.8);
  const head = new THREE.MeshBasicMaterial();
  head.color.setRGB(3, 3, 2.7);
  for (const x of [-0.5, 0.5]) {
    add(g, cyl(0.06, 0.08), black, x, 2.08, 0.72, Math.PI / 2);
    add(g, cyl(0.048, 0.01), head, x, 2.08, 0.762, Math.PI / 2);
  }

  // Markering van de plek waar de pallet terechtkomt
  const marker = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.03, 1.0),
    new THREE.MeshBasicMaterial({ color: '#35e06a', transparent: true, opacity: 0.45, depthWrite: false }),
  );
  marker.visible = false;

  // ---------- Toestand ----------
  let driving = false;
  let speed = 0;
  let steer = 0;
  let forkH = FORK_MIN;
  let carried: Carried | null = null;
  const loose: Loose[] = [];
  let hint = '';

  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    if (driving && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) e.preventDefault();
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => {
    keys.clear();
    setHorn(0);
  });
  const down = (code: string) => (keys.has(code) ? 1 : 0);

  // ---------- Toeter (H ingedrukt houden); klinkt ook bij andere spelers ----------
  let audio: AudioContext | null = null;
  let horn: { gain: GainNode; oscs: OscillatorNode[] } | null = null;
  let hornVolume = 0;
  /** Volume (0..1) van de toeter van een speler die op afstand rijdt. */
  let remoteHorn = 0;
  // De browser laat pas geluid toe na een klik of toets van de speler zelf. Zet het geluid dan alvast aan,
  // zodat ook wie nog niet zelf getoeterd heeft de toeter van een ander hoort.
  const unlockAudio = () => {
    try {
      audio ??= new AudioContext();
      if (audio.state === 'suspended') void audio.resume();
    } catch {
      // geen geluid beschikbaar
    }
  };
  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', unlockAudio);
  function setHorn(volume: number) {
    if (volume === hornVolume) return;
    hornVolume = volume;
    try {
      if (volume <= 0) {
        if (!horn || !audio) return;
        const { gain, oscs } = horn;
        horn = null;
        gain.gain.setTargetAtTime(0, audio.currentTime, 0.02);
        for (const o of oscs) o.stop(audio.currentTime + 0.15);
        return;
      }
      const ctx = (audio ??= new AudioContext());
      if (ctx.state === 'suspended') void ctx.resume();
      if (!horn) {
        const gain = ctx.createGain();
        gain.gain.value = 0;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 2200;
        filter.connect(gain).connect(ctx.destination);
        // Twee tonen vlak bij elkaar geven het schelle geluid van een elektrische claxon
        const oscs = [415, 520].map((freq) => {
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = freq;
          o.connect(filter);
          o.start();
          return o;
        });
        horn = { gain, oscs };
      }
      horn.gain.gain.setTargetAtTime(0.12 * Math.min(1, volume), ctx.currentTime, 0.015);
    } catch {
      horn = null; // geen geluid beschikbaar: stil doorgaan
    }
  }

  const fork = new THREE.Vector3();
  const forward = new THREE.Vector3();

  function forkPoint() {
    forward.set(Math.sin(g.rotation.y), 0, Math.cos(g.rotation.y));
    return fork.copy(g.position).addScaledVector(forward, FORK_Z);
  }

  function pickTargets(): Target[] {
    return [
      ...hall.rackPallets().map((p) => ({ x: p.x, y: p.y, z: p.z, rack: p })),
      ...loose.map((l) => ({ x: l.x, y: 0, z: l.z, loose: l })),
    ];
  }

  function attach(c: Carried) {
    carried = c;
    carriage.add(c.mesh);
    c.mesh.position.set(0, 0.135, FORK_Z);
    c.mesh.rotation.set(0, 0, 0);
  }

  function tryPick(prevH: number) {
    const f = forkPoint();
    for (const t of pickTargets()) {
      if (Math.hypot(t.x - f.x, t.z - f.z) > REACH) continue;
      const lift = t.y + 0.1; // vorken komen van onder het dek omhoog
      if (!(prevH <= lift && forkH > lift && prevH > t.y - 0.1)) continue;
      if (t.loose) {
        attach(takeLoose(t.loose));
        return;
      }
      const p = t.rack!;
      const load = take(p.id);
      if (!load) continue;
      attach({ load, from: p.locId, key: load.id, mesh: hall.buildLoad(load.sku, load.qty, load.id, !load.unlabeled) });
      onStockChange();
      return;
    }
  }

  function tryPlace(prevH: number, slot: Slot | null) {
    if (!carried) return;
    const f = forkPoint();
    const c = carried;
    if (slot && Math.hypot(slot.x - f.x, slot.z - f.z) <= REACH + 0.1) {
      const rest = slot.y + 0.07;
      if (prevH > rest && forkH <= rest) {
        carriage.remove(c.mesh);
        carried = null;
        place(slot.locId, c.load, c.from, slot.index);
        onStockChange();
      }
      return;
    }
    if (hall.inRack(f.x, f.z)) return; // in de stelling alleen op een vrije plek
    if (prevH > 0.07 && forkH <= 0.07) {
      carried = null;
      dropLoose(c, f.x, f.z, g.rotation.y);
    }
  }

  // ---------- Losse pallets op de vloer (gedeeld met de pompwagen) ----------
  function takeLoose(l: Loose): Carried {
    loose.splice(loose.indexOf(l), 1);
    return l;
  }
  function dropLoose(c: Carried, x: number, z: number, r: number) {
    g.parent?.add(c.mesh); // haalt hem ook van de vorken af
    c.mesh.position.set(x, 0, z);
    c.mesh.rotation.set(0, r, 0);
    loose.push({ ...c, x, z, r });
  }

  // ---------- Botsblokken voor spelers: op de vorken (of de last) staan en opgetild worden ----------
  /** Stand van de truck; de blokken hieronder staan in het assenstelsel van de truck. */
  const pose = { x: 0, z: 0, r: 0 };
  const loadTop = (c: Carried) => hall.loadHeight(c.load.sku, c.load.qty);
  function solids(): Solid[] {
    pose.x = g.position.x;
    pose.z = g.position.z;
    pose.r = g.rotation.y;
    const list: Solid[] = [
      { pose, minX: -0.58, maxX: 0.58, minZ: -1.28, maxZ: 0.62, minY: 0, maxY: 1.2 }, // chassis
      { pose, minX: -0.55, maxX: 0.55, minZ: -1.0, maxZ: 0.7, minY: 2.2, maxY: 2.28 }, // dak van de kooi
      { pose, minX: -0.48, maxX: 0.48, minZ: 0.92, maxZ: 1.11, minY: 0, maxY: Math.max(2.55, forkH + 1.1) }, // mast en vorkenbord
      { pose, lift: true, minX: -0.42, maxX: 0.42, minZ: 1.11, maxZ: 2.22, minY: forkH - 0.03, maxY: forkH + 0.0225 }, // vorken
    ];
    if (carried)
      list.push({ pose, lift: true, minX: -0.6, maxX: 0.6, minZ: FORK_Z - 0.5, maxZ: FORK_Z + 0.5, minY: forkH + 0.025, maxY: forkH + 0.025 + loadTop(carried) });
    for (const l of loose)
      list.push({ pose: { x: l.x, z: l.z, r: l.r }, minX: -0.6, maxX: 0.6, minZ: -0.5, maxZ: 0.5, minY: 0, maxY: loadTop(l) });
    return list;
  }

  // ---------- Multiplayer: stand delen met en overnemen van andere spelers ----------
  /** Doelstand als een andere speler rijdt (of de truck heeft geparkeerd); de truck beweegt er soepel naartoe. */
  let remote: { x: number; z: number; r: number; h: number } | null = null;
  let remoteDriven = false;
  let remoteSteer = 0;

  function getState(): ForkliftState {
    const t = remote ?? { x: g.position.x, z: g.position.z, r: g.rotation.y, h: forkH };
    return {
      x: round(t.x),
      z: round(t.z),
      r: round(t.r, 1000),
      h: round(t.h),
      load: carried ? { ...carried.load, from: carried.from, key: carried.key } : null,
      loose: loose.map((l) => ({ ...l.load, from: l.from, key: l.key, x: round(l.x), z: round(l.z), r: round(l.r, 1000) })),
    };
  }

  /** @param withLoose false: de losse pallets op de vloer blijven zoals ze zijn (die komen apart binnen). */
  function applyState(s: ForkliftState, withLoose = true) {
    remote = { x: s.x, z: s.z, r: s.r, h: s.h };
    if ((carried?.load.id ?? '') !== (s.load?.id ?? '')) {
      if (carried) carriage.remove(carried.mesh);
      carried = null;
      if (s.load) {
        const { from, key, ...load } = s.load;
        attach({ load, from, key, mesh: hall.buildLoad(load.sku, load.qty, key, !load.unlabeled) });
      }
    }
    if (withLoose) applyLoose(s.loose);
  }

  function applyLoose(list: ForkliftState['loose']) {
    const sig = (list: { id: string; x: number; z: number }[]) => list.map((l) => `${l.id}@${round(l.x)},${round(l.z)}`).join();
    if (sig(loose.map((l) => ({ id: l.load.id, x: l.x, z: l.z }))) !== sig(list)) {
      for (const l of loose) l.mesh.removeFromParent();
      loose.length = 0;
      for (const { from, key, x, z, r, ...load } of list) {
        const mesh = hall.buildLoad(load.sku, load.qty, key, !load.unlabeled);
        mesh.position.set(x, 0, z);
        mesh.rotation.set(0, r, 0);
        g.parent?.add(mesh);
        loose.push({ load, from, key, mesh, x, z, r });
      }
    }
  }

  /** Volgt de stand van een andere speler; zelf rijden, oppakken en neerzetten staat dan uit. */
  function followRemote(dt: number, time: number, t: NonNullable<typeof remote>) {
    const k = 1 - Math.exp(-dt * 12);
    const far = Math.hypot(t.x - g.position.x, t.z - g.position.z) > 8; // net binnengekomen: niet door de hal schuiven
    g.position.x += (t.x - g.position.x) * (far ? 1 : k);
    g.position.z += (t.z - g.position.z) * (far ? 1 : k);
    g.rotation.y += Math.atan2(Math.sin(t.r - g.rotation.y), Math.cos(t.r - g.rotation.y)) * (far ? 1 : k);
    forkH += (t.h - forkH) * k;
    speed = 0;
    steer += (remoteSteer - steer) * k;
    wheelRim.rotation.z = -steer * 1.2;
    carriage.position.y = forkH - 0.11;
    innerMast.position.y = Math.max(0, forkH - 1.7);
    marker.visible = false;
    const blink = remoteDriven ? 0.6 + 0.4 * Math.sin(time * 9) : 0.15;
    beacon.color.setRGB(3.5 * blink, 1.4 * blink, 0.1);
  }

  function updateHint(slot: Slot | null) {
    const f = forkPoint();
    const h = forkH.toFixed(2);
    if (carried) {
      const what = `${carried.load.unlabeled ? 'pallet zonder sticker' : carried.load.id} · ${carried.load.qty}× ${carried.load.sku}`;
      if (slot) {
        const near = Math.hypot(slot.x - f.x, slot.z - f.z) <= REACH + 0.1;
        hint = near
          ? `Last: ${what} · <b>↓</b> zakken om neer te zetten op <b>${slot.locId}</b>`
          : `Last: ${what} · vrije plek <b>${slot.locId}</b> (groen gemarkeerd) op ${slot.y.toFixed(2)} m · vorken ${h} m`;
      } else {
        hint = hall.inRack(f.x, f.z)
          ? `Last: ${what} · hier is geen vrije plek op deze hoogte · vorken ${h} m`
          : `Last: ${what} · rijd naar een vrije stellingplek, of <b>↓</b> zak tot de vloer om hem neer te zetten`;
      }
      return;
    }
    let best: Target | null = null;
    let bestD = 0.9;
    for (const t of pickTargets()) {
      const d = Math.hypot(t.x - f.x, t.z - f.z) + Math.abs(t.y - forkH) * 0.2;
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    if (!best) {
      hint = `Vorken ${h} m · rijd de vorken onder een pallet en hef`;
      return;
    }
    const name = best.rack ? `op ${best.rack.locId}` : 'op de vloer';
    if (forkH <= best.y + 0.1 && forkH > best.y - 0.1) hint = `<b>↑</b> heffen om de pallet ${name} op te pakken`;
    else hint = `Pallet ${name} staat op ${best.y.toFixed(2)} m · zet de vorken op ${(best.y + 0.06).toFixed(2)} m (nu ${h} m)`;
  }

  return {
    group: g,
    marker,
    /** Plek van het hoofd van de bestuurder (lokaal). */
    seat: new THREE.Vector3(0, 1.95, -0.42),
    /** Plek van de ogen in first person (lokaal): net boven de romp, zodat je je eigen lichaam onder je ziet. */
    eye: new THREE.Vector3(0, 2.07, -0.38),
    /** Punt op het stuur waar de handpalm van de bestuurder op ligt, met de normaal van het stuurvlak (wereld). */
    steeringGrip(point: THREE.Vector3, normal: THREE.Vector3) {
      wheelGrip.getWorldPosition(point);
      normal.set(0, 0, -1).transformDirection(wheelRim.matrixWorld);
      point.addScaledVector(normal, 0.022); // bovenop de rand
    },
    /** Stuuruitslag -1..1 (links +). */
    get steer() {
      return steer;
    },
    /** Stuuruitslag van de speler die op afstand rijdt, zodat het stuur (en zijn hand) meedraait. */
    setRemoteSteer(v: number) {
      remoteSteer = THREE.MathUtils.clamp(v, -1, 1);
    },
    get driving() {
      return driving;
    },
    /** Toetert de bestuurder (deze speler) nu? */
    get honking() {
      return driving && keys.has('KeyH');
    },
    /** Toeter van de speler die op afstand rijdt: volume 0..1 (0 = uit). */
    setRemoteHorn(volume: number) {
      remoteHorn = THREE.MathUtils.clamp(volume, 0, 1);
    },
    get hint() {
      return hint;
    },
    setDriving(on: boolean) {
      driving = on;
      if (on) remote = null;
    },
    getState,
    applyState,
    applyLoose,
    /** Losse pallets op de vloer: ook de pompwagen pakt ze op en zet ze neer. */
    loose: { list: () => loose, take: takeLoose, drop: dropLoose },
    solids,
    /** Stand van de truck waar de blokken van solids() bij horen (steeds hetzelfde object). */
    pose,
    /** Hoogte van de vorken. */
    get forkHeight() {
      return forkH;
    },
    /** Rijdt een andere speler op dit moment met de truck? (zwaailamp) */
    setRemoteDriven(on: boolean) {
      remoteDriven = on;
    },
    /** Handig bij testen: zet de truck ergens neer. */
    teleport(x: number, z: number, rotY: number, height = forkH) {
      g.position.set(x, 0, z);
      g.rotation.y = rotY;
      forkH = height;
      speed = 0;
      remote = null;
    },
    update(dt: number, time: number) {
      if (dt <= 0) return;
      setHorn(driving ? down('KeyH') : remoteHorn);
      if (remote && !driving) return followRemote(dt, time, remote);

      // Rijden
      const throttle = driving ? down('KeyW') - down('KeyS') : 0;
      const target = throttle > 0 ? MAX_SPEED : throttle < 0 ? -MAX_REVERSE : 0;
      const rate = throttle !== 0 ? 5 : 6;
      speed += THREE.MathUtils.clamp(target - speed, -rate * dt, rate * dt);
      steer += ((driving ? down('KeyA') - down('KeyD') : 0) - steer) * Math.min(1, dt * 7);
      g.rotation.y += steer * speed * 0.55 * dt;
      forward.set(Math.sin(g.rotation.y), 0, Math.cos(g.rotation.y));
      g.position.addScaledVector(forward, speed * dt);

      // Botsen met wanden en stellingen
      const p = g.position;
      const bx = THREE.MathUtils.clamp(p.x, bounds.minX + RADIUS, bounds.maxX - RADIUS);
      const bz = THREE.MathUtils.clamp(p.z, bounds.minZ + RADIUS, bounds.maxZ - RADIUS);
      let hit = bx !== p.x || bz !== p.z;
      p.x = bx;
      p.z = bz;
      for (const c of colliders) {
        const ox = Math.min(p.x - (c.minX - RADIUS), c.maxX + RADIUS - p.x);
        const oz = Math.min(p.z - (c.minZ - RADIUS), c.maxZ + RADIUS - p.z);
        if (ox <= 0 || oz <= 0) continue;
        hit = true;
        if (ox < oz) p.x = p.x < (c.minX + c.maxX) / 2 ? c.minX - RADIUS : c.maxX + RADIUS;
        else p.z = p.z < (c.minZ + c.maxZ) / 2 ? c.minZ - RADIUS : c.maxZ + RADIUS;
      }
      if (hit) speed *= 0.5;

      // Vorken
      const prevH = forkH;
      if (driving) forkH = THREE.MathUtils.clamp(forkH + (down('ArrowUp') - down('ArrowDown')) * 0.9 * dt, FORK_MIN, FORK_MAX);
      carriage.position.y = forkH - 0.11;
      innerMast.position.y = Math.max(0, forkH - 1.7);

      const f = forkPoint();
      const slot = carried ? hall.nearestFreeSlot(f.x, forkH, f.z) : null;
      if (forkH > prevH && !carried) tryPick(prevH);
      else if (forkH < prevH && carried) tryPlace(prevH, slot);

      marker.visible = !!carried && !!slot;
      if (slot) marker.position.set(slot.x, slot.y + 0.02, slot.z);
      if (driving) updateHint(slot);

      // Details
      for (const w of wheels) w.o.rotation.x += (speed * dt) / w.r;
      wheelRim.rotation.z = -steer * 1.2;
      const k = driving ? 0.6 + 0.4 * Math.sin(time * 9) : 0.15;
      beacon.color.setRGB(3.5 * k, 1.4 * k, 0.1);
    },
  };
}
