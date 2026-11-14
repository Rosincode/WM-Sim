import { SKUS, SKU_NAMES } from './layout';

// Stamgegevens die de WMS bepaalt: welke artikelen er bestaan en welke locaties geblokkeerd zijn.
// De sim kent ze alleen om de fysieke wereld te vullen (wat zit er in een vrachtwagen) en te tonen;
// beslissen doet de WMS. Tot de eerste stand uit de WMS binnen is geldt het assortiment uit docs/wms/03.

export type Article = { sku: string; name: string; category?: string };

let list: Article[] = SKUS.map((sku) => ({ sku, name: SKU_NAMES[sku] ?? '' }));
let bySku = new Map(list.map((a) => [a.sku, a]));
let blocked = new Set<string>();

export const articles = () => list;
export const skus = () => list.map((a) => a.sku);
export const articleName = (sku: string) => bySku.get(sku)?.name ?? '';

/** Neemt de artikelen van de WMS over. */
export function setArticles(next: Article[]) {
  list = next.map((a) => ({ ...a }));
  bySku = new Map(list.map((a) => [a.sku, a]));
}

/** Het assortiment uit docs/wms/03: de indeling van de paden staat daarmee vast, ook als de WMS (of de mock) er minder kent. */
const ASSORTMENT: Article[] = [
  ...SKUS.map((sku) => ({ sku, name: SKU_NAMES[sku] ?? '' })),
  { sku: 'SKU-006', name: 'Ramenwasrobot Clearo' },
  { sku: 'SKU-007', name: 'Robotvogel Pip' },
  { sku: 'SKU-008', name: 'Muziekrobot Beat' },
  { sku: 'SKU-009', name: 'Robotkonijn Hop' },
  { sku: 'SKU-010', name: 'Goochelrobot Magix' },
];
/** Alle artikelen op artikelnummer: die van de WMS, aangevuld met het assortiment. */
const ordered = () =>
  [...new Map([...ASSORTMENT, ...list].map((a) => [a.sku, a])).values()].sort((a, b) => a.sku.localeCompare(b.sku));

/**
 * Elk stellingpad heeft zijn eigen artikel: het eerste artikel (op artikelnummer) ligt in pad 1 (R1A en R1B),
 * het tweede in pad 2, enzovoort. Pad n ligt recht voor dock n.
 * @param aisle index van het pad (0 = pad 1: R1A en R1B)
 */
export const articleOfAisle = (aisle: number): Article | undefined => ordered()[aisle];
/** Het pad (index) waar een artikel thuishoort, of -1 als het artikel onbekend is. */
export const aisleOfArticle = (sku: string) => ordered().findIndex((a) => a.sku === sku);

export const isBlocked = (locationId: string) => blocked.has(locationId);

/** Locaties die in de WMS geblokkeerd zijn: de WMS weigert daar elke boeking. */
export function setBlockedLocations(ids: Iterable<string>) {
  blocked = new Set(ids);
}
