import type { Item, Location, Order } from '../../shared/contract';
import {
  WmsError, type WmsClient, type WmsCredentials, type WmsDelivery, type WmsItem, type WmsLocation, type WmsPallet, type WmsRobotTask,
} from './types';

// URL-opbouw van de WMS-API (basis: https://<host>/t/wm_sim/api):
//   GET  {base}/{entiteit}                      -> lijst als { data: [...] }
//   GET  {base}/{entiteit}?veld=waarde          -> gefilterde lijst; één waarde per veld, geen OData
//   GET  {base}/truck_visit?status=checked_in   -> aangemelde vrachtwagens; hun ontvangsten: goods_receipt?dock_id=<id>
//   GET  {base}/{entiteit}?limit=200&offset=200 -> volgende pagina; antwoord { data, limit, offset }
//   POST {base}/{entiteit}                      -> record aanmaken (goods_receipt, pallet_move, customer_order,
//                                                  order_line, truck_visit, scan_log), JSON-body; gelukt = 201
//   POST {base}/{entiteit}/{id}/_flows/{flow}   -> actie op één record. Met invoer: { choice: 'bevestigen', input: {...} },
//                                                  zonder invoer: {}. Gelukt = 200, geweigerd = 409 met { error }.
// Acties: customer_order (start_picking, confirm_pick, stage_order, load_order), order_line (confirm_pick_line),
// stock (putaway, register_pallet), truck_visit (truck_check_out), goods_receipt (unload, count),
// robot_task (start_robot_task, complete_robot_task, fail_robot_task). De volledige beschrijving staat in
// GET {base}/_openapi. Artikelen en voorraad leest de game alleen.
//   POST {base}/location/_batch                 -> locaties aanmaken of bijwerken: { operations: [{ op: 'upsert',
//                                                  match: { location_id }, values: {...} }] }, hooguit 100 per call,
//                                                  alles of niets. Antwoord { results: [{ outcome }] }.
// Verwijzingen (sku, dock_id, *_location_id, order_id op een regel, truck_visit_id) zijn de platform-id (uuid,
// veld `id`), niet de tekstsleutel. Deze file vertaalt tussen beide; de rest van de game kent alleen
// de tekstsleutels (SKU-001, DOCK-01, ORD-…). Tekst blijven: pallet_id, truck_id en location_id bij scan_log.
// Wijkt de WMS af, pas dan alleen deze file aan.

type Row = { id: string };
type ItemRow = Row & { sku: string; description?: string | null; category?: string | null };
type LocationRow = Row & {
  location_id: string; location_type: Location['type']; pos_x: number; pos_y: number;
  level?: number | null; blocked?: boolean | number | string | null;
};
type StockRow = Row & { sku: string; location_id: string; qty: number };
type PalletRow = Row & { pallet_id: string; sku: string; qty: number; location_id: string; status: 'active' | 'empty' };
type OrderRow = Row & { order_id: string; status: Order['status'] };
type OrderLineRow = Row & { order_id: string; sku: string; qty: number; picked_qty?: number | null };
type TruckVisitRow = Row & {
  truck_id: string; status?: string | null; direction?: string | null; dock_id?: string | null; created_at?: string | null;
};
type ReceiptRow = Row & {
  sku: string; qty: number; dock_id: string; pallet_id?: string | null; created_at?: string | null; status?: string | null;
};
type RobotRow = Row & { robot_id: string };
type RobotTaskRow = Row & {
  task_id?: string | null; pallet_id: string; from_location_id: string; to_location_id: string;
  from_code?: string | null; to_code?: string | null; status?: string | null; robot_id?: string | null;
};

/** Twee kanten van een verwijzing: platform-id -> tekstsleutel en terug. */
type Refs = { keyById: Map<string, string>; idByKey: Map<string, string> };

const MAX_RETRIES = 3; // bij 429
const MAX_WAIT_S = 30;
const PAGE_SIZE = 200; // het maximum dat de WMS per call teruggeeft
const MAX_PAGES = 50;
const BATCH_SIZE = 100; // het maximum aan bewerkingen in één _batch-call

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
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : undefined) as T;
    // Fouten komen als JSON { error }: bij een weigering (409) is dat de melding voor de speler.
    let reason = '';
    try {
      const body = JSON.parse(text) as { error?: unknown; details?: unknown };
      if (typeof body?.error === 'string') reason = body.error;
      // Bij 400 zegt details welk veld niet klopt (bij een batch: operations.<n>.<veld>).
      const first = Array.isArray(body?.details) ? (body.details[0] as { path?: unknown; message?: unknown } | undefined) : undefined;
      if (reason && first && (first.path || first.message)) reason += ` (${[first.path, first.message].filter(Boolean).join(': ')})`;
    } catch {
      // geen JSON: de ruwe tekst hieronder
    }
    if (res.status === 401) throw new WmsError('Inloggen geweigerd: de API-sleutel is fout, verlopen of ingetrokken.', 401);
    if (res.status === 403) {
      // Scopes en acties worden per API-client aangevinkt in de WMS (Instellingen → Koppelingen → API).
      throw new WmsError(`Geen rechten${reason ? `: ${reason}` : ''}. Vink de scope of actie aan bij de API-client in de WMS.`, 403);
    }
    if (reason && (res.status === 409 || res.status === 400)) throw new WmsError(reason, res.status);
    throw new WmsError(`WMS-fout ${res.status}: ${(reason || text).slice(0, 300)}`, res.status);
  }

  /** Lijst, eventueel gefilterd met één waarde per veld. */
  async function list<R>(entity: string, filter?: Record<string, string>): Promise<R[]> {
    // De WMS geeft een lijst in pagina's: { data, limit, offset }, standaard 50 rijen en hooguit 200 per call.
    // Zonder alle pagina's op te halen mist de game locaties en voorraad.
    const rows: R[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ ...filter, limit: String(PAGE_SIZE), offset: String(rows.length) });
      const res = await request<R[] | { data?: R[]; limit?: number }>(`${entity}?${query}`);
      if (Array.isArray(res)) return res; // geen pagina's: de hele lijst in één keer
      const data = res?.data ?? [];
      rows.push(...data);
      if (data.length === 0 || data.length < (res?.limit ?? PAGE_SIZE)) break;
    }
    return rows;
  }

  const post = <T = unknown>(path: string, body: object = {}) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) });

  /** Actie op één record; `input` alleen als de actie invoer heeft. */
  const flow = (entity: string, id: string, name: string, input?: object) =>
    post(`${entity}/${id}/_flows/${name}`, input ? { choice: 'bevestigen', input } : {});

  // --- Verwijzingen: tekstsleutel <-> platform-id -------------------------------------------------

  const toRefs = (pairs: [id: string, key: string][]): Refs => ({
    keyById: new Map(pairs),
    idByKey: new Map(pairs.map(([id, key]) => [key, id])),
  });

  let items: Promise<Refs> | null = null;
  let locations: Promise<Refs> | null = null;
  /** order_id (tekst) -> platform-id van de order. */
  const orderIds = new Map<string, string>();
  /** truck_id (tekst) -> platform-id van het bezoek dat nu is aangemeld. */
  const visitIds = new Map<string, string>();
  /** Per aangemeld bezoek (platform-id) zijn ontvangsten: die veranderen niet meer, dus één keer ophalen. */
  const receipts = new Map<string, WmsDelivery['pallets']>();

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

  let robots: Promise<Refs> | null = null;
  /** task_id (tekst, RT-…) -> platform-id van de robotopdracht. */
  const taskIds = new Map<string, string>();

  const loadRobots = () =>
    (robots ??= list<RobotRow>('robot')
      .then((rows) => toRefs(rows.map((r) => [r.id, r.robot_id])))
      .catch((err) => {
        robots = null;
        throw err;
      }));

  async function robotUuid(robotId: string): Promise<string> {
    const id = (await loadRobots()).idByKey.get(robotId);
    if (!id) throw new WmsError(`Robot ${robotId} staat niet in de WMS.`, 409);
    return id;
  }

  async function taskUuid(taskId: string): Promise<string> {
    let id = taskIds.get(taskId);
    if (!id) {
      const row = (await list<RobotTaskRow>('robot_task', { task_id: taskId })).find((r) => r.task_id === taskId);
      if (!row) throw new WmsError(`Robotopdracht ${taskId} staat niet in de WMS.`, 409);
      taskIds.set(taskId, (id = row.id));
    }
    return id;
  }

  const refusedWith = (err: unknown, text: RegExp) => err instanceof WmsError && err.status === 409 && text.test(err.message);

  /** De ontvangsten van een pallet uit een levering van de WMS (goods_receipt.pallet_id = het stickernummer). */
  const receiptsOf = async (palletId: string) =>
    (await list<ReceiptRow>('goods_receipt', { pallet_id: palletId })).filter((r) => r.pallet_id === palletId);

  /** Lost de ontvangst; een pallet die al gelost blijkt is geen fout. */
  async function unloadRow(row: ReceiptRow) {
    try {
      await flow('goods_receipt', row.id, 'unload');
    } catch (err) {
      if (!refusedWith(err, /is al gelost/i)) throw err;
    }
  }

  /** false = de WMS heeft van deze pallet geen ontvangst die nog geteld moet worden. */
  async function countReceipt(palletId: string, qty: number): Promise<boolean> {
    const row = (await receiptsOf(palletId)).find((r) => r.status === 'received' || r.status === 'unloaded');
    if (!row) return false;
    if (row.status === 'received') await unloadRow(row); // het lossen is de WMS ontgaan: eerst dat, dan tellen
    try {
      await flow('goods_receipt', row.id, 'count', { counted_qty: qty });
    } catch (err) {
      if (!refusedWith(err, /is al geteld/i)) throw err;
    }
    return true;
  }

  const learn = (refs: Refs, id: string, key: string) => {
    refs.idByKey.set(key, id);
    refs.keyById.set(id, key);
  };

  // Staat een sleutel niet in de lijst (net toegevoegd, of de WMS gaf niet de hele lijst terug), dan
  // zoeken we dat ene record op met een filter op de sleutel.

  async function itemId(sku: string): Promise<string> {
    const refs = await loadItems();
    let id = refs.idByKey.get(sku);
    if (!id) {
      const row = (await list<ItemRow>('item', { sku })).find((r) => r.sku === sku);
      if (row) learn(refs, (id = row.id), sku);
    }
    if (!id) throw new WmsError(`Artikel ${sku} staat niet in de WMS.`);
    return id;
  }

  /** Platform-id van een locatie, of undefined als de WMS hem niet kent. */
  async function findLocation(key: string): Promise<string | undefined> {
    const refs = await loadLocations();
    let id = refs.idByKey.get(key);
    if (!id) {
      const row = (await list<LocationRow>('location', { location_id: key })).find((r) => r.location_id === key);
      if (row) learn(refs, (id = row.id), key);
    }
    return id;
  }

  async function locationId(key: string): Promise<string> {
    const id = await findLocation(key);
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

  /** Het bezoek van een aangemelde vrachtwagen; na een herstart van de game zoeken we het op. */
  async function visitUuid(truckId: string): Promise<string> {
    let id = visitIds.get(truckId);
    if (!id) {
      const rows = (await list<TruckVisitRow>('truck_visit', { truck_id: truckId })).filter((r) => r.truck_id === truckId);
      id = (rows.find((r) => r.status === 'checked_in') ?? rows[rows.length - 1])?.id;
      if (!id) throw new WmsError(`Vrachtwagen ${truckId} is niet aangemeld in de WMS.`);
      visitIds.set(truckId, id);
    }
    return id;
  }

  /** De voorraadregel van een artikel op een locatie: daarop draaien de acties putaway en register_pallet. */
  async function stockRow(sku: string, locationKey: string): Promise<StockRow> {
    const [skuRef, locRef] = await Promise.all([itemId(sku), locationId(locationKey)]);
    const rows = await list<StockRow>('stock', { sku: skuRef, location_id: locRef });
    const row = rows.find((r) => r.sku === skuRef && r.location_id === locRef);
    if (!row) throw new WmsError(`Op ${locationKey} ligt in de WMS geen ${sku}.`, 409);
    return row;
  }

  /** Kent de WMS deze pallet als actieve pallet? Een onbekende of lege pallet telt als losse voorraad. */
  async function isPallet(palletId: string): Promise<boolean> {
    const rows = await list<PalletRow>('pallet', { pallet_id: palletId });
    return rows.some((r) => r.pallet_id === palletId && r.status === 'active');
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

    async syncLocations(list, onProgress) {
      const round = (n: number) => Math.round(n * 1000) / 1000;
      let created = 0;
      let updated = 0;
      try {
        for (let i = 0; i < list.length; i += BATCH_SIZE) {
          const res = await post<{ results?: { outcome?: string }[] } | undefined>('location/_batch', {
            operations: list.slice(i, i + BATCH_SIZE).map((l) => ({
              op: 'upsert',
              match: { location_id: l.id },
              values: { location_type: l.type, pos_x: round(l.x), pos_y: round(l.y), level: l.level },
            })),
          });
          for (const r of res?.results ?? []) {
            if (r.outcome === 'created') created++;
            else if (r.outcome === 'updated') updated++;
          }
          onProgress?.(Math.min(i + BATCH_SIZE, list.length));
        }
      } finally {
        locations = null; // nieuwe locaties hebben een nieuwe platform-id: de verwijzingen opnieuw ophalen
      }
      return { created, updated };
    },

    async getStock(): Promise<Item[]> {
      const [rows, item, loc] = await Promise.all([list<StockRow>('stock'), loadItems(), loadLocations()]);
      return rows.map((r) => ({
        sku: item.keyById.get(r.sku) ?? r.sku,
        qty: Number(r.qty),
        locationId: loc.keyById.get(r.location_id) ?? r.location_id,
      }));
    },

    async getPallets() {
      const [rows, item, loc] = await Promise.all([list<PalletRow>('pallet', { status: 'active' }), loadItems(), loadLocations()]);
      return rows
        .filter((r) => r.status === 'active' && Number(r.qty) > 0)
        .map((r): WmsPallet => ({
          id: r.pallet_id,
          sku: item.keyById.get(r.sku) ?? r.sku,
          qty: Number(r.qty),
          locationId: loc.keyById.get(r.location_id) ?? r.location_id,
        }));
    },

    async getOpenOrders() {
      // te_picken = status open of picking, in één call (filters met 'or' kent de API niet).
      const [open, lines, item] = await Promise.all([
        list<OrderRow>('customer_order', { te_picken: 'true' }),
        list<OrderLineRow>('order_line'),
        loadItems(),
      ]);
      return open
        .filter((o) => o.status === 'open' || o.status === 'picking')
        .map((o) => {
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

    async registerPallet({ palletId, sku, qty, locationId: at }) {
      const row = await stockRow(sku, at);
      await flow('stock', row.id, 'register_pallet', { pallet_id: palletId, pallet_qty: qty });
    },

    async confirmPutaway({ sku, qty, fromLocationId, toLocationId, palletId }) {
      const toRef = await locationId(toLocationId);
      // Een pallet met sticker verhuist in zijn geheel: de WMS weet zelf waar hij stond en wat erop staat.
      if (palletId && (await isPallet(palletId))) {
        const move = () => post('pallet_move', { pallet_id: palletId, to_location_id: toRef });
        try {
          await move();
        } catch (err) {
          // Een pallet uit een levering van de WMS moet eerst geteld zijn. Zet een speler hem met de hand weg zonder
          // dat de telrobot langs is geweest, dan telt het scannen bij het wegzetten als de telling.
          if (!refusedWith(err, /nog niet geteld/i) || !(await countReceipt(palletId, qty))) throw err;
          await move();
        }
        return;
      }
      // Zonder (bekende) sticker: losse voorraad van de voorraadregel op de van-locatie.
      const row = await stockRow(sku, fromLocationId);
      await flow('stock', row.id, 'putaway', { putaway_qty: qty, to_location_id: toRef });
    },

    async createOrder(lines, orderId) {
      const skuRefs = await Promise.all(lines.map((l) => itemId(l.sku))); // eerst controleren, dan pas de order aanmaken
      const order = await post<OrderRow>('customer_order', orderId ? { order_id: orderId } : {});
      orderIds.set(order.order_id, order.id);
      // Regel voor regel: zo blijft bij een fout duidelijk welke regel de WMS weigerde.
      for (let i = 0; i < lines.length; i++) {
        await post('order_line', { order_id: order.id, line_no: i + 1, sku: skuRefs[i], qty: lines[i].qty });
      }
      return order.order_id;
    },

    async startPicking(orderId) {
      await flow('customer_order', await orderUuid(orderId), 'start_picking');
    },

    async confirmPickLine({ orderId, sku, qty, locationId: at }) {
      const [orderRef, skuRef, locRef] = await Promise.all([orderUuid(orderId), itemId(sku), locationId(at)]);
      const lines = (await list<OrderLineRow>('order_line', { order_id: orderRef }))
        .filter((l) => l.order_id === orderRef && l.sku === skuRef)
        .map((l) => ({ id: l.id, open: Number(l.qty) - Number(l.picked_qty ?? 0) }))
        .filter((l) => l.open > 0);
      if (lines.reduce((n, l) => n + l.open, 0) < qty) throw new WmsError(`Order ${orderId} heeft geen ${qty}× ${sku} meer open.`, 409);
      // Staat het artikel op meer regels, dan gaat de pick over die regels heen.
      let rest = qty;
      for (const l of lines) {
        if (rest <= 0) break;
        const take = Math.min(rest, l.open);
        await flow('order_line', l.id, 'confirm_pick_line', { pick_qty: take, location_id: locRef });
        rest -= take;
      }
    },

    async confirmPick(orderId) {
      await flow('customer_order', await orderUuid(orderId), 'confirm_pick');
    },

    async stageOrder({ orderId, dockId }) {
      const [orderRef, dockRef] = await Promise.all([orderUuid(orderId), locationId(dockId)]);
      await flow('customer_order', orderRef, 'stage_order', { dock_id: dockRef });
    },

    async loadOrder({ orderId, truckId }) {
      const [orderRef, visitRef] = await Promise.all([orderUuid(orderId), visitUuid(truckId)]);
      await flow('customer_order', orderRef, 'load_order', { truck_visit_id: visitRef });
    },

    async truckCheckIn({ truckId, direction, dockId }) {
      const dockRef = await locationId(dockId);
      visitIds.delete(truckId); // een nieuw bezoek krijgt een nieuwe id
      try {
        const row = await post<TruckVisitRow | undefined>('truck_visit', { truck_id: truckId, direction, dock_id: dockRef });
        if (row?.id) visitIds.set(truckId, row.id);
      } catch (err) {
        // Stond hij al aangemeld (de game is herstart terwijl de wagen aan het dock stond), dan gaat het bezoek door.
        if (!(err instanceof WmsError && err.status === 409 && /is al aangemeld/i.test(err.message))) throw err;
        await visitUuid(truckId);
      }
    },

    async truckCheckOut({ truckId }) {
      await flow('truck_visit', await visitUuid(truckId), 'truck_check_out');
      visitIds.delete(truckId);
    },

    async getDeliveries() {
      const [visits, item, loc] = await Promise.all([
        list<TruckVisitRow>('truck_visit', { status: 'checked_in' }),
        loadItems(),
        loadLocations(),
      ]);
      const out: WmsDelivery[] = [];
      for (const v of visits) {
        if (v.status !== 'checked_in' || v.direction !== 'in' || !v.dock_id) continue;
        visitIds.set(v.truck_id, v.id);
        let pallets = receipts.get(v.id);
        if (!pallets) {
          // De ontvangsten van dit bezoek: op hetzelfde dock, met de pallet van deze wagen (PAL-<truck_id>) of
          // geboekt nadat de wagen is aangemeld.
          const rows = await list<ReceiptRow>('goods_receipt', { dock_id: v.dock_id });
          pallets = rows
            .filter((r) => r.dock_id === v.dock_id)
            .filter((r) => r.pallet_id === `PAL-${v.truck_id}` || (!!r.created_at && !!v.created_at && r.created_at >= v.created_at))
            .map((r) => ({ palletId: r.pallet_id || undefined, sku: item.keyById.get(r.sku) ?? r.sku, qty: Number(r.qty) }));
          if (pallets.length) receipts.set(v.id, pallets);
        }
        out.push({ truckId: v.truck_id, dockId: loc.keyById.get(v.dock_id) ?? v.dock_id, pallets });
      }
      for (const id of receipts.keys()) if (!visits.some((v) => v.id === id)) receipts.delete(id);
      return out;
    },

    async unloadReceipt({ palletId }) {
      const row = (await receiptsOf(palletId)).find((r) => r.status === 'received');
      if (!row) return false;
      await unloadRow(row);
      return true;
    },

    countReceipt: ({ palletId, qty }) => countReceipt(palletId, qty),

    async getRobots() {
      return [...(await loadRobots()).idByKey.keys()];
    },

    async getRobotTasks(running = false) {
      const [open, busy, loc, robot] = await Promise.all([
        list<RobotTaskRow>('robot_task', { status: 'open' }),
        running ? list<RobotTaskRow>('robot_task', { status: 'in_progress' }) : [],
        loadLocations(),
        loadRobots(),
      ]);
      const code = (text: string | null | undefined, ref: string) => text || loc.keyById.get(ref) || ref;
      return [...open.filter((r) => r.status === 'open'), ...busy.filter((r) => r.status === 'in_progress')].map((r): WmsRobotTask => {
        const id = r.task_id || r.id;
        taskIds.set(id, r.id);
        const robotId = r.status === 'in_progress' ? (r.robot_id && robot.keyById.get(r.robot_id)) || '?' : undefined;
        return {
          id,
          palletId: r.pallet_id,
          fromLocationId: code(r.from_code, r.from_location_id),
          toLocationId: code(r.to_code, r.to_location_id),
          ...(robotId && { robotId }),
        };
      });
    },

    async startRobotTask({ taskId, robotId }) {
      const [taskRef, robotRef] = await Promise.all([taskUuid(taskId), robotUuid(robotId)]);
      await flow('robot_task', taskRef, 'start_robot_task', { robot: robotRef });
    },

    async completeRobotTask({ taskId, robotId }) {
      const [taskRef, robotRef] = await Promise.all([taskUuid(taskId), robotUuid(robotId)]);
      await flow('robot_task', taskRef, 'complete_robot_task', { robot: robotRef });
      taskIds.delete(taskId);
    },

    async failRobotTask({ taskId, robotId, reason, palletOnRobot }) {
      const taskRef = await taskUuid(taskId);
      // Een robot die de WMS niet kent kan de opdracht ook niet gestart hebben: dan zonder robot melden.
      const robotRef = robotId ? (await loadRobots()).idByKey.get(robotId) : undefined;
      try {
        await flow('robot_task', taskRef, 'fail_robot_task', {
          ...(robotRef && { robot: robotRef }),
          reason: reason.slice(0, 300),
          draagt_pallet: palletOnRobot,
        });
      } catch (err) {
        if (!refusedWith(err, /is al afgerond/i)) throw err;
      }
      taskIds.delete(taskId);
    },

    async logScan({ kind, barcode, ok, locationId: at }) {
      await post('scan_log', { kind, barcode, ok, ...(at ? { location_id: at } : {}) });
    },
  };
}
