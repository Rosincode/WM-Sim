import type { Item, Order } from '../../shared/contract';
import { DOCKS, HALL, LOCATIONS } from '../../sim/layout';
import { WmsError, type WmsClient, type WmsItem, type WmsLocation } from './types';

// In-memory WMS met dezelfde regels en seed-data als docs/wms/01-basis-datamodel.md.

// Artikelen uit docs/wms/03-robotassortiment.md.
const ITEMS: WmsItem[] = [
  { sku: 'SKU-001', description: 'Stofzuigrobot Dusty', category: 'huishouden' },
  { sku: 'SKU-002', description: 'Wasvouwrobot Foldy', category: 'huishouden' },
  { sku: 'SKU-003', description: 'Robothond Bolt', category: 'huisdier' },
  { sku: 'SKU-004', description: 'Robotkat Miso', category: 'huisdier' },
  { sku: 'SKU-005', description: 'Dansrobot Groove', category: 'vermaak' },
];
const SKUS = ITEMS.map((i) => i.sku);

function seedLocations(): WmsLocation[] {
  // Zelfde plattegrond als de hal: de locaties komen uit het model (src/sim/warehouse.json via src/sim/layout.ts),
  // dus een andere indeling van de hal geldt vanzelf ook voor de mock.
  return [
    // de deur zelf (aan- en afmelden, laden)
    ...DOCKS.map((d) => ({ id: d.id, type: 'dock' as const, x: -HALL.w / 2, y: d.z, level: 0, blocked: false })),
    // inslag- en uitslaglocaties en de stellingen
    ...LOCATIONS.map((l) => ({ id: l.id, type: l.type, x: l.x, y: l.z, level: l.level, blocked: false })),
  ];
}

export function createMockClient(): WmsClient {
  const locations = seedLocations();
  const stock = new Map<string, Item>(); // sleutel: sku|locationId
  const orders: Order[] = [];
  let orderNr = 1;

  const fail = (msg: string): never => {
    throw new WmsError(msg);
  };
  const loc = (id: string) => locations.find((l) => l.id === id) ?? fail(`Locatie ${id} bestaat niet.`);
  const checkSku = (sku: string) => SKUS.includes(sku) || fail(`Artikel ${sku} bestaat niet.`);
  const qtyAt = (sku: string, locationId: string) => stock.get(`${sku}|${locationId}`)?.qty ?? 0;
  const add = (sku: string, locationId: string, qty: number) => {
    const key = `${sku}|${locationId}`;
    const q = qtyAt(sku, locationId) + qty;
    if (q <= 0) stock.delete(key);
    else stock.set(key, { sku, locationId, qty: q });
  };
  const order = (id: string) => orders.find((o) => o.id === id) ?? fail(`Order ${id} bestaat niet.`);
  /** Per order wat er al per regel is gepickt: sku -> aantal. */
  const picked = new Map<string, Map<string, number>>();
  /** Wat een order per artikel nog nodig heeft. */
  const restOf = (o: Order) => {
    const rest = new Map<string, number>();
    for (const l of o.lines) rest.set(l.sku, (rest.get(l.sku) ?? 0) + l.qty);
    for (const [sku, n] of picked.get(o.id) ?? []) rest.set(sku, (rest.get(sku) ?? 0) - n);
    for (const [sku, n] of rest) if (n <= 0) rest.delete(sku);
    return rest;
  };

  const shelves = locations.filter((l) => l.type !== 'dock');
  for (let i = 0; i < 70; i++) {
    const l = shelves[Math.floor(Math.random() * shelves.length)];
    add(SKUS[Math.floor(Math.random() * SKUS.length)], l.id, 5 + Math.floor(Math.random() * 46));
  }

  return {
    mode: 'mock',

    async getLocations() {
      return structuredClone(locations);
    },

    async createLocation(l) {
      if (locations.some((x) => x.id === l.id)) return false;
      locations.push({ id: l.id, type: l.type, x: l.x, y: l.y, level: l.level, blocked: false });
      return true;
    },

    async getItems() {
      return structuredClone(ITEMS);
    },

    mirror(items, openOrders) {
      stock.clear();
      for (const it of items) if (locations.some((l) => l.id === it.locationId)) add(it.sku, it.locationId, it.qty);
      orders.splice(0, orders.length, ...structuredClone(openOrders));
    },

    async getStock() {
      return structuredClone([...stock.values()]);
    },

    // De mock houdt geen pallets bij: alle voorraad is los, de hal geeft zijn pallets zelf een nummer.
    async getPallets() {
      return [];
    },

    async registerPallet({ sku, locationId }) {
      loc(locationId);
      checkSku(sku);
    },

    async getOpenOrders() {
      return structuredClone(orders.filter((o) => o.status !== 'done'));
    },

    async registerGoodsReceived({ sku, qty, dockId }) {
      if (loc(dockId).type !== 'dock') fail(`${dockId} is geen dock.`);
      checkSku(sku);
      if (qty <= 0) fail('Aantal moet groter dan 0 zijn.');
      add(sku, dockId, qty);
    },

    async confirmPutaway({ sku, qty, fromLocationId, toLocationId }) {
      if (qtyAt(sku, fromLocationId) < qty) fail(`Onvoldoende ${sku} op ${fromLocationId}.`);
      if (loc(toLocationId).type === 'dock') fail(`${toLocationId} is geen stellinglocatie.`);
      add(sku, fromLocationId, -qty);
      add(sku, toLocationId, qty);
    },

    async createOrder(lines, orderId) {
      if (lines.length === 0) fail('Order heeft geen regels.');
      lines.forEach((l) => checkSku(l.sku));
      const id = orderId ?? `ORD-${String(orderNr++).padStart(4, '0')}`;
      if (orders.some((o) => o.id === id)) fail(`Order ${id} bestaat al.`);
      orders.push({ id, status: 'open', lines: structuredClone(lines) });
      return id;
    },

    async startPicking(orderId) {
      const o = order(orderId);
      if (o.status !== 'open') fail(`Order ${orderId} heeft status ${o.status}, verwacht open.`);
      o.status = 'picking';
    },

    async confirmPickLine({ orderId, sku, qty, locationId }) {
      const o = order(orderId);
      if (o.status !== 'picking') fail(`Order ${orderId} staat niet op picking.`);
      if ((restOf(o).get(sku) ?? 0) < qty) fail(`Order ${orderId} heeft geen ${qty}× ${sku} meer open.`);
      if (qtyAt(sku, locationId) < qty) fail(`Te weinig voorraad van ${sku} op ${locationId}.`);
      add(sku, locationId, -qty);
      const done = picked.get(orderId) ?? new Map<string, number>();
      picked.set(orderId, done.set(sku, (done.get(sku) ?? 0) + qty));
    },

    async confirmPick(orderId) {
      const o = order(orderId);
      if (o.status !== 'picking') fail(`Order ${orderId} heeft status ${o.status}, verwacht picking.`);
      const typeRank = (id: string) => (loc(id).type === 'pick' ? 0 : 1);
      const sources = (sku: string) =>
        [...stock.values()]
          .filter((s) => s.sku === sku && loc(s.locationId).type !== 'dock')
          .sort((a, b) => typeRank(a.locationId) - typeRank(b.locationId) || a.locationId.localeCompare(b.locationId));
      // Alleen het restant: wat per regel is gepickt (confirmPickLine) is al afgeboekt.
      const rests = restOf(o);
      for (const [sku, need] of rests) {
        const total = sources(sku).reduce((n, s) => n + s.qty, 0);
        if (total < need) fail(`Onvoldoende voorraad ${sku}: nodig ${need}, aanwezig ${total}.`);
      }
      for (const [sku, need] of rests) {
        let rest = need;
        for (const s of sources(sku)) {
          if (rest <= 0) break;
          const take = Math.min(rest, s.qty);
          add(sku, s.locationId, -take);
          rest -= take;
        }
      }
      picked.delete(orderId);
      o.status = 'done';
    },

    // Klaarzetten, inladen, vrachtwagens en scans: de mock controleert ze niet en houdt er niets van bij.
    async stageOrder() {},
    async loadOrder() {},
    async truckCheckIn({ dockId }) {
      if (loc(dockId).type !== 'dock') fail(`${dockId} is geen docklocatie.`);
    },
    async truckCheckOut() {},
    async logScan() {},
  };
}
