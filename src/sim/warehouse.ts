import type { Item, Order } from '../shared/contract';
import { publish, type Direction, type ProcessEvent, type ScanKind } from './events';
import { articles, isBlocked, skus } from './catalog';
import {
  DOCKS, LANE_SLOTS, LOCATIONS, PER_PALLET, POINTS, SLOT_DX,
  dist, lanePoint, laneSlot, location, shelfLocations, type Dock, type Point,
} from './layout';
import { createRobotFleet } from './robots';
import { offlineGateway, type WmsGateway, type WmsReply } from './wms';

// De fysieke wereld van het magazijn: vrachtwagens, pallets, rolcontainers en wat er in de stellingen staat.
// Die wereld is van de game en voor alle spelers dezelfde. De WMS is de administratie ervan: hij hoort wat
// er gebeurt doordat spelers scannen, en kan dus achterlopen op of afwijken van wat er echt staat. Wat de WMS
// aan voorraad heeft komt alleen in de hal bij de allereerste start en bij een bewuste reset (loadSnapshot).
// De sim beslist niets wat van de WMS is: geen orders aanmaken, geen locatie-advies, geen pickverdeling,
// geen voorraadcontroles. Elke handeling van de speler gaat eerst als vraag naar de WMS (src/sim/wms.ts);
// pas na akkoord gebeurt hij fysiek. Weigert de WMS, dan gebeurt er niets en ziet de speler de melding.

/**
 * id = het nummer op de palletsticker. unlabeled = er zit nog geen sticker op: de speler moet er zelf een
 * plakken (labelPallet) voordat de pallet gescand kan worden. De voorraad bij de start heeft al stickers.
 */
export type Pallet = { id: string; sku: string; qty: number; unlabeled?: boolean };
/** Een pallet in een stelling: op welke locatie, en op welke van de palletplekken daar (0 = links). */
export type StoredPallet = Pallet & { locationId: string; slot: number };
/**
 * Een pallet die fysiek is verplaatst terwijl de WMS hem nog op locationId heeft staan.
 * at = de stellinglocatie waar hij nu staat; leeg zolang hij op de vorken of los op de vloer staat.
 */
type MovedPallet = { locationId: string; sku: string; qty: number; at?: string | null };
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
/** Zo dichtbij (m) moet je bij een pallet staan om zijn verplaatsing te boeken (ook vanaf de heftruck). */
const PALLET_REACH = 4;
const SLOTS = SLOT_DX.map((_, i) => i);

const rand = (n: number) => Math.floor(Math.random() * n);
const pad = (n: number, w = 3) => String(n).padStart(w, '0');
const stamp = Date.now().toString(36).slice(-4).toUpperCase(); // uniek per sessie, voor id's in de echte WMS

interface Options {
  gateway?: WmsGateway;
  /** true: er is geen WMS-app om orders in te voeren (mock); de sim speelt dan zelf klant via create_order. */
  demoOrders?: () => boolean;
  /** Stuks op een volle pallet van een artikel (de hal weet hoeveel dozen erop passen). */
  perPallet?: (sku: string) => number;
}

export function createWarehouse({ gateway = offlineGateway, demoOrders = () => false, perPallet = () => PER_PALLET }: Options = {}) {
  const stock = new Map<string, number>(); // wat er fysiek in de stellingen staat; sleutel: locationId|sku
  const orders: SimOrder[] = [];
  // Per dock een inslagbaan (pallets) en een uitslagbaan (order-id's).
  const laneIn: (Pallet | null)[][] = DOCKS.map(() => Array(LANE_SLOTS).fill(null));
  const laneOut: (string | null)[][] = DOCKS.map(() => Array(LANE_SLOTS).fill(null));
  const trucks: { in: Truck | null; out: Truck | null } = { in: null, out: null };
  /** De pallets in de stellingen, op het nummer van hun sticker. Samen zijn ze gelijk aan `stock`: zie palletize(). */
  const racked = new Map<string, StoredPallet>();
  /**
   * Pallets die met de heftruck of pompwagen zijn verplaatst en nog niet geboekt: fysiek weg van hun oude
   * locatie, in de WMS nog niet. De speler boekt de verplaatsing door de palletsticker op de nieuwe locatie te scannen.
   */
  const moved = new Map<string, MovedPallet>();
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
  const touch = () => {
    revision++;
    palletize();
  };
  const newPalletId = () => `PAL-${stamp}-${pad(seq.pallet++, 4)}`;
  /** true tijdens het laden van de beginstand: die pallets hebben hun sticker al. */
  let seeding = false;
  /** Een pallet die er later bij komt (vrachtwagen, ontvangst of correctie in de WMS) heeft nog geen sticker. */
  const newPallet = (sku: string, qty: number): Pallet =>
    seeding ? { id: newPalletId(), sku, qty } : { id: newPalletId(), sku, qty, unlabeled: true };
  const what = (p: Pallet) => `${p.qty}× ${p.sku}`;
  const nameOf = (p: Pallet) => (p.unlabeled ? `pallet zonder sticker (${what(p)})` : p.id);

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

  // --- Pallets in de stellingen ---
  const palletsAt = (loc: string) => [...racked.values()].filter((p) => p.locationId === loc);
  const freeSlot = (loc: string) => {
    const taken = new Set(palletsAt(loc).map((p) => p.slot));
    return SLOTS.find((s) => !taken.has(s));
  };

  /**
   * Houdt de pallets gelijk met de voorraad per locatie. De WMS kent (nog) geen pallets, alleen aantallen:
   * komt er voorraad bij, dan vult die een aangebroken pallet aan of komt er een pallet met een nieuw nummer;
   * gaat er voorraad af (een pick, een correctie in de WMS), dan wordt de buitenste pallet kleiner of verdwijnt.
   * Een pallet die in zijn geheel wordt verplaatst houdt zijn nummer.
   */
  function palletize() {
    const want = new Map<string, Map<string, number>>();
    for (const [k, qty] of stock) {
      const [loc, sku] = k.split('|');
      if (!want.has(loc)) want.set(loc, new Map());
      want.get(loc)!.set(sku, qty);
    }
    const have = new Map<string, StoredPallet[]>();
    for (const p of racked.values()) {
      if (!have.has(p.locationId)) have.set(p.locationId, []);
      have.get(p.locationId)!.push(p);
    }
    for (const loc of new Set([...want.keys(), ...have.keys()])) {
      const lines = want.get(loc) ?? new Map<string, number>();
      let here = (have.get(loc) ?? []).sort((a, b) => a.slot - b.slot);
      for (const p of here) if (!lines.has(p.sku)) racked.delete(p.id);
      here = here.filter((p) => lines.has(p.sku));
      for (const [sku, qty] of lines) {
        const mine = here.filter((p) => p.sku === sku);
        let diff = qty - mine.reduce((n, p) => n + p.qty, 0);
        if (diff < 0) {
          // Te veel: eerst van de geboekte pallets, de buitenste het eerst
          const order = [...mine].sort((a, b) => Number(moved.has(a.id)) - Number(moved.has(b.id)) || b.slot - a.slot);
          for (const p of order) {
            if (diff === 0) break;
            const take = Math.min(-diff, p.qty);
            p.qty -= take;
            diff += take;
            if (p.qty > 0) continue;
            racked.delete(p.id);
            here = here.filter((x) => x !== p);
          }
        } else if (diff > 0) {
          const booked = mine.filter((p) => !moved.has(p.id));
          for (const p of booked) {
            const room = Math.min(diff, perPallet(sku) - p.qty);
            if (room <= 0) continue;
            p.qty += room;
            diff -= room;
          }
          while (diff > 0) {
            const slot = SLOTS.find((x) => !here.some((p) => p.slot === x));
            if (slot === undefined) break;
            const p = { ...newPallet(sku, Math.min(diff, perPallet(sku))), locationId: loc, slot };
            racked.set(p.id, p);
            here.push(p);
            diff -= p.qty;
          }
          // Alle plekken bezet: de rest komt op de laatste pallet van dit artikel (zonder zo'n pallet blijft hij uit beeld).
          const last = here.filter((p) => p.sku === sku && !moved.has(p.id)).pop();
          if (diff > 0 && last) last.qty += diff;
        }
      }
    }
  }
  /** De pallets in de stellingen, voor de hal. unbooked = verplaatst en nog niet geboekt in de WMS. */
  const pallets = () => [...racked.values()].map((p) => ({ ...p, unbooked: moved.has(p.id) }));

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
    return done(`Ontvangen op ${inId}: ${what(pallet)}. Plak er een palletsticker op.`);
  }

  /**
   * Plakt een palletsticker op een pallet (op een inslaglocatie of in een stelling): daarmee ligt de voorraad
   * op die pallet onder een barcode vast (register_pallet). Later drukt de WMS de sticker af op een printer in de hal.
   */
  async function labelPallet(id: string): Promise<ScanResult> {
    const find = () => {
      const stored = racked.get(id);
      if (stored) return { pallet: stored as Pallet, locationId: stored.locationId };
      for (const d of DOCKS) {
        const pallet = laneIn[d.index].find((x) => x?.id === id);
        if (pallet) return { pallet, locationId: d.inId };
      }
      return null;
    };
    const before = find();
    if (!before?.pallet.unlabeled) return refused('Hier staat geen pallet zonder sticker.');
    const { pallet, locationId } = before;
    const r = await ask({ type: 'PalletLabeled', palletId: id, sku: pallet.sku, qty: pallet.qty, locationId });
    if (!r.ok) return wmsRefused(r, ' de palletsticker');
    const now = find();
    if (!now) return refused('De pallet is intussen weg.');
    delete now.pallet.unlabeled;
    touch();
    return done(`Sticker ${id} geplakt: ${what(now.pallet)} op ${now.locationId} vastgelegd.`);
  }

  function pickUpPallet(d: Dock, slot: number): ScanResult {
    const pallet = laneIn[d.index][slot];
    if (!pallet || carry) return refused('Hier valt niets op te pakken.');
    if (pallet.unlabeled) return refused('Plak eerst een palletsticker op deze pallet.');
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
    const slot = freeSlot(locId); // de pallet houdt zijn nummer; zonder vrije plek gaat hij op in de voorraad daar
    if (slot !== undefined) racked.set(pallet.id, { ...pallet, locationId: locId, slot });
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
    const unbooked = [...moved].find(([, m]) => m.at === locId);
    if (unbooked) {
      scanned('location', locId, false, locId);
      return refused(`Op ${locId} staat ${unbooked[0]}, die nog niet geboekt is: scan eerst de palletsticker.`);
    }
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

  // ========== Heftruck en pompwagen: hele pallets verplaatsen ==========

  /** Haalt een pallet uit de stelling; hij staat daarna op de vorken. In de WMS staat hij nog op zijn oude locatie. */
  function forkliftTake(palletId: string): Pallet | null {
    const p = racked.get(palletId);
    if (!p) return null;
    racked.delete(palletId);
    add(p.locationId, p.sku, -p.qty);
    const m = moved.get(palletId);
    if (m) m.at = null; // was al verplaatst en nog niet geboekt: de WMS-locatie blijft de oude
    else moved.set(palletId, { locationId: p.locationId, sku: p.sku, qty: p.qty, at: null });
    touch();
    say(`${p.unlabeled ? 'Pallet zonder sticker' : p.id} (${what(p)}) van ${p.locationId} gepakt.`);
    const { locationId: _from, slot: _slot, ...pallet } = p;
    return pallet;
  }

  /**
   * Zet een pallet van de vorken op een stellinglocatie. Dat is alleen fysiek: de voorraadmutatie volgt pas
   * als de speler de palletsticker op de nieuwe locatie scant (zie scanPallet).
   * @param fromLocationId waar de WMS de pallet heeft staan, voor een pallet die de sim niet (meer) volgt.
   * @param slot de palletplek op de locatie (0 = links).
   */
  function forkliftPlace(locId: string, pallet: Pallet, fromLocationId: string, slot = 0) {
    const taken = new Set(palletsAt(locId).map((p) => p.slot));
    if (taken.has(slot)) slot = SLOTS.find((x) => !taken.has(x)) ?? slot;
    const m = moved.get(pallet.id) ?? { locationId: fromLocationId, sku: pallet.sku, qty: pallet.qty };
    add(locId, pallet.sku, pallet.qty);
    racked.set(pallet.id, { ...pallet, locationId: locId, slot });
    if (m.locationId === locId) {
      moved.delete(pallet.id); // terug op de plek waar de WMS hem heeft: er valt niets te boeken
      touch();
      say(`${nameOf(pallet)} teruggezet op ${locId}.`);
      return;
    }
    moved.set(pallet.id, { ...m, at: locId });
    touch();
    say(
      pallet.unlabeled
        ? `De pallet staat nu op ${locId}. Plak er een sticker op en scan die om de verplaatsing te boeken.`
        : `${pallet.id} staat nu op ${locId}. Scan de palletsticker om de verplaatsing te boeken.`,
    );
  }

  /** Boekt een verplaatste pallet op de locatie waar hij nu staat (confirm_putaway van de oude naar de nieuwe locatie). */
  async function bookMove(id: string): Promise<ScanResult> {
    const m = moved.get(id);
    const to = racked.get(id)?.locationId;
    if (!m || !to) return refused(`${id} staat niet (meer) op een locatie.`);
    const from = m.locationId;
    const r = await ask({ type: 'PutawayDone', sku: m.sku, qty: m.qty, fromLocationId: from, locationId: to, palletId: id });
    scanned('pallet', id, r.ok, to);
    if (!r.ok) return wmsRefused(r, ` de verplaatsing van ${id} naar ${to}`);
    // Is hij intussen alweer opgepakt of verzet, dan staat hij in de WMS nu op `to` en moet hij opnieuw gescand worden.
    const now = moved.get(id);
    if (racked.get(id)?.locationId === to) moved.delete(id);
    else if (now) now.locationId = to;
    touch();
    return done(`${id} verplaatst van ${from} naar ${to}: ${m.qty}× ${m.sku} omgeboekt.`);
  }

  /** Een gescande palletsticker. Staat de pallet op een andere locatie dan in de WMS, dan boekt de scan de verplaatsing. */
  function scanPallet(id: string, pos: Point): Promise<ScanResult> | ScanResult {
    const p = racked.get(id);
    if (!p) return { ok: false, text: `${id} staat niet op een locatie. Zet hem in een stelling en scan hem daar.` };
    if (p.unlabeled) return { ok: false, text: 'Op deze pallet zit nog geen sticker.' };
    if (!moved.has(id)) {
      scanned('pallet', id, true, p.locationId);
      return { ok: true, text: `${id}: ${p.qty}× ${p.sku} op ${p.locationId}.` };
    }
    const loc = location(p.locationId)!;
    if (dist({ x: loc.x + SLOT_DX[p.slot], z: loc.z }, pos) > PALLET_REACH)
      return { ok: false, text: `Loop naar ${id} op ${p.locationId} om de verplaatsing te boeken.` };
    return guard(() => bookMove(id));
  }

  // ========== Geek+-robots: wat zij van de fysieke wereld nodig hebben (src/sim/robots.ts) ==========

  /** De pallet die een robot moet halen: op een inslagbaan of op de vloer in een stelling. Een tekst = dat kan niet. */
  function robotPallet(palletId: string, fromId: string): { point: Point; take(): Pallet } | string {
    const d = DOCKS.find((x) => x.inId === fromId);
    if (d) {
      const lane = laneIn[d.index];
      const i = lane.findIndex((p) => p?.id === palletId);
      const pallet = lane[i];
      if (!pallet) return `${palletId} staat niet (meer) op ${fromId}`;
      if (pallet.unlabeled) return `op de pallet op ${fromId} zit nog geen sticker`;
      return { point: laneSlot(d.laneIn, i), take: () => ((lane[i] = null), pallet) };
    }
    const p = racked.get(palletId);
    const loc = location(fromId);
    if (!p || !loc || p.locationId !== fromId) return `${palletId} staat niet (meer) op ${fromId}`;
    if (loc.level !== 1) return `${fromId} ligt niet op de vloer: daar kan een robot niet bij`;
    if (p.unlabeled) return `op de pallet op ${fromId} zit nog geen sticker`;
    if (moved.has(palletId)) return `${palletId} is verplaatst en nog niet geboekt`;
    return {
      point: { x: loc.x + SLOT_DX[p.slot], z: loc.z },
      take() {
        racked.delete(palletId);
        add(fromId, p.sku, -p.qty);
        const { locationId: _from, slot: _slot, ...pallet } = p;
        return pallet;
      },
    };
  }

  const robots = createRobotFleet({
    authority: () => authority,
    revision: () => revision,
    touch: () => touch(),
    say,
    ask,
    pickupSpot(palletId, fromId) {
      const found = robotPallet(palletId, fromId);
      return typeof found === 'string' ? found : found.point;
    },
    take(palletId, fromId) {
      const found = robotPallet(palletId, fromId);
      if (typeof found === 'string') return found;
      scanned('pallet', palletId, true, fromId); // de robot leest de sticker van de pallet die hij optilt
      return found.take();
    },
    dropSpot(locId, pallet) {
      const loc = location(locId);
      if (!loc || loc.type === 'dock') return `${locId} is geen stellinglocatie`;
      if (loc.level !== 1) return `${locId} ligt niet op de vloer: daar kan een robot niet bij`;
      if (stockAt(locId).some((s) => s.sku !== pallet.sku)) return `op ${locId} staat al een ander artikel`;
      const slot = freeSlot(locId);
      if (slot === undefined) return `${locId} is vol`;
      return { x: loc.x + SLOT_DX[slot], z: loc.z, slot };
    },
    drop(locId, pallet, slot) {
      add(locId, pallet.sku, pallet.qty);
      racked.set(pallet.id, { ...pallet, locationId: locId, slot });
    },
    inbound: () =>
      DOCKS.flatMap((d) =>
        laneIn[d.index].flatMap((p) => (p && !p.unlabeled ? [{ palletId: p.id, sku: p.sku, qty: p.qty, locationId: d.inId, z: d.z }] : [])),
      ),
    floorSpace(sku) {
      const lines = new Map<string, Set<string>>();
      for (const k of stock.keys()) {
        const [loc, s] = k.split('|');
        if (!lines.has(loc)) lines.set(loc, new Set());
        lines.get(loc)!.add(s);
      }
      const used = new Map<string, number>();
      for (const p of racked.values()) used.set(p.locationId, (used.get(p.locationId) ?? 0) + 1);
      return shelfLocations().flatMap((l) => {
        const here = lines.get(l.id);
        const free = SLOTS.length - (used.get(l.id) ?? 0);
        if (l.level !== 1 || isBlocked(l.id) || free <= 0 || (here && [...here].some((s) => s !== sku))) return [];
        return [{ locationId: l.id, free, x: l.x, z: l.z, sameSku: !!here?.size }];
      });
    },
  });

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
      return i(`Los een pallet (${what(p)}, nog ${t.cargo.length})`, () => unload(t.id));
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
        push(
          p.unlabeled
            ? interaction(`Plak een palletsticker op de pallet op ${d.inId} (${what(p)})`, inPoint, () => labelPallet(p.id))
            : interaction(`Scan ${p.id} op ${d.inId} en pak op (${what(p)})`, inPoint, () => pickUpPallet(d, inSlot)),
          1.5,
        );
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
        const bare = levels.flatMap((l) => palletsAt(l.id)).find((p) => p.unlabeled);
        push(
          bare
            ? interaction(`Plak een palletsticker op de pallet op ${bare.locationId} (${what(bare)})`, section, () => labelPallet(bare.id))
            : interaction(`Scan ${name}: wat staat hier?`, section, () => lookAt(section.id)),
          1.8,
        );
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
   * Een palletsticker boekt de verplaatsing van die pallet.
   */
  async function scan(code: string, pos: Point): Promise<ScanResult | null> {
    if (racked.has(code) || moved.has(code)) return scanPallet(code, pos);
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
    const unbooked = [...moved].find(([, m]) => m.at);
    if (unbooked) {
      const at = location(unbooked[1].at!);
      const text = racked.get(unbooked[0])?.unlabeled
        ? `Plak een sticker op de pallet op ${unbooked[1].at} en scan die om de verplaatsing te boeken`
        : `Scan de sticker van ${unbooked[0]} op ${unbooked[1].at} om de verplaatsing te boeken`;
      return { point: at, level: at?.level, text };
    }
    const inPoint = ti ? DOCKS[ti.dock].truck : undefined;
    const outPoint = to ? DOCKS[to.dock].truck : undefined;
    if (ti?.status === 'waiting') return { point: inPoint, text: `Meld ${ti.id} aan bij ${ti.dockId}` };
    if (ti?.status === 'checkedIn' && ti.cargo.length && laneIn[ti.dock].includes(null))
      return { point: inPoint, text: `Los ${ti.id} (${plural(ti.cargo.length, 'pallet')})` };
    const full = DOCKS.find((d) => laneIn[d.index].some((p) => p));
    if (full)
      return {
        point: full.laneIn,
        text: laneIn[full.index].findLast((p) => p)?.unlabeled ? `Plak palletstickers op de pallets van ${full.inId}` : `Zet de pallets van ${full.inId} weg`,
      };
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
            id: newPalletId(),
            sku: inbound[rand(inbound.length)],
            qty: 5 * (2 + rand(5)),
            unlabeled: true, // een binnenkomende pallet krijgt zijn sticker pas in de hal
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
    robots.update(dt);
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
      forks: [...moved],
      pallets: [...racked.values()],
      transit: [...transit],
      robots: robots.shared(),
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
    moved.clear();
    for (const [id, f] of s.forks ?? []) moved.set(id, f);
    racked.clear();
    for (const p of s.pallets ?? []) racked.set(p.id, p);
    seeding = !s.pallets; // een speler met een oudere versie stuurt geen pallets: palletize() maakt ze, met sticker
    palletize();
    seeding = false;
    transit.clear();
    for (const [id, t] of s.transit ?? []) transit.set(id, t);
    robots.applyShared(s.robots); // een speler met een oudere versie stuurt geen robots
    seq.truckIn = Math.max(seq.truckIn, s.seq.truckIn);
    seq.truckOut = Math.max(seq.truckOut, s.seq.truckOut);
    // Draag je een order die een ander inmiddels heeft afgehandeld of teruggezet, dan ben je hem kwijt.
    if (carry?.kind === 'order') {
      const o = order(carry.orderId);
      if (!o || (o.status !== 'picking' && o.status !== 'picked')) carry = null;
    }
  }

  // ========== De WMS: open orders komen uit de WMS, de voorraad alleen bij een reset ==========

  /** Alleen orders waar nog aan gewerkt moet worden (de WMS kent ook latere statussen, zie docs/wms/04). */
  const isOpen = (o: Order) => (o.status as string) === 'open' || (o.status as string) === 'picking';
  const fromWms = (o: Order): SimOrder => ({
    id: o.id,
    lines: o.lines.map((l) => ({ sku: l.sku, qty: l.qty, picked: 0 })),
    status: 'open',
    wmsStatus: o.status,
    picks: [],
  });

  /** Zet de stellingvoorraad gelijk aan de WMS (alleen bij een reset: zie loadSnapshot). */
  function setShelfStock(items: Item[]) {
    stock.clear();
    for (const it of items) if (isShelf(it.locationId) && it.qty > 0) add(it.locationId, it.sku, it.qty);
    palletize();
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

  /**
   * Open orders uit de WMS: daar worden ze ingevoerd. De voorraad komt hier bewust niet mee: de hal heeft
   * zijn eigen voorraad, en de WMS hoort alleen via scans wat daar verandert.
   */
  function syncOrders(wmsOrders: Order[]) {
    const open = wmsOrders.filter(isOpen);
    const ids = new Set(open.map((o) => o.id));
    const before = JSON.stringify(orders);
    for (let i = orders.length - 1; i >= 0; i--) {
      if (orders[i].status === 'open' && !ids.has(orders[i].id)) orders.splice(i, 1); // elders afgehandeld of vervallen
    }
    for (const w of open) {
      const cur = order(w.id);
      if (!cur) orders.push(fromWms(w));
      // Een order waar al voor gepickt is (rolcontainer teruggevonden na een herstart) houdt wat erin ligt.
      else if (cur.status === 'open' && cur.picks.length === 0) Object.assign(cur, fromWms(w));
    }
    if (JSON.stringify(orders) !== before) touch();
  }

  /**
   * Na het laden van een bewaarde wereld draagt niemand nog iets: wat onderweg was toen de vorige spelers
   * weggingen gaat terug naar waar het vandaan kwam, zodat er niets zoekraakt.
   */
  function dropCarried() {
    carry = null;
    for (const [id, t] of transit) {
      const lane = laneIn[DOCKS.findIndex((d) => d.inId === t.fromId)];
      if (lane?.includes(null)) lane[lane.lastIndexOf(null)] = { id, sku: t.sku, qty: t.qty };
    }
    transit.clear();
    for (const o of orders) {
      if (o.status === 'picking') o.status = 'open'; // de rolcontainer staat weer bij de andere, met wat er al in lag
      else if (o.status === 'picked') {
        const lane = laneOut[outDock]?.includes(null) ? laneOut[outDock] : laneOut.find((l) => l.includes(null));
        if (!lane) continue;
        lane[lane.indexOf(null)] = o.id;
        o.status = 'staged';
      }
    }
    touch();
  }

  /**
   * Allereerste start of een bewuste reset: de hele hal gelijkzetten met de WMS, ook wat er bij de docks staat.
   * Alles wat fysiek afweek (verplaatste pallets, lopende picks, wat spelers dragen) vervalt.
   */
  function loadSnapshot(items: Item[], wmsOrders: Order[], source: string) {
    laneIn.forEach((lane) => lane.fill(null));
    laneOut.forEach((lane) => lane.fill(null));
    moved.clear();
    racked.clear();
    transit.clear();
    robots.reset();
    carry = null;
    foreign = false; // deze wereld komt uit de eigen WMS
    if (trucks.out) trucks.out.loaded = [];
    orders.length = 0;
    seeding = true; // de voorraad waarmee de hal begint heeft al palletstickers
    setShelfStock(items);
    seeding = false;
    for (const it of items) {
      const lane = laneIn[DOCKS.findIndex((d) => d.inId === it.locationId)];
      if (it.qty > 0 && lane?.includes(null)) {
        lane[lane.lastIndexOf(null)] = { id: newPalletId(), sku: it.sku, qty: it.qty }; // beginstand: met sticker
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
    syncOrders,
    dropCarried,
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
    pallets,
    forkliftTake,
    forkliftPlace,
    /** De Geek+-robots (src/sim/robots.ts). */
    robots,
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
