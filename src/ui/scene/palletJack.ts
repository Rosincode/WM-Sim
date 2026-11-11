import * as THREE from 'three';
import type { Carried, Load, Loose } from './forklift';
import { paint, type Hall, type RackPallet, type Solid } from './warehouse';

// Pompwagen (handpallettruck). Pakken met R: hij rolt dan voor je uit, de vorken wijzen van je af.
// Q pompt de vorken omhoog of laat ze zakken. Alleen voor pallets op de vloer: los in de hal of op
// het onderste niveau van een stelling. Hoger komt alleen de heftruck.

interface Options {
  hall: Hall;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Voorraadmutaties in de sim (dezelfde als van de heftruck). */
  take: (locId: string, maxQty: number) => Load | null;
  place: (locId: string, load: Load, fromLocId: string) => void;
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
};

const round = (n: number, f = 100) => Math.round(n * f) / f;
type Target = { x: number; z: number; rack?: RackPallet; loose?: Loose };

const FORK_Z = 0.5; // midden van de vorken, vanaf het hart van de pompwagen
const TIP_Z = 1.08; // punt van de vorken
const GRIP = 1.25; // afstand van de speler tot het hart van de pompwagen
const REACH = 0.45; // hoe nauwkeurig de vorken onder de pallet moeten zitten
const LIFT = 0.1; // zo ver komen de vorken omhoog

export function createPalletJack({ hall, bounds, take, place, onStockChange, loose }: Options) {
  const g = new THREE.Group();
  const red = paint('#d1401f', 0.45, 0.3);
  const dark = paint('#2b2e32', 0.5, 0.5);
  const part = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
  };
  // Vorken (gaan omhoog bij het pompen); laag genoeg om in de openingen van een pallet te schuiven
  const forks = new THREE.Group();
  for (const x of [-0.2, 0.2]) {
    part(forks, new THREE.BoxGeometry(0.16, 0.05, 1.18), red, x, 0.06, 0.49);
    part(g, new THREE.CylinderGeometry(0.035, 0.035, 0.1, 12), dark, x, 0.035, 0.95, 0, Math.PI / 2);
  }
  part(forks, new THREE.BoxGeometry(0.56, 0.36, 0.2), red, 0, 0.24, -0.2);
  g.add(forks);
  // Stuurwielen en dissel met handgreep
  part(g, new THREE.CylinderGeometry(0.09, 0.09, 0.16, 16), dark, 0, 0.09, -0.3, 0, Math.PI / 2);
  part(g, new THREE.CylinderGeometry(0.018, 0.018, 1.1, 10), dark, 0, 0.85, -0.52, -0.4);
  part(g, new THREE.TorusGeometry(0.09, 0.015, 8, 20), dark, 0, 1.38, -0.74, -0.4);

  // ---------- Toestand ----------
  let held = false;
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
      if (!p.last) return;
      const load = take(p.locId, p.qty);
      if (!load) return;
      const key = `${p.locId}:${p.index}`;
      attach({ load, from: p.locId, key, mesh: hall.buildLoad(load.sku, load.qty, key) });
      onStockChange();
      return;
    }
    if (carried) {
      const c = carried;
      const f = forkPoint();
      const slot = slotHere();
      if (slot) {
        detach();
        place(slot.locId, c.load, c.from);
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
      const what = `${carried.load.qty}× ${carried.load.sku}`;
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
    if (t?.rack && !t.rack.last) hint = `Pak eerst de buitenste pallet van ${t.rack.locId} (meest rechts) · <b>R</b>: loslaten`;
    else if (t) hint = `<b>Q</b>: pallet ${t.rack ? `van ${t.rack.locId}` : 'van de vloer'} optillen · <b>R</b>: loslaten`;
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
      { pose, minX: -0.28, maxX: 0.28, minZ: -0.3, maxZ: -0.1, minY: 0, maxY: 0.42 + y },
      { pose, minX: -0.28, maxX: 0.28, minZ: -0.1, maxZ: TIP_Z, minY: 0, maxY: 0.085 + y },
    ];
    if (carried) {
      const base = carried.mesh.position.y;
      list.push({ pose, minX: -0.6, maxX: 0.6, minZ: FORK_Z - 0.5, maxZ: FORK_Z + 0.5, minY: base, maxY: base + hall.loadHeight(carried.load.sku, carried.load.qty) });
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
    };
  }

  function applyState(s: JackState) {
    remote = { x: s.x, z: s.z, r: s.r };
    up = s.up === 1;
    if ((carried?.load.id ?? '') !== (s.load?.id ?? '')) {
      detach();
      if (s.load) {
        const { from, key, ...load } = s.load;
        attach({ load, from, key, mesh: hall.buildLoad(load.sku, load.qty, key) });
      }
    }
  }

  const angle = (to: number, from: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

  return {
    group: g,
    solids,
    getState,
    applyState,
    pump,
    /** Plek van de pols op de handgreep (wereld): side 1 = linkerhand, -1 = rechterhand van wie hem duwt. */
    grip(side: 1 | -1, point: THREE.Vector3) {
      g.updateMatrixWorld();
      return g.localToWorld(point.set(side * 0.12, 1.36, -0.8));
    },
    get held() {
      return held;
    },
    get hint() {
      return hint;
    },
    /** Pakken (true) of loslaten (false); losgelaten blijft hij staan waar hij is. */
    setHeld(on: boolean) {
      held = on;
      if (on) remote = null;
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
      // de pallet rust op de vorken zodra die de onderkant van het dek raken
      if (carried) carried.mesh.position.y = Math.max(0, lift * LIFT - 0.015);
    },
  };
}
