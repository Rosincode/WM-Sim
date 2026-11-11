import type { Item, Location, Order } from '../../shared/contract';
import { WmsError, type WmsClient } from './types';

// In-memory WMS met dezelfde regels en seed-data als docs/wms/01-basis-datamodel.md.

const SKUS = ['SKU-001', 'SKU-002', 'SKU-003', 'SKU-004', 'SKU-005'];

function seedLocations(): Location[] {
  const locs: Location[] = [
    { id: 'DOCK-01', type: 'dock', x: -18, y: -3 },
    { id: 'DOCK-02', type: 'dock', x: -18, y: 3 },
  ];
  const xs = [-4, 0, 4, 8, 12];
  const ys = [-9, -4, 1, 6];
  ys.forEach((y, r) =>
    xs.forEach((x, s) => {
      for (const level of [1, 2, 3]) {
        const id = `R${r + 1}-${String(s + 1).padStart(2, '0')}-${level}`;
        locs.push({ id, type: level === 1 ? 'pick' : 'rack', x, y });
      }
    }),
  );
  return locs;
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

  const shelves = locations.filter((l) => l.type !== 'dock');
  for (let i = 0; i < 25; i++) {
    const l = shelves[Math.floor(Math.random() * shelves.length)];
    add(SKUS[Math.floor(Math.random() * SKUS.length)], l.id, 5 + Math.floor(Math.random() * 46));
  }

  return {
    mode: 'mock',

    async getLocations() {
      return structuredClone(locations);
    },

    async getStock() {
      return structuredClone([...stock.values()]);
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

    async confirmPick(orderId) {
      const o = order(orderId);
      if (o.status !== 'picking') fail(`Order ${orderId} heeft status ${o.status}, verwacht picking.`);
      const typeRank = (id: string) => (loc(id).type === 'pick' ? 0 : 1);
      const sources = (sku: string) =>
        [...stock.values()]
          .filter((s) => s.sku === sku && loc(s.locationId).type !== 'dock')
          .sort((a, b) => typeRank(a.locationId) - typeRank(b.locationId) || a.locationId.localeCompare(b.locationId));
      for (const line of o.lines) {
        const total = sources(line.sku).reduce((n, s) => n + s.qty, 0);
        if (total < line.qty) fail(`Onvoldoende voorraad ${line.sku}: nodig ${line.qty}, aanwezig ${total}.`);
      }
      for (const line of o.lines) {
        let rest = line.qty;
        for (const s of sources(line.sku)) {
          const take = Math.min(rest, s.qty);
          add(line.sku, s.locationId, -take);
          rest -= take;
          if (rest === 0) break;
        }
      }
      o.status = 'done';
    },
  };
}
