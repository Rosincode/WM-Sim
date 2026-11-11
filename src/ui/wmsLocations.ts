import type { Location } from '../shared/contract';
import { wms, type WmsClient, type WmsLocation } from '../integrations/wms';
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

/**
 * Locaties waarvan bij het toevoegen bleek dat de WMS ze al had, terwijl ze niet in zijn lijst stonden
 * (de API gaf dan niet alle locaties terug). Per WMS-client; die tellen niet meer als ontbrekend.
 */
const confirmed = new WeakMap<WmsClient, Set<string>>();

/** Locaties van de hal die de WMS niet kent. */
export function missingLocations(inWms: Location[]): HallLocation[] {
  const known = new Set(inWms.map((l) => l.id));
  const present = confirmed.get(wms.client);
  return hallLocations().filter((l) => !known.has(l.id) && !present?.has(l.id));
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
 * Maakt de ontbrekende locaties aan in de WMS, één voor één. Een locatie die er al blijkt te staan wordt
 * overgeslagen (existing). Stopt na drie fouten achter elkaar: dan mag de API-gebruiker het waarschijnlijk
 * niet, of wijkt de entiteit af.
 */
export async function addMissingLocations(missing: HallLocation[], onProgress: (done: number, total: number) => void) {
  const client = wms.client;
  let added = 0;
  let existing = 0;
  const present = confirmed.get(client) ?? new Set<string>();
  confirmed.set(client, present);
  let streak = 0;
  let error = '';
  for (const [i, l] of missing.entries()) {
    try {
      if (await client.createLocation(l)) added++;
      else {
        existing++;
        present.add(l.id);
      }
      streak = 0;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      if (++streak >= 3) break;
    }
    onProgress(i + 1, missing.length);
  }
  if (added + existing > 0) wms.locationsChanged();
  return { added, existing, error };
}
