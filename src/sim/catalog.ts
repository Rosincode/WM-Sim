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

export const isBlocked = (locationId: string) => blocked.has(locationId);

/** Locaties die in de WMS geblokkeerd zijn: de WMS weigert daar elke boeking. */
export function setBlockedLocations(ids: Iterable<string>) {
  blocked = new Set(ids);
}
