// Hoe de hal en de WMS op elkaar aansluiten, na elke stand die uit de WMS is opgehaald.
// src/ui/warehouse.ts vult dit in; het WMS-paneel (K) toont het.

export type SyncReport = {
  mode: 'live' | 'mock';
  /** false: deze speler leest de WMS niet zelf, maar volgt de wereld die de spelers delen. */
  fromWms: boolean;
  at: Date;
  items: number;
  locations: {
    hall: number;
    /** In de hal, niet in de WMS. */
    missing: number;
    /** In de WMS, niet in de hal: daar kan de speler niet komen. */
    extra: string[];
    /** Type, positie of niveau wijkt af van de hal. */
    different: string[];
    blocked: number;
  };
  stock: {
    lines: number;
    /** Voorraadregels op een plek die de hal niet toont (onbekende locatie of de dockdeur zelf). */
    hidden: number;
    /** Voorraad van artikelen die niet in de artikellijst van de WMS staan. */
    unknownSkus: string[];
  };
  orders: number;
};

let report: SyncReport | null = null;
const listeners: (() => void)[] = [];

export const wmsSync = {
  get report() {
    return report;
  },
  set(next: SyncReport | null) {
    report = next;
    listeners.forEach((l) => l());
  },
  onChange(l: () => void) {
    listeners.push(l);
  },
};
