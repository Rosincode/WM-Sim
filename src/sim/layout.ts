// Fysieke layout van het magazijn. Alles hier is afgeleid van het model in ./warehouse.json:
// wie de hal anders wil indelen past alleen dat bestand aan (maten in meters, draaiing in graden).
//
//   hall            binnenmaat van het gebouw; het midden ligt op (0, 0)
//   racks           stellingen: rijen (langs z) x secties (langs x) x niveaus (levelHeights = hoogte per niveau,
//                   minstens twee), met palletsPerLocation palletplekken naast elkaar per locatie
//   docks           dockdeuren in de westwand (x = -width/2), elk met een inslag- en een uitslagbaan
//   desk            bureau met de pc; radio en printer staan erop (dx/dz ten opzichte van het bureau)
//   rollContainers  lege rolcontainers: hier begin je aan een order
//   equipment       startplek van de heftruck en de pompwagen
//   playerStart     waar de speler begint
//   furniture       paktafel, palletstapels, nooduitgang (zuidwand), brandblussers
//
// De locaties moeten gelijk lopen met de WMS (pos_x = x, pos_y = z in de 3D-scène); het WMS-paneel
// laat zien welke locaties van de hal de WMS nog niet kent.
import model from './warehouse.json';

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

/** Secties per stelling (x) en stellingrijen (z); standaard ligt elk dock recht voor een pad. */
export const SECTION_PITCH = racks.sectionPitch;
export const SECTION_X = range(racks.sections, racks.firstSectionX, racks.sectionPitch);
export const ROW_Z = range(racks.rows, racks.firstRowZ, racks.rowPitch);
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
