import type { Item, Location, Order } from '../../shared/contract';
import { WmsError, type WmsClient, type WmsCredentials, type WmsItem, type WmsLocation } from './types';

// URL-opbouw van de WMS-API (basis: https://<host>/t/wm_sim/api):
//   GET  {base}/{entiteit}                      -> lijst als { data: [...] }
//   GET  {base}/{entiteit}?veld=waarde          -> gefilterde lijst; één waarde per veld, geen OData
//   POST {base}/{entiteit}                      -> record aanmaken of actie boeken, JSON-body
//   POST {base}/{entiteit}/{id}/_flows/{flow}   -> statusovergang op één record
// Verwijzingen (sku, dock_id, from/to_location_id, order_id op een regel) zijn de platform-id (uuid,
// veld `id`), niet de tekstsleutel. Deze file vertaalt tussen beide; de rest van de game kent alleen
// de tekstsleutels (SKU-001, DOCK-01, ORD-…).
// Wijkt de WMS af, pas dan alleen deze file aan.

type Row = { id: string };
type ItemRow = Row & { sku: string; description?: string | null; category?: string | null };
type LocationRow = Row & {
  location_id: string; location_type: Location['type']; pos_x: number; pos_y: number;
  level?: number | null; blocked?: boolean | number | string | null;
};
type StockRow = Row & { sku: string; location_id: string; qty: number };
type OrderRow = Row & { order_id: string; status: Order['status'] };
type OrderLineRow = Row & { order_id: string; sku: string; qty: number };
type FlowResult = { run?: { message?: string } } | undefined;

/** Twee kanten van een verwijzing: platform-id -> tekstsleutel en terug. */
type Refs = { keyById: Map<string, string>; idByKey: Map<string, string> };

const MAX_RETRIES = 3; // bij 429
const MAX_WAIT_S = 30;

// Aanmelden: de API-sleutel (amk_...) van een API-client in de WMS gaat mee als Bearer-token.
// De WMS accepteert geen Basic auth.

export function createLiveClient(c: WmsCredentials): WmsClient {
  const base = c.baseUrl.trim().replace(/\/+$/, '');
  const auth = `Bearer ${(c.apiKey ?? '').trim()}`;

  async function request<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${base}/${path}`, {
        ...init,
        headers: {
          Authorization: auth,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    } catch {
      throw new WmsError('WMS niet bereikbaar. Controleer de URL, HTTPS en de CORS-instelling van de WMS.');
    }
    if (res.status === 429) {
      // Te veel calls: wacht het aantal seconden uit Retry-After en probeer het opnieuw.
      if (attempt >= MAX_RETRIES) throw new WmsError('De WMS krijgt te veel calls. Probeer het zo opnieuw.', 429);
      const seconds = Number(res.headers.get('Retry-After'));
      const wait = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_WAIT_S) : 1;
      await new Promise((r) => setTimeout(r, wait * 1000));
      return request<T>(path, init, attempt + 1);
    }
    if (res.status === 401 || res.status === 403) {
      throw new WmsError(
        res.status === 401
          ? 'Inloggen geweigerd: de API-sleutel is fout, verlopen of ingetrokken.'
          : 'Geen rechten: de API-sleutel mag dit niet (controleer de scopes van de API-client).',
        res.status,
      );
    }
    if (!res.ok) throw new WmsError(`WMS-fout ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Lijst, eventueel gefilterd met één waarde per veld. */
  async function list<R>(entity: string, filter?: Record<string, string>): Promise<R[]> {
    const query = filter ? `?${new URLSearchParams(filter)}` : '';
    const res = await request<R[] | { data?: R[] }>(entity + query);
    return Array.isArray(res) ? res : (res?.data ?? []);
  }

  const post = <T = unknown>(path: string, body: object = {}) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) });

  // --- Verwijzingen: tekstsleutel <-> platform-id -------------------------------------------------

  const toRefs = (pairs: [id: string, key: string][]): Refs => ({
    keyById: new Map(pairs),
    idByKey: new Map(pairs.map(([id, key]) => [key, id])),
  });

  let items: Promise<Refs> | null = null;
  let locations: Promise<Refs> | null = null;
  /** order_id (tekst) -> platform-id van de order. */
  const orderIds = new Map<string, string>();

  const loadItems = () =>
    (items ??= list<ItemRow>('item')
      .then((rows) => toRefs(rows.map((r) => [r.id, r.sku])))
      .catch((err) => {
        items = null;
        throw err;
      }));

  const loadLocations = () =>
    (locations ??= list<LocationRow>('location')
      .then((rows) => toRefs(rows.map((r) => [r.id, r.location_id])))
      .catch((err) => {
        locations = null;
        throw err;
      }));

  async function itemId(sku: string): Promise<string> {
    let id = (await loadItems()).idByKey.get(sku);
    if (!id) {
      items = null; // misschien net toegevoegd in de WMS
      id = (await loadItems()).idByKey.get(sku);
    }
    if (!id) throw new WmsError(`Artikel ${sku} staat niet in de WMS.`);
    return id;
  }

  async function locationId(key: string): Promise<string> {
    let id = (await loadLocations()).idByKey.get(key);
    if (!id) {
      locations = null;
      id = (await loadLocations()).idByKey.get(key);
    }
    if (!id) throw new WmsError(`Locatie ${key} staat niet in de WMS.`);
    return id;
  }

  async function orderUuid(orderId: string): Promise<string> {
    let id = orderIds.get(orderId);
    if (!id) {
      const [row] = await list<OrderRow>('customer_order', { order_id: orderId });
      if (!row) throw new WmsError(`Order ${orderId} staat niet in de WMS.`);
      id = row.id;
      orderIds.set(orderId, id);
    }
    return id;
  }

  return {
    mode: 'live',

    async getLocations() {
      const rows = await list<LocationRow>('location');
      locations = Promise.resolve(toRefs(rows.map((r) => [r.id, r.location_id])));
      return rows.map((r): WmsLocation => ({
        id: r.location_id,
        type: r.location_type,
        x: Number(r.pos_x),
        y: Number(r.pos_y),
        level: r.level == null ? undefined : Number(r.level),
        blocked: r.blocked == null ? undefined : r.blocked === true || r.blocked === 1 || r.blocked === '1' || r.blocked === 'true',
      }));
    },

    async getItems() {
      const rows = await list<ItemRow>('item');
      items = Promise.resolve(toRefs(rows.map((r) => [r.id, r.sku])));
      return rows.map((r): WmsItem => ({ sku: r.sku, description: r.description ?? '', category: r.category ?? undefined }));
    },

    async createLocation(l) {
      // `blocked` blijft op de standaardwaarde van de WMS (nee)
      await post('location', { location_id: l.id, location_type: l.type, pos_x: l.x, pos_y: l.y, level: l.level });
      locations = null;
    },

    async getStock(): Promise<Item[]> {
      const [rows, item, loc] = await Promise.all([list<StockRow>('stock'), loadItems(), loadLocations()]);
      return rows.map((r) => ({
        sku: item.keyById.get(r.sku) ?? r.sku,
        qty: Number(r.qty),
        locationId: loc.keyById.get(r.location_id) ?? r.location_id,
      }));
    },

    async getOpenOrders() {
      // Geen 'status ne done' in de API: één call per status die nog open is.
      const [open, picking, lines, item] = await Promise.all([
        list<OrderRow>('customer_order', { status: 'open' }),
        list<OrderRow>('customer_order', { status: 'picking' }),
        list<OrderLineRow>('order_line'),
        loadItems(),
      ]);
      return [...open, ...picking].map((o) => {
        orderIds.set(o.order_id, o.id);
        return {
          id: o.order_id,
          status: o.status,
          lines: lines
            .filter((l) => l.order_id === o.id || l.order_id === o.order_id)
            .map((l) => ({ sku: item.keyById.get(l.sku) ?? l.sku, qty: Number(l.qty) })),
        };
      });
    },

    async registerGoodsReceived({ sku, qty, dockId }) {
      const [skuRef, dockRef] = await Promise.all([itemId(sku), locationId(dockId)]);
      await post('goods_receipt', { sku: skuRef, qty, dock_id: dockRef });
    },

    async confirmPutaway({ sku, qty, fromLocationId, toLocationId }) {
      const [skuRef, fromRef, toRef] = await Promise.all([itemId(sku), locationId(fromLocationId), locationId(toLocationId)]);
      await post('putaway', { sku: skuRef, qty, from_location_id: fromRef, to_location_id: toRef });
    },

    async createOrder(lines, orderId) {
      const skuRefs = await Promise.all(lines.map((l) => itemId(l.sku))); // eerst controleren, dan pas de order aanmaken
      const order = await post<OrderRow>('customer_order', orderId ? { order_id: orderId } : {});
      orderIds.set(order.order_id, order.id);
      // Regel voor regel: de vorm van de body van order_line/_batch ligt niet vast.
      for (let i = 0; i < lines.length; i++) {
        await post('order_line', { order_id: order.id, line_no: i + 1, sku: skuRefs[i], qty: lines[i].qty });
      }
      return order.order_id;
    },

    async startPicking(orderId) {
      await post(`customer_order/${await orderUuid(orderId)}/_flows/start_picking`);
    },

    async confirmPick(orderId) {
      const res = await post<FlowResult>(`customer_order/${await orderUuid(orderId)}/_flows/confirm_pick`);
      // Te weinig voorraad geeft 200 zonder dat er iets verandert; de reden staat in run.message.
      const message = res?.run?.message;
      if (message && /te weinig voorraad/i.test(message)) throw new WmsError(message, 409);
    },
  };
}
