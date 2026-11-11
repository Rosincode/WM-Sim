import type { Location } from '../shared/contract';
import { wms } from '../integrations/wms';
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

/** Voor import in de WMS: zelfde kolommen als de entiteit `location` (docs/wms/01). */
export function locationsCsv(list: HallLocation[]) {
  return ['location_id;location_type;pos_x;pos_y;level;blocked', ...list.map((l) => `${l.id};${l.type};${l.x};${l.y};${l.level};0`)].join('\r\n');
}

/**
 * Maakt de ontbrekende locaties aan in de WMS, één voor één. Stopt na drie fouten achter elkaar:
 * dan mag de API-gebruiker het waarschijnlijk niet, of wijkt de entiteit af.
 */
export async function addMissingLocations(missing: HallLocation[], onProgress: (done: number, total: number) => void) {
  const client = wms.client;
  let added = 0;
  let streak = 0;
  let error = '';
  for (const [i, l] of missing.entries()) {
    try {
      await client.createLocation(l);
      added++;
      streak = 0;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      if (++streak >= 3) break;
    }
    onProgress(i + 1, missing.length);
  }
  if (added > 0) wms.locationsChanged();
  return { added, error };
}
