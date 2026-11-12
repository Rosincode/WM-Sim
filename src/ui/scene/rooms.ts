import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HALL, ROOMS, WALKWAY_X, type Rect } from '../../sim/layout';
import { STYLE, onTop } from './style';
import * as tex from './textures';

// Kantoor (administratie) en kantine: een aanbouw buiten tegen de noordgevel, bij de hoek met de dockgevel.
// Vanuit de hal loop je er door een openstaande deur in de noordwand naar binnen. Het kantoor zit op de hoek
// en kijkt door een raam uit over het vrachtwagenterrein; de kantine ligt ernaast.
// Alleen aankleding: geen sim-logica. Stijl: zie "Stijl van 3D-modellen" in CLAUDE.md.

/** Hoogte van de kamers; de aanbouw is veel lager dan de hal. */
export const ROOM_HEIGHT = 2.9;
const WALL = 0.12; // dikte van de binnenwand tussen kantoor en kantine
const OUTER = 0.2; // dikte van de buitenwanden van de aanbouw
const HALL_SIDE = 0.16; // dikte van de wand tussen de aanbouw en de hal (met de deuren)
const SILL = 0.9; // onderkant van de ramen
const HEAD = 2.3; // bovenkant van de ramen
const DOOR_H = 2.1;

/**
 * Raam in een buitenwand van de aanbouw: `from`..`to` loopt langs z (westwand) of langs x (noordwand);
 * `at` is de buitenkant van die wand (x voor west, z voor noord).
 */
export type WallWindow = { wall: 'west' | 'north'; at: number; from: number; to: number; y0: number; y1: number };

const { office, canteen } = ROOMS;
/** De noordwand van de hal: de aanbouw ligt daar aan de buitenkant tegenaan. */
const HALL_WALL = -HALL.d / 2;
const canteenMid = (canteen.minX + canteen.maxX) / 2;
export const ROOM_WINDOWS: WallWindow[] = [
  { wall: 'west', at: office.minX, from: office.minZ + 1.2, to: office.maxZ - 1.2, y0: SILL, y1: HEAD }, // uitzicht op het terrein
  { wall: 'north', at: office.minZ, from: office.minX + 1.5, to: office.maxX - 1.5, y0: SILL, y1: HEAD },
  { wall: 'north', at: office.minZ, from: canteen.minX + 1.6, to: canteenMid - 0.4, y0: SILL, y1: HEAD },
  { wall: 'north', at: office.minZ, from: canteenMid + 0.4, to: canteen.maxX - 1.6, y0: SILL, y1: HEAD },
];

const COLUMN_PITCH = 7; // de kolommen langs de halwand staan om de 7 m (zie warehouse.ts)
/** Midden van een deur van 2 × `half` breed in de halwand: zo dicht mogelijk bij x, binnen de kamer en vrij van de kolommen. */
function doorAt(x: number, r: Rect, half: number) {
  const within = (v: number) => Math.min(r.maxX - half - 0.6, Math.max(r.minX + half + 0.6, v));
  let c = within(x);
  const column = -HALL.w / 2 + Math.round((c + HALL.w / 2) / COLUMN_PITCH) * COLUMN_PITCH;
  const clear = half + 0.45;
  if (Math.abs(c - column) < clear) c = within(column + (c < column ? -clear : clear));
  return c;
}
const door = (text: string, x: number, half: number) => ({ text, x, from: x - half, to: x + half, height: DOOR_H });
/** Deuropeningen in de noordwand van de hal (langs x): die van de kantine ligt waar het looppad op de wand uitkomt (als het past). */
export const ROOM_DOORS = [
  door('KANTOOR', doorAt(office.maxX - 1.2, office, 0.55), 0.55),
  door('KANTINE', doorAt(WALKWAY_X, canteen, 0.6), 0.6),
];

type Part = [THREE.Material, THREE.BufferGeometry];
type Opening = { from: number; to: number; y0: number; y1: number; glass?: boolean };

interface Options {
  scene: THREE.Scene;
  /** Groep die in de overzicht-modus verborgen is: plafond en dak gaan daarin, zodat je van boven naar binnen kijkt. */
  roof: THREE.Group;
  /** Massief blok voor de speler: midden (x, z), breedte, diepte, onder- en bovenkant. */
  solid: (x: number, z: number, w: number, d: number, minY: number, maxY: number) => void;
}

const rb = (w: number, h: number, d: number, r: number, x = 0, y = 0, z = 0) => new RoundedBoxGeometry(w, h, d, 2, r).translate(x, y, z);
const cyl = (r: number, h: number, x = 0, y = 0, z = 0, top = r) => new THREE.CylinderGeometry(top, r, h, 14).translate(x, y, z);

// ---------- Meubels: opgebouwd rond (0, 0) op de vloer, voorkant naar +z ----------
function chair(): Part[] {
  const legs = [-0.19, 0.19].flatMap((x) => [cyl(0.014, 0.45, x, 0.225, 0.18), cyl(0.014, 0.95, x, 0.475, -0.2)]);
  return [
    [STYLE.blue, rb(0.44, 0.05, 0.42, 0.02, 0, 0.46, 0)],
    [STYLE.blue, rb(0.42, 0.34, 0.04, 0.018, 0, 0.8, -0.2)],
    ...legs.map((g): Part => [STYLE.steel, g]),
  ];
}

function table(w: number, d: number): Part[] {
  const legs = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => cyl(0.022, 0.72, sx * (w / 2 - 0.09), 0.36, sz * (d / 2 - 0.09))));
  return [[STYLE.wood, rb(w, 0.04, d, 0.015, 0, 0.74, 0)], ...legs.map((g): Part => [STYLE.steel, g])];
}

/** Bureau met beeldscherm en toetsenbord; je zit aan de kant van +z. */
function desk(): Part[] {
  return [
    [STYLE.wood, rb(1.6, 0.04, 0.8, 0.015, 0, 0.74, 0)],
    [STYLE.white, rb(0.04, 0.72, 0.74, 0.012, -0.76, 0.36, 0)],
    [STYLE.white, rb(0.04, 0.72, 0.74, 0.012, 0.76, 0.36, 0)],
    [STYLE.white, rb(1.5, 0.4, 0.03, 0.012, 0, 0.5, -0.36)],
    [STYLE.black, rb(0.56, 0.34, 0.03, 0.012, 0, 1.06, -0.2)],
    [STYLE.black, cyl(0.02, 0.16, 0, 0.84, -0.22)],
    [STYLE.black, rb(0.22, 0.016, 0.15, 0.006, 0, 0.768, -0.22)],
    [STYLE.dark, rb(0.42, 0.02, 0.14, 0.008, 0, 0.77, 0.12)],
  ];
}

function cabinet(): Part[] {
  return [
    [STYLE.white, rb(0.8, 1.3, 0.45, 0.02, 0, 0.65, 0)],
    ...[0.32, 0.75, 1.12].map((y): Part => [STYLE.dark, rb(0.22, 0.02, 0.025, 0.008, 0, y, 0.235)]),
  ];
}

function fridge(): Part[] {
  return [
    [STYLE.steel, rb(0.62, 1.8, 0.62, 0.03, 0, 0.9, 0)],
    [STYLE.dark, rb(0.02, 0.5, 0.03, 0.008, -0.22, 1.2, 0.32)],
    [STYLE.dark, rb(0.6, 0.012, 0.01, 0.004, 0, 0.62, 0.312)],
  ];
}

/** Keukenblok met spoelbak, kraan, koffieapparaat en magnetron. */
function counter(len: number): Part[] {
  return [
    [STYLE.white, rb(len, 0.86, 0.6, 0.012, 0, 0.43, 0)],
    [STYLE.wood, rb(len + 0.02, 0.04, 0.63, 0.012, 0, 0.88, 0)],
    [STYLE.steel, rb(0.5, 0.012, 0.38, 0.005, -len / 2 + 0.6, 0.903, 0)],
    [STYLE.steel, cyl(0.012, 0.24, -len / 2 + 0.6, 1.02, -0.22)],
    [STYLE.steel, new THREE.CylinderGeometry(0.012, 0.012, 0.16, 10).rotateX(Math.PI / 2).translate(-len / 2 + 0.6, 1.14, -0.14)],
    [STYLE.black, rb(0.28, 0.38, 0.32, 0.03, 0.1, 1.09, -0.08)],
    [STYLE.paint, rb(0.06, 0.03, 0.01, 0.004, 0.1, 1.2, 0.083)],
    [STYLE.white, rb(0.5, 0.29, 0.36, 0.02, len / 2 - 0.45, 1.045, -0.06)],
    [STYLE.black, rb(0.34, 0.2, 0.01, 0.004, len / 2 - 0.5, 1.045, 0.123)],
    ...[-1, 0, 1].map((i): Part => [STYLE.dark, rb(0.18, 0.02, 0.025, 0.008, (i * len) / 3.2, 0.72, 0.31)]),
  ];
}

function vendingMachine(): Part[] {
  return [
    [STYLE.paint, rb(0.95, 1.85, 0.8, 0.03, 0, 0.925, 0)],
    [STYLE.black, rb(0.58, 1.05, 0.012, 0.005, -0.13, 1.2, 0.402)],
    [STYLE.steel, rb(0.16, 0.32, 0.012, 0.005, 0.32, 1.25, 0.402)],
    [STYLE.black, rb(0.58, 0.16, 0.012, 0.005, -0.13, 0.4, 0.402)],
  ];
}

function plant(): Part[] {
  return [
    [STYLE.dark, cyl(0.14, 0.36, 0, 0.18, 0, 0.18)],
    [STYLE.green, new THREE.IcosahedronGeometry(0.3, 1).scale(1, 1.25, 1).translate(0, 0.72, 0)],
    [STYLE.green, new THREE.IcosahedronGeometry(0.2, 1).translate(0.12, 1.05, 0.05)],
  ];
}

export function createRooms({ scene, roof, solid }: Options) {
  const back = office.minZ; // buitenkant van de noordwand van de aanbouw
  /** Binnenkant van de wand naar de hal: daar zitten de deuren in. */
  const frontZ = HALL_WALL - 0.02 - HALL_SIDE;
  const all: Rect = { minX: office.minX, maxX: canteen.maxX, minZ: back, maxZ: HALL_WALL };

  // Alles met hetzelfde materiaal gaat samen in één mesh.
  const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const put = (mat: THREE.Material, geo: THREE.BufferGeometry) => {
    const list = parts.get(mat) ?? [];
    list.push(geo.index ? geo.toNonIndexed() : geo);
    parts.set(mat, list);
  };
  const box = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number) =>
    put(mat, new THREE.BoxGeometry(w, h, d).translate(x, y, z));
  /** Zet een meubel neer op (x, z), gedraaid om de verticale as; `block` = [breedte, diepte, hoogte] waar je tegenaan loopt. */
  const place = (item: Part[], x: number, z: number, ry = 0, block?: [number, number, number]) => {
    for (const [mat, geo] of item) put(mat, geo.rotateY(ry).translate(x, 0, z));
    if (!block) return;
    const turned = Math.abs(Math.sin(ry)) > 0.5; // een kwartslag gedraaid: breedte en diepte wisselen
    solid(x, z, turned ? block[1] : block[0], turned ? block[0] : block[1], 0, block[2]);
  };

  /**
   * Wand langs x (op z = at) of langs z (op x = at) met openingen: een deur begint op de vloer, een raam krijgt
   * glas en een kozijn. `walk` false: geen botsblokken.
   */
  function wallRun(axis: 'x' | 'z', at: number, from: number, to: number, thick: number, openings: Opening[], walk = true) {
    const piece = (mat: THREE.Material, a: number, b: number, y0: number, y1: number, t: number, block: boolean) => {
      if (b - a < 0.001 || y1 - y0 < 0.001) return;
      const [w, d, x, z] = axis === 'x' ? [b - a, t, (a + b) / 2, at] : [t, b - a, at, (a + b) / 2];
      box(mat, w, y1 - y0, d, x, (y0 + y1) / 2, z);
      if (block) solid(x, z, w, d, y0, y1);
    };
    let cur = from;
    for (const o of [...openings].sort((a, b) => a.from - b.from)) {
      piece(STYLE.white, cur, o.from, 0, ROOM_HEIGHT, thick, walk);
      piece(STYLE.white, o.from, o.to, 0, o.y0, thick, walk);
      piece(STYLE.white, o.from, o.to, o.y1, ROOM_HEIGHT, thick, walk);
      // kozijn: stijlen, boven- en onderdorpel (een deur heeft geen onderdorpel)
      const f = 0.05;
      const t = thick + 0.03;
      piece(STYLE.dark, o.from, o.from + f, o.y0, o.y1, t, false);
      piece(STYLE.dark, o.to - f, o.to, o.y0, o.y1, t, false);
      piece(STYLE.dark, o.from, o.to, o.y1 - f, o.y1, t, false);
      if (o.glass) {
        piece(STYLE.dark, o.from, o.to, o.y0, o.y0 + f, t, false);
        const panes = Math.max(1, Math.round((o.to - o.from) / 1.4));
        for (let i = 1; i < panes; i++) {
          const m = o.from + ((o.to - o.from) * i) / panes;
          piece(STYLE.dark, m - 0.02, m + 0.02, o.y0, o.y1, t, false);
        }
        piece(STYLE.glass, o.from, o.to, o.y0, o.y1, 0.015, walk); // door het raam loop je niet
      }
      cur = o.to;
    }
    piece(STYLE.white, cur, to, 0, ROOM_HEIGHT, thick, walk);
  }

  // ---------- Wanden ----------
  // De wand naar de hal staat 2 cm achter de halwand (die op de plek van de deuren open is) en heeft de deuropeningen.
  wallRun('x', HALL_WALL - 0.02 - HALL_SIDE / 2, all.minX + OUTER, all.maxX - OUTER, HALL_SIDE, ROOM_DOORS.map((d) => ({ from: d.from, to: d.to, y0: 0, y1: d.height })));
  const windows = (wall: 'west' | 'north') => ROOM_WINDOWS.filter((w) => w.wall === wall).map((w): Opening => ({ ...w, glass: true }));
  wallRun('z', all.minX + OUTER / 2, back, HALL_WALL - 0.01, OUTER, windows('west'));
  wallRun('z', all.maxX - OUTER / 2, back, HALL_WALL - 0.01, OUTER, []);
  wallRun('x', back + OUTER / 2, all.minX + OUTER, all.maxX - OUTER, OUTER, windows('north'));
  wallRun('z', office.maxX, back + OUTER, frontZ, WALL, []); // tussen kantoor en kantine

  // Fundering (ook de drempel in de deuropeningen) en de vloeren
  box(STYLE.dark, all.maxX - all.minX, 0.3, HALL_WALL - back, (all.minX + all.maxX) / 2, -0.15, (back + HALL_WALL) / 2);
  const floor = (mat: THREE.Material, x0: number, x1: number) =>
    box(mat, x1 - x0, 0.012, frontZ - back - OUTER, (x0 + x1) / 2, 0.006, (back + OUTER + frontZ) / 2);
  floor(STYLE.carpet, office.minX + OUTER, office.maxX - WALL / 2);
  floor(STYLE.vinyl, canteen.minX + WALL / 2, canteen.maxX - OUTER);

  // Openstaande deuren: het blad staat de kamer in gedraaid, naast de opening
  const OPEN = (80 * Math.PI) / 180;
  for (const d of ROOM_DOORS) {
    const w = d.to - d.from - 0.1;
    const h = d.height - 0.07;
    const hingeX = d.to - 0.05;
    const hingeZ = frontZ - 0.03;
    const leaf: Part[] = [
      [STYLE.blue, rb(w, h, 0.04, 0.012, w / 2, h / 2 + 0.01, 0)],
      [STYLE.steel, rb(0.14, 0.025, 0.11, 0.01, w - 0.11, 1.03, 0)], // klink, steekt aan beide kanten uit
    ];
    for (const [mat, geo] of leaf) put(mat, geo.rotateY(OPEN).translate(hingeX, 0, hingeZ));
    solid(hingeX + (Math.cos(OPEN) * w) / 2, hingeZ - (Math.sin(OPEN) * w) / 2, 0.2, w, 0, d.height);
  }

  // ---------- Kantoor: twee bureaus aan het raam met uitzicht op het terrein, kasten langs de tussenwand ----------
  const QUARTER = Math.PI / 2;
  const officeMidZ = (office.minZ + office.maxZ) / 2;
  for (const dz of [-1.35, 1.35]) {
    place(desk(), office.minX + OUTER + 0.44, officeMidZ + dz, QUARTER, [1.6, 0.8, 0.76]);
    place(chair(), office.minX + OUTER + 1.18, officeMidZ + dz, -QUARTER);
  }
  for (let i = 0; i < 3; i++) place(cabinet(), office.maxX - WALL / 2 - 0.25, office.minZ + 1.5 + i * 0.85, -QUARTER, [0.8, 0.45, 1.3]);
  place(plant(), office.maxX - 0.5, office.minZ + 0.6);

  // ---------- Kantine: keukenblok en koelkast langs de oostwand, twee tafels, automaat ----------
  const counterX = canteen.maxX - OUTER - 0.33;
  place(fridge(), counterX, canteen.minZ + 0.6, -QUARTER, [0.62, 0.62, 1.8]);
  place(counter(3.2), counterX, canteen.minZ + 2.6, -QUARTER, [3.2, 0.63, 0.9]);
  const tableX = canteen.minX + Math.min(3.2, (canteen.maxX - canteen.minX) / 2 - 0.6);
  for (const tz of [canteen.minZ + 2.2, canteen.minZ + 4.9]) {
    if (tz + 1.2 > frontZ) continue;
    place(table(1.8, 0.8), tableX, tz, 0, [1.8, 0.8, 0.76]);
    for (const dx of [-0.6, 0, 0.6]) {
      place(chair(), tableX + dx, tz - 0.62, 0);
      place(chair(), tableX + dx, tz + 0.62, Math.PI);
    }
  }
  place(vendingMachine(), canteen.minX + WALL / 2 + 0.42, frontZ - 1.2, QUARTER, [0.95, 0.8, 1.85]);
  place(plant(), canteen.minX + 0.5, canteen.minZ + 0.6);

  for (const [mat, geos] of parts) {
    const m = new THREE.Mesh(mergeGeometries(geos), mat);
    const glass = mat === STYLE.glass;
    m.castShadow = !glass;
    m.receiveShadow = !glass;
    scene.add(m);
  }

  // ---------- Plafond met lichtbakken en het platte dak (verborgen in de overzicht-modus) ----------
  // Net als het dak van de hal werpen ze geen schaduw: het daglicht valt gewoon naar binnen.
  const roofTo = HALL_WALL - 0.035; // tot tegen de gevel van de hal
  const ceiling = new THREE.Mesh(new THREE.BoxGeometry(all.maxX - all.minX, 0.08, roofTo - back), STYLE.ceiling);
  ceiling.position.set((all.minX + all.maxX) / 2, ROOM_HEIGHT + 0.04, (back + roofTo) / 2);
  const roofSlab = new THREE.Mesh(new THREE.BoxGeometry(all.maxX - all.minX + 0.3, 0.22, roofTo - back + 0.15), STYLE.dark);
  roofSlab.position.set((all.minX + all.maxX) / 2, ROOM_HEIGHT + 0.19, (back - 0.15 + roofTo) / 2);
  roof.add(ceiling, roofSlab);
  const lampMat = new THREE.MeshBasicMaterial();
  lampMat.color.setRGB(3.2, 3.2, 3);
  const lamps: THREE.BufferGeometry[] = [];
  for (const r of [office, canteen]) {
    for (const fx of [0.3, 0.7])
      for (const fz of [0.3, 0.7])
        lamps.push(new THREE.PlaneGeometry(1.2, 0.3).rotateX(Math.PI / 2).translate(r.minX + (r.maxX - r.minX) * fx, ROOM_HEIGHT - 0.005, r.minZ + (r.maxZ - r.minZ) * fz));
    // de lampen van de hal reiken hier niet: elke kamer heeft zijn eigen licht
    const light = new THREE.PointLight('#fff4e2', 4, 10, 2);
    light.position.set((r.minX + r.maxX) / 2, ROOM_HEIGHT - 0.4, (r.minZ + r.maxZ) / 2);
    scene.add(light);
  }
  roof.add(new THREE.Mesh(mergeGeometries(lamps), onTop(lampMat)));

  // ---------- Bordjes boven de deuren, aan de kant van de hal ----------
  const signGeo = new THREE.PlaneGeometry(1.0, 0.5);
  for (const d of ROOM_DOORS) {
    const s = new THREE.Mesh(signGeo, onTop(new THREE.MeshStandardMaterial({ map: tex.sign(d.text, '#17346b', '#ffffff'), roughness: 0.7 })));
    s.position.set(d.x, d.height + 0.42, HALL_WALL + 0.012);
    scene.add(s);
  }

  /** Waar de speler buiten de hal mag lopen: de deuropeningen en de kamers erachter (de wanden zijn massief). */
  const walkable: Rect[] = [
    { minX: all.minX, maxX: all.maxX, minZ: back, maxZ: frontZ },
    ...ROOM_DOORS.map((d): Rect => ({ minX: d.from, maxX: d.to, minZ: frontZ - 0.5, maxZ: HALL_WALL + 0.7 })),
  ];
  return { walkable };
}
