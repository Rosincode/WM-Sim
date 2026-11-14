import type { Location } from '../shared/contract';
import { wms, type WmsLocation } from '../integrations/wms';
import { DOCKS, HALL, LOCATIONS } from '../sim/layout';

// Vergelijkt de locaties van de hal met die in de WMS. De hal is de fysieke wereld: elke locatie die
// daar bestaat moet de WMS ook kennen, anders weigert hij scans en boekingen op die plek.
// De lijst is dezelfde als in docs/wms/05-grotere-hal-locaties.md.

export type HallLocation = Location & { level: number };

/** Alle locaties van de hal, in WMS-vorm (pos_x = x, pos_y = z in de 3D-scène). */
export function hallLocations(): HallLocation[] {
  return [
    // de dockdeur zelf: aan- en afmelden van vrachtwagens, laden
    ...DOCKS.map((d) => ({ id: d.id, type: 'dock' as const, x: -HALL.w / 2, y: d.z, level: 0 })),
    ...LOCATIONS.map((l) => ({ id: l.id, type: l.type, x: l.x, y: l.z, level: l.level })),
  ];
}

/** Locaties van de hal die de WMS niet kent. */
export function missingLocations(inWms: Location[]): HallLocation[] {
  const known = new Set(inWms.map((l) => l.id));
  return hallLocations().filter((l) => !known.has(l.id));
}

/** Verschillen tussen de hal en de WMS: de hal ligt fysiek vast, dus afwijkingen moeten in de WMS worden rechtgezet. */
export function compareLocations(inWms: WmsLocation[]) {
  const hall = new Map(hallLocations().map((l) => [l.id, l]));
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const extra: string[] = [];
  const different: string[] = [];
  const blocked: string[] = [];
  for (const w of inWms) {
    const h = hall.get(w.id);
    if (!h) {
      extra.push(w.id);
      continue;
    }
    if (w.blocked) blocked.push(w.id);
    if (w.type !== h.type || !near(w.x, h.x) || !near(w.y, h.y) || (w.level !== undefined && w.level !== h.level)) different.push(w.id);
  }
  return { hall: hall.size, missing: missingLocations(inWms), extra, different, blocked };
}

/** Voor import in de WMS: zelfde kolommen als de entiteit `location` (docs/wms/01). */
export function locationsCsv(list: HallLocation[]) {
  return ['location_id;location_type;pos_x;pos_y;level;blocked', ...list.map((l) => `${l.id};${l.type};${l.x};${l.y};${l.level};0`)].join('\r\n');
}

/**
 * Zet de WMS gelijk met de hal: ontbrekende locaties worden aangemaakt, afwijkende krijgen het type, de positie
 * en het niveau van de hal. Gaat in delen; bij een fout blijft staan wat al verwerkt was.
 */
export async function syncLocationsToWms(list: HallLocation[], onProgress: (done: number, total: number) => void) {
  let done = 0;
  try {
    const { created, updated } = await wms.client.syncLocations(list, (n) => onProgress((done = n), list.length));
    return { created, updated, done: list.length, error: '' };
  } catch (err) {
    return { created: 0, updated: 0, done, error: err instanceof Error ? err.message : String(err) };
  } finally {
    wms.locationsChanged();
  }
}
