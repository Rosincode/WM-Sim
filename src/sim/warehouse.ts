import type { Item, Order } from '../shared/contract';
import { publish, type Direction, type ProcessEvent, type ScanKind } from './events';
import { articles, isBlocked, skus } from './catalog';
import {
  DOCKS, LANE_SLOTS, LOCATIONS, POINTS,
  dist, lanePoint, location, shelfLocations, type Dock, type Point,
} from './layout';
import { offlineGateway, type WmsGateway, type WmsReply } from './wms';

// De fysieke wereld van het magazijn: vrachtwagens, pallets, rolcontainers en wat er in de stellingen staat.
// De sim beslist niets wat van de WMS is: geen orders aanmaken, geen locatie-advies, geen pickverdeling,
// geen voorraadcontroles. Elke handeling van de speler gaat eerst als vraag naar de WMS (src/sim/wms.ts);
// pas na akkoord gebeurt hij fysiek. Weigert de WMS, dan gebeurt er niets en ziet de speler de melding.

export type Pallet = { id: string; sku: string; qty: number };
export type TruckStatus = 'arriving' | 'waiting' | 'checkedIn' | 'departing';
export type Truck = {
  id: string;
  direction: Direction;
  dockId: string;
  /** Index in DOCKS van de deur waar de wagen staat. */
  dock: number;
  status: TruckStatus;
  /** 0 = op de weg, 1 = tegen de dockdeur. */
  t: number;
  cargo: Pallet[];
  loaded: string[];
};
/** picked = wat er al in de rolcontainer ligt. */
export type OrderLine = { sku: string; qty: number; picked: number };
/** Eén greep uit een locatie; booked = de WMS heeft hem al afgeboekt. */
export type Pick = { sku: string; qty: number; locationId: string; booked: boolean };
/** Waar de rolcontainer van de order fysiek is; 'open' = nog niet gepakt. */
export type SimOrderStatus = 'open' | 'picking' | 'picked' | 'staged' | 'loaded' | 'shipped';
export type SimOrder = {
  id: string;
  lines: OrderLine[];
  status: SimOrderStatus;
  /** Status in de WMS toen de order daar voor het laatst gelezen of gewijzigd is. */
  wmsStatus: Order['status'];
  picks: Pick[];
};
export type Carry = { kind: 'pallet'; pallet: Pallet; fromId: string } | { kind: 'order'; orderId: string } | null;
export type Message = { text: string; kind: 'info' | 'ok' | 'err'; at: number };
export type Interaction = { label: string; point: Point; enabled: boolean; run?: () => void };
/** point ontbreekt als de WMS (app of scanner) de speler moet vertellen waar hij heen moet. */
export type Objective = { point?: Point; level?: number; text: string };
/** Uitkomst van een scan of handeling, voor het scherm van de scanner. */
export type ScanResult = { ok: boolean; text: string };

const DRIVE_SECONDS = 4;
const DEMO_ORDER_INTERVAL = 45;
const DEMO_MAX_OPEN_ORDERS = 2;
/** Zo dichtbij (m) moet je staan om op een gescande locatie iets neer te zetten of te pakken. */
const REACH = 3.2;
const DOCK_REACH = 4.5;

const rand = (n: number) => Math.floor(Math.random() * n);
const pad = (n: number, w = 3) => String(n).padStart(w, '0');
const stamp = Date.now().toString(36).slice(-4).toUpperCase(); // uniek per sessie, voor id's in de echte WMS

interface Options {
  gateway?: WmsGateway;
  /** true: er is geen WMS-app om orders in te voeren (mock); de sim speelt dan zelf klant via create_order. */
  demoOrders?: () => boolean;
}

export function createWarehouse({ gateway = offlineGateway, demoOrders = () => false }: Options = {}) {
  const stock = new Map<string, number>(); // wat er fysiek in de stellingen staat; sleutel: locationId|sku
  const orders: SimOrder[] = [];
  // Per dock een inslagbaan (pallets) en een uitslagbaan (order-id's).
  const laneIn: (Pallet | null)[][] = DOCKS.map(() => Array(LANE_SLOTS).fill(null));
  const laneOut: (string | null)[][] = DOCKS.map(() => Array(LANE_SLOTS).fill(null));
  const trucks: { in: Truck | null; out: Truck | null } = { in: null, out: null };
  /** Pallets die op de heftruck (of los op de vloer) staan: fysiek weg uit de stelling, in de WMS nog niet. */
  const forks = new Map<string, { locationId: string; sku: string; qty: number }>();
  /** Pallets die iemand van een inslaglocatie heeft opgepakt: fysiek van het dock af, in de WMS staan ze er nog. */
  const transit = new Map<string, { fromId: string; sku: string; qty: number }>();
  const messages: Message[] = [];
  let carry: Carry = null;
  let clock = 0;
  let inTimer = 3;
  let outTimer = 5;
  let orderTimer = 8;
  /** Dock waar de volgende (of huidige) uitgaande vrachtwagen komt; daar zet je orders klaar. */
  let outDock = rand(DOCKS.length);
  const seq = { truckIn: 1, truckOut: 1, pallet: 1, order: 1 };
  let authority = true;
  /** De wereld is (mede) door een andere speler gevormd. */
  let foreign = false;
  /** Aantal vragen dat nog bij de WMS loopt. */
  let pending = 0;
  /** Telt elke wijziging in de fysieke wereld; zo herkent de UI een verouderde WMS-stand. */
  let revision = 0;
  const touch = () => void revision++;

  // --- Berichten ---
  function say(text: string, kind: Message['kind'] = 'info') {
    messages.push({ text, kind, at: clock });
    if (messages.length > 6) messages.shift();
  }
  const done = (text: string): ScanResult => (say(text, 'ok'), { ok: true, text });
  const refused = (text: string): ScanResult => (say(text, 'err'), { ok: false, text });
  const wmsRefused = (r: WmsReply & { ok: false }, what = '') => refused(`WMS weigert${what}: ${r.error}`);

  // --- De WMS vragen ---
  async function ask(e: ProcessEvent): Promise<WmsReply> {
    pending++;
    let reply: WmsReply;
    try {
      reply = await gateway.send(e);
    } catch (err) {
      reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    pending--;
    publish(e, reply.ok ? { ok: true, linked: reply.linked } : { ok: false, linked: true, error: reply.error });
    return reply;
  }
  /** Elke scan, ook een mislukte (register_scan). */
  const scanned = (kind: ScanKind, barcode: string, ok: boolean, locationId?: string) =>
    publish({ type: 'Scanned', kind, barcode, ok, locationId });

  /** De speler doet één ding tegelijk: tijdens een vraag aan de WMS wacht de volgende handeling. */
  let acting = false;
  async function guard(action: () => Promise<ScanResult> | ScanResult): Promise<ScanResult> {
    if (acting) return { ok: false, text: 'Even wachten: de WMS verwerkt de vorige scan.' };
    acting = true;
    try {
      return await action();
    } finally {
      acting = false;
    }
  }

  // --- Wat er fysiek staat ---
  const key = (loc: string, sku: string) => `${loc}|${sku}`;
  const qtyAt = (loc: string, sku: string) => stock.get(key(loc, sku)) ?? 0;
  function add(loc: string, sku: string, qty: number) {
    const q = qtyAt(loc, sku) + qty;
    if (q <= 0) stock.delete(key(loc, sku));
    else stock.set(key(loc, sku), q);
  }
  function stockList(): Item[] {
    return [...stock].map(([k, qty]) => {
      const [locationId, sku] = k.split('|');
      return { locationId, sku, qty };
    });
  }
  const stockAt = (loc: string) => stockList().filter((s) => s.locationId === loc);
  const shelfQty = (sku: string) => shelfLocations().reduce((n, l) => n + qtyAt(l.id, sku), 0);
  const isShelf = (id: string) => {
    const l = location(id);
    return !!l && l.type !== 'dock';
  };

  const order = (id: string) => orders.find((o) => o.id === id);
  const truck = (id: string) => [trucks.in, trucks.out].find((t) => t?.id === id) ?? null;
  const carriedOrder = () => (carry?.kind === 'order' ? order(carry.orderId) : undefined);
  const openLines = (o: SimOrder) => o.lines.filter((l) => l.picked < l.qty);
  const linesText = (lines: { sku: string; qty: number }[]) => lines.map((l) => `${l.qty}× ${l.sku}`).join(', ');
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // ========== Handelingen: eerst de WMS, dan de fysieke wereld ==========

  async function checkIn(truckId: string): Promise<ScanResult> {
    const t = truck(truckId);
    if (!t || t.status !== 'waiting') return refused(`${truckId} staat niet te wachten.`);
    const r = await ask({ type: 'TruckCheckedIn', truckId, direction: t.direction, dockId: t.dockId });
    scanned('truck', truckId, r.ok, t.dockId);
    if (!r.ok) return wmsRefused(r);
    const now = truck(truckId);
    if (now) now.status = 'checkedIn';
    touch();
    return done(`${truckId} aangemeld aan ${t.dockId}.`);
  }

  async function checkOut(truckId: string): Promise<ScanResult> {
    const t = truck(truckId);
    if (!t || t.status !== 'checkedIn') return refused(`${truckId} is niet aangemeld.`);
    const r = await ask({ type: 'TruckCheckedOut', truckId, direction: t.direction, dockId: t.dockId, orderIds: [...t.loaded] });
    scanned('truck', truckId, r.ok, t.dockId);
    if (!r.ok) return wmsRefused(r);
    const now = truck(truckId);
    if (!now) return refused(`${truckId} is al vertrokken.`);
    now.status = 'departing';
    for (const id of now.loaded) {
      const o = order(id);
      if (o) o.status = 'shipped';
    }
    touch();
    return done(`${truckId} uitgemeld${now.loaded.length ? ` met ${plural(now.loaded.length, 'order')}` : ''}.`);
  }

  async function unload(truckId: string): Promise<ScanResult> {
    const t = truck(truckId);
    const pallet = t?.cargo[0];
    if (!t || !pallet) return refused('Er staat niets meer in de vrachtwagen.');
    const { inId } = DOCKS[t.dock];
    const lane = laneIn[t.dock];
    if (!lane.includes(null)) return refused(`${inId} staat vol: zet eerst pallets weg.`);
    const r = await ask({ type: 'GoodsReceived', sku: pallet.sku, qty: pallet.qty, dockId: inId, palletId: pallet.id });
    scanned('pallet', pallet.id, r.ok, inId);
    if (!r.ok) return wmsRefused(r);
    const now = truck(truckId);
    const i = now?.cargo.findIndex((p) => p.id === pallet.id) ?? -1;
    if (!now || i < 0 || !laneIn[t.dock].includes(null)) return refused(`${pallet.id} is al gelost.`);
    now.cargo.splice(i, 1);
    laneIn[t.dock][laneIn[t.dock].lastIndexOf(null)] = pallet; // doorschuiven: de eerste pallet staat het verst de hal in
    touch();
    return done(`Ontvangen op ${inId}: ${pallet.id}, ${pallet.qty}× ${pallet.sku}.`);
  }

  function pickUpPallet(d: Dock, slot: number): ScanResult {
    const pallet = laneIn[d.index][slot];
    if (!pallet || carry) return refused('Hier valt niets op te pakken.');
    scanned('pallet', pallet.id, true, d.inId);
    laneIn[d.index][slot] = null;
    transit.set(pallet.id, { fromId: d.inId, sku: pallet.sku, qty: pallet.qty });
    carry = { kind: 'pallet', pallet, fromId: d.inId };
    touch();
    return done(`${pallet.id} opgepakt (${pallet.qty}× ${pallet.sku}). Scan de stellinglocatie waar je hem wegzet.`);
  }

  function returnPallet(d: Dock): ScanResult {
    if (carry?.kind !== 'pallet') return refused('Je draagt geen pallet.');
    const lane = laneIn[d.index];
    if (!lane.includes(null)) return refused(`${d.inId} staat vol.`);
    lane[lane.lastIndexOf(null)] = carry.pallet;
    transit.delete(carry.pallet.id);
    const text = `${carry.pallet.id} teruggezet op ${d.inId}.`;
    carry = null;
    touch();
    return done(text);
  }

  /** Zet de gedragen pallet op de gescande locatie. Of dat mag bepaalt de WMS (confirm_putaway). */
  async function putaway(locId: string): Promise<ScanResult> {
    if (carry?.kind !== 'pallet') return refused('Je draagt geen pallet.');
    const { pallet, fromId } = carry;
    if (!isShelf(locId)) return refused(`${locId} is geen stellinglocatie.`);
    if (stockAt(locId).some((s) => s.sku !== pallet.sku)) {
      scanned('location', locId, false, locId);
      return refused(`Op ${locId} staat al een ander artikel: daar past deze pallet niet bij.`);
    }
    const r = await ask({
      type: 'PutawayDone', sku: pallet.sku, qty: pallet.qty,
      fromLocationId: fromId, locationId: locId, palletId: pallet.id,
    });
    scanned('location', locId, r.ok, locId);
    if (!r.ok) return wmsRefused(r);
    if (carry?.kind === 'pallet' && carry.pallet.id === pallet.id) carry = null;
    transit.delete(pallet.id);
    add(locId, pallet.sku, pallet.qty);
    touch();
    return done(`${pallet.id} weggezet op ${locId}.`);
  }

  /** Pakt een rolcontainer voor de eerste open order uit de WMS (start_picking). */
  async function takeContainer(): Promise<ScanResult> {
    if (carry) return refused('Handen vol.');
    const o = orders.find((x) => x.status === 'open');
    if (!o) return refused('Geen open orders in de WMS.');
    // Stond de order in de WMS al op picking (herstart, of eerder teruggezet), dan gaan we daarmee verder.
    if (o.wmsStatus !== 'picking') {
      const r = await ask({ type: 'PickStarted', orderId: o.id });
      scanned('order', o.id, r.ok);
      if (!r.ok) return wmsRefused(r);
    }
    const now = order(o.id);
    if (!now || now.status !== 'open' || carry) return refused(`${o.id} is al door iemand anders gepakt.`);
    now.status = 'picking';
    now.wmsStatus = 'picking';
    carry = { kind: 'order', orderId: now.id };
    touch();
    return done(`Rolcontainer voor ${now.id}: ${linesText(now.lines)}. Zoek de locaties op in de WMS-app.`);
  }

  /** Legt alles terug en zet de rolcontainer weer weg. */
  function returnContainer(): ScanResult {
    const o = carriedOrder();
    if (!o || o.status !== 'picking') return refused('Je hebt geen order onderhanden.');
    if (o.picks.some((p) => p.booked)) return refused(`${o.id}: de WMS heeft al picks geboekt; maak de order af.`);
    for (const p of o.picks) add(p.locationId, p.sku, p.qty);
    o.picks = [];
    for (const l of o.lines) l.picked = 0;
    o.status = 'open';
    carry = null;
    touch();
    return done(`Rolcontainer van ${o.id} teruggezet.`);
  }

  /** Pakt van de gescande locatie wat de order nog nodig heeft. Of dat klopt bepaalt de WMS. */
  async function pickAt(locId: string): Promise<ScanResult> {
    const o = carriedOrder();
    if (!o || o.status !== 'picking') return refused('Je hebt geen order onderhanden.');
    if (openLines(o).length === 0) return completePick(o.id);
    const line = openLines(o).find((l) => qtyAt(locId, l.sku) > 0);
    if (!line) {
      scanned('location', locId, false, locId);
      return refused(`Op ${locId} ligt niets wat ${o.id} nog nodig heeft.`);
    }
    const { sku } = line;
    const qty = Math.min(line.qty - line.picked, qtyAt(locId, sku));
    const r = await ask({ type: 'PickLineConfirmed', orderId: o.id, sku, qty, locationId: locId });
    scanned('location', locId, r.ok, locId);
    if (!r.ok) return wmsRefused(r);
    const now = order(o.id);
    const nowLine = now?.lines.find((l) => l.sku === sku && l.picked < l.qty);
    if (!now || !nowLine || qtyAt(locId, sku) < qty) return refused(`${locId} is intussen gewijzigd: scan opnieuw.`);
    add(locId, sku, -qty);
    nowLine.picked += qty;
    now.picks.push({ sku, qty, locationId: locId, booked: r.linked });
    touch();
    if (openLines(now).length === 0) return completePick(now.id);
    return done(`Gepickt: ${qty}× ${sku} van ${locId}. Nog nodig: ${linesText(openLines(now).map((l) => ({ sku: l.sku, qty: l.qty - l.picked })))}.`);
  }

  /** Meldt de complete order af bij de WMS (confirm_pick). */
  async function completePick(orderId: string): Promise<ScanResult> {
    const r = await ask({ type: 'PickCompleted', orderId });
    if (!r.ok) return wmsRefused(r, ` het afmelden van ${orderId}`);
    const o = order(orderId);
    if (o) {
      o.status = 'picked';
      o.wmsStatus = 'done';
    }
    touch();
    return done(`${orderId} compleet gepickt en afgemeld. Breng hem naar een uitslaglocatie of de vrachtwagen.`);
  }

  async function stage(dockIndex: number): Promise<ScanResult> {
    const o = carriedOrder();
    const d = DOCKS[dockIndex];
    if (!o || o.status !== 'picked') return refused('Je hebt geen afgemelde order bij je.');
    if (!laneOut[dockIndex].includes(null)) return refused(`${d.outId} staat vol.`);
    const r = await ask({ type: 'OrderStaged', orderId: o.id, dockId: d.outId });
    scanned('location', d.outId, r.ok, d.outId);
    if (!r.ok) return wmsRefused(r);
    const now = order(o.id);
    const lane = laneOut[dockIndex];
    if (!now || !lane.includes(null)) return refused(`${d.outId} staat vol.`);
    lane[lane.indexOf(null)] = now.id;
    now.status = 'staged';
    carry = null;
    touch();
    return done(`${now.id} klaargezet op ${d.outId}.`);
  }

  function takeStaged(d: Dock, slot: number): ScanResult {
    const id = laneOut[d.index][slot];
    const o = id ? order(id) : undefined;
    if (!o || carry) return refused('Hier valt niets op te pakken.');
    laneOut[d.index][slot] = null;
    o.status = 'picked';
    carry = { kind: 'order', orderId: o.id };
    scanned('order', o.id, true, d.outId);
    touch();
    return done(`${o.id} opgepakt voor inladen.`);
  }

  async function load(truckId: string): Promise<ScanResult> {
    const t = truck(truckId);
    const o = carriedOrder();
    if (!t || !o) return refused('Niets om in te laden.');
    const r = await ask({ type: 'OrderLoaded', orderId: o.id, truckId, dockId: t.dockId });
    scanned('order', o.id, r.ok, t.dockId);
    if (!r.ok) return wmsRefused(r);
    const nowTruck = truck(truckId);
    const now = order(o.id);
    if (!nowTruck || !now) return refused(`${truckId} is al vertrokken.`);
    nowTruck.loaded.push(now.id);
    now.status = 'loaded';
    carry = null;
    touch();
    return done(`${now.id} ingeladen in ${truckId}.`);
  }

  /** Wat staat hier fysiek? Voor wie zonder scanner (E) langs een stelling loopt. */
  function lookAt(sectionLocId: string): ScanResult {
    const loc = location(sectionLocId)!;
    const levels = LOCATIONS.filter((l) => l.x === loc.x && l.z === loc.z && l.type !== 'dock');
    scanned('location', loc.id, true, loc.id);
    const text = levels
      .map((l) => `${l.id}: ${linesText(stockAt(l.id)) || 'leeg'}${isBlocked(l.id) ? ' (geblokkeerd)' : ''}`)
      .join(' · ');
    say(text);
    return { ok: true, text };
  }

  // ========== Heftruck: hele pallets tussen stellinglocaties verplaatsen ==========

  /** Haalt (maximaal maxQty van) het grootste artikel van een locatie; de pallet staat daarna op de vorken. */
  function forkliftTake(locId: string, maxQty: number): Pallet | null {
    const top = stockAt(locId).sort((a, b) => b.qty - a.qty)[0];
    if (!top) return null;
    const qty = Math.min(maxQty, top.qty);
    const pallet = { id: `PAL-${stamp}-${pad(seq.pallet++, 4)}`, sku: top.sku, qty };
    add(locId, top.sku, -qty);
    forks.set(pallet.id, { locationId: locId, sku: top.sku, qty });
    touch();
    say(`Heftruck: ${qty}× ${top.sku} van ${locId} gepakt.`);
    return pallet;
  }

  /**
   * Zet een pallet van de vorken op een stellinglocatie en meldt de verplaatsing bij de WMS (confirm_putaway).
   * De pallet staat er dan al; weigert de WMS, dan blijft de WMS leidend en trekt de volgende stand het recht.
   */
  function forkliftPlace(locId: string, pallet: Pallet, fromLocationId: string) {
    add(locId, pallet.sku, pallet.qty);
    touch();
    if (fromLocationId === locId) {
      forks.delete(pallet.id);
      say(`${pallet.id} teruggezet op ${locId}.`);
      return;
    }
    void ask({
      type: 'PutawayDone', sku: pallet.sku, qty: pallet.qty,
      fromLocationId, locationId: locId, palletId: pallet.id,
    }).then((r) => {
      forks.delete(pallet.id);
      touch();
      if (r.ok) say(`${pallet.id} verplaatst van ${fromLocationId} naar ${locId}.`, 'ok');
      else say(`WMS weigert de verplaatsing van ${fromLocationId} naar ${locId}: ${r.error} De WMS blijft leidend.`, 'err');
    });
  }

  // ========== Interacties rond de speler (E) ==========

  type Action = () => Promise<ScanResult> | ScanResult;
  const interaction = (label: string, point: Point, action?: Action): Interaction => ({
    label, point, enabled: !!action, run: action && (() => void guard(action)),
  });

  function truckInteraction(t: Truck | null): Interaction | null {
    if (!t || t.status === 'arriving' || t.status === 'departing') return null;
    const i = (label: string, action?: Action) => interaction(label, DOCKS[t.dock].truck, action);
    if (t.status === 'waiting') return i(`Scan ${t.id}: aanmelden`, () => checkIn(t.id));
    if (carry?.kind === 'pallet') return i('Zet eerst je pallet weg');

    if (t.direction === 'in') {
      if (carry) return i('Handen vol');
      if (t.cargo.length === 0) return i(`Scan ${t.id}: uitmelden`, () => checkOut(t.id));
      const p = t.cargo[0];
      return i(`Scan ${p.id} en los (${p.qty}× ${p.sku}, nog ${t.cargo.length})`, () => unload(t.id));
    }

    const o = carriedOrder();
    if (o) return o.status === 'picked' ? i(`Scan ${o.id} en laad in`, () => load(t.id)) : i(`${o.id} is nog niet afgemeld`);
    return i(`Scan ${t.id}: uitmelden (${plural(t.loaded.length, 'order')})`, () => checkOut(t.id));
  }

  function candidates(pos: Point): (Interaction & { radius: number })[] {
    const list: (Interaction & { radius: number })[] = [];
    const push = (it: Interaction | null, radius: number) => it && list.push({ ...it, radius });

    push(truckInteraction(trucks.in), 2.2);
    push(truckInteraction(trucks.out), 2.2);

    // Per dock: inslaglocatie (pallets oppakken) en uitslaglocatie (orders klaarzetten of oppakken)
    const o = carriedOrder();
    for (const d of DOCKS) {
      if (Math.abs(pos.z - d.z) > 4.5) continue;
      const inPoint = lanePoint(d.laneIn, pos);
      const inSlot = laneIn[d.index].findLastIndex((p) => p); // de pallet aan de halkant eerst
      if (carry?.kind === 'pallet') {
        if (carry.fromId === d.inId) push(interaction(`Pallet terugzetten op ${d.inId}`, inPoint, () => returnPallet(d)), 1.5);
      } else if (!carry && inSlot >= 0) {
        const p = laneIn[d.index][inSlot]!;
        push(interaction(`Scan ${p.id} op ${d.inId} en pak op (${p.qty}× ${p.sku})`, inPoint, () => pickUpPallet(d, inSlot)), 1.5);
      }

      const outPoint = lanePoint(d.laneOut, pos);
      const outSlot = laneOut[d.index].findIndex((id) => id);
      if (o?.status === 'picked' && laneOut[d.index].includes(null)) {
        push(interaction(`Scan ${d.outId}: ${o.id} klaarzetten`, outPoint, () => stage(d.index)), 1.5);
      } else if (!carry && outSlot >= 0) {
        push(interaction(`Scan ${laneOut[d.index][outSlot]} op ${d.outId} en pak op`, outPoint, () => takeStaged(d, outSlot)), 1.5);
      }
    }

    // Rolcontainers: hier begin je aan de volgende order uit de WMS
    if (!carry) {
      const open = orders.find((x) => x.status === 'open');
      push(
        open
          ? interaction(`Pak een rolcontainer voor ${open.id} (${plural(open.lines.length, 'regel')})`, POINTS.containers, takeContainer)
          : interaction('Geen open orders in de WMS', POINTS.containers),
        1.8,
      );
    } else if (o?.status === 'picking') {
      push(interaction(`Rolcontainer van ${o.id} terugzetten`, POINTS.containers, returnContainer), 1.8);
    }

    // Stellingen: zonder scanner in de hand scan je met E de sectie waar je voor staat
    const section = shelfLocations().find((l) => l.level === 1 && dist(l, pos) < 1.8);
    if (section) {
      const name = section.id.slice(0, -2);
      const levels = LOCATIONS.filter((l) => l.x === section.x && l.z === section.z && l.type !== 'dock');
      if (carry?.kind === 'pallet') {
        const { pallet } = carry;
        const free = levels.find((l) => !isBlocked(l.id) && stockAt(l.id).every((s) => s.sku === pallet.sku));
        push(
          free
            ? interaction(`Scan ${free.id} en zet ${pallet.id} weg`, section, () => putaway(free.id))
            : interaction(`${name}: geen plek voor deze pallet`, section),
          1.8,
        );
      } else if (o?.status === 'picking') {
        const rest = openLines(o);
        const hit = levels.flatMap((l) => rest.filter((line) => qtyAt(l.id, line.sku) > 0).map((line) => ({ l, line })))[0];
        push(
          rest.length === 0
            ? interaction(`${o.id} afmelden bij de WMS`, section, () => completePick(o.id))
            : hit
              ? interaction(
                  `Scan ${hit.l.id} en pick ${Math.min(hit.line.qty - hit.line.picked, qtyAt(hit.l.id, hit.line.sku))}× ${hit.line.sku}`,
                  section,
                  () => pickAt(hit.l.id),
                )
              : interaction(`${name}: hier ligt niets voor ${o.id}`, section),
          1.8,
        );
      } else {
        push(interaction(`Scan ${name}: wat staat hier?`, section, () => lookAt(section.id)), 1.8);
      }
    }
    return list;
  }

  function interactionAt(pos: Point): Interaction | null {
    let best: Interaction | null = null;
    let bestD = Infinity;
    for (const c of candidates(pos)) {
      const d = dist(c.point, pos);
      if (d <= c.radius && d < bestD) {
        best = c;
        bestD = d;
      }
    }
    return best;
  }

  function interact(pos: Point) {
    const it = interactionAt(pos);
    if (it?.enabled && it.run) it.run();
    else if (it) say(it.label, 'err');
  }

  // ========== De handscanner: een gescand locatielabel ==========

  /**
   * Verwerkt een scan van de handscanner. Wat de scan betekent hangt af van wat je bij je hebt: een pallet
   * (wegzetten), een order onderhanden (picken) of een afgemelde order (klaarzetten). null = alleen kijken.
   */
  async function scan(code: string, pos: Point): Promise<ScanResult | null> {
    const loc = location(code);
    if (!loc) return null;
    const o = carriedOrder();
    const far = (reach: number, point: Point) =>
      dist(point, pos) > reach ? { ok: false, text: `Loop naar ${code} om daar iets te doen.` } : null;

    if (loc.type === 'dock') {
      const d = DOCKS.find((x) => x.outId === code);
      if (!d || o?.status !== 'picked') return null;
      return far(DOCK_REACH, lanePoint(d.laneOut, pos)) ?? guard(() => stage(d.index));
    }
    if (carry?.kind === 'pallet') return far(REACH, loc) ?? guard(() => putaway(code));
    if (o?.status === 'picking') return far(REACH, loc) ?? guard(() => pickAt(code));
    return null;
  }

  // ========== Volgende stap voor de speler ==========

  function objective(): Objective | null {
    const ti = trucks.in;
    const to = trucks.out;
    const o = carriedOrder();
    if (carry?.kind === 'pallet') {
      const { pallet } = carry;
      return { text: `Zet ${pallet.id} (${pallet.qty}× ${pallet.sku}) weg: scan een stellinglocatie` };
    }
    if (o?.status === 'picking') {
      const rest = openLines(o).map((l) => ({ sku: l.sku, qty: l.qty - l.picked }));
      return rest.length
        ? { text: `Pick voor ${o.id}: ${linesText(rest)} · de locaties staan in de WMS-app` }
        : { text: `Meld ${o.id} af: scan een stellinglocatie` };
    }
    if (o?.status === 'picked') {
      if (to?.status === 'checkedIn') return { point: DOCKS[to.dock].truck, text: `Laad ${o.id} in ${to.id} (${to.dockId})` };
      const d = laneOut[outDock].includes(null) ? DOCKS[outDock] : DOCKS.find((x) => laneOut[x.index].includes(null));
      return d ? { point: d.laneOut, text: `Zet ${o.id} klaar op ${d.outId}` } : null;
    }
    const inPoint = ti ? DOCKS[ti.dock].truck : undefined;
    const outPoint = to ? DOCKS[to.dock].truck : undefined;
    if (ti?.status === 'waiting') return { point: inPoint, text: `Meld ${ti.id} aan bij ${ti.dockId}` };
    if (ti?.status === 'checkedIn' && ti.cargo.length && laneIn[ti.dock].includes(null))
      return { point: inPoint, text: `Los ${ti.id} (${plural(ti.cargo.length, 'pallet')})` };
    const full = DOCKS.find((d) => laneIn[d.index].some((p) => p));
    if (full) return { point: full.laneIn, text: `Zet de pallets van ${full.inId} weg` };
    if (ti?.status === 'checkedIn' && !ti.cargo.length) return { point: inPoint, text: `Meld ${ti.id} uit` };
    if (to?.status === 'waiting') return { point: outPoint, text: `Meld ${to.id} aan bij ${to.dockId}` };
    if (to?.status === 'checkedIn') {
      const staged = [DOCKS[to.dock], ...DOCKS].find((d) => laneOut[d.index].some((id) => id));
      if (staged) return { point: staged.laneOut, text: `Pak de order op ${staged.outId} op om in te laden` };
    }
    if (orders.some((x) => x.status === 'open')) return { point: POINTS.containers, text: 'Pak een rolcontainer voor de volgende order' };
    if (to?.status === 'checkedIn' && to.loaded.length) return { point: outPoint, text: `Meld ${to.id} uit` };
    return null;
  }

  // ========== Tijd ==========

  /** Uitgaand dock: bij voorkeur waar al orders klaarstaan, nooit het dock van de lossende wagen. */
  function chooseOutDock() {
    const staged = laneOut.findIndex((lane) => lane.some((id) => id));
    if (staged >= 0 && staged !== trucks.in?.dock) return staged;
    let d = rand(DOCKS.length);
    while (d === trucks.in?.dock) d = rand(DOCKS.length);
    return d;
  }

  function spawnTruck(direction: Direction): Truck {
    let dock = outDock;
    if (direction === 'in') do dock = rand(DOCKS.length); while (dock === outDock);
    const id = direction === 'in' ? `IN-${pad(seq.truckIn++)}` : `UIT-${pad(seq.truckOut++)}`;
    const inbound = skus(); // een vrachtwagen brengt alleen artikelen die de WMS kent
    const cargo: Pallet[] =
      direction === 'in'
        ? Array.from({ length: 2 + rand(3) }, () => ({
            id: `PAL-${stamp}-${pad(seq.pallet++, 4)}`,
            sku: inbound[rand(inbound.length)],
            qty: 5 * (2 + rand(5)),
          }))
        : [];
    return { id, direction, dockId: DOCKS[dock].id, dock, status: 'arriving', t: 0, cargo, loaded: [] };
  }

  function driveTruck(slot: 'in' | 'out', dt: number) {
    const t = trucks[slot];
    if (!t) return;
    if (t.status === 'arriving') {
      t.t = Math.min(1, t.t + dt / DRIVE_SECONDS);
      if (t.t === 1) {
        t.status = 'waiting';
        say(`${t.id} staat aan ${t.dockId}: aanmelden.`);
      }
    } else if (t.status === 'departing') {
      t.t = Math.max(0, t.t - dt / DRIVE_SECONDS);
      if (t.t === 0) {
        trucks[slot] = null;
        for (const id of t.loaded) {
          const i = orders.findIndex((o) => o.id === id && o.status === 'shipped');
          if (i >= 0) orders.splice(i, 1); // de order is de deur uit
        }
        if (slot === 'in') inTimer = 20;
        else {
          outTimer = 8;
          outDock = chooseOutDock();
        }
      }
    }
  }

  /** Zonder WMS-app speelt de sim zelf klant: een testorder via create_order. De WMS beslist of hij mag. */
  function placeDemoOrder() {
    const inStock = skus().filter((s) => shelfQty(s) > 0).sort(() => Math.random() - 0.5);
    if (inStock.length === 0) return;
    const lines = inStock
      .slice(0, 1 + rand(Math.min(3, inStock.length)))
      .map((sku) => ({ sku, qty: 1 + rand(Math.min(5, shelfQty(sku))) }));
    const id = `ORD-${stamp}-${pad(seq.order++)}`;
    void ask({ type: 'OrderCreated', order: { id, lines, status: 'open' } }).then((r) => {
      if (!r.ok) return void say(`WMS weigert testorder ${id}: ${r.error}`, 'err');
      if (!order(id)) orders.push(fromWms({ id, lines, status: 'open' }));
      touch();
      say(`Nieuwe order ${id} (${plural(lines.length, 'regel')}).`);
    });
  }

  function update(dt: number) {
    clock += dt;
    driveTruck('in', dt);
    driveTruck('out', dt);
    if (!authority) return; // in multiplayer laat alleen de host nieuwe vrachtwagens en testorders ontstaan
    if (!trucks.in && skus().length > 0 && (inTimer -= dt) <= 0) trucks.in = spawnTruck('in');
    const outboundWork = orders.some((o) => ['picking', 'picked', 'staged'].includes(o.status));
    if (!trucks.out && outboundWork && (outTimer -= dt) <= 0) trucks.out = spawnTruck('out');
    if ((orderTimer -= dt) <= 0) {
      orderTimer = DEMO_ORDER_INTERVAL;
      if (demoOrders() && orders.filter((o) => o.status === 'open').length < DEMO_MAX_OPEN_ORDERS) placeDemoOrder();
    }
  }

  // ========== Multiplayer: de wereld die alle spelers delen ==========

  /** Alles wat spelers delen. Wat je zelf draagt (carry) en je berichten blijven lokaal. */
  function sharedState() {
    return structuredClone({
      stock: [...stock],
      orders,
      laneIn,
      laneOut,
      trucks,
      outDock,
      forks: [...forks],
      transit: [...transit],
      articles: articles(),
      seq: { truckIn: seq.truckIn, truckOut: seq.truckOut },
    });
  }

  /** Neemt de gedeelde wereld van een andere speler over. Vraagt de WMS niets: dat deed die speler al. */
  function applyShared(s: ReturnType<typeof sharedState>) {
    foreign = true;
    stock.clear();
    for (const [k, qty] of s.stock) stock.set(k, qty);
    // Een speler met een oudere versie stuurt orders zonder picks/wmsStatus: aanvullen.
    orders.splice(0, orders.length, ...s.orders.map((o) => ({
      ...o,
      wmsStatus: o.wmsStatus ?? 'open',
      picks: o.picks ?? [],
      lines: o.lines.map((l) => ({ ...l, picked: l.picked ?? 0 })),
    })));
    laneIn.splice(0, laneIn.length, ...s.laneIn);
    laneOut.splice(0, laneOut.length, ...s.laneOut);
    for (const slot of ['in', 'out'] as const) {
      const cur = trucks[slot];
      const next = s.trucks[slot];
      if (cur && next && cur.id === next.id && cur.status === next.status) next.t = cur.t; // rijdt hier al: niet verspringen
      trucks[slot] = next;
    }
    outDock = s.outDock;
    forks.clear();
    for (const [id, f] of s.forks ?? []) forks.set(id, f);
    transit.clear();
    for (const [id, t] of s.transit ?? []) transit.set(id, t);
    seq.truckIn = Math.max(seq.truckIn, s.seq.truckIn);
    seq.truckOut = Math.max(seq.truckOut, s.seq.truckOut);
    // Draag je een order die een ander inmiddels heeft afgehandeld of teruggezet, dan ben je hem kwijt.
    if (carry?.kind === 'order') {
      const o = order(carry.orderId);
      if (!o || (o.status !== 'picking' && o.status !== 'picked')) carry = null;
    }
  }

  // ========== WMS is leidend: voorraad en open orders komen uit de WMS ==========

  /** Alleen orders waar nog aan gewerkt moet worden (de WMS kent ook latere statussen, zie docs/wms/04). */
  const isOpen = (o: Order) => (o.status as string) === 'open' || (o.status as string) === 'picking';
  const fromWms = (o: Order): SimOrder => ({
    id: o.id,
    lines: o.lines.map((l) => ({ sku: l.sku, qty: l.qty, picked: 0 })),
    status: 'open',
    wmsStatus: o.status,
    picks: [],
  });

  /** Zet de stellingvoorraad gelijk aan de WMS, minus wat fysiek onderweg is (heftruck, lopende picks). */
  function setShelfStock(items: Item[]) {
    stock.clear();
    for (const it of items) if (isShelf(it.locationId) && it.qty > 0) add(it.locationId, it.sku, it.qty);
    for (const f of forks.values()) add(f.locationId, f.sku, -f.qty);
    for (const o of orders) {
      if (o.status !== 'picking') continue;
      for (const p of o.picks) if (!p.booked) add(p.locationId, p.sku, -p.qty);
    }
  }

  /**
   * Zet de inslaglocaties gelijk aan de WMS: een ontvangst of correctie die in de WMS-app is geboekt staat
   * daarna ook fysiek op het dock. Pallets die iemand heeft opgepakt tellen in de WMS nog mee op het dock.
   */
  function setDockStock(items: Item[]) {
    for (const d of DOCKS) {
      const lane = laneIn[d.index];
      const want = new Map<string, number>();
      const bump = (m: Map<string, number>, sku: string, qty: number) => m.set(sku, (m.get(sku) ?? 0) + qty);
      for (const it of items) if (it.locationId === d.inId && it.qty > 0) bump(want, it.sku, it.qty);
      for (const t of transit.values()) if (t.fromId === d.inId) bump(want, t.sku, -t.qty);
      const have = new Map<string, number>();
      for (const p of lane) if (p) bump(have, p.sku, p.qty);
      // Te veel: pallets weghalen of kleiner maken
      lane.forEach((p, i) => {
        if (!p) return;
        const over = (have.get(p.sku) ?? 0) - (want.get(p.sku) ?? 0);
        if (over <= 0) return;
        const take = Math.min(over, p.qty);
        bump(have, p.sku, -take);
        lane[i] = take === p.qty ? null : { ...p, qty: p.qty - take };
      });
      // Te weinig: een pallet erbij, zolang er plek is
      for (const [sku, qty] of want) {
        const short = qty - (have.get(sku) ?? 0);
        if (short > 0 && lane.includes(null)) {
          lane[lane.lastIndexOf(null)] = { id: `PAL-${stamp}-${pad(seq.pallet++, 4)}`, sku, qty: short };
        }
      }
    }
  }

  /** Voorraad zoals hij nu in de hal staat (stellingen en inslaglocaties), voor wie de WMS niet zelf kan lezen. */
  function worldStock(): Item[] {
    const list = stockList();
    DOCKS.forEach((d, i) => {
      for (const p of laneIn[i]) {
        if (!p) continue;
        const cur = list.find((s) => s.locationId === d.inId && s.sku === p.sku);
        if (cur) cur.qty += p.qty;
        else list.push({ locationId: d.inId, sku: p.sku, qty: p.qty });
      }
    });
    return list;
  }

  /** Tussentijdse stand uit de WMS: voorraad (stellingen en docks) en open orders. Wat fysiek onderhanden is blijft staan. */
  function syncFromWms(items: Item[], wmsOrders: Order[]) {
    setShelfStock(items);
    setDockStock(items);
    const open = wmsOrders.filter(isOpen);
    const ids = new Set(open.map((o) => o.id));
    for (let i = orders.length - 1; i >= 0; i--) {
      if (orders[i].status === 'open' && !ids.has(orders[i].id)) orders.splice(i, 1); // elders afgehandeld of vervallen
    }
    for (const w of open) {
      const cur = order(w.id);
      if (!cur) orders.push(fromWms(w));
      else if (cur.status === 'open') Object.assign(cur, fromWms(w));
    }
  }

  /** Begin (of opnieuw aanmelden): de hele wereld overnemen uit de WMS, ook wat er bij de docks staat. */
  function loadSnapshot(items: Item[], wmsOrders: Order[], source: string) {
    laneIn.forEach((lane) => lane.fill(null));
    laneOut.forEach((lane) => lane.fill(null));
    forks.clear();
    transit.clear();
    carry = null;
    if (trucks.out) trucks.out.loaded = [];
    orders.length = 0;
    setShelfStock(items);
    for (const it of items) {
      const lane = laneIn[DOCKS.findIndex((d) => d.inId === it.locationId)];
      if (it.qty > 0 && lane?.includes(null)) {
        lane[lane.lastIndexOf(null)] = { id: `PAL-${stamp}-${pad(seq.pallet++, 4)}`, sku: it.sku, qty: it.qty };
      }
    }
    const open = wmsOrders.filter(isOpen);
    orders.push(...open.map(fromWms));
    touch();
    say(`Voorraad (${items.length} regels) en ${plural(open.length, 'open order')} geladen uit ${source}.`, 'ok');
  }

  return {
    update,
    interact,
    interactionAt,
    objective,
    scan,
    loadSnapshot,
    syncFromWms,
    get trucks() { return trucks; },
    get laneIn() { return laneIn; },
    get laneOut() { return laneOut; },
    /** Index van het dock waar de volgende uitgaande wagen komt. */
    get outDock() { return outDock; },
    get carry() { return carry; },
    get orders() { return orders; },
    get messages() { return messages; },
    get clock() { return clock; },
    /** Loopt er nog een vraag bij de WMS? */
    get pending() { return pending; },
    get revision() { return revision; },
    get authority() { return authority; },
    /** true: de wereld is (mede) door een andere speler gevormd. */
    get foreign() { return foreign; },
    stockList,
    worldStock,
    stockAt,
    forkliftTake,
    forkliftPlace,
    order,
    sharedState,
    applyShared,
    /** false: een andere speler is host en laat vrachtwagens en testorders ontstaan. */
    setAuthority(on: boolean) {
      authority = on;
    },
  };
}

export type Warehouse = ReturnType<typeof createWarehouse>;
export type SharedState = ReturnType<Warehouse['sharedState']>;
