import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CANTEEN, HALL, ROOMS, ROOM_DOORS as DOOR_SPOTS, type Rect } from '../../sim/layout';
import { COFFEE_SPOTS, coffeeMachine } from './coffee';
import { STYLE, onTop } from './style';
import * as tex from './textures';

// Kantoor (administratie) en kantine: twee kamers in de hal, tegen de zuidwand (de voorkant van het magazijn) in
// de hoek met de dockwand. Vanuit de hal loop je er door een openstaande deur naar binnen. Het kantoor zit op de
// hoek en kijkt door een raam uit over het vrachtwagenterrein; de kantine ligt ernaast, met de parkeerplaats van
// de heftruck en de pompwagen aan de andere kant van haar oostwand.
// Alleen aankleding: geen sim-logica. Stijl: zie "Stijl van 3D-modellen" in CLAUDE.md.

/** Hoogte van de kamers; ze zijn veel lager dan de hal. */
export const ROOM_HEIGHT = 2.9;
const WALL = 0.12; // dikte van de binnenwand tussen kantoor en kantine
// Dikte van de voorzetwand tegen de buitenwanden van de hal (west en zuid): de kolommen van de hal vallen erin weg.
const OUTER = 0.32;
const GAP = 0.02; // de voorzetwand staat zo ver los van het wandvlak van de hal
const SIDE = 0.2; // dikte van de oostwand, naar de parkeerplaats
const HALL_SIDE = 0.16; // dikte van de wand naar de hal (met de deuren)
/** De kolommen langs de zuidwand van de hal staan om de zoveel meter (x), vanaf de dockwand (zie warehouse.ts). */
const COLUMN_PITCH = 7;
const SILL = 0.9; // onderkant van de ramen
const HEAD = 2.3; // bovenkant van de ramen
const DOOR_H = 2.1;

/**
 * Raam in een buitenwand van de hal, ter hoogte van een kamer: `from`..`to` loopt langs z (westwand, de dockgevel)
 * of langs x (zuidwand, de voorgevel). De hal en de gevel laten er een gat voor open (warehouse.ts, exterior.ts).
 */
export type WallWindow = { wall: 'west' | 'south'; from: number; to: number; y0: number; y1: number };

const { office, canteen } = ROOMS;
/** De zuidwand van de hal: de kamers liggen daar aan de binnenkant tegenaan. */
const HALL_WALL = HALL.d / 2;
const canteenMid = (canteen.minX + canteen.maxX) / 2;
/** Staat er in de zuidwand een kolom van de hal in dit stuk (x)? Daar komt geen raam. */
const onColumn = (from: number, to: number) => {
  const first = Math.ceil((from - 0.25 - office.minX) / COLUMN_PITCH);
  return office.minX + first * COLUMN_PITCH <= to + 0.25;
};
const south = (from: number, to: number): WallWindow[] => (to - from < 0.8 || onColumn(from, to) ? [] : [{ wall: 'south', from, to, y0: SILL, y1: HEAD }]);
export const ROOM_WINDOWS: WallWindow[] = [
  { wall: 'west', from: office.minZ + 1.2, to: office.maxZ - 1.2, y0: SILL, y1: HEAD }, // uitzicht op het vrachtwagenterrein
  ...south(office.minX + 1.5, office.maxX - 1.5),
  ...south(canteen.minX + 1.6, canteenMid - 0.4),
  ...south(canteenMid + 0.4, canteen.maxX - 1.6),
];

const door = (text: string, at: { x: number; half: number }) => ({ text, x: at.x, from: at.x - at.half, to: at.x + at.half, height: DOOR_H });
/** Deuropeningen in de wand van de kamers naar de hal (langs x); waar ze zitten staat in src/sim/layout.ts. */
export const ROOM_DOORS = [door('KANTOOR', DOOR_SPOTS.office), door('KANTINE', DOOR_SPOTS.canteen)];

/** Beeldvlak van de monitor op een kantoorbureau (m): 16:9, net binnen de behuizing. */
const DESK_SCREEN = { w: 0.52, h: 0.52 * (9 / 16) };
/** Bovenkant van de zitting van een stoel (m). */
const CHAIR_SEAT = 0.485;
/** Wie op een stoel zit: hoogte van de heupen, en waar hoofd en ogen dan zitten (m boven de vloer). */
export const CHAIR_HIP_Y = CHAIR_SEAT + 0.09;
export const CHAIR_HEAD_Y = CHAIR_HIP_Y + 0.56;
export const CHAIR_EYE_Y = CHAIR_HIP_Y + 0.68;

/** Werkplek in het kantoor: het beeldvlak van de monitor (w × h m) en de stoel ervoor (op x, z; voorkant = +z van `seat`). */
export type OfficeDesk = { display: THREE.Object3D; w: number; h: number; x: number; z: number; seat: THREE.Object3D };

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

/** Koelkast zonder deur: een open kast met plateaus en wat erin staat. De deur is een los onderdeel (fridgeDoor). */
function fridge(): Part[] {
  const shelves = [0.5, 0.86, 1.2, 1.5];
  return [
    [STYLE.steel, rb(0.03, 1.8, 0.58, 0.012, -0.295, 0.9, -0.02)],
    [STYLE.steel, rb(0.03, 1.8, 0.58, 0.012, 0.295, 0.9, -0.02)],
    [STYLE.steel, rb(0.56, 0.03, 0.58, 0.012, 0, 1.785, -0.02)],
    [STYLE.steel, rb(0.56, 0.14, 0.58, 0.012, 0, 0.07, -0.02)],
    [STYLE.white, rb(0.56, 1.62, 0.03, 0.01, 0, 0.95, -0.29)],
    ...shelves.map((y): Part => [STYLE.white, rb(0.56, 0.015, 0.5, 0.005, 0, y, -0.03)]),
    // lunchtrommels, pakken en flessen
    [STYLE.blue, rb(0.18, 0.07, 0.12, 0.015, -0.14, 1.243, 0.02)],
    [STYLE.paint, rb(0.18, 0.07, 0.12, 0.015, 0.12, 1.243, -0.06)],
    [STYLE.green, rb(0.18, 0.07, 0.12, 0.015, -0.1, 0.903, -0.04)],
    [STYLE.blue, rb(0.18, 0.07, 0.12, 0.015, 0.14, 0.543, 0)],
    [STYLE.white, rb(0.08, 0.2, 0.08, 0.01, 0.16, 0.968, -0.1)],
    [STYLE.wood, rb(0.08, 0.2, 0.08, 0.01, -0.18, 1.608, -0.08)],
    [STYLE.green, cyl(0.035, 0.24, 0.02, 1.628, -0.1)],
    [STYLE.dark, cyl(0.035, 0.24, 0.14, 1.628, -0.02)],
  ];
}

/** De deur van de koelkast, rond zijn scharnier (de y-as): dicht ligt hij langs +x voor de kast. */
function fridgeDoor(): Part[] {
  return [
    [STYLE.steel, rb(0.6, 1.76, 0.04, 0.015, 0.3, 0.9, 0.02)],
    [STYLE.dark, rb(0.02, 0.5, 0.03, 0.008, 0.52, 1.2, 0.053)],
    [STYLE.white, rb(0.5, 0.06, 0.07, 0.01, 0.3, 0.6, -0.035)], // deurvak
    [STYLE.white, rb(0.5, 0.06, 0.07, 0.01, 0.3, 1.15, -0.035)],
  ];
}

/** Keukenblok met spoelbak, kraan en magnetron; het koffieapparaat (coffee.ts) staat er los op. */
function counter(len: number): Part[] {
  return [
    [STYLE.white, rb(len, 0.86, 0.6, 0.012, 0, 0.43, 0)],
    [STYLE.wood, rb(len + 0.02, 0.04, 0.63, 0.012, 0, 0.88, 0)],
    [STYLE.steel, rb(0.5, 0.012, 0.38, 0.005, -len / 2 + 0.6, 0.903, 0)],
    [STYLE.steel, cyl(0.012, 0.24, -len / 2 + 0.6, 1.02, -0.22)],
    [STYLE.steel, new THREE.CylinderGeometry(0.012, 0.012, 0.16, 10).rotateX(Math.PI / 2).translate(-len / 2 + 0.6, 1.14, -0.14)],
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
  const all: Rect = { minX: office.minX, maxX: canteen.maxX, minZ: office.minZ, maxZ: HALL_WALL };
  /** Buitenkant (z) van de wand naar de hal, en de binnenkant ervan: daar zitten de deuren in. */
  const front = all.minZ;
  const frontZ = front + HALL_SIDE;
  /** Binnenkant van de voorzetwanden (west en zuid) en van de oostwand. */
  const westX = all.minX + GAP + OUTER;
  const southZ = HALL_WALL - GAP - OUTER;
  const eastX = all.maxX - SIDE;

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
    solid(x, z, turned ? block[1] : block[0], turned ? block[0] : block[1], 0, reach(block[2]));
  };
  // Het plafond is massief: je stoot je hoofd eraan. Waar je niet rechtop op kunt staan (koelkast, kast, automaat,
  // deurblad) loopt het blok door tot het plafond, zodat je er niet op kunt klimmen en door het dak de hal in komt.
  const reach = (top: number) => (top > ROOM_HEIGHT - 1.85 ? ROOM_HEIGHT : top);
  solid((all.minX + all.maxX) / 2, (front + HALL_WALL) / 2, all.maxX - all.minX, HALL_WALL - front, ROOM_HEIGHT, ROOM_HEIGHT + 0.3);

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
  // De wand naar de hal (met de deuropeningen) en de oostwand naar de parkeerplaats staan vrij in de hal. Tegen de
  // dockwand en de zuidwand staat een voorzetwand met de ramen: 2 cm los van het wandvlak van de hal, dat op de
  // plek van de ramen open is.
  wallRun('x', front + HALL_SIDE / 2, all.minX + GAP, all.maxX, HALL_SIDE, ROOM_DOORS.map((d) => ({ from: d.from, to: d.to, y0: 0, y1: d.height })));
  const windows = (wall: WallWindow['wall']) => ROOM_WINDOWS.filter((w) => w.wall === wall).map((w): Opening => ({ ...w, glass: true }));
  wallRun('z', all.minX + GAP + OUTER / 2, frontZ, HALL_WALL - GAP, OUTER, windows('west'));
  wallRun('z', all.maxX - SIDE / 2, frontZ, HALL_WALL - GAP, SIDE, []);
  wallRun('x', HALL_WALL - GAP - OUTER / 2, westX, eastX, OUTER, windows('south'));
  wallRun('z', office.maxX, frontZ, southZ, WALL, []); // tussen kantoor en kantine

  // De vloeren: een dunne plaat op de halvloer
  const floor = (mat: THREE.Material, x0: number, x1: number) =>
    box(mat, x1 - x0, 0.012, southZ - frontZ, (x0 + x1) / 2, 0.006, (frontZ + southZ) / 2);
  floor(STYLE.carpet, westX, office.maxX - WALL / 2);
  floor(STYLE.vinyl, canteen.minX + WALL / 2, eastX);

  // Openstaande deuren: het blad staat de kamer in gedraaid, naast de opening
  const OPEN = (80 * Math.PI) / 180;
  for (const d of ROOM_DOORS) {
    const w = d.to - d.from - 0.1;
    const h = d.height - 0.07;
    const hingeX = d.to - 0.05;
    const hingeZ = frontZ + 0.03;
    const leaf: Part[] = [
      [STYLE.blue, rb(w, h, 0.04, 0.012, w / 2, h / 2 + 0.01, 0)],
      [STYLE.steel, rb(0.14, 0.025, 0.11, 0.01, w - 0.11, 1.03, 0)], // klink, steekt aan beide kanten uit
    ];
    for (const [mat, geo] of leaf) put(mat, geo.rotateY(-OPEN).translate(hingeX, 0, hingeZ));
    solid(hingeX + (Math.cos(OPEN) * w) / 2, hingeZ + (Math.sin(OPEN) * w) / 2, 0.2, w, 0, reach(d.height));
  }

  // ---------- Kantoor: vier bureaus (twee aan het raam, twee tegen de tussenwand), kasten naast de deur ----------
  const QUARTER = Math.PI / 2;
  const officeMidZ = (office.minZ + office.maxZ) / 2;
  // Op elk bureau draait de WMS-app (src/ui/pcScreen.ts legt hem over het beeldvlak); je gaat ervoor op de stoel zitten.
  const screens = new THREE.Group();
  scene.add(screens);
  const screenMat = onTop(new THREE.MeshBasicMaterial({ color: '#0b0d10' }));
  const desks: OfficeDesk[] = [];
  /** Elke stoel als zitplek: op de vloer onder de stoel, voorkant (+z) waar je heen kijkt als je zit. */
  const seats: THREE.Object3D[] = [];
  const seatAt = (x: number, z: number, ry: number) => {
    const seat = new THREE.Object3D();
    seat.position.set(x, 0, z);
    seat.rotation.y = ry;
    screens.add(seat);
    seats.push(seat);
    return seat;
  };
  // Vier werkplekken: twee aan het raam (west) en twee ertegenover tegen de tussenwand (oost), met een gangpad ertussen.
  // side = de kant waar je zit ten opzichte van het bureau: +1 = aan de oostkant ervan, -1 = aan de westkant.
  for (const [deskX, side] of [[westX + 0.44, 1], [office.maxX - WALL / 2 - 0.44, -1]]) {
    for (const dz of [-1.35, 1.35]) {
      const chairX = deskX + side * 0.64; // aangeschoven: de zitting raakt net de rand van het blad
      const z = officeMidZ + dz;
      place(desk(), deskX, z, side * QUARTER, [1.6, 0.8, 0.76]);
      place(chair(), chairX, z, -side * QUARTER);
      // Beeldvlak (16:9) vlak voor de monitor, naar de stoel gericht
      const display = new THREE.Mesh(new THREE.PlaneGeometry(DESK_SCREEN.w, DESK_SCREEN.h), screenMat);
      display.position.set(deskX - side * 0.182, 1.06, z);
      display.rotation.y = side * QUARTER;
      // De stoel als zitplek: voorkant (+z) naar het bureau
      const seat = seatAt(chairX, z, -side * QUARTER);
      screens.add(display);
      desks.push({ display, ...DESK_SCREEN, x: chairX, z, seat });
    }
  }
  const deskSeats = seats.length;
  // Kasten tegen de wand naar de hal, naast de deur
  for (let i = 0; i < 3; i++) place(cabinet(), westX + 0.75 + i * 0.85, frontZ + 0.25, 0, [0.8, 0.45, 1.3]);
  place(plant(), office.maxX - 0.5, southZ - 0.4);

  // ---------- Kantine: keukenblok met het koffieapparaat en de koelkast langs de oostwand, twee tafels, automaat ----------
  // Waar alles staat komt uit src/sim/layout.ts (CANTEEN): de chauffeurs halen hier koffie en schuiven aan.
  const block = CANTEEN.counter;
  const fridgeZ = southZ - 0.36;
  place(fridge(), block.x, fridgeZ, -QUARTER, [0.62, 0.62, 1.8]);
  // De deur van de koelkast gaat echt open: hij scharniert aan de kant van het keukenblok
  const fridgeHinge = new THREE.Group();
  fridgeHinge.position.set(block.x - 0.27, 0, fridgeZ - 0.29);
  fridgeHinge.rotation.y = -QUARTER;
  for (const [mat, geo] of fridgeDoor()) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = m.receiveShadow = true;
    fridgeHinge.add(m);
  }
  scene.add(fridgeHinge);
  place(counter(block.length), block.x, block.z, -QUARTER, [block.length, 0.63, 0.9]);
  place(coffeeMachine(), CANTEEN.machine.x, CANTEEN.machine.z, -QUARTER);
  /** Waar je staat voor het aanrecht of de koelkast (x), met je gezicht ernaartoe. */
  const standX = block.x - 0.31 - 0.5;
  const stations = {
    /** Koffieapparaat: waar je staat, en waar de beker onder de uitloop staat (de onderkant van de beker). */
    coffee: { ...CANTEEN.coffeeStand, hand: new THREE.Vector3(CANTEEN.machine.x - COFFEE_SPOTS.cup.z, COFFEE_SPOTS.cup.y, CANTEEN.machine.z) },
    /** Koelkast: het plateau met de lunchtrommels. */
    fridge: { x: standX + 0.1, z: fridgeZ + 0.04, r: QUARTER, hand: new THREE.Vector3(block.x - 0.2, 1.3, fridgeZ + 0.06) },
    /** Spoelbak. */
    sink: { x: standX, z: block.z - block.length / 2 + 0.6, r: QUARTER, hand: new THREE.Vector3(block.x - 0.05, 0.98, block.z - block.length / 2 + 0.6) },
  };
  for (const t of CANTEEN.tables) place(table(1.8, 0.8), t.x, t.z, 0, [1.8, 0.8, 0.76]);
  for (const s of CANTEEN.seats) {
    place(chair(), s.x, s.z, s.r);
    seatAt(s.x, s.z, s.r);
  }
  place(vendingMachine(), canteen.minX + WALL / 2 + 0.42, frontZ + 1.2, QUARTER, [0.95, 0.8, 1.85]);
  place(plant(), canteen.minX + 0.5, southZ - 0.4);

  for (const [mat, geos] of parts) {
    const m = new THREE.Mesh(mergeGeometries(geos), mat);
    const glass = mat === STYLE.glass;
    m.castShadow = !glass;
    m.receiveShadow = !glass;
    scene.add(m);
  }

  // ---------- Plafond met lichtbakken en het platte dak (verborgen in de overzicht-modus) ----------
  // Net als het dak van de hal werpen ze geen schaduw: het licht valt gewoon naar binnen.
  const roofTo = HALL_WALL - GAP; // tot tegen de zuidwand van de hal
  const roofFrom = all.minX + GAP; // en tot tegen de dockwand
  const ceiling = new THREE.Mesh(new THREE.BoxGeometry(all.maxX - roofFrom, 0.08, roofTo - front), STYLE.ceiling);
  ceiling.position.set((roofFrom + all.maxX) / 2, ROOM_HEIGHT + 0.04, (front + roofTo) / 2);
  // het dak steekt aan de vrije kanten (hal en parkeerplaats) een stukje over
  const roofSlab = new THREE.Mesh(new THREE.BoxGeometry(all.maxX - roofFrom + 0.15, 0.22, roofTo - front + 0.15), STYLE.dark);
  roofSlab.position.set((roofFrom + all.maxX + 0.15) / 2, ROOM_HEIGHT + 0.19, (front - 0.15 + roofTo) / 2);
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
    s.position.set(d.x, d.height + 0.42, front - 0.012);
    s.rotation.y = Math.PI; // leesbaar vanuit de hal
    scene.add(s);
  }

  /** Voor de kantoormedewerkers (src/sim/staff.ts): waar de deuren, de bureaustoelen, de kantinestoelen en het aanrecht zijn. */
  const pose = (s: THREE.Object3D) => ({ x: s.position.x, z: s.position.z, r: s.rotation.y });
  const staff = {
    /** De lijn (z) in de hal voor de deuren langs. */
    frontZ: front - 1.2,
    office: { door: ROOM_DOORS[0].x, inZ: frontZ + 0.9, aisle: (westX + office.maxX - WALL / 2) / 2, desks: seats.slice(0, deskSeats).map(pose) },
    canteen: { door: ROOM_DOORS[1].x, inZ: frontZ + 0.9, ...stations, seats: seats.slice(deskSeats).map(pose) },
    /** Het aantal bureaustoelen: de eerste stoelen in `seats`; daarna komen de kantinestoelen. */
    deskSeats,
    /** @param open 0 = koelkast dicht, 1 = open */
    setFridge(open: number) {
      fridgeHinge.rotation.y = -QUARTER - open * 1.6;
    },
  };
  /** footprint: het blok dat de kamers in de hal innemen (daar rijdt de heftruck niet doorheen). */
  return { footprint: all, desks, seats, staff };
}
