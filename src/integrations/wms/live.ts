import type { Item, Location, Order } from '../../shared/contract';
import { WmsError, type WmsClient, type WmsCredentials } from './types';

// Aanname over de URL-opbouw van de gegenereerde API (zie docs/wms/01 en 02):
//   GET  {base}/{entiteit}            -> lijst, als array of als { value: [...] } (OData)
//   GET  {base}/{entiteit}?$filter=…  -> gefilterde lijst (OData-syntax)
//   POST {base}/{actie}               -> actie, parameters als JSON-body
// Wijkt de WMS af, pas dan alleen deze file aan.

type LocationRow = { location_id: string; location_type: Location['type']; pos_x: number; pos_y: number };
type StockRow = { sku: string; location_id: string; qty: number };
type OrderRow = { order_id: string; status: Order['status'] };
type OrderLineRow = { order_id: string; sku: string; qty: number };

// Aanmelden: de API-sleutel van een API-client in de WMS gaat mee als Bearer-token.
// De WMS accepteert geen Basic auth.

export function createLiveClient(c: WmsCredentials): WmsClient {
  const base = c.baseUrl.trim().replace(/\/+$/, '');
  const auth = `Bearer ${(c.apiKey ?? '').trim()}`;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    if (res.status === 401 || res.status === 403) {
      throw new WmsError(
        res.status === 401
          ? 'Inloggen geweigerd: controleer de API-sleutel.'
          : 'Geen rechten: de API-sleutel mag dit niet (controleer de scopes van de API-client).',
        res.status,
      );
    }
    if (!res.ok) throw new WmsError(`WMS-fout ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async function list<R>(entity: string, filter?: string): Promise<R[]> {
    const query = filter ? `?$filter=${encodeURIComponent(filter)}` : '';
    const data = await request<R[] | { value: R[] }>(entity + query);
    return Array.isArray(data) ? data : (data?.value ?? []);
  }

  const action = (name: string, params: object) =>
    request<unknown>(name, { method: 'POST', body: JSON.stringify(params) });

  return {
    mode: 'live',

    async getLocations() {
      const rows = await list<LocationRow>('location');
      return rows.map((r) => ({ id: r.location_id, type: r.location_type, x: Number(r.pos_x), y: Number(r.pos_y) }));
    },

    async createLocation(l) {
      // `blocked` blijft op de standaardwaarde van de WMS (nee)
      await request<unknown>('location', {
        method: 'POST',
        body: JSON.stringify({ location_id: l.id, location_type: l.type, pos_x: l.x, pos_y: l.y, level: l.level }),
      });
    },

    async getStock(): Promise<Item[]> {
      const rows = await list<StockRow>('stock');
      return rows.map((r) => ({ sku: r.sku, qty: Number(r.qty), locationId: r.location_id }));
    },

    async getOpenOrders() {
      const [orders, lines] = await Promise.all([
        list<OrderRow>('order', "status ne 'done'"),
        list<OrderLineRow>('order_line'),
      ]);
      // Sinds de procesacties (docs/wms/04) kent de WMS ook staged/loaded/shipped: die zijn niet meer open.
      return orders.filter((o) => o.status === 'open' || o.status === 'picking').map((o) => ({
        id: o.order_id,
        status: o.status,
        lines: lines.filter((l) => l.order_id === o.order_id).map((l) => ({ sku: l.sku, qty: Number(l.qty) })),
      }));
    },

    async registerGoodsReceived({ sku, qty, dockId }) {
      await action('register_goods_received', { sku, qty, dock_id: dockId });
    },

    async confirmPutaway({ sku, qty, fromLocationId, toLocationId }) {
      await action('confirm_putaway', { sku, qty, from_location_id: fromLocationId, to_location_id: toLocationId });
    },

    async createOrder(lines, orderId) {
      const res = (await action('create_order', { order_id: orderId, lines })) as { order_id?: string } | undefined;
      return res?.order_id ?? orderId ?? '';
    },

    async startPicking(orderId) {
      await action('start_picking', { order_id: orderId });
    },

    async confirmPick(orderId) {
      await action('confirm_pick', { order_id: orderId });
    },
  };
}
