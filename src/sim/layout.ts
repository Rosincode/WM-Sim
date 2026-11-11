// Fysieke layout van het magazijn. Moet gelijk lopen met de seed-data van de WMS
// (pos_x = x, pos_y = z in de 3D-scène).

export type LocationType = 'dock' | 'rack' | 'pick';
export type SimLocation = { id: string; type: LocationType; x: number; z: number; level: number };
export type Point = { x: number; z: number };

/** Binnenmaat van de hal (m); het midden ligt op (0, 0). De docks zitten in de westwand (x = -w/2). */
export const HALL = { w: 56, d: 56 };

/** 7 secties per stelling, 11 stellingen met daartussen 10 paden; elk dock ligt recht voor een pad. */
export const SECTION_X = [-8, -4, 0, 4, 8, 12, 16];
export const ROW_Z = Array.from({ length: 11 }, (_, i) => -25 + i * 5);
export const DOCK_Z = Array.from({ length: 10 }, (_, i) => -22.5 + i * 5);

const pad2 = (n: number) => String(n).padStart(2, '0');
const WALL_X = -HALL.w / 2;
/** Midden van de banen (x); elke baan is een rij van LANE_SLOTS palletplekken vanaf het dock de hal in. */
const LANE_X = WALL_X + 7.7;
const LANE_PITCH = 1.3;
export const LANE_SLOTS = 6;
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
    laneIn: { x: LANE_X, z: z - 1.3 },
    laneOut: { x: LANE_X, z: z + 1.3 },
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
      for (const level of [1, 2, 3]) {
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

/** Hoogte (y) waarop een pallet staat per niveau; zie de stellingen in src/ui/scene/warehouse.ts. */
export const LEVEL_Y = [0, 0, 2, 4];

/** Interactiepunten op de vloer (naast de docks). */
export const POINTS = {
  terminal: { x: -11.3, z: 0 },
} satisfies Record<string, Point>;

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
