import * as THREE from 'three';
import { DOCKS, HALL, LANE_LENGTH, LANE_SLOTS, LEVEL_Y, POINTS, laneSlot, shelfLocations, type Point } from '../sim/layout';
import type { Truck, Warehouse } from '../sim/warehouse';
import { createPcMesh } from './scene/pc';

// 3D-weergave van de processtaat. Leest alleen de sim; wijzigt niets.

export const SKU_COLORS: Record<string, string> = {
  'SKU-001': '#4fc3f7',
  'SKU-002': '#81c784',
  'SKU-003': '#ffb74d',
  'SKU-004': '#e57373',
  'SKU-005': '#ba68c8',
};
const skuColor = (sku: string) => SKU_COLORS[sku] ?? '#a5784a';

function box(w: number, h: number, d: number, color: string) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function pallet(color = '#a5784a') {
  const g = new THREE.Group();
  const base = box(1, 0.12, 1, '#8d6e4a');
  base.position.y = 0.06;
  const load = box(0.9, 0.7, 0.9, color);
  load.position.y = 0.47;
  g.add(base, load);
  g.userData.load = load;
  return g;
}

function setPalletColor(g: THREE.Object3D, color: string) {
  ((g.userData.load as THREE.Mesh).material as THREE.MeshStandardMaterial).color.set(color);
}

/** Rolcontainer voor een orderpick. */
function tote() {
  const g = new THREE.Group();
  const cage = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 1.2, 0.7),
    new THREE.MeshStandardMaterial({ color: '#b0bec5', wireframe: true }),
  );
  cage.position.y = 0.7;
  const goods = box(0.7, 0.5, 0.6, '#ffcc80');
  goods.position.y = 0.35;
  g.add(cage, goods);
  return g;
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

function floorMark(p: Point, w: number, d: number, color: string) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.35 }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(p.x, 0.02, p.z);
  return m;
}

function truckMesh(direction: Truck['direction']) {
  const g = new THREE.Group();
  const trailer = box(8, 3, 2.5, direction === 'in' ? '#3b6ea5' : '#2e7d32');
  trailer.position.set(-4, 2, 0);
  const cab = box(2.2, 2.6, 2.4, '#eceff1');
  cab.position.set(-9.3, 1.6, 0);
  const window = box(0.05, 0.9, 2, '#263238');
  window.position.set(-10.42, 2.2, 0);
  g.add(trailer, cab, window);
  for (const x of [-1.5, -2.8, -8.8]) for (const z of [-1.1, 1.1]) {
    const wheel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.45, 0.3, 16),
      new THREE.MeshStandardMaterial({ color: '#111' }),
    );
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(x, 0.45, z);
    g.add(wheel);
  }
  g.visible = false;
  return g;
}

export function createWarehouseView(
  scene: THREE.Scene,
  player: THREE.Object3D,
  sim: Warehouse,
  opts: { rackStock?: boolean } = {},
) {
  const root = new THREE.Group();
  scene.add(root);

  // --- Vaste objecten: per dock een inslag- en uitslagbaan, en de pc (orderterminal + WMS-aanmelding) ---
  // (het buitenterrein staat in src/ui/scene/exterior.ts)
  for (const d of DOCKS) {
    root.add(floorMark(d.laneIn, LANE_LENGTH + 0.3, 1.5, '#4fc3f7'), floorMark(d.laneOut, LANE_LENGTH + 0.3, 1.5, '#81c784'));
  }
  const pc = createPcMesh();
  pc.group.position.set(POINTS.terminal.x, 0, POINTS.terminal.z);
  root.add(pc.group);

  // Lege rolcontainers: hier pak je er een voor de volgende order
  for (const dx of [-0.95, 0, 0.95]) {
    const t = tote();
    t.children[1].visible = false; // nog niets in
    t.position.set(POINTS.containers.x + dx, 0, POINTS.containers.z);
    root.add(t);
  }

  const labels = { containers: label(3.4), truckIn: label(4.5), truckOut: label(4.5) };
  labels.containers.sprite.position.set(POINTS.containers.x, 2.2, POINTS.containers.z);
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
  const trucks = { in: truckMesh('in'), out: truckMesh('out') };
  root.add(trucks.in, trucks.out);

  // --- Pallets en rolcontainers in de banen ---
  const laneInMeshes = DOCKS.map((d) =>
    Array.from({ length: LANE_SLOTS }, (_, i) => {
      const p = pallet();
      const s = laneSlot(d.laneIn, i);
      p.position.set(s.x, 0, s.z);
      p.visible = false;
      root.add(p);
      return p;
    }),
  );
  const laneOutMeshes = DOCKS.map((d) =>
    Array.from({ length: LANE_SLOTS }, (_, i) => {
      const t = tote();
      const s = laneSlot(d.laneOut, i);
      t.position.set(s.x, 0, s.z);
      t.visible = false;
      root.add(t);
      return t;
    }),
  );

  // --- Voorraad in de stellingen: één pallet per locatie, kleur per artikel ---
  const stockMeshes = new Map<string, THREE.Group>();
  for (const l of shelfLocations()) {
    const p = pallet();
    p.position.set(l.x, LEVEL_Y[l.level] + 0.04, l.z);
    p.visible = false;
    root.add(p);
    stockMeshes.set(l.id, p);
  }

  // --- Wat de speler draagt ---
  const carriedPallet = pallet();
  const carriedTote = tote();
  root.add(carriedPallet, carriedTote);

  // --- Doelmarkering ---
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 0.6, 6, 24, 1, true),
    new THREE.MeshBasicMaterial({ color: '#00e5ff', transparent: true, opacity: 0.15, side: THREE.DoubleSide, depthWrite: false }),
  );
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.7, 16), new THREE.MeshBasicMaterial({ color: '#00e5ff' }));
  arrow.rotation.x = Math.PI;
  root.add(beam, arrow);

  const forward = new THREE.Vector3();
  let time = 0;

  function placeTruck(mesh: THREE.Group, text: ReturnType<typeof label>, t: Truck | null) {
    mesh.visible = !!t;
    text.set(truckText(t));
    if (!t) return;
    const dock = DOCKS[t.dock];
    const eased = 1 - (1 - t.t) ** 2;
    mesh.position.set(-HALL.w / 2 - 0.4 - (1 - eased) * 34, 0, dock.z); // achterkant trailer tegen de dockdeur
    text.sprite.position.set(dock.truck.x + 1, 4.3, dock.z);
  }

  const truckText = (t: Truck | null) => {
    if (!t || t.status === 'arriving') return '';
    const status = {
      waiting: 'wacht op aanmelden',
      checkedIn: t.direction === 'in' ? `aangemeld · ${t.cargo.length} pallet(s)` : `aangemeld · ${t.loaded.length} ingeladen`,
      departing: 'vertrekt',
    }[t.status];
    return `${t.id} · ${status}`;
  };

  function update(dt: number) {
    time += dt;

    placeTruck(trucks.in, labels.truckIn, sim.trucks.in);
    placeTruck(trucks.out, labels.truckOut, sim.trucks.out);

    const open = sim.orders.filter((o) => o.status === 'open').length;
    labels.containers.set(open ? `Rolcontainers · ${open} order${open === 1 ? '' : 's'}` : '');

    const staging = sim.carry?.kind === 'order' && sim.order(sim.carry.orderId)?.status === 'picked';
    DOCKS.forEach((d, i) => {
      const inCount = sim.laneIn[i].filter(Boolean).length;
      const outCount = sim.laneOut[i].filter(Boolean).length;
      laneLabels[i].in.set(inCount ? `${d.inId} · ${inCount}/${LANE_SLOTS}` : '');
      laneLabels[i].out.set(outCount || (staging && i === sim.outDock) ? `${d.outId} · ${outCount}/${LANE_SLOTS}` : '');
      sim.laneIn[i].forEach((p, k) => {
        laneInMeshes[i][k].visible = !!p;
        if (p) setPalletColor(laneInMeshes[i][k], skuColor(p.sku));
      });
      sim.laneOut[i].forEach((id, k) => (laneOutMeshes[i][k].visible = !!id));
    });

    // Voorraad: per locatie de grootste voorraadregel tonen
    const top = new Map<string, { sku: string; qty: number }>();
    for (const s of sim.stockList()) {
      const cur = top.get(s.locationId);
      if (!cur || s.qty > cur.qty) top.set(s.locationId, s);
    }
    for (const [id, mesh] of stockMeshes) {
      const s = top.get(id);
      mesh.visible = !!s && opts.rackStock !== false;
      if (s) setPalletColor(mesh, skuColor(s.sku));
    }

    // Gedragen object voor de speler
    const c = sim.carry;
    forward.set(Math.sin(player.rotation.y), 0, Math.cos(player.rotation.y));
    const carried = c?.kind === 'pallet' ? carriedPallet : c?.kind === 'order' ? carriedTote : null;
    carriedPallet.visible = carried === carriedPallet;
    carriedTote.visible = carried === carriedTote;
    if (carried) {
      carried.position.copy(player.position).addScaledVector(forward, 0.9);
      carried.position.y += c?.kind === 'pallet' ? 0.25 : 0;
      carried.rotation.y = player.rotation.y;
      if (c?.kind === 'pallet') setPalletColor(carriedPallet, skuColor(c.pallet.sku));
    }

    // Doelmarkering
    // Zonder punt wijst de game niets aan: waar je heen moet staat dan in de WMS-app.
    const obj = sim.objective();
    const point = obj?.point;
    beam.visible = arrow.visible = !!point;
    if (obj && point) {
      beam.position.set(point.x, 3, point.z);
      const y = obj.level ? LEVEL_Y[obj.level] + 1.4 : 3;
      arrow.position.set(point.x, y + Math.sin(time * 3) * 0.15, point.z);
    }
  }

  return { update, pcDisplay: pc.screen };
}
