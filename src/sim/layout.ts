// Fysieke layout van het magazijn. Alles hier is afgeleid van het model in ./warehouse.json:
// wie de hal anders wil indelen past alleen dat bestand aan (maten in meters, draaiing in graden).
//
//   hall            binnenmaat van het gebouw; het midden ligt op (0, 0)
//   racks           stellingen: rijen (langs z) x secties (langs x) x niveaus (levelHeights = hoogte per niveau,
//                   minstens twee), met palletsPerLocation palletplekken naast elkaar per locatie.
//                   De rijen staan rug-aan-rug: rij 1 staat alleen, daarna pad, rij 2 en 3 tegen elkaar, pad,
//                   rij 4 en 5, enzovoort. Elke rij is dus vanaf één pad te bereiken. rowPitch = afstand tussen
//                   twee rijen aan weerszijden van een pad, backToBackPitch = tussen twee rijen rug-aan-rug
//   docks           dockdeuren in de westwand (x = -width/2), elk met een inslag- en een uitslagbaan
//   desk            bureau met de pc; radio en printer staan erop (dx/dz ten opzichte van het bureau)
//   rollContainers  lege rolcontainers: hier begin je aan een order
//   rooms           kantoor en kantine: aanbouw buiten tegen de noordwand, bij de dockwand (het kantoor op de hoek);
//                   depth is de diepte van de aanbouw, vanuit de hal door een deur in de noordwand te bereiken
//   parking         parkeerplaats in de andere hoek van de dockwand (zuid): een vak voor de heftruck en een voor
//                   de pompwagen (de robots staan bij hun laadstation aan het eind van hun pad)
//   equipment       startplek van de heftruck en de pompwagen (standaard in hun vak op de parkeerplaats)
//   playerStart     waar de speler begint
//   furniture       paktafel, palletstapels, nooduitgang (zuidwand), brandblussers
//
// De locaties moeten gelijk lopen met de WMS (pos_x = x, pos_y = z in de 3D-scène); het WMS-paneel
// laat zien welke locaties van de hal de WMS nog niet kent.
//
// Bewerken in de game (src/ui/editor.ts) levert een concept op dat in localStorage van deze browser staat en
// hier vóór het bestand gaat; definitief wordt het pas als het als warehouse.json is opgeslagen en ingecheckt.
import base from './warehouse.json';

export type WarehouseModel = typeof base;
/** localStorage-sleutel van het concept uit de bewerkmodus. */
export const MODEL_DRAFT_KEY = 'wm-sim.model-draft';

function shapeError(m: unknown, ref: unknown, path: string): string | null {
  if (typeof ref === 'number') return typeof m === 'number' && Number.isFinite(m) ? null : `${path} moet een getal zijn`;
  if (Array.isArray(ref)) {
    if (!Array.isArray(m)) return `${path} moet een lijst zijn`;
    for (const [i, v] of m.entries()) {
      const e = shapeError(v, ref[0], `${path}[${i}]`);
      if (e) return e;
    }
    return null;
  }
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return `${path} ontbreekt`;
  for (const [k, v] of Object.entries(ref as object)) {
    const e = shapeError((m as Record<string, unknown>)[k], v, path ? `${path}.${k}` : k);
    if (e) return e;
  }
  return null;
}

/** Waarom dit geen bruikbaar model is (zelfde opbouw als warehouse.json, zinnige aantallen), of null als het klopt. */
export function modelError(m: unknown): string | null {
  const shape = shapeError(m, base, '');
  if (shape) return shape;
  const { hall, racks, docks } = m as WarehouseModel;
  const count = (v: number) => Number.isInteger(v) && v >= 1 && v <= 40;
  if (hall.width < 10 || hall.depth < 10 || hall.height < 3) return 'hall: minstens 10 × 10 m en 3 m hoog';
  if (!count(racks.rows) || !count(racks.sections)) return 'racks.rows en racks.sections: een geheel getal van 1 t/m 40';
  if (!count(racks.palletsPerLocation)) return 'racks.palletsPerLocation: een geheel getal vanaf 1';
  if (racks.rowPitch <= 0 || racks.sectionPitch <= 0 || racks.palletPitch <= 0) return 'racks: tussenafstanden moeten groter dan 0 zijn';
  if (racks.backToBackPitch < 1.2) return 'racks.backToBackPitch: minstens 1,2 m, anders raken de rijen rug-aan-rug elkaar';
  const levels = racks.levelHeights;
  if (levels.length < 2 || levels[0] !== 0 || levels.some((y, i) => i > 0 && y <= levels[i - 1]))
    return 'racks.levelHeights: minstens twee niveaus, oplopend vanaf 0';
  if (!count(docks.count) || !count(docks.lanes.slots)) return 'docks.count en docks.lanes.slots: een geheel getal van 1 t/m 40';
  if (docks.pitch <= 0 || docks.lanes.slotPitch <= 0) return 'docks: tussenafstanden moeten groter dan 0 zijn';
  const { rooms, parking } = m as WarehouseModel;
  if (rooms.depth < 4 || rooms.officeWidth < 4 || rooms.canteenWidth < 6) return 'rooms: kantoor minstens 4 × 4 m, kantine minstens 6 × 4 m';
  if (parking.width < 6.2 || parking.depth < 5) return 'parking: minstens 6,2 m breed en 5 m diep';
  return null;
}

function loadDraft(): WarehouseModel | null {
  try {
    const text = globalThis.localStorage?.getItem(MODEL_DRAFT_KEY);
    if (!text) return null;
    const m: unknown = JSON.parse(text);
    // Onbruikbaar (bijvoorbeeld van een oudere versie) of inmiddels gelijk aan het bestand: het concept vervalt.
    if (modelError(m) || JSON.stringify(m) === JSON.stringify(base)) {
      localStorage.removeItem(MODEL_DRAFT_KEY);
      return null;
    }
    return m as WarehouseModel;
  } catch {
    return null;
  }
}

const draft = loadDraft();
/** Het model uit warehouse.json. */
export const BASE_MODEL: WarehouseModel = base;
/** Het model waarmee de hal nu is opgebouwd: het concept uit de bewerkmodus, anders warehouse.json. */
export const MODEL: WarehouseModel = draft ?? base;
/** true: de hal is opgebouwd uit een concept dat alleen in deze browser staat. */
export const MODEL_IS_DRAFT = !!draft;
const model = MODEL;

export type LocationType = 'dock' | 'rack' | 'pick';
export type SimLocation = { id: string; type: LocationType; x: number; z: number; level: number };
export type Point = { x: number; z: number };
/** Plek met kijkrichting (r in radialen, om de verticale as). */
export type Pose = Point & { r: number };

const { hall, racks, docks, desk } = model;
const range = (n: number, first: number, pitch: number) => Array.from({ length: n }, (_, i) => first + i * pitch);
const pose = (p: { x: number; z: number; rotation: number }): Pose => ({ x: p.x, z: p.z, r: (p.rotation * Math.PI) / 180 });

/** Binnenmaat van de hal (m); het midden ligt op (0, 0). De docks zitten in de westwand (x = -w/2). */
export const HALL = { w: hall.width, d: hall.depth, h: hall.height };

/**
 * Afstand (z) van rij r (vanaf 0) tot de eerste rij. De rijen staan rug-aan-rug: rij 0 alleen, dan een pad,
 * rij 1 en 2 tegen elkaar, een pad, rij 3 en 4, enzovoort.
 */
export const rowOffset = (r: number, m: Pick<WarehouseModel['racks'], 'rowPitch' | 'backToBackPitch'> = racks) =>
  Math.floor(r / 2) * (m.rowPitch + m.backToBackPitch) + (r % 2) * m.rowPitch;

/** Secties per stelling (x) en stellingrijen (z). */
export const SECTION_PITCH = racks.sectionPitch;
export const SECTION_X = range(racks.sections, racks.firstSectionX, racks.sectionPitch);
export const ROW_Z = Array.from({ length: racks.rows }, (_, r) => +(racks.firstRowZ + rowOffset(r)).toFixed(3));
/** Aan welke kant (z) van rij r zijn pad ligt: +1 of -1. De andere kant is de rug. */
export const ROW_FACE = ROW_Z.map((_, r) => (r % 2 ? -1 : 1));
/** Het pad waar rij r aan ligt (index in AISLE_Z): elke rij is vanaf één pad te bereiken. */
export const ROW_AISLE = ROW_Z.map((_, r) => Math.floor(r / 2));
/** De paden tussen de stellingen (z): pad a ligt voor rij 2a, met aan de overkant rij 2a + 1 (als die er is). */
export const AISLE_Z = range(Math.ceil(racks.rows / 2), racks.firstRowZ + racks.rowPitch / 2, racks.rowPitch + racks.backToBackPitch);
/** De rij waar rij r met zijn rug tegenaan staat, of -1 als hij alleen staat (de eerste, en de laatste bij een even aantal). */
export const rowBehind = (r: number) => (r - ROW_FACE[r] >= 0 && r - ROW_FACE[r] < ROW_Z.length ? r - ROW_FACE[r] : -1);
export const DOCK_PITCH = docks.pitch;
export const DOCK_Z = range(docks.count, docks.firstZ, docks.pitch);

const pad2 = (n: number) => String(n).padStart(2, '0');
const WALL_X = -HALL.w / 2;
/** Midden van de banen (x); elke baan is een rij van LANE_SLOTS palletplekken vanaf het dock de hal in. */
const LANE_X = WALL_X + docks.lanes.distanceFromWall;
const LANE_PITCH = docks.lanes.slotPitch;
const LANE_DZ = docks.lanes.offsetFromDoor;
export const LANE_SLOTS = docks.lanes.slots;
export const LANE_LENGTH = LANE_SLOTS * LANE_PITCH;

/** Een dockdeur met zijn eigen inslaglocatie (lossen) en uitslaglocatie (klaarzetten). */
export type Dock = {
  index: number;
  id: string;
  z: number;
  inId: string;
  outId: string;
  /** Waar je staat om de vrachtwagen te scannen, lossen of laden. */
  truck: Point;
  laneIn: Point;
  laneOut: Point;
};

export const DOCKS: Dock[] = DOCK_Z.map((z, index) => {
  const id = `DOCK-${pad2(index + 1)}`;
  return {
    index,
    id,
    z,
    inId: `${id}-IN`,
    outId: `${id}-UIT`,
    truck: { x: WALL_X + 1.5, z },
    laneIn: { x: LANE_X, z: z - LANE_DZ },
    laneOut: { x: LANE_X, z: z + LANE_DZ },
  };
});

export const LOCATIONS: SimLocation[] = (() => {
  const locs: SimLocation[] = [];
  for (const d of DOCKS) {
    locs.push({ id: d.inId, type: 'dock', x: d.laneIn.x, z: d.laneIn.z, level: 0 });
    locs.push({ id: d.outId, type: 'dock', x: d.laneOut.x, z: d.laneOut.z, level: 0 });
  }
  ROW_Z.forEach((z, r) =>
    SECTION_X.forEach((x, s) => {
      for (let level = 1; level <= racks.levelHeights.length; level++) {
        const id = `R${r + 1}-${pad2(s + 1)}-${level}`;
        locs.push({ id, type: level === 1 ? 'pick' : 'rack', x, z, level });
      }
    }),
  );
  return locs;
})();

const byId = new Map(LOCATIONS.map((l) => [l.id, l]));
const SHELVES = LOCATIONS.filter((l) => l.type !== 'dock');
export const location = (id: string) => byId.get(id);
export const shelfLocations = () => SHELVES;

/** Hoogte (y) van de niveaus, van onder naar boven. */
export const LEVEL_HEIGHTS = racks.levelHeights;
/** Hoogte (y) waarop een pallet staat per niveau (niveau 1 = index 1). */
export const LEVEL_Y = [0, ...LEVEL_HEIGHTS];

/** Een stellinglocatie heeft palletplekken naast elkaar; verschuiving (x) van elke plek ten opzichte van het midden. */
export const SLOT_DX = Array.from(
  { length: racks.palletsPerLocation },
  (_, i) => (i - (racks.palletsPerLocation - 1) / 2) * racks.palletPitch,
);
/** Stuks op een volle pallet als de hal niet opgeeft hoeveel er van een artikel op passen. */
export const PER_PALLET = 20;

/** Interactiepunten op de vloer (naast de docks). */
export const POINTS = {
  /** De pc met de WMS-app. */
  terminal: { x: desk.x, z: desk.z },
  /** Lege rolcontainers: hier begin je aan een order. */
  containers: { ...model.rollContainers },
} satisfies Record<string, Point>;

/** Wat er op het bureau staat. */
export const DESK = {
  radio: { x: desk.x + desk.radio.dx, z: desk.z + desk.radio.dz },
  printer: { x: desk.x + desk.printer.dx, z: desk.z + desk.printer.dz },
} satisfies Record<string, Point>;

/** Waar de speler en de middelen beginnen. */
export const START = {
  player: pose(model.playerStart),
  forklift: pose(model.equipment.forklift),
  palletJack: pose(model.equipment.palletJack),
};

export type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };
/** Vak op de vloer: midden (x, z), breedte (langs x) en diepte (langs z). */
export type Bay = Point & { w: number; d: number };

/** Looppad (x) tussen de dockzone en de stellingen; het loopt langs z door de hele hal. */
export const WALKWAY_X = SECTION_X[0] - SECTION_PITCH / 2 - 4.8;

/**
 * Kantoor en kantine: een aanbouw buiten tegen de noordwand, bij de hoek met de dockwand. Het kantoor zit op de
 * hoek en de kantine ernaast; vanuit de hal loop je er door een deur in de noordwand in.
 */
export const ROOMS = (() => {
  const { depth, officeWidth, canteenWidth } = model.rooms;
  const maxZ = -HALL.d / 2;
  const minZ = maxZ - depth;
  const office: Rect = { minX: WALL_X, maxX: WALL_X + officeWidth, minZ, maxZ };
  const canteen: Rect = { minX: office.maxX, maxX: office.maxX + canteenWidth, minZ, maxZ };
  return { office, canteen };
})();

/** Parkeerplaats tegen de zuidwand bij de docks: vakken voor de heftruck en de pompwagen. */
export const PARKING = (() => {
  const { width, depth } = model.parking;
  const maxZ = HALL.d / 2;
  const area: Rect = { minX: WALL_X, maxX: WALL_X + width, minZ: maxZ - depth, maxZ };
  /** Vak met zijn achterkant 0,3 m van de wand. */
  const bay = (x: number, w: number, d: number): Bay => ({ x, z: maxZ - 0.3 - d / 2, w, d });
  return {
    area,
    forklift: bay(WALL_X + 2.3, 2.6, 4.3),
    palletJack: bay(WALL_X + 4.7, 1.4, 2.4),
  };
})();

/** Vaste aankleding van de hal. */
export const FURNITURE = model.furniture;

/** Palletplek i in een baan; plek 0 ligt het dichtst bij de dockdeur. */
export function laneSlot(lane: Point, i: number): Point {
  return { x: lane.x + (i - (LANE_SLOTS - 1) / 2) * LANE_PITCH, z: lane.z };
}

/** Dichtstbijzijnde punt op de baan: je kunt overal langs de baan scannen. */
export function lanePoint(lane: Point, pos: Point): Point {
  const half = LANE_LENGTH / 2;
  return { x: Math.min(lane.x + half, Math.max(lane.x - half, pos.x)), z: lane.z };
}

export const SKUS = ['SKU-001', 'SKU-002', 'SKU-003', 'SKU-004', 'SKU-005'];
export const SKU_NAMES: Record<string, string> = {
  'SKU-001': 'Stofzuigrobot Dusty',
  'SKU-002': 'Wasvouwrobot Foldy',
  'SKU-003': 'Robothond Bolt',
  'SKU-004': 'Robotkat Miso',
  'SKU-005': 'Dansrobot Groove',
};

export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);
