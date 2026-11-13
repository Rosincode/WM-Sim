import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AISLE_Z, DOCKS, DOCK_PITCH, EMPTY_PALLETS, FURNITURE, HALL as FLOOR, LANE_LENGTH, LEVEL_HEIGHTS, PARKING, ROOMS, ROW_FACE, ROW_Z, SECTION_PITCH, SECTION_X as BAY_X, SLOT_DX, WALKWAY_X, emptyStackSizes, location, rackLocationId, rowBehind, rowName, type Bay } from '../../sim/layout';
import { DOCK_RAMP, DRIVER_DOORS, TRUCK, dockScreen, jackBay } from '../../sim/drivers';
import { createRooms, ROOM_DOORS } from './rooms';
import { STYLE, onTop } from './style';
import { EXTINGUISHER_SIZE, extinguisherParts } from './extinguisher';
import * as tex from './textures';

// Het magazijngebouw: vloer, wanden, dak, docks, stellingen, pallets en verlichting.
// Alleen weergave: de pallets in de stellingen komen binnen via setPallets().

// Plattegrond (maten, docks, stellingrijen, aankleding) komt uit het model: src/sim/warehouse.json via src/sim/layout.ts.
export const HALL = FLOOR;
const LEVEL_Y = LEVEL_HEIGHTS;
/** Posities op een vaste afstand van elkaar, gecentreerd over `size` (lampen, lichtstraten, pictogrammen). */
const spread = (size: number, pitch: number) => {
  const n = Math.max(1, Math.round(size / pitch));
  return Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * pitch);
};
/** Stellingstaanders: tussen de secties en aan beide koppen. */
const FRAME_X = [...BAY_X.map((x) => x - SECTION_PITCH / 2), BAY_X[BAY_X.length - 1] + SECTION_PITCH / 2];
const RACK_MIN_X = FRAME_X[0];
const RACK_MAX_X = FRAME_X[FRAME_X.length - 1];
const RACK_MID_X = (RACK_MIN_X + RACK_MAX_X) / 2;
const RACK_LEN = RACK_MAX_X - RACK_MIN_X;
const PALLET_H = 0.144;
/** Personeelsdeur / nooduitgang in de zuidgevel (ook de entree aan de buitenkant). */
export const EXIT_X = FURNITURE.exitDoor.x;

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
  /** Een pallet met lading: de vorken van een pompwagen schuiven eronder. */
  pallet?: boolean;
};
/** pallet: het label is een palletsticker; locationId is leeg als de pallet los op de vloer staat. */
export type ScanTarget = { code: string; position: THREE.Vector3; pallet?: { sku: string; qty: number; locationId: string | null } };
/** Een pallet zoals de sim hem in een stelling heeft staan. slot = de palletplek op de locatie (0 = links). */
export type PalletView = { id: string; locationId: string; slot: number; sku: string; qty: number; unlabeled?: boolean; /** Verplaatst, nog niet geboekt. */ unbooked?: boolean };
/** Een pallet zoals hij nu in de stelling staat. index = de palletplek op zijn locatie. */
export type RackPallet = { id: string; locId: string; index: number; x: number; y: number; z: number; qty: number; sku: string; /** Bovenkant van de lading. */ top: number };
export type Slot = { locId: string; /** De palletplek op de locatie (0 = links). */ index: number; x: number; y: number; z: number };
/** Een pallet die los op de vloer staat (r = draaiing). */
export type LoosePallet = { id: string; sku: string; qty: number; x: number; z: number; r: number; unlabeled?: boolean };

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
      mat = onTop(
        new THREE.MeshStandardMaterial({
          color,
          map: map ?? null,
          alphaMap: map ? null : wornAlpha,
          transparent: true,
          roughness: 0.55,
          depthWrite: false,
        }),
      );
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
  // Een lijn langs de padkant van elke rij; een rij die alleen staat heeft ook aan zijn rug een lijn
  ROW_Z.forEach((z, r) => {
    marking(RACK_MID_X, z + ROW_FACE[r] * 0.85, RACK_LEN + 1.4, 0.1, YELLOW);
    if (rowBehind(r) < 0) marking(RACK_MID_X, z - ROW_FACE[r] * 0.85, RACK_LEN + 1.4, 0.1, YELLOW);
  });
  // Looppad tussen de dockzone en de stellingen
  const WALK_X = WALKWAY_X;
  // Het loopt van de noordwand (daar zit de deur naar de kantine) tot aan de parkeerplaats, of anders tot de wand.
  const across = (r: { minX: number; maxX: number }) => WALK_X > r.minX && WALK_X < r.maxX;
  const walkFrom = across(ROOMS.canteen) || across(ROOMS.office) ? -D / 2 + 0.4 : -D / 2 + 2;
  const walkTo = across(PARKING.area) ? PARKING.area.minZ - 0.3 : D / 2 - 2;
  const walkMid = (walkFrom + walkTo) / 2;
  const walkLen = walkTo - walkFrom;
  marking(WALK_X, walkMid, 1.4, walkLen, '#2f7a4c');
  marking(WALK_X - 0.75, walkMid, 0.1, walkLen, '#e9e9e2');
  marking(WALK_X + 0.75, walkMid, 0.1, walkLen, '#e9e9e2');
  const walkIcon = tex.walkwayIcon();
  for (const z of spread(walkLen - 2, 10)) marking(WALK_X, walkMid + z, 0.9, 0.9, '#ffffff', walkIcon, Math.PI / 2);
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
    // Het parkeervak van de elektrische pompwagen van dit dock, bij het scherm: open aan de kant van de hal
    const b = jackBay(d);
    for (const side of [-1, 1]) marking(b.x, b.z + (side * b.d) / 2, b.w, 0.08, YELLOW);
    marking(b.x - b.w / 2, b.z, 0.08, b.d + 0.08, YELLOW);
    marking(b.x + b.w / 2 + 0.2, b.z, 0.8, 0.2, '#e9e9e2', tex.floorText(`POMPWAGEN ${d.id.replace('DOCK-', '')}`), Math.PI / 2);
  }
  // Parkeerplaats: een vak voor de heftruck en een voor de pompwagen.
  // De tekst lees je als je vanuit de hal naar de wand kijkt.
  {
    const { area, forklift, palletJack } = PARKING;
    const WHITE = '#e9e9e2';
    const bay = (b: Bay, color: string) => {
      for (const side of [-1, 1]) marking(b.x + (side * b.w) / 2, b.z, 0.08, b.d, color);
      marking(b.x, b.z + b.d / 2, b.w + 0.08, 0.08, color);
    };
    const label = (b: Bay, text: string, w: number) => marking(b.x, b.z - b.d / 2 - 0.45, w, w / 4, WHITE, tex.floorText(text), Math.PI);
    bay(forklift, YELLOW);
    label(forklift, 'HEFTRUCK', 2.2);
    bay(palletJack, YELLOW);
    label(palletJack, 'POMPWAGEN', 1.5);
    // rand van de parkeerplaats aan de kant van de hal
    marking((area.minX + area.maxX) / 2 + 0.3, area.minZ, area.maxX - area.minX - 0.6, 0.1, YELLOW);
    marking(area.maxX, (area.minZ + area.maxZ) / 2, 0.1, area.maxZ - area.minZ, YELLOW);
  }
  for (const [mat, geos] of paintGeos) {
    const m = new THREE.Mesh(mergeGeometries(geos), mat);
    m.receiveShadow = true;
    m.renderOrder = -1; // vloerverf ligt onder alle andere doorzichtige dingen (folie, markeringen)
    scene.add(m);
  }

  // ---------- Wanden ----------
  const panelTex = tex.wallPanel();
  /**
   * @param holes openingen (raam of deur) [van, tot, onderkant, bovenkant]; van/tot langs de wand, gemeten vanuit het midden
   *              in de eigen richting van het vlak (naar rechts als je er van binnenuit tegenaan kijkt).
   */
  function wall(x: number, z: number, ry: number, len: number, holes: [number, number, number, number][] = []) {
    const t = panelTex.clone();
    t.repeat.set(len, 1);
    t.needsUpdate = true;
    let geo: THREE.BufferGeometry = new THREE.PlaneGeometry(len, H);
    if (holes.length) {
      const rect = (a: number, b: number, y0: number, y1: number) =>
        [new THREE.Vector2(a, y0), new THREE.Vector2(b, y0), new THREE.Vector2(b, y1), new THREE.Vector2(a, y1)];
      const shape = new THREE.Shape(rect(-len / 2, len / 2, -H / 2, H / 2));
      // een deur begint op de vloer: het gat blijft 2 mm van de rand, anders deelt het een zijde met de omtrek
      for (const [a, b, y0, y1] of holes) shape.holes.push(new THREE.Path(rect(a, b, Math.max(y0, 0.002) - H / 2, y1 - H / 2)));
      geo = new THREE.ShapeGeometry(shape);
      const p = geo.attributes.position;
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, p.getX(i) / len + 0.5, p.getY(i) / H + 0.5);
    }
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: t, roughness: 0.55, metalness: 0.25 }));
    m.position.set(x, H / 2, z);
    m.rotation.y = ry;
    m.receiveShadow = true;
    scene.add(m);
    // Plint: doorlopend, behalve onder een raam dat lager begint dan de plint hoog is
    const plinthMat = paint('#9a9b96', 0.9, 0);
    const plinth = (a: number, b: number, h: number) => {
      if (b - a < 0.001 || h < 0.001) return; // onder een deur geen plint
      const part = new THREE.Mesh(new THREE.BoxGeometry(b - a, h, 0.1), plinthMat);
      part.position.set(x + Math.cos(ry) * ((a + b) / 2), h / 2, z - Math.sin(ry) * ((a + b) / 2));
      part.rotation.y = ry;
      part.receiveShadow = true;
      scene.add(part);
    };
    let cur = -len / 2;
    for (const [a, b, y0] of [...holes].sort((p, q) => p[0] - q[0])) {
      plinth(cur, a, 1.2);
      plinth(a, b, Math.min(1.2, y0));
      cur = b;
    }
    plinth(cur, len / 2, 1.2);
  }
  // Deuren naar het kantoor en de kantine: open gaten in de noordwand
  wall(0, -D / 2, 0, W, ROOM_DOORS.map((d): [number, number, number, number] => [d.from, d.to, 0, d.height]));
  wall(0, D / 2, Math.PI, W);
  // Dockwand: open gaten voor de dockdeuren (de deur zelf gaat open en dicht) en de chauffeursdeuren.
  // Langs deze wand loopt de eigen richting van het vlak naar -z.
  wall(-W / 2, 0, Math.PI / 2, D, [
    ...DOCKS.map((d): [number, number, number, number] => [-d.z - 1.5, -d.z + 1.5, 0, 3.5]),
    ...DRIVER_DOORS.map((z): [number, number, number, number] => [-z - 0.5, -z + 0.5, 0, 2.1]),
  ]);
  wall(W / 2, 0, -Math.PI / 2, D);

  // ---------- Kantoor en kantine: aanbouw buiten tegen de noordwand ----------
  const rooms = createRooms({ scene, roof, solid });

  // Kolommen met aanrijbescherming
  const columns = new Batch();
  const columnWraps = new Batch();
  const columnSpots: [number, number][] = [];
  for (let x = -W / 2; x <= W / 2; x += 7) columnSpots.push([x, -D / 2 + 0.17], [x, D / 2 - 0.17]);
  for (const z of [DOCKS[0].z - DOCK_PITCH / 2, ...DOCKS.map((d) => d.z + DOCK_PITCH / 2)])
    columnSpots.push([-W / 2 + 0.17, z], [W / 2 - 0.17, z]); // tussen de dockdeuren
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
  const LIGHT_X = spread(W, 14);
  const LIGHT_Z = spread(D, 14);
  for (const lx of LIGHT_X)
    for (const z of LIGHT_Z) {
      const x = lx + 3.5;
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
    for (const z of AISLE_Z) { // boven elk gangpad
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
  const reach = Math.max(W, D) / 2 + 34; // de hal plus het terrein eromheen
  Object.assign(key.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 5, far: 130 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  key.shadow.radius = 4;
  scene.add(key);
  for (const x of spread(W, 18))
    for (const z of LIGHT_Z) {
      const p = new THREE.PointLight('#fff4e2', 46, 28, 2);
      p.position.set(x, LAMP_Y - 0.4, z);
      scene.add(p);
    }

  // ---------- Docks ----------
  const doorMat = paint('#c3c8cc', 0.5, 0.35);
  const windowMat = onTop(glow(2.4, 2.8, 3.3));
  const leveller = onTop(new THREE.MeshStandardMaterial({ map: tex.treadPlate(), roughness: 0.45, metalness: 0.75 }));
  const dockHazard = new Batch();
  /** Per dock de deur (rolt omhoog) en de laadklep (kantelt omhoog naar de laadvloer van de vrachtwagen). */
  const dockDoors: { door: THREE.Group; ramp: THREE.Group }[] = [];
  const rampLength = Math.hypot(DOCK_RAMP.low - DOCK_RAMP.high, TRUCK.floor);
  const rampGeo = new THREE.BoxGeometry(rampLength, 0.03, 1.7);
  const bollards = new Batch();
  DOCKS.forEach(({ z, id }, i) => {
    const x0 = -W / 2;
    // De deur hangt aan zijn bovenkant: bij het openen rolt hij daar op
    const door = new THREE.Group();
    door.position.set(x0 + 0.09, 3.5, z);
    for (let s = 0; s < 4; s++) {
      const panel = new THREE.Mesh(UNIT_BOX, doorMat);
      panel.scale.set(0.05, 0.86, 3.0);
      panel.position.y = 0.44 + s * 0.875 - 3.5;
      panel.castShadow = panel.receiveShadow = true;
      door.add(panel);
    }
    for (const dz of [-0.9, 0, 0.9]) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.28), windowMat);
      win.rotation.y = Math.PI / 2;
      win.position.set(0.03, 2.2 - 3.5, dz);
      door.add(win);
    }
    // De laadklep scharniert in de halvloer en komt omhoog tot op de laadvloer van de vrachtwagen
    const ramp = new THREE.Group();
    ramp.position.set(DOCK_RAMP.low, 0.012, z);
    const plateUp = new THREE.Mesh(rampGeo, STYLE.steel);
    plateUp.position.x = -rampLength / 2;
    plateUp.receiveShadow = true;
    ramp.add(plateUp);
    ramp.visible = false;
    scene.add(door, ramp);
    dockDoors.push({ door, ramp });
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
      onTop(new THREE.MeshStandardMaterial({ map: tex.sign(`DOCK ${i + 1}`, '#17346b', '#ffffff'), roughness: 0.5 })),
    );
    board.rotation.y = Math.PI / 2;
    board.position.set(x0 + 0.06, 4.35, z);
    scene.add(board);

    // Scanlabel van het dock zelf: op de plint onder het aanraakscherm, met een pijl naar de deur (links)
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.4, 0.15),
      onTop(new THREE.MeshStandardMaterial({ map: tex.locationLabel(id, 'left', 0.5), roughness: 0.6 })),
    );
    label.rotation.y = Math.PI / 2;
    label.position.set(x0 + 0.053, 1.11, dockScreen(DOCKS[i]).z);
    scene.add(label);
    scanTargets.push({ code: id, position: label.position.clone() });

    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), glow(0.3, 3.2, 0.6));
    lamp.position.set(x0 + 0.2, 2.6, z - 1.6);
    // de deur zelf is dicht: je loopt er niet doorheen
    scene.add(lamp);
  });
  /** @param open 0 = dockdeur dicht, 1 = open met de laadklep op de vrachtwagen */
  function setDockDoor(i: number, open: number) {
    const d = dockDoors[i];
    if (!d) return;
    d.door.scale.y = 1 - 0.97 * open;
    d.ramp.visible = open > 0.02;
    d.ramp.rotation.z = -Math.atan2(TRUCK.floor, DOCK_RAMP.low - DOCK_RAMP.high) * open;
  }
  // Chauffeursdeuren: hierdoor komen de chauffeurs van de vrachtwagens de hal in
  const driverDoorMat = paint('#5d6b63', 0.5, 0.3);
  const driverDoors = DRIVER_DOORS.map((z) => {
    const hinge = new THREE.Group();
    hinge.position.set(-W / 2 - 0.015, 0, z - 0.5);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.05, 2.08, 0.98), driverDoorMat);
    leaf.position.set(0, 1.04, 0.49);
    leaf.castShadow = leaf.receiveShadow = true;
    hinge.add(leaf);
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(1.0, 0.5),
      onTop(new THREE.MeshStandardMaterial({ map: tex.sign('CHAUFFEURS', '#17346b', '#ffffff'), roughness: 0.5 })),
    );
    board.rotation.y = Math.PI / 2;
    board.position.set(-W / 2 + 0.02, 2.5, z);
    scene.add(hinge, board);
    return hinge;
  });
  /** @param open 0 = chauffeursdeur dicht, 1 = open (de hal in) */
  function setDriverDoor(i: number, open: number) {
    if (driverDoors[i]) driverDoors[i].rotation.y = open * 1.45;
  }
  scene.add(
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
  const POST_H = LEVEL_Y[LEVEL_Y.length - 1] + 1.6;
  const signGeo = new THREE.PlaneGeometry(0.7, 0.35);
  // Locatielabels: honderden stuks, daarom samen in één mesh met één textuur (zie tex.locationLabelAtlas).
  const rackLabels: { id: string; arrow: 'up' | 'down' }[] = [];
  const rackLabelSpots: { index: number; position: THREE.Vector3; back: boolean }[] = [];

  ROW_Z.forEach((z0, r) => {
    // De rijen staan rug-aan-rug: het pad ligt aan de kant `face`, aan de andere kant staat (meestal) de buurrij.
    const face = ROW_FACE[r];
    const behind = rowBehind(r);
    const paired = behind >= 0;
    /** Het midden en de diepte van het blok: deze rij, of het paar rug-aan-rug (dan alleen bij de eerste van de twee). */
    const block = !paired ? { z: z0, d: 1.4 } : behind > r ? { z: (z0 + ROW_Z[behind]) / 2, d: 1.4 + ROW_Z[behind] - z0 } : null;
    for (const fx of FRAME_X) {
      for (const dz of [-0.5, 0.5]) {
        posts.add(fx, POST_H / 2, z0 + dz, 0.09, POST_H, 0.07);
        // aanrijbescherming alleen waar verkeer langs komt, niet tussen twee rijen in
        if (!paired || dz * face > 0) guards.add(fx, 0.2, z0 + dz * 1.16, 0.16, 0.4, 0.05);
      }
      // rugkoppelingen: de twee rijen zitten met afstandhouders aan elkaar vast
      if (paired && behind > r)
        for (let y = 0.9; y < POST_H; y += 1.6) braces.add(fx, y, block!.z, 0.04, 0.04, ROW_Z[behind] - z0 - 1);
      for (let y = 0.3, k = 0; y < POST_H; y += 1.6, k++) {
        braces.add(fx, y, z0, 0.035, 0.035, 0.94);
        if (y + 1.6 < POST_H) braces.add(fx, y + 0.8, z0, 0.035, 0.035, 1.84, (k % 2 ? 1 : -1) * Math.atan2(1.6, 0.94), 0, 0);
      }
      solid(fx, z0, 0.09, 1.07, 0, POST_H); // staanders met schoren: daar kun je niet tussendoor
    }
    BAY_X.forEach((bx, s) => {
      for (const y of LEVEL_Y.slice(1)) {
        for (const dz of [-0.5, 0.5]) beams.add(bx, y - 0.065, z0 + dz, SECTION_PITCH - 0.09, 0.13, 0.05);
        decks.add(bx, y + 0.004, z0, SECTION_PITCH - 0.1, 0.006, 0.95);
        solid(bx, z0, SECTION_PITCH - 0.09, 1.05, y - 0.13, y + 0.007); // liggers met roosterdek: je loopt eronderdoor of staat erop
      }
      const base = rackLocationId(r, s, 1).slice(0, -2);
      // Labels op de liggers: niveau 1 en 2 delen de onderste ligger (pijl omlaag / omhoog), daarboven elk zijn eigen ligger
      const spots = LEVEL_Y.map((_, l): [string, number, number, 'up' | 'down'] => [
        `${base}-${l + 1}`,
        bx + (l === 0 ? -0.3 : l === 1 ? 0.3 : 0),
        LEVEL_Y[Math.max(1, l)] - 0.065,
        l === 0 ? 'down' : 'up',
      ]);
      for (const [id, x, y, arrow] of spots) {
        const index = rackLabels.push({ id, arrow }) - 1;
        // alleen aan de padkant: aan de rug kom je niet
        const position = new THREE.Vector3(x, y, z0 + face * 0.5265);
        rackLabelSpots.push({ index, position, back: face < 0 });
        scanTargets.push({ code: id, position });
      }
    });
    // Kopbescherming en rij-aanduiding
    const rowSign = onTop(new THREE.MeshStandardMaterial({ map: tex.sign(rowName(r), '#17346b', '#ffffff'), roughness: 0.5 }));
    for (const [x, ry] of [[RACK_MIN_X - 0.36, -Math.PI / 2], [RACK_MAX_X + 0.36, Math.PI / 2]] as const) {
      if (block) {
        // één kopbescherming per blok: twee rijen rug-aan-rug delen hem
        endGuards.add(x, 0.22, block.z, 0.12, 0.44, block.d);
        solid(x, block.z, 0.12, block.d, 0, 0.44);
      }
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
    onTop(new THREE.MeshStandardMaterial({ map: labelAtlas.texture, roughness: 0.6 })),
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
      onTop(new THREE.MeshStandardMaterial({ map: deckTexture, alphaTest: 0.5, roughness: 0.4, metalness: 0.7 })),
      false,
    ),
  );

  // ---------- Vaste aankleding ----------
  const palletGeo = palletGeometry();
  // De stapels lege pallets langs de wand: zoveel als de sim er telt (setEmptyPallets), om de beurt op een stapel.
  // Elke plek in een stapel heeft zijn eigen vaste scheefstand; de heftruck rijdt nooit over een stapelplek.
  const r0 = tex.rng(7);
  const stackSpots = EMPTY_PALLETS.stacks.map(({ x, z }) => {
    colliders.push({ minX: x - 0.7, maxX: x + 0.7, minZ: z - 0.6, maxZ: z + 0.6 });
    solid(x, z, 1.2, 1.0, 0, 0);
    return {
      solid: fixedSolids[fixedSolids.length - 1],
      layers: Array.from({ length: EMPTY_PALLETS.perStack }, (_, i) =>
        new THREE.Matrix4().compose(
          new THREE.Vector3(x + (r0() - 0.5) * 0.04, i * PALLET_H, z + (r0() - 0.5) * 0.04),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (r0() - 0.5) * 0.06, 0)),
          new THREE.Vector3(1, 1, 1),
        ),
      ),
    };
  });
  const emptyPallets = new THREE.InstancedMesh(palletGeo, woodMat, EMPTY_PALLETS.max);
  emptyPallets.castShadow = emptyPallets.receiveShadow = true;
  scene.add(emptyPallets);
  let emptyCount = -1;
  /** Tekent de stapels lege pallets: `count` pallets in totaal. */
  function setEmptyPallets(count: number) {
    count = Math.max(0, Math.min(EMPTY_PALLETS.max, Math.round(count)));
    if (count === emptyCount) return;
    emptyCount = count;
    let k = 0;
    emptyStackSizes(count).forEach((n, i) => {
      for (let layer = 0; layer < n; layer++) emptyPallets.setMatrixAt(k++, stackSpots[i].layers[layer]);
      stackSpots[i].solid.maxY = n * PALLET_H; // een lege plek is alleen nog vloer
    });
    emptyPallets.count = k;
    emptyPallets.instanceMatrix.needsUpdate = true;
    emptyPallets.computeBoundingSphere();
  }
  setEmptyPallets(EMPTY_PALLETS.start);

  // Paktafel met dozen
  const { x: TX, z: TZ } = FURNITURE.packingTable; // midden van de paktafel
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
  // Elke blusser hangt aan een standaard en kijkt de hal in: met zijn rug naar de dichtstbijzijnde wand.
  const extinguishers = new Batch();
  for (const { x, z } of FURNITURE.fireExtinguishers) {
    const toWall = [
      { dist: z + D / 2, ry: 0 },
      { dist: D / 2 - z, ry: Math.PI },
      { dist: x + W / 2, ry: Math.PI / 2 },
      { dist: W / 2 - x, ry: -Math.PI / 2 },
    ].reduce((a, b) => (b.dist < a.dist ? b : a));
    extinguishers.add(x, 0, z, 1, 1, 1, 0, toWall.ry, 0);
    solid(x, z, EXTINGUISHER_SIZE.w, EXTINGUISHER_SIZE.d, 0, EXTINGUISHER_SIZE.h);
  }
  for (const part of extinguisherParts()) scene.add(extinguishers.build(part.geometry, part.material, part.shadows));
  const exitDoor = new THREE.Mesh(new THREE.BoxGeometry(1.0, 2.1, 0.06), paint('#5d6b63', 0.5, 0.3));
  exitDoor.position.set(EXIT_X, 1.05, D / 2 - 0.04);
  scene.add(exitDoor);
  const exitSign = new THREE.Mesh(
    new THREE.PlaneGeometry(0.6, 0.3),
    onTop(new THREE.MeshBasicMaterial({ map: tex.sign('EXIT', '#0c8a3e', '#ffffff') })),
  );
  exitSign.position.set(EXIT_X, 2.45, D / 2 - 0.06);
  exitSign.rotation.y = Math.PI;
  scene.add(exitSign);

  const parkSign = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 1.2),
    new THREE.MeshStandardMaterial({ map: tex.sign('P', '#17346b', '#ffffff', 'HEFTRUCK - POMPWAGEN - ROBOTS'), roughness: 0.7 }),
  );
  // midden tussen twee kolommen (om de 7 m langs de wand), zo dicht mogelijk bij het midden van de parkeerplaats
  const parkMid = (PARKING.area.minX + PARKING.area.maxX) / 2;
  parkSign.position.set(-W / 2 + (Math.floor((parkMid + W / 2) / 7) + 0.5) * 7, 3.2, D / 2 - 0.07);
  parkSign.rotation.y = Math.PI;
  scene.add(parkSign);

  // ---------- Voorraad: pallets, dozen en wikkelfolie ----------
  const MAX_PALLETS = Math.max(700, ROW_Z.length * BAY_X.length * LEVEL_Y.length * SLOT_DX.length); // elke palletplek bezet
  const MAX_CARTONS = 24000;
  const pallets = new THREE.InstancedMesh(palletGeo, woodMat, MAX_PALLETS);
  const cartons = new THREE.InstancedMesh(UNIT_BOX, cartonMats, MAX_CARTONS);
  const wraps = new THREE.InstancedMesh(UNIT_BOX, wrapMat, MAX_PALLETS);
  cartons.setColorAt(0, new THREE.Color(1, 1, 1));
  for (const m of [pallets, cartons]) {
    m.castShadow = true;
    m.receiveShadow = true;
  }
  // Palletstickers: op de pallet zelf, op de middelste klos, aan beide gangpadkanten. Oranje = verplaatst en nog niet geboekt.
  const STICKER_Y = PALLET_H / 2;
  const STICKER_Z = 0.503; // net voor de klossen
  const STICKER_X = 0.603;
  const stickerGeo = new THREE.PlaneGeometry(0.2, 0.13);
  const stickerMat = onTop(new THREE.MeshStandardMaterial({ map: tex.palletSticker(), roughness: 0.6 }));
  const stickers = new THREE.InstancedMesh(stickerGeo, stickerMat, MAX_PALLETS * 2);
  stickers.setColorAt(0, new THREE.Color(1, 1, 1));
  stickers.receiveShadow = true;
  for (const m of [pallets, cartons, wraps, stickers]) {
    m.count = 0;
    m.frustumCulled = false;
    scene.add(m);
  }
  // Scanbare stickers komen achter de vaste labels in scanTargets: de scanner leest die lijst elke keer opnieuw.
  const fixedTargets = scanTargets.length;
  let rackStickers: ScanTarget[] = [];
  let looseStickers: ScanTarget[] = [];
  function refreshTargets() {
    scanTargets.length = fixedTargets;
    scanTargets.push(...rackStickers, ...looseStickers);
  }

  function slotsFor(id: string): [number, number, number][] | null {
    const loc = location(id);
    const y = loc && loc.type !== 'dock' ? LEVEL_Y[loc.level - 1] : undefined;
    if (!loc || y === undefined) return null;
    return SLOT_DX.map((dx) => [loc.x + dx, y === 0 ? 0 : y + 0.01, loc.z]);
  }

  const CARTON_SIZES: [number, number, number][] = [
    [0.6, 0.36, 0.5],
    [0.4, 0.3, 0.5],
    [0.6, 0.45, 0.33],
    [0.3, 0.24, 0.5],
    [0.4, 0.4, 0.33],
  ];
  /** Hoe vaak een doos gehalveerd mag worden om een pallet met meer stuks dan er normaal op passen toch te tonen. */
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

  /** Stuks op een volle pallet van dit artikel, met de gewone doosmaat: zo groot maakt de sim nieuwe pallets. */
  const palletCapacity = (sku: string) => stacking(sku, 0).capacity;

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

  /**
   * Losse pallet met lading (voor op de vorken of los op de vloer); zelfde uiterlijk als in de stelling.
   * @param sticker false: er zit nog geen palletsticker op.
   */
  function buildLoad(sku: string, qty: number, jitterKey: string, sticker = true) {
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
    if (sticker)
      for (const [x, z, ry] of [[0, STICKER_Z, 0], [0, -STICKER_Z, Math.PI], [STICKER_X, 0, Math.PI / 2], [-STICKER_X, 0, -Math.PI / 2]]) {
        const s = new THREE.Mesh(stickerGeo, stickerMat);
        s.position.set(x, STICKER_Y, z);
        s.rotation.y = ry;
        g.add(s);
      }
    g.userData.top = loadHeight(sku, qty); // bovenkant van de lading, voor botsingen
    return g;
  }

  /** Zo hoog (m) wordt de lading op een orderpallet hooguit gestapeld. */
  const ORDER_STACK_H = 1.3;
  /**
   * De indeling van een orderpallet: elk artikel in zijn eigen blok van stapels, de blokken in stroken naast
   * elkaar op het palletdek (1,2 × 1,0 m). `shrink` halveert de dozen, net als bij een overvolle stellingpallet.
   */
  function orderPlan(lines: { sku: string; qty: number }[], shrink: number) {
    const blocks = lines
      .map((l) => {
        const s = stacking(l.sku, shrink);
        const cols = Math.ceil(l.qty / Math.max(1, Math.floor(ORDER_STACK_H / s.ch)));
        const colsZ = Math.min(s.nz, cols);
        const colsX = Math.ceil(cols / colsZ);
        return { ...l, cw: s.cw, ch: s.ch, cd: s.cd, colsX, colsZ, w: colsX * s.cw, d: colsZ * s.cd };
      })
      .sort((a, b) => b.d - a.d || b.w - a.w);
    const strips: { w: number; d: number; blocks: typeof blocks }[] = [];
    for (const b of blocks) {
      const strip = strips.find((s) => s.d + b.d <= 1.0 + 1e-6);
      if (!strip) strips.push({ w: b.w, d: b.d, blocks: [b] });
      else {
        strip.blocks.push(b);
        strip.d += b.d;
        strip.w = Math.max(strip.w, b.w);
      }
    }
    return { strips, width: strips.reduce((n, s) => n + s.w, 0) };
  }

  /**
   * De pallet van een order (op de uitslagbaan, op de pompwagen van de chauffeur, in de vrachtwagen): dezelfde
   * pallet en dozen als in de stelling, met van elk artikel precies het aantal dat voor de order is gepickt.
   * De lange kant van de pallet ligt langs x.
   */
  function buildOrderLoad(lines: { sku: string; qty: number }[], jitterKey: string) {
    const g = new THREE.Group();
    const base = new THREE.Mesh(palletGeo, woodMat);
    base.castShadow = base.receiveShadow = true;
    g.add(base);
    const want = lines.map((l) => ({ sku: l.sku, qty: Math.floor(l.qty) })).filter((l) => l.qty > 0);
    let plan = orderPlan(want, 0);
    for (let k = 1; k <= MAX_SHRINK && plan.width > 1.2 + 1e-6; k++) plan = orderPlan(want, k);
    const j = tex.rng(tex.hashString(jitterKey));
    const list: Carton[] = [];
    let x0 = -Math.min(plan.width, 1.2) / 2;
    for (const strip of plan.strips) {
      let z0 = -strip.d / 2;
      for (const b of strip.blocks) {
        // zelfde tint als dit artikel in de stelling heeft (zie loadLayout)
        const r = tex.rng(tex.hashString(b.sku));
        r();
        const shade = 0.78 + r() * 0.22;
        const warm = r() * 0.08;
        const cols = b.colsX * b.colsZ;
        for (let k = 0; k < b.qty; k++) {
          // laag voor laag over de stapels van het blok: zo blijft de bovenkant vlak
          const col = k % cols;
          const x = x0 + (Math.floor(col / b.colsZ) + 0.5) * b.cw;
          if (x + b.cw / 2 > 0.6 + 1e-6) continue; // past ook met de kleinste dozen niet meer op de pallet
          const v = shade * (0.94 + j() * 0.06);
          list.push({
            x: x + (j() - 0.5) * 0.012,
            y: PALLET_H + (Math.floor(k / cols) + 0.5) * b.ch,
            z: z0 + ((col % b.colsZ) + 0.5) * b.cd + (j() - 0.5) * 0.012,
            sx: b.cw - 0.008,
            sy: b.ch - 0.003,
            sz: b.cd - 0.008,
            ry: (j() - 0.5) * 0.03,
            r: v + warm,
            g: v,
            b: v - warm,
          });
        }
        z0 += b.d;
      }
      x0 += strip.w;
    }
    g.userData.top = list.reduce((top, c) => Math.max(top, c.y + c.sy / 2), PALLET_H); // bovenkant van de lading, voor botsingen
    if (list.length === 0) return g;
    const boxes = new THREE.InstancedMesh(UNIT_BOX, cartonMats, list.length);
    list.forEach((c, i) => {
      q.setFromEuler(euler.set(0, c.ry, 0));
      boxes.setMatrixAt(i, m4.compose(pos.set(c.x, c.y, c.z), q, scl.set(c.sx, c.sy, c.sz)));
      boxes.setColorAt(i, tint.setRGB(c.r, c.g, c.b));
    });
    boxes.frustumCulled = false;
    boxes.castShadow = boxes.receiveShadow = true;
    g.add(boxes);
    return g;
  }

  let stockSignature = '';
  let rackPallets: RackPallet[] = [];
  let solids: Solid[] = fixedSolids;
  /** Bezette palletplekken per locatie. */
  const usedSlots = new Map<string, Set<number>>();

  /** Tekent de pallets in de stellingen, elk op zijn eigen plek, met zijn sticker als hij die heeft. */
  function setPallets(list: PalletView[]) {
    const signature = list.map((p) => `${p.id}:${p.locationId}:${p.slot}:${p.qty}:${p.sku}:${p.unlabeled ? 0 : p.unbooked ? 2 : 1}`).join('|');
    if (signature === stockSignature) return;
    stockSignature = signature;

    let np = 0;
    let nc = 0;
    let nw = 0;
    let ns = 0;
    rackPallets = [];
    rackStickers = [];
    usedSlots.clear();
    for (const p of list) {
      const slot = slotsFor(p.locationId)?.[p.slot];
      if (!slot || p.qty <= 0 || np >= MAX_PALLETS) continue;
      const used = usedSlots.get(p.locationId) ?? new Set<number>();
      used.add(p.slot);
      usedSlots.set(p.locationId, used);
      const [sx, sy, sz] = slot;
      const r = tex.rng(tex.hashString(`${p.locationId}:${p.slot}`));
      const px = sx + (r() - 0.5) * 0.06;
      const pz = sz + (r() - 0.5) * 0.05;
      q.setFromEuler(euler.set(0, (r() - 0.5) * 0.05, 0));
      pallets.setMatrixAt(np++, m4.compose(pos.set(px, sy, pz), q, scl.set(1, 1, 1)));
      rackPallets.push({ id: p.id, locId: p.locationId, index: p.slot, x: px, y: sy, z: pz, qty: p.qty, sku: p.sku, top: sy + loadHeight(p.sku, p.qty) });

      // De opbouw hangt aan het palletnummer: een pallet ziet er op elke plek hetzelfde uit.
      const { cartons: boxes, wrap } = loadLayout(p.sku, p.qty, p.id);
      for (const c of boxes) {
        if (nc >= MAX_CARTONS) break;
        q.setFromEuler(euler.set(0, c.ry, 0));
        cartons.setMatrixAt(nc, m4.compose(pos.set(px + c.x, sy + c.y, pz + c.z), q, scl.set(c.sx, c.sy, c.sz)));
        cartons.setColorAt(nc++, tint.setRGB(c.r, c.g, c.b));
      }
      if (wrap) {
        q.identity();
        wraps.setMatrixAt(nw++, m4.compose(pos.set(px, sy + wrap.y, pz), q, scl.set(wrap.sx, wrap.sy, wrap.sz)));
      }
      if (p.unlabeled) continue;
      for (const side of [1, -1]) {
        const position = new THREE.Vector3(px, sy + STICKER_Y, pz + side * STICKER_Z);
        q.setFromEuler(euler.set(0, side > 0 ? 0 : Math.PI, 0));
        stickers.setMatrixAt(ns, m4.compose(position, q, scl.set(1, 1, 1)));
        stickers.setColorAt(ns++, p.unbooked ? tint.setRGB(1, 0.62, 0.2) : tint.setRGB(1, 1, 1));
        rackStickers.push({ code: p.id, position, pallet: { sku: p.sku, qty: p.qty, locationId: p.locationId } });
      }
    }
    solids = [
      ...fixedSolids,
      ...rackPallets.map((p) => ({ minX: p.x - 0.6, maxX: p.x + 0.6, minZ: p.z - 0.5, maxZ: p.z + 0.5, minY: p.y, maxY: p.top, pallet: true })),
    ];
    pallets.count = np;
    cartons.count = nc;
    wraps.count = nw;
    stickers.count = ns;
    for (const m of [pallets, cartons, wraps, stickers]) m.instanceMatrix.needsUpdate = true;
    for (const m of [cartons, stickers]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
    refreshTargets();
  }

  let looseSignature = '';
  /** Pallets die los op de vloer staan: hun stickers zijn ook te scannen. */
  function setLoose(list: LoosePallet[]) {
    const signature = list.map((l) => `${l.id}:${l.x}:${l.z}:${l.r}:${l.unlabeled ? 0 : 1}`).join('|');
    if (signature === looseSignature) return;
    looseSignature = signature;
    looseStickers = [];
    for (const l of list) {
      if (l.unlabeled) continue;
      const cos = Math.cos(l.r);
      const sin = Math.sin(l.r);
      for (const [dx, dz] of [[0, STICKER_Z], [0, -STICKER_Z], [STICKER_X, 0], [-STICKER_X, 0]])
        looseStickers.push({
          code: l.id,
          position: new THREE.Vector3(l.x + dx * cos + dz * sin, STICKER_Y, l.z - dx * sin + dz * cos),
          pallet: { sku: l.sku, qty: l.qty, locationId: null },
        });
    }
    refreshTargets();
  }

  /** Dichtstbijzijnde vrije palletplek in de stellingen bij punt (x, hoogte, z), of null. */
  function nearestFreeSlot(x: number, height: number, z: number, maxDist = 1.6): Slot | null {
    let best: Slot | null = null;
    let bestD = maxDist;
    ROW_Z.forEach((_, r) =>
      BAY_X.forEach((_, s) =>
        LEVEL_Y.forEach((_, l) => {
          const locId = rackLocationId(r, s, l + 1);
          const used = usedSlots.get(locId);
          slotsFor(locId)!.forEach(([sx, sy, sz], index) => {
            if (used?.has(index) || Math.abs(height - sy) > 1.3) return;
            const d = Math.hypot(x - sx, z - sz);
            if (d < bestD) {
              bestD = d;
              best = { locId, index, x: sx, y: sy, z: sz };
            }
          });
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
    /** Waar de speler buiten de hal mag lopen: de deuren naar en de kamers van de aanbouw (kantoor, kantine). */
    walkable: rooms.walkable,
    setDockDoor,
    setDriverDoor,
    /** De bureaus in het kantoor: monitor met de WMS-app en de stoel waarop je ervoor gaat zitten. */
    desks: rooms.desks,
    /** Alle stoelen (kantoor en kantine) als zitplek: plek op de vloer, voorkant = +z. */
    seats: rooms.seats,
    /** Alles waar de speler tegenaan loopt of op kan staan: stellingen, pallets in de stellingen en vaste aankleding. */
    solids: () => solids,
    loadHeight,
    scanTargets,
    setPallets,
    setEmptyPallets,
    setLoose,
    /** De pallets die nu in de stellingen staan. */
    rackPallets: () => rackPallets,
    nearestFreeSlot,
    inRack,
    buildLoad,
    buildOrderLoad,
    palletCapacity,
  };
}

export type Hall = ReturnType<typeof createWarehouse>;
