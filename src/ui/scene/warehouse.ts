import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Item } from '../../shared/contract';
import { DOCKS, HALL as FLOOR, LANE_LENGTH, ROW_Z, SECTION_X as BAY_X } from '../../sim/layout';
import * as tex from './textures';

// Het magazijngebouw: vloer, wanden, dak, docks, stellingen, pallets en verlichting.
// Alleen weergave: de voorraad komt binnen via setStock().

// Plattegrond (maten, docks, stellingrijen) komt uit src/sim/layout.ts.
export const HALL = { ...FLOOR, h: 8.5 };
const LEVEL_Y = [0, 2, 4];
/** Stellingstaanders: tussen de secties en aan beide koppen. */
const FRAME_X = [...BAY_X.map((x) => x - 2), BAY_X[BAY_X.length - 1] + 2];
const RACK_MIN_X = FRAME_X[0];
const RACK_MAX_X = FRAME_X[FRAME_X.length - 1];
const RACK_MID_X = (RACK_MIN_X + RACK_MAX_X) / 2;
const RACK_LEN = RACK_MAX_X - RACK_MIN_X;
const PALLET_H = 0.144;
/** Personeelsdeur / nooduitgang in de zuidgevel (ook de entree aan de buitenkant). */
export const EXIT_X = 20.5;

export type Collider = { minX: number; maxX: number; minZ: number; maxZ: number };
/**
 * Massief blok waar de speler tegenaan loopt, op kan staan of onderdoor kan lopen.
 * Met `pose` staan de maten in het eigen assenstelsel van een (bewegend) voorwerp, zoals de heftruck.
 */
export type Solid = {
  minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number;
  pose?: { x: number; z: number; r: number };
  /** Beweegt mee met de vorken van de heftruck. */
  lift?: boolean;
};
export type ScanTarget = { code: string; position: THREE.Vector3 };
/** Een pallet zoals hij nu in de stelling staat. `last` = de buitenste van zijn locatie (die pak je als eerste). */
export type RackPallet = { locId: string; index: number; last: boolean; x: number; y: number; z: number; qty: number; sku: string; /** Bovenkant van de lading. */ top: number };
export type Slot = { locId: string; x: number; y: number; z: number };

export const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
export const UNIT_CYL = new THREE.CylinderGeometry(1, 1, 1, 20);

/** Verzamelt transformaties en bouwt er één InstancedMesh van (weinig draw calls). */
export class Batch {
  private matrices: THREE.Matrix4[] = [];
  private static q = new THREE.Quaternion();
  private static e = new THREE.Euler();

  add(x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) {
    Batch.q.setFromEuler(Batch.e.set(rx, ry, rz));
    this.matrices.push(
      new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), Batch.q, new THREE.Vector3(sx, sy, sz)),
    );
    return this;
  }

  build(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], shadows = true) {
    const mesh = new THREE.InstancedMesh(geometry, material, this.matrices.length);
    this.matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    return mesh;
  }
}

export const paint = (color: string, roughness = 0.5, metalness = 0.15) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });

function glow(r: number, g: number, b: number) {
  const m = new THREE.MeshBasicMaterial();
  m.color.setRGB(r, g, b);
  return m;
}

function palletGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const b = (w: number, h: number, d: number, x: number, y: number, z: number) =>
    parts.push(new THREE.BoxGeometry(w, h, d).translate(x, y, z));
  for (const z of [-0.4275, -0.214, 0, 0.214, 0.4275]) b(1.2, 0.022, 0.145, 0, 0.133, z); // dekplanken
  for (const x of [-0.5275, 0, 0.5275]) {
    b(0.145, 0.022, 1.0, x, 0.111, 0); // dwarsplanken
    for (const z of [-0.4275, 0, 0.4275]) b(0.145, 0.078, 0.145, x, 0.061, z); // klossen
  }
  for (const z of [-0.45, 0, 0.45]) b(1.2, 0.022, 0.1, 0, 0.011, z); // bodemplanken
  return mergeGeometries(parts);
}

export function createWarehouse(scene: THREE.Scene) {
  const { w: W, d: D, h: H } = HALL;
  const colliders: Collider[] = []; // voor de heftruck: die rijdt nergens onderdoor
  const fixedSolids: Solid[] = []; // voor de speler: met hoogte, zie Solid
  const solid = (x: number, z: number, w: number, d: number, minY: number, maxY: number) =>
    fixedSolids.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, minY, maxY });
  const scanTargets: ScanTarget[] = [];
  const roof = new THREE.Group(); // verborgen in overzicht-modus
  scene.add(roof);

  // ---------- Materialen ----------
  const steelBlue = paint('#1e4f9c', 0.45, 0.25);
  const steelOrange = paint('#e2601a', 0.45, 0.2);
  const steelGrey = paint('#8b9399', 0.55, 0.45);
  const darkMetal = paint('#2b2e32', 0.5, 0.5);
  const safetyYellow = paint('#f0c20a', 0.5, 0.1);
  const red = paint('#c8231c', 0.4, 0.2);
  const hazardTex = tex.hazardStripes();
  const hazard = new THREE.MeshStandardMaterial({ map: hazardTex, roughness: 0.6 });
  const woodMat = new THREE.MeshStandardMaterial({ map: tex.wood(), roughness: 0.85 });
  const box = tex.cardboard();
  const cartonSide = new THREE.MeshStandardMaterial({ map: box.side, roughness: 0.82 });
  const cartonTop = new THREE.MeshStandardMaterial({ map: box.top, roughness: 0.7 });
  const cartonMats = [cartonSide, cartonSide, cartonTop, cartonTop, cartonSide, cartonSide];
  const wrapMat = new THREE.MeshStandardMaterial({
    color: '#eef4f8',
    roughness: 0.12,
    metalness: 0,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });

  // ---------- Vloer ----------
  const floorTex = tex.concreteFloor();
  floorTex.map.repeat.set(W / 10, D / 10);
  floorTex.roughnessMap.repeat.set(W / 7, D / 7);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshStandardMaterial({ map: floorTex.map, roughnessMap: floorTex.roughnessMap, roughness: 1, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Vloermarkering (versleten verf)
  const wornAlpha = tex.wornPaintAlpha();
  const paintMats = new Map<string, THREE.MeshStandardMaterial>();
  // Alle vlakken met hetzelfde materiaal gaan samen in één mesh (zie verderop): ruim honderd losse
  // vlakjes zouden anders elk een eigen tekenopdracht zijn.
  const paintGeos = new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>();
  let paintLayer = 0;
  /** @param turn draaiing om de verticale as (rad), voor tekst en pictogrammen. */
  function marking(x: number, z: number, w: number, d: number, color: string, map?: THREE.Texture, turn = 0) {
    const key = color + (map ? map.id : '');
    let mat = paintMats.get(key);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        color,
        map: map ?? null,
        alphaMap: map ? null : wornAlpha,
        transparent: true,
        roughness: 0.55,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });
      paintMats.set(key, mat);
    }
    const geo = new THREE.PlaneGeometry(w, d);
    if (!map) {
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / 2) + x * 0.37, uv.getY(i) * (d / 2) + z * 0.37);
    }
    geo.rotateZ(turn).rotateX(-Math.PI / 2).translate(x, 0.003 + (paintLayer++ % 5) * 0.0004, z);
    const list = paintGeos.get(mat) ?? [];
    list.push(geo);
    paintGeos.set(mat, list);
  }
  const YELLOW = '#e3b505';
  for (const z of ROW_Z) {
    marking(RACK_MID_X, z - 0.85, RACK_LEN + 1.4, 0.1, YELLOW);
    marking(RACK_MID_X, z + 0.85, RACK_LEN + 1.4, 0.1, YELLOW);
  }
  // Looppad tussen de dockzone en de stellingen
  const WALK_X = RACK_MIN_X - 4.8;
  marking(WALK_X, 0, 1.4, D - 4, '#2f7a4c');
  marking(WALK_X - 0.75, 0, 0.1, D - 4, '#e9e9e2');
  marking(WALK_X + 0.75, 0, 0.1, D - 4, '#e9e9e2');
  const walkIcon = tex.walkwayIcon();
  for (const z of [-20, -10, 0, 10, 20]) marking(WALK_X, z, 0.9, 0.9, '#ffffff', walkIcon, Math.PI / 2);
  // Per dock: een inslagbaan (blauw) en een uitslagbaan (groen), met de locatiecode op de vloer
  for (const d of DOCKS) {
    const lanes = [
      { p: d.laneIn, code: d.inId, color: '#2e8bd8' },
      { p: d.laneOut, code: d.outId, color: '#3a9a5c' },
    ];
    for (const { p, code, color } of lanes) {
      const len = LANE_LENGTH + 0.3;
      marking(p.x, p.z - 0.75, len, 0.1, color);
      marking(p.x, p.z + 0.75, len, 0.1, color);
      marking(p.x - len / 2, p.z, 0.1, 1.6, color);
      marking(p.x + len / 2, p.z, 0.1, 1.6, color);
      // leesbaar als je vanaf de stellingen naar het dock loopt
      marking(p.x + len / 2 + 0.4, p.z, 1.8, 0.45, color, tex.floorText(code.replace('DOCK-', '')), Math.PI / 2);
    }
  }
  for (const [mat, geos] of paintGeos) {
    const m = new THREE.Mesh(mergeGeometries(geos), mat);
    m.receiveShadow = true;
    m.renderOrder = -1; // vloerverf ligt onder alle andere doorzichtige dingen (folie, markeringen)
    scene.add(m);
  }

  // ---------- Wanden ----------
  const panelTex = tex.wallPanel();
  function wall(x: number, z: number, ry: number, len: number) {
    const t = panelTex.clone();
    t.repeat.set(len, 1);
    t.needsUpdate = true;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(len, H),
      new THREE.MeshStandardMaterial({ map: t, roughness: 0.55, metalness: 0.25 }),
    );
    m.position.set(x, H / 2, z);
    m.rotation.y = ry;
    m.receiveShadow = true;
    scene.add(m);
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(len, 1.2, 0.1), paint('#9a9b96', 0.9, 0));
    plinth.position.set(x, 0.6, z);
    plinth.rotation.y = ry;
    plinth.receiveShadow = true;
    scene.add(plinth);
  }
  wall(0, -D / 2, 0, W);
  wall(0, D / 2, Math.PI, W);
  wall(-W / 2, 0, Math.PI / 2, D);
  wall(W / 2, 0, -Math.PI / 2, D);

  // Kolommen met aanrijbescherming
  const columns = new Batch();
  const columnWraps = new Batch();
  const columnSpots: [number, number][] = [];
  for (let x = -W / 2; x <= W / 2; x += 7) columnSpots.push([x, -D / 2 + 0.17], [x, D / 2 - 0.17]);
  for (const z of ROW_Z) columnSpots.push([-W / 2 + 0.17, z], [W / 2 - 0.17, z]); // tussen de dockdeuren
  for (const [x, z] of columnSpots) {
    columns.add(x, H / 2, z, 0.26, H, 0.26);
    columnWraps.add(x, 0.6, z, 0.3, 1.2, 0.3);
  }
  scene.add(columns.build(UNIT_BOX, steelGrey), columnWraps.build(UNIT_BOX, hazard));

  // ---------- Dak ----------
  const deckTex = tex.roofDeck();
  deckTex.repeat.set(W, 1);
  const deck = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshStandardMaterial({ map: deckTex, roughness: 0.6, metalness: 0.4 }),
  );
  deck.rotation.x = Math.PI / 2;
  deck.position.y = H;
  roof.add(deck);

  const rafters = new Batch();
  for (let x = -W / 2; x <= W / 2; x += 7) rafters.add(x, H - 0.3, 0, 0.2, 0.6, D);
  for (let z = -D / 2 + 1; z <= D / 2 - 1; z += 2.7) rafters.add(0, H - 0.08, z, W, 0.16, 0.08);
  roof.add(rafters.build(UNIT_BOX, steelGrey, false));

  const skylightMat = glow(1.7, 1.95, 2.3);
  const LIGHT_X = [-21, -7, 7, 21];
  for (const x of [-17.5, -3.5, 10.5, 24.5])
    for (const z of [-21, -7, 7, 21]) {
      const s = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 7), skylightMat);
      s.rotation.x = Math.PI / 2;
      s.position.set(x, H - 0.01, z);
      roof.add(s);
    }

  // Sprinklerleidingen
  const pipes = new Batch();
  pipes.add(W / 2 - 2, H - 0.85, 0, 0.06, D - 0.6, 0.06, Math.PI / 2, 0, 0);
  for (const z of ROW_Z) pipes.add(-1, H - 0.8, z, 0.03, W - 2.4, 0.03, 0, 0, Math.PI / 2);
  roof.add(pipes.build(UNIT_CYL, red, false));

  // High-bay ledarmaturen
  const housings = new Batch();
  const lamps = new Batch();
  const wires = new Batch();
  const LAMP_Y = 7;
  for (const x of LIGHT_X)
    for (const { z } of DOCKS) { // boven elk gangpad
      housings.add(x, LAMP_Y, z, 1.25, 0.07, 0.32);
      lamps.add(x, LAMP_Y - 0.04, z, 1.15, 0.012, 0.24);
      for (const dx of [-0.5, 0.5]) wires.add(x + dx, (H + LAMP_Y) / 2, z, 0.008, H - LAMP_Y, 0.008);
    }
  roof.add(
    housings.build(UNIT_BOX, darkMetal, false),
    lamps.build(UNIT_BOX, glow(5, 5, 4.7), false),
    wires.build(UNIT_BOX, darkMetal, false),
  );

  // ---------- Licht ----------
  scene.add(new THREE.HemisphereLight('#eef3ff', '#77746e', 0.34));
  const key = new THREE.DirectionalLight('#fff6ea', 1.05);
  key.position.set(8, 60, 10);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  Object.assign(key.shadow.camera, { left: -62, right: 62, top: 62, bottom: -62, near: 5, far: 130 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  key.shadow.radius = 4;
  scene.add(key);
  for (const x of [-18, 0, 18])
    for (const z of [-21, -7, 7, 21]) {
      const p = new THREE.PointLight('#fff4e2', 46, 28, 2);
      p.position.set(x, LAMP_Y - 0.4, z);
      scene.add(p);
    }

  // ---------- Docks ----------
  const doorMat = paint('#c3c8cc', 0.5, 0.35);
  const windowMat = glow(2.4, 2.8, 3.3);
  const leveller = new THREE.MeshStandardMaterial({ map: tex.treadPlate(), roughness: 0.45, metalness: 0.75 });
  const dockParts = new Batch();
  const dockHazard = new Batch();
  const bollards = new Batch();
  DOCKS.forEach(({ z, inId, outId }, i) => {
    const x0 = -W / 2;
    for (let s = 0; s < 4; s++) dockParts.add(x0 + 0.09, 0.44 + s * 0.875, z, 0.05, 0.86, 3.0);
    for (const dz of [-0.9, 0, 0.9]) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.28), windowMat);
      win.rotation.y = Math.PI / 2;
      win.position.set(x0 + 0.12, 2.2, z + dz);
      scene.add(win);
    }
    for (const dz of [-1.6, 1.6]) dockHazard.add(x0 + 0.12, 1.8, z + dz, 0.14, 3.6, 0.14);
    dockHazard.add(x0 + 0.12, 3.67, z, 0.14, 0.14, 3.34);
    for (const dz of [-2.0, 2.0]) bollards.add(x0 + 0.8, 0.5, z + dz, 0.08, 1, 0.08);

    const plate = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.6), leveller);
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(x0 + 1.3, 0.006, z);
    plate.receiveShadow = true;
    scene.add(plate);

    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 0.75),
      new THREE.MeshStandardMaterial({ map: tex.sign(`DOCK ${i + 1}`, '#17346b', '#ffffff'), roughness: 0.5 }),
    );
    board.rotation.y = Math.PI / 2;
    board.position.set(x0 + 0.06, 4.35, z);
    scene.add(board);

    // Scanlabels op de deurstijlen: links de inslaglocatie, rechts de uitslaglocatie
    for (const [id, dz] of [[inId, -1.6], [outId, 1.6]] as const) {
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(0.4, 0.15),
        new THREE.MeshStandardMaterial({ map: tex.locationLabel(id, 'down', 0.5), roughness: 0.6 }),
      );
      label.rotation.y = Math.PI / 2;
      label.position.set(x0 + 0.195, 1.5, z + dz);
      scene.add(label);
      scanTargets.push({ code: id, position: label.position.clone() });
    }

    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), glow(0.3, 3.2, 0.6));
    lamp.position.set(x0 + 0.2, 2.6, z - 1.6);
    // de deur zelf is dicht: je loopt er niet doorheen
    scene.add(lamp);
  });
  scene.add(
    dockParts.build(UNIT_BOX, doorMat),
    dockHazard.build(UNIT_BOX, hazard),
    bollards.build(UNIT_CYL, safetyYellow),
  );

  // ---------- Stellingen ----------
  const posts = new Batch();
  const braces = new Batch();
  const beams = new Batch();
  const guards = new Batch();
  const endGuards = new Batch();
  const decks = new Batch();
  const POST_H = 5.6;
  const signGeo = new THREE.PlaneGeometry(0.7, 0.35);
  // Locatielabels: honderden stuks, daarom samen in één mesh met één textuur (zie tex.locationLabelAtlas).
  const rackLabels: { id: string; arrow: 'up' | 'down' }[] = [];
  const rackLabelSpots: { index: number; position: THREE.Vector3; back: boolean }[] = [];

  ROW_Z.forEach((z0, r) => {
    for (const fx of FRAME_X) {
      for (const dz of [-0.5, 0.5]) {
        posts.add(fx, POST_H / 2, z0 + dz, 0.09, POST_H, 0.07);
        guards.add(fx, 0.2, z0 + dz * 1.16, 0.16, 0.4, 0.05);
      }
      for (let y = 0.3, k = 0; y < POST_H; y += 1.6, k++) {
        braces.add(fx, y, z0, 0.035, 0.035, 0.94);
        if (y + 1.6 < POST_H) braces.add(fx, y + 0.8, z0, 0.035, 0.035, 1.84, (k % 2 ? 1 : -1) * Math.atan2(1.6, 0.94), 0, 0);
      }
      solid(fx, z0, 0.09, 1.07, 0, POST_H); // staanders met schoren: daar kun je niet tussendoor
    }
    BAY_X.forEach((bx, s) => {
      for (const y of [LEVEL_Y[1], LEVEL_Y[2]]) {
        for (const dz of [-0.5, 0.5]) beams.add(bx, y - 0.065, z0 + dz, 3.91, 0.13, 0.05);
        decks.add(bx, y + 0.004, z0, 3.9, 0.006, 0.95);
        solid(bx, z0, 3.91, 1.05, y - 0.13, y + 0.007); // liggers met roosterdek: je loopt eronderdoor of staat erop
      }
      const base = `R${r + 1}-${String(s + 1).padStart(2, '0')}`;
      const spots: [string, number, number, 'up' | 'down'][] = [
        [`${base}-1`, bx - 0.3, LEVEL_Y[1] - 0.065, 'down'],
        [`${base}-2`, bx + 0.3, LEVEL_Y[1] - 0.065, 'up'],
        [`${base}-3`, bx, LEVEL_Y[2] - 0.065, 'up'],
      ];
      for (const [id, x, y, arrow] of spots) {
        const index = rackLabels.push({ id, arrow }) - 1;
        for (const side of [1, -1]) {
          const position = new THREE.Vector3(x, y, z0 + side * 0.5265);
          rackLabelSpots.push({ index, position, back: side < 0 });
          scanTargets.push({ code: id, position });
        }
      }
    });
    // Kopbescherming en rij-aanduiding
    const rowSign = new THREE.MeshStandardMaterial({ map: tex.sign(`R${r + 1}`, '#17346b', '#ffffff'), roughness: 0.5 });
    for (const [x, ry] of [[RACK_MIN_X - 0.36, -Math.PI / 2], [RACK_MAX_X + 0.36, Math.PI / 2]] as const) {
      endGuards.add(x, 0.22, z0, 0.12, 0.44, 1.4);
      solid(x, z0, 0.12, 1.4, 0, 0.44);
      const s = new THREE.Mesh(signGeo, rowSign);
      s.position.set(ry < 0 ? RACK_MIN_X - 0.05 : RACK_MAX_X + 0.05, 2.7, z0);
      s.rotation.y = ry;
      scene.add(s);
    }
    colliders.push({ minX: RACK_MIN_X - 0.45, maxX: RACK_MAX_X + 0.45, minZ: z0 - 0.62, maxZ: z0 + 0.62 });
  });
  const labelAtlas = tex.locationLabelAtlas(rackLabels);
  const labelMesh = new THREE.Mesh(
    mergeGeometries(
      rackLabelSpots.map(({ index, position, back }) => {
        const geo = new THREE.PlaneGeometry(0.34, 0.1275);
        const [u0, v0, u1, v1] = labelAtlas.rects[index];
        const uv = geo.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
        if (back) geo.rotateY(Math.PI);
        return geo.translate(position.x, position.y, position.z);
      }),
    ),
    new THREE.MeshStandardMaterial({ map: labelAtlas.texture, roughness: 0.6 }),
  );
  scene.add(labelMesh);

  const deckTexture = tex.wireDeck();
  deckTexture.repeat.set(6, 2);
  scene.add(
    posts.build(UNIT_BOX, steelBlue),
    braces.build(UNIT_BOX, steelBlue),
    beams.build(UNIT_BOX, steelOrange),
    guards.build(UNIT_BOX, safetyYellow),
    endGuards.build(UNIT_BOX, hazard),
    decks.build(
      UNIT_BOX,
      new THREE.MeshStandardMaterial({ map: deckTexture, alphaTest: 0.5, roughness: 0.4, metalness: 0.7 }),
      false,
    ),
  );

  // ---------- Vaste aankleding ----------
  const palletGeo = palletGeometry();
  const stacks = new Batch();
  const r0 = tex.rng(7);
  const STACK_Z = D / 2 - 1.2;
  [[23.5, 9], [25.1, 12], [26.7, 6]].forEach(([x, n]) => {
    solid(x, STACK_Z, 1.2, 1.0, 0, n * PALLET_H);
    for (let i = 0; i < n; i++) stacks.add(x + (r0() - 0.5) * 0.04, i * PALLET_H, STACK_Z + (r0() - 0.5) * 0.04, 1, 1, 1, 0, (r0() - 0.5) * 0.06, 0);
  });
  scene.add(stacks.build(palletGeo, woodMat));
  colliders.push({ minX: 22.8, maxX: 27.4, minZ: STACK_Z - 0.6, maxZ: STACK_Z + 0.6 });

  // Paktafel met dozen
  const TX = 24.5; // midden van de paktafel
  const TZ = -D / 2 + 1.5;
  const table = new Batch();
  table.add(TX, 0.9, TZ, 2.2, 0.05, 0.9);
  const legs = new Batch();
  for (const dx of [-1, 1]) for (const dz of [-0.38, 0.38]) legs.add(TX + dx, 0.44, TZ + dz, 0.05, 0.88, 0.05);
  legs.add(TX, 0.25, TZ, 2.05, 0.03, 0.8);
  const tableBoxes = new Batch();
  tableBoxes.add(TX - 0.6, 1.075, TZ - 0.05, 0.5, 0.3, 0.4, 0, 0.2, 0);
  tableBoxes.add(TX + 0.05, 1.025, TZ + 0.05, 0.4, 0.2, 0.3, 0, -0.15, 0);
  tableBoxes.add(TX + 0.05, 1.2, TZ + 0.03, 0.3, 0.15, 0.25, 0, 0.3, 0);
  tableBoxes.add(TX + 0.65, 0.2, TZ + 0.7, 0.6, 0.4, 0.5, 0, 0.1, 0);
  scene.add(table.build(UNIT_BOX, woodMat), legs.build(UNIT_BOX, steelGrey), tableBoxes.build(UNIT_BOX, cartonMats));
  colliders.push({ minX: TX - 1.2, maxX: TX + 1.2, minZ: TZ - 0.55, maxZ: TZ + 1.0 });
  solid(TX, TZ, 2.2, 0.9, 0, 0.925);
  solid(TX + 0.65, TZ + 0.7, 0.6, 0.5, 0, 0.4);

  // Brandblussers en nooduitgang
  const extinguishers = new Batch();
  for (const [x, z] of [[-14, -D / 2 + 0.4], [14, -D / 2 + 0.4], [-14, D / 2 - 0.4], [0, D / 2 - 0.4], [W / 2 - 0.4, -10], [W / 2 - 0.4, 10]]) extinguishers.add(x, 1.0, z, 0.075, 0.5, 0.075);
  scene.add(extinguishers.build(UNIT_CYL, red));
  const exitDoor = new THREE.Mesh(new THREE.BoxGeometry(1.0, 2.1, 0.06), paint('#5d6b63', 0.5, 0.3));
  exitDoor.position.set(EXIT_X, 1.05, D / 2 - 0.04);
  scene.add(exitDoor);
  const exitSign = new THREE.Mesh(
    new THREE.PlaneGeometry(0.6, 0.3),
    new THREE.MeshBasicMaterial({ map: tex.sign('EXIT', '#0c8a3e', '#ffffff') }),
  );
  exitSign.position.set(EXIT_X, 2.45, D / 2 - 0.06);
  exitSign.rotation.y = Math.PI;
  scene.add(exitSign);

  // ---------- Voorraad: pallets, dozen en wikkelfolie ----------
  const MAX_PALLETS = 700;
  const MAX_CARTONS = 24000;
  const pallets = new THREE.InstancedMesh(palletGeo, woodMat, MAX_PALLETS);
  const cartons = new THREE.InstancedMesh(UNIT_BOX, cartonMats, MAX_CARTONS);
  const wraps = new THREE.InstancedMesh(UNIT_BOX, wrapMat, MAX_PALLETS);
  cartons.setColorAt(0, new THREE.Color(1, 1, 1));
  for (const m of [pallets, cartons]) {
    m.castShadow = true;
    m.receiveShadow = true;
  }
  for (const m of [pallets, cartons, wraps]) {
    m.count = 0;
    m.frustumCulled = false;
    scene.add(m);
  }

  function slotsFor(id: string): [number, number, number][] | null {
    const rack = /^R(\d+)-(\d+)-(\d+)$/.exec(id);
    if (rack) {
      const z = ROW_Z[+rack[1] - 1];
      const x = BAY_X[+rack[2] - 1];
      const y = LEVEL_Y[+rack[3] - 1];
      if (z === undefined || x === undefined || y === undefined) return null;
      return [-1.3, 0, 1.3].map((dx) => [x + dx, y === 0 ? 0 : y + 0.01, z]);
    }
    return null;
  }

  const CARTON_SIZES: [number, number, number][] = [
    [0.6, 0.36, 0.5],
    [0.4, 0.3, 0.5],
    [0.6, 0.45, 0.33],
    [0.3, 0.24, 0.5],
    [0.4, 0.4, 0.33],
  ];
  const SLOTS_PER_LOCATION = 3;
  /** Hoe vaak een doos gehalveerd mag worden om een grote voorraad toch op 3 pallets te krijgen. */
  const MAX_SHRINK = 3;
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const tint = new THREE.Color();

  type Carton = { x: number; y: number; z: number; sx: number; sy: number; sz: number; ry: number; r: number; g: number; b: number };

  /**
   * Stapelpatroon van een artikel: 1 doos = 1 stuk uit de WMS. De doosmaat hoort bij het artikel;
   * met `shrink` wordt hij per stap gehalveerd (meer stuks per pallet).
   */
  function stacking(sku: string, shrink: number) {
    const [w, h, d] = CARTON_SIZES[Math.floor(tex.rng(tex.hashString(sku))() * CARTON_SIZES.length)];
    const f = 0.5 ** shrink;
    const [cw, ch, cd] = [w * f, h * f, d * f];
    const nx = Math.round(1.2 / cw);
    const nz = Math.round(1.0 / cd);
    const maxLayers = Math.floor(1.45 / ch);
    return { cw, ch, cd, nx, nz, maxLayers, perLayer: nx * nz, capacity: nx * nz * maxLayers };
  }

  /** Doosmaat voor een pallet met `qty` stuks: de gewone maat, of kleiner als ze er anders niet op passen. */
  function stackingFor(sku: string, qty: number) {
    let s = stacking(sku, 0);
    for (let k = 1; k <= MAX_SHRINK && s.capacity < qty; k++) s = stacking(sku, k);
    return s;
  }

  /** Stuks per pallet voor een hele locatie: zo groot dat de voorraad op de 3 palletplekken past. */
  function perPalletAt(sku: string, total: number) {
    let s = stacking(sku, 0);
    for (let k = 1; k <= MAX_SHRINK && s.capacity * SLOTS_PER_LOCATION < total; k++) s = stacking(sku, k);
    return s.capacity;
  }

  /** Hoogte van een pallet met lading (bovenkant van de bovenste laag dozen). */
  function loadHeight(sku: string, qty: number) {
    const s = stackingFor(sku, qty);
    return PALLET_H + Math.min(s.maxLayers, Math.max(1, Math.ceil(qty / s.perLayer))) * s.ch;
  }

  /** Opbouw van één pallet (in palletcoördinaten): precies `qty` dozen. Doosmaat en kleur horen bij het artikel. */
  function loadLayout(sku: string, qty: number, jitterKey: string) {
    const r = tex.rng(tex.hashString(sku));
    r(); // eerste trekking is de doosmaat (zie stacking)
    const j = tex.rng(tex.hashString(jitterKey));
    const { cw, ch, cd, nx, nz, maxLayers, perLayer } = stackingFor(sku, qty);
    const shade = 0.78 + r() * 0.22;
    const warm = r() * 0.08;
    const wrapped = r() < 0.55;
    const count = Math.min(Math.max(0, Math.floor(qty)), perLayer * maxLayers);
    const layers = Math.max(1, Math.ceil(count / perLayer));
    const cartons: Carton[] = [];
    for (let l = 0; l < layers; l++) {
      // aangebroken bovenlaag: de dozen die er nog zijn staan aan één kant tegen elkaar aan
      const inLayer = Math.min(perLayer, count - l * perLayer);
      for (let k = 0; k < inLayer; k++) {
        const ix = Math.floor(k / nz);
        const iz = k % nz;
        const v = shade * (0.94 + j() * 0.06);
        cartons.push({
          x: (ix - (nx - 1) / 2) * cw + (j() - 0.5) * 0.012,
          y: PALLET_H + (l + 0.5) * ch,
          z: (iz - (nz - 1) / 2) * cd + (j() - 0.5) * 0.012,
          sx: cw - 0.008,
          sy: ch - 0.003,
          sz: cd - 0.008,
          ry: (j() - 0.5) * 0.03,
          r: v + warm,
          g: v,
          b: v - warm,
        });
      }
    }
    const wrap = wrapped ? { y: PALLET_H + (layers * ch) / 2, sx: nx * cw + 0.02, sy: layers * ch + 0.006, sz: nz * cd + 0.02 } : null;
    return { cartons, wrap };
  }

  /** Losse pallet met lading (voor op de vorken of los op de vloer); zelfde uiterlijk als in de stelling. */
  function buildLoad(sku: string, qty: number, jitterKey: string) {
    const g = new THREE.Group();
    const { cartons: list, wrap } = loadLayout(sku, qty, jitterKey);
    const base = new THREE.Mesh(palletGeo, woodMat);
    const boxes = new THREE.InstancedMesh(UNIT_BOX, cartonMats, list.length);
    list.forEach((c, i) => {
      q.setFromEuler(euler.set(0, c.ry, 0));
      boxes.setMatrixAt(i, m4.compose(pos.set(c.x, c.y, c.z), q, scl.set(c.sx, c.sy, c.sz)));
      boxes.setColorAt(i, tint.setRGB(c.r, c.g, c.b));
    });
    boxes.frustumCulled = false;
    for (const m of [base, boxes]) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    g.add(base, boxes);
    if (wrap) {
      const w = new THREE.Mesh(UNIT_BOX, wrapMat);
      w.position.y = wrap.y;
      w.scale.set(wrap.sx, wrap.sy, wrap.sz);
      g.add(w);
    }
    return g;
  }

  let stockSignature = '';
  let rackPallets: RackPallet[] = [];
  let solids: Solid[] = fixedSolids;
  const palletCount = new Map<string, number>();

  /** Tekent de voorraad: per locatie 1-3 pallets, de laatste pallet bevat de rest. */
  function setStock(items: Item[]) {
    const perLoc = new Map<string, { qty: number; sku: string; top: number }>();
    for (const it of items) {
      if (it.qty <= 0) continue;
      const cur = perLoc.get(it.locationId) ?? { qty: 0, sku: it.sku, top: 0 };
      cur.qty += it.qty;
      if (it.qty > cur.top) {
        cur.top = it.qty;
        cur.sku = it.sku;
      }
      perLoc.set(it.locationId, cur);
    }
    const signature = [...perLoc].map(([id, v]) => `${id}:${v.qty}:${v.sku}`).sort().join('|');
    if (signature === stockSignature) return;
    stockSignature = signature;

    let np = 0;
    let nc = 0;
    let nw = 0;
    rackPallets = [];
    palletCount.clear();
    for (const [id, { qty, sku }] of perLoc) {
      const slots = slotsFor(id);
      if (!slots) continue;
      // 1 doos = 1 stuk: volle pallets vooraan, de buitenste pallet heeft de rest
      const perPallet = perPalletAt(sku, qty);
      const count = Math.min(slots.length, Math.ceil(qty / perPallet));
      palletCount.set(id, count);
      for (let i = 0; i < count && np < MAX_PALLETS; i++) {
        const [sx, sy, sz] = slots[i];
        const onPallet = i === count - 1 ? qty - i * perPallet : perPallet;
        const key = `${id}:${i}`;
        const r = tex.rng(tex.hashString(key));
        const px = sx + (r() - 0.5) * 0.06;
        const pz = sz + (r() - 0.5) * 0.05;
        q.setFromEuler(euler.set(0, (r() - 0.5) * 0.05, 0));
        pallets.setMatrixAt(np++, m4.compose(pos.set(px, sy, pz), q, scl.set(1, 1, 1)));
        rackPallets.push({ locId: id, index: i, last: i === count - 1, x: px, y: sy, z: pz, qty: onPallet, sku, top: sy + loadHeight(sku, onPallet) });

        const { cartons: list, wrap } = loadLayout(sku, onPallet, key);
        for (const c of list) {
          if (nc >= MAX_CARTONS) break;
          q.setFromEuler(euler.set(0, c.ry, 0));
          cartons.setMatrixAt(nc, m4.compose(pos.set(px + c.x, sy + c.y, pz + c.z), q, scl.set(c.sx, c.sy, c.sz)));
          cartons.setColorAt(nc++, tint.setRGB(c.r, c.g, c.b));
        }
        if (wrap) {
          q.identity();
          wraps.setMatrixAt(nw++, m4.compose(pos.set(px, sy + wrap.y, pz), q, scl.set(wrap.sx, wrap.sy, wrap.sz)));
        }
      }
    }
    solids = [
      ...fixedSolids,
      ...rackPallets.map((p) => ({ minX: p.x - 0.6, maxX: p.x + 0.6, minZ: p.z - 0.5, maxZ: p.z + 0.5, minY: p.y, maxY: p.top })),
    ];
    pallets.count = np;
    cartons.count = nc;
    wraps.count = nw;
    for (const m of [pallets, cartons, wraps]) m.instanceMatrix.needsUpdate = true;
    if (cartons.instanceColor) cartons.instanceColor.needsUpdate = true;
  }

  /** Dichtstbijzijnde vrije palletplek in de stellingen bij punt (x, hoogte, z), of null. */
  function nearestFreeSlot(x: number, height: number, z: number, maxDist = 1.6): Slot | null {
    let best: Slot | null = null;
    let bestD = maxDist;
    ROW_Z.forEach((_, r) =>
      BAY_X.forEach((_, s) =>
        LEVEL_Y.forEach((_, l) => {
          const locId = `R${r + 1}-${String(s + 1).padStart(2, '0')}-${l + 1}`;
          const n = palletCount.get(locId) ?? 0;
          if (n >= SLOTS_PER_LOCATION) return;
          const [sx, sy, sz] = slotsFor(locId)![n];
          if (Math.abs(height - sy) > 1.3) return;
          const d = Math.hypot(x - sx, z - sz);
          if (d < bestD) {
            bestD = d;
            best = { locId, x: sx, y: sy, z: sz };
          }
        }),
      ),
    );
    return best;
  }

  /** Staat dit punt binnen een stellingrij (dan kun je daar niet los op de vloer neerzetten)? */
  const inRack = (x: number, z: number) => x > RACK_MIN_X - 0.2 && x < RACK_MAX_X + 0.2 && ROW_Z.some((z0) => Math.abs(z - z0) < 0.75);

  return {
    roof,
    colliders,
    /** Alles waar de speler tegenaan loopt of op kan staan: stellingen, pallets in de stellingen en vaste aankleding. */
    solids: () => solids,
    loadHeight,
    scanTargets,
    setStock,
    /** De pallets die nu in de stellingen staan. */
    rackPallets: () => rackPallets,
    nearestFreeSlot,
    inRack,
    buildLoad,
  };
}

export type Hall = ReturnType<typeof createWarehouse>;
