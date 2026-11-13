import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import modelUrl from '../assets/palletjack.glb?url';
import type { Carried, Load, Loose } from './forklift';
import { restyle, STYLE } from './style';
import type { Hall, RackPallet, Solid } from './warehouse';

// Pompwagen (handpallettruck). Pakken met R: hij rolt dan voor je uit, de vorken wijzen van je af.
// Q pompt de vorken omhoog of laat ze zakken. Alleen voor pallets op de vloer: los in de hal of op
// het onderste niveau van een stelling. Hoger komt alleen de heftruck.
//
// Het model (src/ui/assets/palletjack.glb) bestaat uit drie delen, in meters, vorken naar +Z:
// - frame: chassis en vorken, gaat omhoog bij het pompen;
// - base: pomp, stuurwiel en de rollen onder de vorkpunten, blijven op de vloer;
// - handle: de dissel, met zijn draaipunt op de pomp; kantelt naar je toe zolang iemand hem duwt.
// Het model levert alleen de vorm: de materialen komen uit de huisstijl (style.ts), zonder textures.
// Lukt het laden niet, dan staat er een eenvoudige pompwagen van blokken.

interface Options {
  hall: Hall;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Pallets uit en in de stellingen van de sim (dezelfde als van de heftruck). */
  take: (palletId: string) => Load | null;
  place: (locId: string, load: Load, fromLocId: string, slot: number) => void;
  onStockChange: () => void;
  /** Pallets die los op de vloer staan; de heftruck en de pompwagen delen die. */
  loose: { list(): Loose[]; take(l: Loose): Carried; drop(c: Carried, x: number, z: number, r: number): void };
}

/** Stand van de pompwagen zoals spelers die onderling delen (multiplayer). */
export type JackState = {
  x: number;
  z: number;
  r: number;
  /** Vorken omhoog gepompt. */
  up: 0 | 1;
  load: (Load & { from: string; key: string }) | null;
  /** 1: iemand duwt hem (de dissel staat gekanteld). Ontbreekt bij oudere versies. */
  h?: 1;
};

const round = (n: number, f = 100) => Math.round(n * f) / f;
type Target = { x: number; z: number; rack?: RackPallet; loose?: Loose };

const FORK_Z = 0.5; // midden van de vorken, vanaf het hart van de pompwagen
const TIP_Z = 1.08; // punt van de vorken
const GRIP = 1.1; // afstand van de speler tot het hart van de pompwagen
const REACH = 0.45; // hoe nauwkeurig de vorken onder de pallet moeten zitten
const LIFT = 0.1; // zo ver komen de vorken omhoog
/** Draaipunt van de dissel op de pomp (zoals in het model). */
const PIVOT = new THREE.Vector3(-0.027, 0.48, -0.412);
/** Waar de handen op de handgreep zitten, ten opzichte van het draaipunt (dissel rechtop). */
const HAND = { x: 0.11, y: 0.72, z: 0.01 };
/** Zo ver (rad) kantelt de dissel naar je toe als je duwt. */
const TILT = 0.45;

const loader = new GLTFLoader();
/** Het model heeft hier en daar vlakken die van binnenuit zichtbaar zijn: daarom dubbelzijdig. */
const twoSided = (m: THREE.Material) => Object.assign(m.clone(), { side: THREE.DoubleSide });
const MATERIALS = { jack_paint: twoSided(STYLE.paint), jack_rubber: twoSided(STYLE.rubber), jack_steel: twoSided(STYLE.steel) };

export function createPalletJack({ hall, bounds, take, place, onStockChange, loose }: Options) {
  const g = new THREE.Group();
  /** Gaat omhoog bij het pompen: chassis en vorken. */
  const forks = new THREE.Group();
  /** Draait om het draaipunt op de pomp. */
  const handle = new THREE.Group();
  handle.position.copy(PIVOT);
  g.add(forks, handle);

  const shadows = (o: THREE.Object3D) =>
    o.traverse((m) => {
      if ((m as THREE.Mesh).isMesh) m.castShadow = m.receiveShadow = true;
    });
  loader.load(
    modelUrl,
    (gltf) => {
      restyle(gltf.scene, MATERIALS);
      const part = (name: string) => {
        const o = gltf.scene.getObjectByName(name);
        if (!o) throw new Error(`pompwagen: deel "${name}" ontbreekt in het model`);
        shadows(o);
        return o;
      };
      forks.add(part('frame'));
      g.add(part('base'));
      const h = part('handle');
      h.position.set(0, 0, 0); // het draaipunt zit al in `handle`
      handle.add(h);
    },
    undefined,
    (err) => {
      console.warn('[pompwagen] model niet geladen, eenvoudige vorm in de plaats:', err);
      simpleShape();
    },
  );

  /** Reserve als het model niet laadt: blokken in dezelfde maten. */
  function simpleShape() {
    const { paint: red, rubber: dark } = STYLE;
    const part = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, 0, rz);
      shadows(m);
      parent.add(m);
    };
    for (const x of [-0.2, 0.2]) {
      part(forks, new THREE.BoxGeometry(0.18, 0.05, 1.08), red, x, 0.085, 0.54);
      part(g, new THREE.CylinderGeometry(0.03, 0.03, 0.1, 12), dark, x, 0.03, 0.88, 0, Math.PI / 2);
    }
    part(forks, new THREE.BoxGeometry(0.6, 0.4, 0.2), red, 0, 0.26, -0.1);
    part(g, new THREE.CylinderGeometry(0.1, 0.1, 0.16, 16), dark, 0, 0.1, -0.34, 0, Math.PI / 2);
    part(handle, new THREE.CylinderGeometry(0.018, 0.018, 0.68, 10), red, 0, 0.34, 0);
    part(handle, new THREE.TorusGeometry(0.1, 0.018, 8, 20), dark, 0, 0.72, 0);
  }

  // ---------- Toestand ----------
  let held = false;
  /** Een andere speler duwt hem. */
  let remoteHeld = false;
  let tilt = 0; // 0..1, loopt vloeiend naar wel/niet geduwd
  let up = false;
  let lift = 0; // 0..1, loopt vloeiend naar `up`
  let carried: Carried | null = null;
  let hint = '';

  const fork = new THREE.Vector3();
  function forkPoint() {
    return fork.set(g.position.x + Math.sin(g.rotation.y) * FORK_Z, 0, g.position.z + Math.cos(g.rotation.y) * FORK_Z);
  }

  /** Pallets op de vloer: los in de hal en op het onderste niveau van de stellingen. */
  function targets(): Target[] {
    return [
      ...hall.rackPallets().filter((p) => p.y < 0.5).map((p) => ({ x: p.x, z: p.z, rack: p })),
      ...loose.list().map((l) => ({ x: l.x, z: l.z, loose: l })),
    ];
  }

  function nearestTarget(maxDist: number) {
    const f = forkPoint();
    let best: Target | null = null;
    let bestD = maxDist;
    for (const t of targets()) {
      const d = Math.hypot(t.x - f.x, t.z - f.z);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  function attach(c: Carried) {
    carried = c;
    g.add(c.mesh);
    c.mesh.position.set(0, 0, FORK_Z);
    c.mesh.rotation.set(0, 0, 0);
  }

  function detach() {
    carried?.mesh.removeFromParent();
    carried = null;
  }

  /** Vrije plek op de vloer van een stelling, vlak bij de vorken. */
  function slotHere() {
    const f = forkPoint();
    const slot = hall.nearestFreeSlot(f.x, 0, f.z);
    return slot && Math.hypot(slot.x - f.x, slot.z - f.z) <= REACH + 0.1 ? slot : null;
  }

  /** Q: omhoog pompen (pakt de pallet boven de vorken op) of laten zakken (zet hem neer). */
  function pump() {
    if (!held) return;
    if (!up) {
      up = true;
      const t = nearestTarget(REACH);
      if (!t) return;
      if (t.loose) {
        attach(loose.take(t.loose));
        return;
      }
      const p = t.rack!;
      const load = take(p.id);
      if (!load) return;
      attach({ load, from: p.locId, key: load.id, mesh: hall.buildLoad(load.sku, load.qty, load.id, !load.unlabeled) });
      onStockChange();
      return;
    }
    if (carried) {
      const c = carried;
      const f = forkPoint();
      const slot = slotHere();
      if (slot) {
        detach();
        place(slot.locId, c.load, c.from, slot.index);
        onStockChange();
      } else if (hall.inRack(f.x, f.z)) {
        return; // in de stelling alleen op een vrije plek: de vorken blijven omhoog
      } else {
        detach();
        loose.drop(c, f.x, f.z, g.rotation.y);
      }
    }
    up = false;
  }

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    if (e.code === 'KeyQ' && !e.repeat) pump();
  });

  function updateHint() {
    const keys = '<b>Q</b>: vorken omhoog/omlaag · <b>R</b>: pompwagen loslaten';
    if (carried) {
      const what = `${carried.load.unlabeled ? 'pallet zonder sticker' : carried.load.id} · ${carried.load.qty}× ${carried.load.sku}`;
      const f = forkPoint();
      const slot = slotHere();
      hint = slot
        ? `Last: ${what} · <b>Q</b>: neerzetten op <b>${slot.locId}</b> · <b>R</b>: loslaten`
        : hall.inRack(f.x, f.z)
          ? `Last: ${what} · hier is geen vrije plek op de vloer van de stelling · <b>R</b>: loslaten`
          : `Last: ${what} · <b>Q</b>: hier op de vloer neerzetten, of rijd naar een vrije plek onderin een stelling · <b>R</b>: loslaten`;
      return;
    }
    if (up) {
      hint = `Pompwagen · vorken staan omhoog, laat ze eerst zakken · ${keys}`;
      return;
    }
    const t = nearestTarget(REACH);
    if (t) hint = `<b>Q</b>: pallet ${t.rack ? `van ${t.rack.locId}` : 'van de vloer'} optillen · <b>R</b>: loslaten`;
    else hint = `Pompwagen · schuif de vorken onder een pallet op de vloer · ${keys}`;
  }

  // ---------- Botsblokken voor spelers ----------
  const pose = { x: 0, z: 0, r: 0 };
  function solids(): Solid[] {
    pose.x = g.position.x;
    pose.z = g.position.z;
    pose.r = g.rotation.y;
    const y = lift * LIFT;
    const list: Solid[] = [
      { pose, minX: -0.3, maxX: 0.3, minZ: -0.46, maxZ: 0, minY: 0, maxY: 0.46 + y },
      { pose, minX: -0.31, maxX: 0.31, minZ: 0, maxZ: TIP_Z, minY: 0, maxY: 0.11 + y },
    ];
    if (carried) {
      const base = carried.mesh.position.y;
      list.push({ pose, minX: -0.6, maxX: 0.6, minZ: FORK_Z - 0.5, maxZ: FORK_Z + 0.5, minY: base, maxY: base + hall.loadHeight(carried.load.sku, carried.load.qty), pallet: true });
    }
    return list;
  }

  // ---------- Multiplayer ----------
  /** Doelstand als een andere speler de pompwagen heeft (of heeft neergezet). */
  let remote: { x: number; z: number; r: number } | null = null;

  function getState(): JackState {
    const t = remote ?? { x: g.position.x, z: g.position.z, r: g.rotation.y };
    return {
      x: round(t.x),
      z: round(t.z),
      r: round(t.r, 1000),
      up: up ? 1 : 0,
      load: carried ? { ...carried.load, from: carried.from, key: carried.key } : null,
      ...(held ? { h: 1 as const } : {}),
    };
  }

  function applyState(s: JackState) {
    remote = { x: s.x, z: s.z, r: s.r };
    up = s.up === 1;
    remoteHeld = s.h === 1;
    if ((carried?.load.id ?? '') !== (s.load?.id ?? '')) {
      detach();
      if (s.load) {
        const { from, key, ...load } = s.load;
        attach({ load, from, key, mesh: hall.buildLoad(load.sku, load.qty, key, !load.unlabeled) });
      }
    }
  }

  const angle = (to: number, from: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

  return {
    group: g,
    solids,
    /**
     * Voor wie hem duwt: de pompwagen (en de pallet erop) als cirkels voor de speler uit, zodat hij er nergens mee
     * doorheen rijdt. De vorken schuiven wel onder een pallet.
     */
    probes() {
      const list = [
        { ahead: GRIP - 0.22, radius: 0.32 },
        { ahead: GRIP + 0.35, radius: 0.3, underPallets: true },
        { ahead: GRIP + 0.8, radius: 0.3, underPallets: true },
      ];
      if (carried) list.push({ ahead: GRIP + FORK_Z, radius: 0.55, underPallets: false });
      return list;
    },
    getState,
    applyState,
    pump,
    /** Plek van de pols op de handgreep (wereld): side 1 = linkerhand, -1 = rechterhand van wie hem duwt. */
    grip(side: 1 | -1, point: THREE.Vector3) {
      g.updateMatrixWorld();
      return handle.localToWorld(point.set(side * HAND.x, HAND.y, HAND.z));
    },
    get held() {
      return held;
    },
    /** Hoe hoog (m) de vorken nu gepompt staan. */
    get lift() {
      return lift * LIFT;
    },
    get hint() {
      return hint;
    },
    /** Pakken (true) of loslaten (false); losgelaten blijft hij staan waar hij is. */
    setHeld(on: boolean) {
      held = on;
      if (on) {
        remote = null;
        remoteHeld = false;
      }
      hint = '';
    },
    /** Handig bij testen: zet de pompwagen ergens neer. */
    teleport(x: number, z: number, rotY: number) {
      g.position.set(x, 0, z);
      g.rotation.y = rotY;
      remote = null;
    },
    /**
     * Elke frame, nadat de speler bewogen heeft. Wie hem vasthoudt duwt hem voor zich uit; tegen een wand
     * houdt de pompwagen de speler tegen.
     */
    update(dt: number, player: THREE.Object3D) {
      const k = 1 - Math.exp(-dt * 12);
      if (held) {
        g.rotation.y += angle(player.rotation.y, g.rotation.y) * k;
        const dx = Math.sin(g.rotation.y);
        const dz = Math.cos(g.rotation.y);
        const p = player.position;
        const tipX = p.x + dx * (GRIP + TIP_Z);
        const tipZ = p.z + dz * (GRIP + TIP_Z);
        p.x += THREE.MathUtils.clamp(tipX, bounds.minX - 0.4, bounds.maxX + 0.4) - tipX;
        p.z += THREE.MathUtils.clamp(tipZ, bounds.minZ - 0.4, bounds.maxZ + 0.4) - tipZ;
        g.position.set(p.x + dx * GRIP, 0, p.z + dz * GRIP);
        updateHint();
      } else if (remote) {
        const far = Math.hypot(remote.x - g.position.x, remote.z - g.position.z) > 8;
        g.position.x += (remote.x - g.position.x) * (far ? 1 : k);
        g.position.z += (remote.z - g.position.z) * (far ? 1 : k);
        g.rotation.y += angle(remote.r, g.rotation.y) * (far ? 1 : k);
      }
      lift += ((up ? 1 : 0) - lift) * (1 - Math.exp(-dt * 9));
      forks.position.y = lift * LIFT;
      // dissel: gekanteld naar wie duwt, losgelaten veert hij terug rechtop
      tilt += ((held || remoteHeld ? 1 : 0) - tilt) * (1 - Math.exp(-dt * 10));
      handle.rotation.x = -tilt * TILT;
      // de pallet rust op de vorken zodra die de onderkant van het dek raken
      if (carried) carried.mesh.position.y = Math.max(0, lift * LIFT - 0.015);
    },
  };
}
