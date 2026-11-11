// Fysieke layout van het magazijn. Moet gelijk lopen met de seed-data in docs/wms/01
// (pos_x = x, pos_y = z in de 3D-scène).

export type LocationType = 'dock' | 'rack' | 'pick';
export type SimLocation = { id: string; type: LocationType; x: number; z: number; level: number };
export type Point = { x: number; z: number };

export const DOCK_IN = 'DOCK-01';
export const DOCK_OUT = 'DOCK-02';

export const SECTION_X = [-4, 0, 4, 8, 12];
export const ROW_Z = [-9, -4, 1, 6];

export const LOCATIONS: SimLocation[] = (() => {
  const locs: SimLocation[] = [
    { id: DOCK_IN, type: 'dock', x: -18, z: -3, level: 0 },
    { id: DOCK_OUT, type: 'dock', x: -18, z: 3, level: 0 },
  ];
  ROW_Z.forEach((z, r) =>
    SECTION_X.forEach((x, s) => {
      for (const level of [1, 2, 3]) {
        const id = `R${r + 1}-${String(s + 1).padStart(2, '0')}-${level}`;
        locs.push({ id, type: level === 1 ? 'pick' : 'rack', x, z, level });
      }
    }),
  );
  return locs;
})();

export const location = (id: string) => LOCATIONS.find((l) => l.id === id);
export const shelfLocations = () => LOCATIONS.filter((l) => l.type !== 'dock');

/** Hoogte (y) waarop een pallet staat per niveau; zie de stellingen in src/ui/scene/warehouse.ts. */
export const LEVEL_Y = [0, 0, 2, 4];

/** Interactiepunten op de vloer. */
export const POINTS = {
  truckIn: { x: -17.5, z: -3 },
  truckOut: { x: -17.5, z: 3 },
  laneIn: { x: -13.3, z: -3 },
  laneOut: { x: -13.3, z: 3 },
  terminal: { x: -14, z: 9 },
} satisfies Record<string, Point>;

/** Pallet-plekken in de inslagbaan (inbound) en de uitgaande baan (outbound). */
export const LANE_SLOTS = 6;
export function laneSlot(lane: Point, i: number): Point {
  return { x: lane.x - 1.2 + (i % 3) * 1.2, z: lane.z + (i < 3 ? -0.6 : 0.6) };
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
