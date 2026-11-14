import * as THREE from 'three';
import { DOCKS, LANE_SLOTS, ORDER_PALLETS_ACTIVE, POINTS, laneSlot, type Point } from '../sim/layout';
import { TRUCK, cargoSpot } from '../sim/drivers';
import type { Truck, Warehouse } from '../sim/warehouse';
import { atGate, truckPoseOf } from '../sim/yard';
import { createPcMesh } from './scene/pc';
import { createTruck } from './scene/truck';
import type { Collider, Solid } from './scene/warehouse';

// 3D-weergave van de processtaat. Leest alleen de sim; wijzigt niets.
// Elke pallet is een echte pallet met dozen: precies zoveel als er volgens de sim op staan (in de vrachtwagen,
// op de banen, op een pompwagen en in je handen), net als in de stellingen. De hal bouwt ze (buildLoad en
// buildOrderLoad in src/ui/scene/warehouse.ts).

export const SKU_COLORS: Record<string, string> = {
  'SKU-001': '#4fc3f7',
  'SKU-002': '#81c784',
  'SKU-003': '#ffb74d',
  'SKU-004': '#e57373',
  'SKU-005': '#ba68c8',
};
/** Vaste kleur per artikel (voor lijsten in de HUD); artikelen die de WMS erbij heeft gekregen krijgen een eigen kleur op basis van hun code. */
export function skuColor(sku: string) {
  if (SKU_COLORS[sku]) return SKU_COLORS[sku];
  let h = 0;
  for (const ch of sku) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h}, 55%, 60%)`;
}

/** Tekstlabel dat altijd naar de camera kijkt; tekent alleen opnieuw als de tekst verandert. */
function label(width = 4) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.set(width, width * (96 / 512), 1);
  sprite.renderOrder = 10;
  let current = '';
  return {
    sprite,
    set(text: string) {
      sprite.visible = text !== '';
      if (text === current) return;
      current = text;
      ctx.clearRect(0, 0, 512, 96);
      ctx.fillStyle = 'rgba(0,0,0,.65)';
      ctx.beginPath();
      ctx.roundRect(4, 4, 504, 88, 16);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 38px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 256, 50, 480);
      texture.needsUpdate = true;
    },
  };
}

/** Haalt een losse lading (pallet met dozen) uit beeld en geeft zijn buffers vrij; de vormen en materialen zijn gedeeld. */
export function dropLoad(o: THREE.Object3D) {
  o.removeFromParent();
  o.traverse((c) => c instanceof THREE.InstancedMesh && c.dispose());
}

/** Bovenkant (m boven zijn voet) van een lading die de hal heeft gebouwd. */
export const loadTop = (o: THREE.Object3D) => (typeof o.userData.top === 'number' ? (o.userData.top as number) : 1);

/** Een pallet zoals de sim hem kent. */
export type PalletInfo = { id: string; sku: string; qty: number; unlabeled?: boolean };
/** Een pallet met zijn dozen in beeld: `key` verandert als er een andere pallet staat of het aantal anders is. */
export type PalletLoads = { key(p: PalletInfo): string; build(p: PalletInfo): THREE.Object3D };
/** Een orderpallet in beeld: `key` verandert als er een andere order staat of er iets bij gepickt is. */
export type OrderLoads = { key(orderId: string): string; build(orderId: string): THREE.Object3D };

/** Een plek waar een lading kan staan: houdt bij wat er nu staat en bouwt alleen opnieuw als dat verandert. */
function loadSlot() {
  let key = '';
  let mesh: THREE.Object3D | null = null;
  return {
    get mesh() {
      return mesh;
    },
    /** Zet neer wat bij `next` hoort ('' = niets). `place` krijgt de nieuwe lading om hem op zijn plek te zetten. */
    show(next: string, build: () => THREE.Object3D, place: (o: THREE.Object3D) => void) {
      if (next === key) return mesh;
      key = next;
      if (mesh) dropLoad(mesh);
      mesh = next ? build() : null;
      if (mesh) place(mesh);
      return mesh;
    },
  };
}

/** Een vrachtwagen met wat er in de laadruimte staat: de pallets die nog gelost moeten worden, of de geladen orders. */
function truckView(direction: Truck['direction']) {
  const truck = createTruck(direction);
  const cargo: ReturnType<typeof loadSlot>[] = [];
  return {
    mesh: truck.group,
    /** Buitenmaat van de wagen rond zijn nulpunt: daar loopt de speler buiten tegenaan. */
    size: new THREE.Box3().setFromObject(truck.group),
    setDoors: truck.setDoors,
    /** Zet op plek i in de laadruimte de lading die bij `key` hoort, of haalt hem weg (''). */
    cargoAt(i: number, key: string, build: () => THREE.Object3D) {
      (cargo[i] ??= loadSlot()).show(key, build, (o) => {
        const spot = cargoSpot(0, i);
        o.position.set(spot.x - TRUCK.rear, TRUCK.floor, spot.z);
        // Geen schaduw: anders moet de schaduwkaart elke frame opnieuw voor een rijdende wagen
        o.traverse((c) => (c.castShadow = false));
        truck.group.add(o);
      });
    },
    slots: () => cargo.length,
  };
}
type TruckView = ReturnType<typeof truckView>;

export function createWarehouseView(
  scene: THREE.Scene,
  player: THREE.Object3D,
  sim: Warehouse,
  opts: {
    /** Bouwt een pallet met precies `qty` dozen van een artikel (de hal, src/ui/scene/warehouse.ts). */
    palletLoad: (sku: string, qty: number, key: string, sticker: boolean) => THREE.Object3D;
    /** Bouwt de pallet van een order: van elk artikel het aantal dozen (de hal). */
    orderLoad: (lines: { sku: string; qty: number }[], key: string) => THREE.Object3D;
  },
) {
  const root = new THREE.Group();
  scene.add(root);

  // --- Pallets met hun dozen: wat er volgens de sim op staat ---
  const palletLoads: PalletLoads = {
    key: (p) => `${p.id}|${p.sku}|${p.qty}|${p.unlabeled ? 0 : 1}`,
    build: (p) => opts.palletLoad(p.sku, p.qty, p.id, !p.unlabeled),
  };
  // --- Orderpallets: wat er voor een order gepickt is, op een pallet zoals in de stelling ---
  const orderLines = (id: string) => (sim.order(id)?.lines ?? []).map((l) => ({ sku: l.sku, qty: l.picked }));
  const orderLoads: OrderLoads = {
    key: (id) => `${id}|${orderLines(id).map((l) => `${l.sku}:${l.qty}`).join(',')}`,
    build: (id) => opts.orderLoad(orderLines(id), id),
  };

  // --- Vaste objecten: de pc (orderterminal + WMS-aanmelding) ---
  // De inslag- en uitslagbanen zijn alleen vloerverf (omlijning en tekst, src/ui/scene/warehouse.ts): geen gekleurd
  // vlak dat oplicht. Het buitenterrein staat in src/ui/scene/exterior.ts.
  const pc = createPcMesh();
  pc.group.position.set(POINTS.terminal.x, 0, POINTS.terminal.z);
  root.add(pc.group);

  // De stapels lege pallets tekent de hal zelf (setEmptyPallets in src/ui/scene/warehouse.ts); hier alleen het
  // label boven de stapel waar je er een pakt voor de volgende order
  const stackAt = POINTS.orderPallets;

  // Waar je tegenaan loopt (en de heftruck tegenaan rijdt): het bureau
  const box = (x: number, z: number, w: number, d: number, maxY: number): Solid => ({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, minY: 0, maxY });
  const fixedSolids: Solid[] = [box(POINTS.terminal.x, POINTS.terminal.z, 1.5, 0.75, 1.0)];
  const colliders: Collider[] = fixedSolids.map(({ minX, maxX, minZ, maxZ }) => ({ minX, maxX, minZ, maxZ }));

  const labels = { stack: label(3.4), truckIn: label(4.5), truckOut: label(4.5) };
  labels.stack.sprite.position.set(stackAt.x, 2.7, stackAt.z);
  Object.values(labels).forEach((l) => root.add(l.sprite));
  // Baanlabels verschijnen alleen als er iets staat (of als je er een order moet klaarzetten).
  const laneLabels = DOCKS.map((d) => {
    const pair = { in: label(3.4), out: label(3.4) };
    pair.in.sprite.position.set(d.laneIn.x, 2.1, d.laneIn.z);
    pair.out.sprite.position.set(d.laneOut.x, 2.1, d.laneOut.z);
    root.add(pair.in.sprite, pair.out.sprite);
    return pair;
  });

  // --- Vrachtwagens ---
  const trucks = { in: truckView('in'), out: truckView('out') };
  root.add(trucks.in.mesh, trucks.out.mesh);
  /**
   * Leveringen die de WMS heeft aangemeld, op het nummer van de wagen: pas gemaakt als er een komt. Er kunnen er
   * twee voor hetzelfde dock zijn (de tweede wacht op het terrein). Een wagen die weg is gaat terug in de voorraad.
   */
  type DeliveryTruck = { truck: TruckView; text: ReturnType<typeof label> };
  const deliveryTrucks = new Map<string, DeliveryTruck>();
  const spareTrucks: DeliveryTruck[] = [];

  // --- Pallets in de banen: op de inslagbaan wat gelost is, op de uitslagbaan de klaargezette orders ---
  const lanes = DOCKS.map(() => ({
    in: Array.from({ length: LANE_SLOTS }, loadSlot),
    out: Array.from({ length: LANE_SLOTS }, loadSlot),
  }));

  // --- Wat de speler draagt: de pallet zelf, vlak boven de vloer voor hem uit ---
  const carried = loadSlot();

  // Een opdracht licht niet op in de hal (geen lichtbundel of pijl): wat je moet doen staat in het taakvenster.

  const forward = new THREE.Vector3();
  /** Staat er een vrachtwagen bij de slagboom van het terrein, en hoe ver die open is (0..1). */
  let gateWanted = false;
  let gate = 0;

  function placeTruck(view: TruckView, text: ReturnType<typeof label>, t: Truck | null) {
    view.mesh.visible = !!t;
    text.set(truckText(t));
    if (!t) return;
    const dock = DOCKS[t.dock];
    // Over de weg het terrein op, steken en achteruit tegen de dockdeur (de route staat in src/sim/yard.ts);
    // de achterdeuren gaan open voordat hij het dock in rijdt
    // (een wagen die te vroeg is, of waarvan het dock nog bezet is, staat eerst op een wachtplaats)
    const pose = truckPoseOf(t);
    view.mesh.position.set(pose.x, 0, pose.z);
    view.mesh.rotation.y = pose.r;
    view.setDoors(pose.doors);
    if (atGate(pose)) gateWanted = true;
    // Wat er in de laadruimte staat: de pallets die nog gelost moeten worden, of de orders die al geladen zijn
    const n = Math.max(view.slots(), t.cargo.length, t.loaded.length);
    for (let i = 0; i < n; i++) {
      const p = t.direction === 'in' ? t.cargo[i] : undefined;
      const id = t.direction === 'out' ? t.loaded[i] : undefined;
      if (p) view.cargoAt(i, palletLoads.key(p), () => palletLoads.build(p));
      else view.cargoAt(i, id ? orderLoads.key(id) : '', () => orderLoads.build(id!));
    }
    // het label hangt boven de achterkant van de wagen (aan het dock: boven de dockdeur) en rijdt mee
    const back = dock.truck.x + 1 - TRUCK.rear;
    text.sprite.position.set(pose.x + Math.cos(pose.r) * back, 4.3, pose.z - Math.sin(pose.r) * back);
  }

  const truckText = (t: Truck | null) => {
    if (!t || t.status === 'arriving' || t.status === 'parking') return '';
    if (t.status === 'parked') {
      if (t.go) return `${t.id} · mag naar ${t.dockId}`;
      const left = Math.ceil(t.wait ?? 0);
      if (left <= 0) return `${t.id} · wacht tot ${t.dockId} vrij is`;
      return `${t.id} · te vroeg voor ${t.dockId} · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    }
    const status = {
      waiting: 'wacht op aanmelden',
      checkedIn: t.direction === 'in' ? `aangemeld · ${t.cargo.length} pallet(s)` : `aangemeld · ${t.loaded.length} ingeladen`,
      departing: 'vertrekt',
    }[t.status];
    return `${t.id} · ${status}`;
  };

  /** Bouwt wat iemand draagt uit de omschrijving van carryLabel() (ook voor andere spelers), of null. */
  function carryMesh(text: string): THREE.Object3D | null {
    const [kind, a, b, c, d] = text.split('|');
    if (kind === 'O' && a) return orderLoads.build(a);
    if (kind === 'P' && a && c) return palletLoads.build({ sku: a, qty: Number(b) || 0, id: c, unlabeled: d === '0' });
    return null;
  }
  /** Wat de speler draagt, als tekst die bij elke speler dezelfde lading oplevert ('' = niets). */
  function carryLabel() {
    const c = sim.carry;
    if (c?.kind === 'pallet') return `P|${c.pallet.sku}|${c.pallet.qty}|${c.pallet.id}|${c.pallet.unlabeled ? 0 : 1}`;
    if (c?.kind === 'order') return `O|${orderLoads.key(c.orderId)}`;
    return '';
  }

  function update(dt: number) {
    gateWanted = false;

    placeTruck(trucks.in, labels.truckIn, sim.trucks.in);
    placeTruck(trucks.out, labels.truckOut, sim.trucks.out);
    for (const t of sim.deliveries) {
      if (deliveryTrucks.has(t.id)) continue;
      let made = spareTrucks.pop();
      if (!made) {
        made = { truck: truckView('in'), text: label(4.5) };
        root.add(made.truck.mesh, made.text.sprite);
      }
      deliveryTrucks.set(t.id, made);
    }
    for (const [id, v] of deliveryTrucks) {
      const t = sim.deliveries.find((x) => x.id === id) ?? null;
      placeTruck(v.truck, v.text, t);
      if (t) continue;
      deliveryTrucks.delete(id);
      spareTrucks.push(v);
    }

    gate = THREE.MathUtils.clamp(gate + (gateWanted ? dt : -dt) / 1.2, 0, 1);

    const open = sim.orders.filter((o) => o.status === 'open').length;
    labels.stack.set(ORDER_PALLETS_ACTIVE && open ? `Lege pallets · ${open} order${open === 1 ? '' : 's'}` : '');

    const staging = sim.carry?.kind === 'order' && sim.order(sim.carry.orderId)?.status === 'picked';
    DOCKS.forEach((d, i) => {
      const inCount = sim.laneIn[i].filter(Boolean).length;
      const outCount = sim.laneOut[i].filter(Boolean).length;
      laneLabels[i].in.set(inCount ? `${d.inId} · ${inCount}/${LANE_SLOTS}` : '');
      laneLabels[i].out.set(outCount || (staging && i === sim.outDock) ? `${d.outId} · ${outCount}/${LANE_SLOTS}` : '');
      const put = (lane: Point, k: number) => (o: THREE.Object3D) => {
        const s = laneSlot(lane, k);
        o.position.set(s.x, 0, s.z);
        root.add(o);
      };
      sim.laneIn[i].forEach((p, k) => lanes[i]?.in[k]?.show(p ? palletLoads.key(p) : '', () => palletLoads.build(p!), put(d.laneIn, k)));
      sim.laneOut[i].forEach((id, k) => lanes[i]?.out[k]?.show(id ? orderLoads.key(id) : '', () => orderLoads.build(id!), put(d.laneOut, k)));
    });

    // Wat de speler draagt: voor hem uit, de korte kant van de pallet naar hem toe
    const mesh = carried.show(carryLabel(), () => carryMesh(carryLabel()) ?? new THREE.Group(), (o) => {
      o.traverse((c) => (c.castShadow = false)); // loopt mee: geen schaduw (zie de vrachtwagen)
      root.add(o);
    });
    if (mesh) {
      forward.set(Math.sin(player.rotation.y), 0, Math.cos(player.rotation.y));
      mesh.position.copy(player.position).addScaledVector(forward, CARRY_AHEAD);
      mesh.position.y += 0.03;
      mesh.rotation.y = player.rotation.y;
    }
  }

  /** Waar de speler tegenaan loopt: het bureau en elke pallet die op een baan staat. */
  function solids(): Solid[] {
    const out = [...fixedSolids];
    DOCKS.forEach((d, i) => {
      for (const [slots, lane] of [[lanes[i].in, d.laneIn], [lanes[i].out, d.laneOut]] as const)
        slots.forEach((slot, k) => {
          if (!slot.mesh) return;
          const s = laneSlot(lane, k);
          out.push({ minX: s.x - 0.6, maxX: s.x + 0.6, minZ: s.z - 0.5, maxZ: s.z + 0.5, minY: 0, maxY: loadTop(slot.mesh), pallet: true });
        });
    });
    return out;
  }

  /** Waar de speler buiten tegenaan loopt: de vrachtwagens op het terrein. */
  function truckSolids(): Solid[] {
    return [trucks.in, trucks.out, ...[...deliveryTrucks.values()].map((v) => v.truck)]
      .filter((t) => t.mesh.visible)
      .map(({ mesh, size }) => ({
        // in het eigen assenstelsel van de wagen: hij botst ook goed als hij gedraaid op het terrein staat
        pose: { x: mesh.position.x, z: mesh.position.z, r: mesh.rotation.y },
        minX: size.min.x, maxX: size.max.x, minZ: size.min.z, maxZ: size.max.z, minY: 0, maxY: size.max.y,
      }));
  }

  return { update, gateOpen: () => gate, pcDisplay: pc.screen, palletLoads, orderLoads, solids, truckSolids, colliders, carryLabel, carryMesh };
}

/** Zo ver (m) voor de speler staat het midden van de pallet die hij draagt, en de halve maat van die pallet. */
export const CARRY_AHEAD = 1.1;
export const CARRY_RADIUS = 0.6;
