import type { Item, Order } from '../shared/contract';
import { publish, type Direction, type ProcessEvent, type ScanKind } from './events';
import { articles, isBlocked, skus } from './catalog';
import {
  DOCKS, EMPTY_PALLETS, LANE_SLOTS, LOCATIONS, PER_PALLET, POINTS, SLOT_DX, currentLocationId,
  dist, lanePoint, laneSlot, location, shelfLocations, type Dock, type Point,
} from './layout';
import { createCounter } from './counter';
import { createDrivers, dockScreen } from './drivers';
import { createRobotFleet } from './robots';
import { offlineGateway, type WmsGateway, type WmsReply } from './wms';
import { truckSeconds } from './yard';

// De fysieke wereld van het magazijn: vrachtwagens, pallets, de pallets van orders en wat er in de stellingen staat.
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
export type Pallet = {
  id: string; sku: string; qty: number; unlabeled?: boolean;
  /** Op de inslagbaan geteld door de telrobot: pas daarna zetten de robots hem weg. */
  counted?: boolean;
  /** Gelost, maar de chauffeur heeft nog niet gemeld dat hij klaar is met lossen: de telrobot wacht daarop. */
  unloading?: boolean;
};
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
  /** 0 = ver weg op de openbare weg, 1 = tegen de dockdeur; de route ertussen staat in yard.ts (truckPose). */
  t: number;
  cargo: Pallet[];
  loaded: string[];
  /** Aangemeld door de WMS zelf (een levering uit de flow): de ontvangst is daar al geboekt, op de dockdeur. */
  wms?: boolean;
};
/** Een inkomende vrachtwagen die in de WMS is aangemeld, met de pallets die nog op de dockdeur staan. */
export type Delivery = { truckId: string; dockId: string; pallets: { palletId?: string; sku: string; qty: number }[] };
/** picked = wat er al op de pallet van de order ligt. */
export type OrderLine = { sku: string; qty: number; picked: number };
/** Eén greep uit een locatie; booked = de WMS heeft hem al afgeboekt. */
export type Pick = { sku: string; qty: number; locationId: string; booked: boolean };
/** Waar de pallet van de order fysiek is; 'open' = nog niet gepakt. */
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
  /** true: de WMS meldt zelf inkomende vrachtwagens aan (syncDeliveries); de sim laat er dan zelf geen komen. */
  deliveryFeed?: () => boolean;
  /** true: de robots doen het inkomende werk zelf (aanmelden, lossen, tellen, wegzetten, afmelden). */
  automation?: () => boolean;
}

export function createWarehouse({
  gateway = offlineGateway,
  demoOrders = () => false,
  perPallet = () => PER_PALLET,
  deliveryFeed = () => false,
  automation = () => false,
}: Options = {}) {
  const stock = new Map<string, number>(); // wat er fysiek in de stellingen staat; sleutel: locationId|sku
  const orders: SimOrder[] = [];
  // Per dock een inslagbaan (pallets) en een uitslagbaan (order-id's).
  const laneIn: (Pallet | null)[][] = DOCKS.map(() => Array(LANE_SLOTS).fill(null));
  const laneOut: (string | null)[][] = DOCKS.map(() => Array(LANE_SLOTS).fill(null));
  const trucks: { in: Truck | null; out: Truck | null } = { in: null, out: null };
  /** De inkomende vrachtwagens die de WMS heeft aangemeld: hooguit één per dock. */
  const deliveries: Truck[] = [];
  /** Leveringen die hier al zijn afgemeld: een stand uit de WMS van net daarvoor mag ze niet terugbrengen. */
  const departed = new Set<string>();
  /**
   * Per dock de levering waarvan het lossen is afgemeld en die de telrobot nu controleert. Pas als alle pallets
   * zijn geteld en de telling is bevestigd, zetten de robots ze weg.
   */
  const checking = new Map<number, { truckId: string; busy?: boolean }>();
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
  /** Lege pallets op de stapels langs de wand: een order neemt er een af, een leeggeraakte pallet komt erbij. */
  let empties = EMPTY_PALLETS.start;
  /** true: palletize() loopt voor een overgenomen of opnieuw geladen wereld; dan raakt er niets echt leeg. */
  let restoring = false;
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

  // --- Lege pallets ---
  /** Een order begint: er gaat een lege pallet van de stapel. Is de stapel op, dan is er net een nieuwe partij gebracht. */
  function takeEmpty() {
    if (empties <= 0) {
      empties = EMPTY_PALLETS.start;
      say('De lege pallets waren op: er is een nieuwe partij bij de wand gezet.');
    }
    empties--;
  }
  /** Er komt een lege pallet op de stapel; wat er niet meer bij past wordt afgevoerd. */
  const returnEmpty = () => (empties = Math.min(EMPTY_PALLETS.max, empties + 1));
  /** Een pallet in een stelling is leeg geraakt (een pick, een correctie): hij gaat naar de stapel lege pallets. */
  function emptied(p: StoredPallet) {
    racked.delete(p.id);
    if (restoring) return;
    returnEmpty();
    say(`De pallet op ${p.locationId} is leeg: hij ligt nu bij de lege pallets.`);
  }

  // --- Pallets in de stellingen ---
  const palletsAt = (loc: string) => [...racked.values()].filter((p) => p.locationId === loc);
  const freeSlot = (loc: string) => {
    const taken = new Set(palletsAt(loc).map((p) => p.slot));
    return SLOTS.find((s) => !taken.has(s));
  };

  /**
   * Houdt de pallets gelijk met de voorraad per locatie. De WMS kent (nog) geen pallets, alleen aantallen:
   * komt er voorraad bij, dan vult die een aangebroken pallet aan of komt er een pallet met een nieuw nummer;
   * gaat er voorraad af (een pick, een correctie in de WMS), dan wordt de buitenste pallet kleiner; raakt hij leeg,
   * dan gaat hij naar de stapel lege pallets.
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
      for (const p of here) if (!lines.has(p.sku)) emptied(p);
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
            emptied(p);
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
  const truck = (id: string) => [trucks.in, trucks.out, ...deliveries].find((t) => t?.id === id) ?? null;
  /** De inkomende vrachtwagens: die van de sim zelf en de leveringen uit de WMS. */
  const inbound = () => [trucks.in, ...deliveries].filter((t): t is Truck => !!t);
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
    // Een levering uit de WMS is daar al ontvangen: lossen is dan alleen nog fysiek.
    const r: WmsReply = t.wms
      ? { ok: true, linked: false }
      : await ask({ type: 'GoodsReceived', sku: pallet.sku, qty: pallet.qty, dockId: inId, palletId: pallet.id });
    scanned('pallet', pallet.id, r.ok, inId);
    if (!r.ok) return wmsRefused(r);
    const now = truck(truckId);
    const i = now?.cargo.findIndex((p) => p.id === pallet.id) ?? -1;
    if (!now || i < 0 || !laneIn[t.dock].includes(null)) return refused(`${pallet.id} is al gelost.`);
    now.cargo.splice(i, 1);
    laneIn[t.dock][laneIn[t.dock].lastIndexOf(null)] = pallet; // doorschuiven: de eerste pallet staat het verst de hal in
    touch();
    return done(`Ontvangen op ${inId}: ${what(pallet)}.${pallet.unlabeled ? ' Plak er een palletsticker op.' : ''}`);
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

  /** Pakt een lege pallet voor de eerste open order uit de WMS (start_picking). */
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
    takeEmpty();
    carry = { kind: 'order', orderId: now.id };
    touch();
    return done(`Lege pallet voor ${now.id}: ${linesText(now.lines)}. Zoek de locaties op in de WMS-app.`);
  }

  /** Legt alles terug en zet de lege pallet weer op de stapel. */
  function returnContainer(): ScanResult {
    const o = carriedOrder();
    if (!o || o.status !== 'picking') return refused('Je hebt geen order onderhanden.');
    if (o.picks.some((p) => p.booked)) return refused(`${o.id}: de WMS heeft al picks geboekt; maak de order af.`);
    for (const p of o.picks) add(p.locationId, p.sku, p.qty);
    o.picks = [];
    for (const l of o.lines) l.picked = 0;
    o.status = 'open';
    returnEmpty();
    carry = null;
    touch();
    return done(`Pallet van ${o.id} teruggezet.`);
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

  /** De pallet die een robot moet halen: op een inslagbaan of in een stelling. Een tekst = dat kan niet. */
  function robotPallet(palletId: string, fromId: string): { point: Point & { level: number; strip?: number }; take(): Pallet } | string {
    const door = DOCKS.find((x) => x.id === fromId);
    if (door) {
      // Lossen: de pallet staat achter in de vrachtwagen aan deze dockdeur
      const t = inbound().find((x) => x.dock === door.index && x.status === 'checkedIn');
      const pallet = t?.cargo.find((p) => p.id === palletId);
      if (!t || !pallet) return `${palletId} staat niet (meer) in een vrachtwagen aan ${fromId}`;
      return { point: { ...door.truck, level: 1 }, take: () => (t.cargo.splice(t.cargo.indexOf(pallet), 1), pallet) };
    }
    const d = DOCKS.find((x) => x.inId === fromId);
    if (d) {
      const lane = laneIn[d.index];
      const i = lane.findIndex((p) => p?.id === palletId);
      const pallet = lane[i];
      if (!pallet) return `${palletId} staat niet (meer) op ${fromId}`;
      if (pallet.unlabeled) return `op de pallet op ${fromId} zit nog geen sticker`;
      return { point: { ...laneSlot(d.laneIn, i), level: 1, strip: d.z }, take: () => ((lane[i] = null), pallet) };
    }
    const p = racked.get(palletId);
    const loc = location(fromId);
    if (!p || !loc || p.locationId !== fromId) return `${palletId} staat niet (meer) op ${fromId}`;
    if (p.unlabeled) return `op de pallet op ${fromId} zit nog geen sticker`;
    if (moved.has(palletId)) return `${palletId} is verplaatst en nog niet geboekt`;
    return {
      point: { x: loc.x + SLOT_DX[p.slot], z: loc.z, level: loc.level },
      take() {
        racked.delete(palletId);
        add(fromId, p.sku, -p.qty);
        const { locationId: _from, slot: _slot, ...pallet } = p;
        return pallet;
      },
    };
  }

  const laneRoom = (dock: number) => laneIn[dock]?.filter((p) => !p).length ?? 0;
  /**
   * De plek op een uitslagbaan waar een pickrobot een order neerzet: de eerste plek met alleen vrije plekken
   * erachter (aan de halkant). Hij rijdt de baan van die kant achteruit in en komt dus nooit langs een pallet. -1 = vol.
   */
  const robotStageSlot = (dock: number) => {
    const lane = laneOut[dock];
    const slot = lane ? lane.findLastIndex((id) => id) + 1 : LANE_SLOTS;
    return slot < LANE_SLOTS ? slot : -1;
  };

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
      const lane = DOCKS.find((d) => d.inId === locId);
      if (lane) {
        const slot = laneIn[lane.index].lastIndexOf(null); // doorschuiven: de eerste pallet staat het verst de hal in
        return slot < 0 ? `${locId} staat vol` : { ...laneSlot(lane.laneIn, slot), slot, level: 1, strip: lane.z };
      }
      const loc = location(locId);
      if (!loc || loc.type === 'dock') return `${locId} is geen stellinglocatie`;
      if (stockAt(locId).some((s) => s.sku !== pallet.sku)) return `op ${locId} staat al een ander artikel`;
      const slot = freeSlot(locId);
      if (slot === undefined) return `${locId} is vol`;
      return { x: loc.x + SLOT_DX[slot], z: loc.z, slot, level: loc.level };
    },
    level: (locId) => location(locId)?.level || 1,
    drop(locId, pallet, slot) {
      const lane = DOCKS.find((d) => d.inId === locId);
      if (lane) return void (laneIn[lane.index][slot] = pallet);
      delete pallet.counted; // alleen van belang op de inslagbaan
      add(locId, pallet.sku, pallet.qty);
      racked.set(pallet.id, { ...pallet, locationId: locId, slot });
    },
    async received(pallet, laneId, dockId) {
      // Een levering uit de WMS is daar al ontvangen (op de dockdeur); anders boekt het lossen de ontvangst.
      const t = inbound().find((x) => x.dockId === dockId);
      const r: WmsReply = t?.wms
        ? { ok: true, linked: false }
        : await ask({ type: 'GoodsReceived', sku: pallet.sku, qty: pallet.qty, dockId: laneId, palletId: pallet.id });
      scanned('pallet', pallet.id, r.ok, laneId);
      return r;
    },
    unload: () => [], // lossen doet de chauffeur van de wagen zelf (src/sim/drivers.ts)
    laneRoom: (laneId) => laneRoom(DOCKS.findIndex((d) => d.inId === laneId)),
    inbound: () =>
      DOCKS.flatMap((d) =>
        laneIn[d.index].flatMap((p) =>
          // pas wegzetten als de telling van de hele levering is bevestigd
          p && !p.unlabeled && p.counted && !checking.has(d.index) ? [{ palletId: p.id, sku: p.sku, qty: p.qty, locationId: d.inId, z: d.z }] : [],
        ),
      ),
    space(sku) {
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
        if (isBlocked(l.id) || free <= 0 || (here && [...here].some((s) => s !== sku))) return [];
        return [{ locationId: l.id, level: l.level, free, x: l.x, z: l.z, sameSku: !!here?.size }];
      });
    },
    orders: {
      next: (skip) => orders.find((o) => o.status === 'open' && !skip.has(o.id))?.id ?? null,
      status(id) {
        const s = order(id)?.status;
        return s === 'picking' || s === 'picked' ? s : 'other';
      },
      async start(id) {
        const o = order(id);
        if (!o || o.status !== 'open') return `${id} is geen open order (meer)`;
        // Stond de order in de WMS al op picking, dan gaat de robot daarmee verder (zie takeContainer).
        if (o.wmsStatus !== 'picking') {
          const r = await ask({ type: 'PickStarted', orderId: id });
          scanned('order', id, r.ok);
          if (!r.ok) return `de WMS weigert: ${r.error}`;
        }
        const now = order(id);
        if (!now || now.status !== 'open') return `${id} is al door iemand anders gepakt`;
        now.status = 'picking';
        now.wmsStatus = 'picking';
        takeEmpty();
        touch();
        return null;
      },
      pickSpot(id, near, avoid) {
        const o = order(id);
        if (!o) return null;
        const rest = openLines(o);
        if (rest.length === 0) return 'done';
        const unbooked = new Set([...moved.values()].map((m) => m.at));
        // De dichtstbijzijnde locatie met voorraad voor een open regel; de vloer (de pickplek) gaat voor
        const spot = shelfLocations()
          .filter((l) => !isBlocked(l.id) && !avoid.has(l.id) && !unbooked.has(l.id) && rest.some((line) => qtyAt(l.id, line.sku) > 0))
          .sort((a, b) => dist(a, near) + a.level * 4 - (dist(b, near) + b.level * 4))[0];
        if (!spot) return null;
        const sku = rest.find((line) => qtyAt(spot.id, line.sku) > 0)!.sku;
        // de pallet waar de voorraad vanaf gaat: de buitenste (zie palletize)
        const pallet = palletsAt(spot.id).filter((p) => p.sku === sku).sort((a, b) => b.slot - a.slot)[0];
        return { x: spot.x + SLOT_DX[pallet?.slot ?? 0], z: spot.z, level: spot.level, locationId: spot.id };
      },
      async pick(id, locId) {
        const o = order(id);
        const line = o && openLines(o).find((l) => qtyAt(locId, l.sku) > 0);
        if (!o || o.status !== 'picking' || !line) return `op ${locId} ligt niets (meer) wat ${id} nodig heeft`;
        const { sku } = line;
        const qty = Math.min(line.qty - line.picked, qtyAt(locId, sku));
        const r = await ask({ type: 'PickLineConfirmed', orderId: id, sku, qty, locationId: locId });
        scanned('location', locId, r.ok, locId);
        if (!r.ok) return `de WMS weigert: ${r.error}`;
        const now = order(id);
        const nowLine = now?.lines.find((l) => l.sku === sku && l.picked < l.qty);
        if (!now || !nowLine || qtyAt(locId, sku) < qty) return `${locId} is intussen gewijzigd`;
        add(locId, sku, -qty);
        nowLine.picked += qty;
        now.picks.push({ sku, qty, locationId: locId, booked: r.linked });
        touch();
        return null;
      },
      async finish(id) {
        const r = await ask({ type: 'PickCompleted', orderId: id });
        if (!r.ok) return `de WMS weigert: ${r.error}`;
        const o = order(id);
        if (!o) return `${id} bestaat niet meer`;
        o.status = 'picked';
        o.wmsStatus = 'done';
        touch();
        return null;
      },
      stageSpot() {
        const dock = robotStageSlot(outDock) >= 0 ? outDock : laneOut.findIndex((_, i) => robotStageSlot(i) >= 0);
        if (dock < 0) return null;
        const slot = robotStageSlot(dock);
        return { ...laneSlot(DOCKS[dock].laneOut, slot), dock, slot, locationId: DOCKS[dock].outId };
      },
      async stage(id, dock) {
        const d = DOCKS[dock];
        // Staat hij al klaar (teruggezet bij het laden van een bewaarde wereld), dan niet nog een keer
        if (order(id)?.status === 'staged' && laneOut.some((lane) => lane.includes(id))) return null;
        const r = await ask({ type: 'OrderStaged', orderId: id, dockId: d.outId });
        scanned('location', d.outId, r.ok, d.outId);
        if (!r.ok) return `de WMS weigert: ${r.error}`;
        const o = order(id);
        const slot = robotStageSlot(dock);
        if (!o || slot < 0) return `${d.outId} staat vol`;
        laneOut[dock][slot] = o.id;
        o.status = 'staged';
        touch();
        return null;
      },
    },
    async count(x, rows) {
      const seen = { pallets: 0, booked: 0, bare: 0 };
      for (const l of shelfLocations()) {
        if (l.x !== x || !rows.includes(l.z)) continue;
        for (const p of palletsAt(l.id)) {
          if (p.unlabeled) seen.bare++;
          else {
            seen.pallets++;
            // Een verplaatste pallet boekt de scan op de plek waar hij nu staat, net als de scanner van een speler
            if (moved.has(p.id) && (await bookMove(p.id)).ok) seen.booked++;
          }
        }
        scanned('location', l.id, true, l.id);
      }
      return seen;
    },
    refill() {
      const at = (l: { x: number; z: number }) => `${l.x}|${l.z}`;
      const occupied = new Set([...stock.keys()].map((k) => k.split('|')[0]));
      for (const p of racked.values()) occupied.add(p.locationId);
      /** Per sectie de laagste pallet boven de vloer die een robot kan pakken. */
      const above = new Map<string, StoredPallet & { level: number }>();
      for (const p of racked.values()) {
        const l = location(p.locationId);
        if (!l || l.level === 1 || p.unlabeled || moved.has(p.id) || isBlocked(l.id)) continue;
        const best = above.get(at(l));
        if (!best || l.level < best.level) above.set(at(l), { ...p, level: l.level });
      }
      return shelfLocations().flatMap((l) => {
        const p = above.get(at(l));
        if (l.level !== 1 || !p || occupied.has(l.id) || isBlocked(l.id)) return [];
        return [{ palletId: p.id, fromLocationId: p.locationId, toLocationId: l.id }];
      });
    },
  });

  // ========== De telrobot (src/sim/counter.ts) ==========

  const lanePallet = (id: string) => {
    for (const d of DOCKS) {
      const pallet = laneIn[d.index].find((p) => p?.id === id);
      if (pallet) return { pallet, dock: d };
    }
    return null;
  };

  /** Telt een pallet op een inslagbaan. Zit er nog geen sticker op, dan plakt de telrobot die (register_pallet). */
  async function countPallet(id: string): Promise<boolean> {
    const before = lanePallet(id);
    if (!before) return false;
    const { inId } = before.dock;
    if (before.pallet.unlabeled) {
      const r = await ask({ type: 'PalletLabeled', palletId: id, sku: before.pallet.sku, qty: before.pallet.qty, locationId: inId });
      if (!r.ok) return (say(`Telrobot: de WMS weigert de palletsticker voor ${what(before.pallet)} op ${inId}: ${r.error}`, 'err'), false);
    }
    const now = lanePallet(id);
    if (!now) return false; // intussen opgepakt
    scanned('pallet', id, true, inId);
    delete now.pallet.unlabeled;
    now.pallet.counted = true;
    touch();
    say(`Telrobot: ${id} geteld op ${inId}: ${what(now.pallet)}. Klaar om weg te zetten.`, 'ok');
    return true;
  }

  const counter = createCounter({
    authority: () => authority,
    revision: () => revision,
    enabled: automation,
    touch: () => touch(),
    // De telrobot begint pas als de chauffeur heeft gemeld dat hij klaar is met lossen (of als de baan vol staat:
    // anders kan de chauffeur niet verder)
    uncounted: () =>
      DOCKS.flatMap((d) =>
        laneIn[d.index].flatMap((p, i) =>
          p && !p.counted && (!p.unloading || laneRoom(d.index) === 0) ? [{ palletId: p.id, ...laneSlot(d.laneIn, i) }] : [],
        ),
      ),
    count: countPallet,
  });

  // ========== De chauffeurs: lossen en laden zelf (src/sim/drivers.ts) ==========

  const drivers = createDrivers({
    authority: () => authority,
    revision: () => revision,
    touch: () => touch(),
    trucks: () => [trucks.in, trucks.out, ...deliveries].filter((t): t is Truck => !!t),
    async checkIn(truckId) {
      const t = truck(truckId);
      if (t?.status === 'checkedIn') return true; // een levering uit de WMS is daar al aangemeld
      return (await checkIn(truckId)).ok;
    },
    takeCargo(truckId) {
      const pallet = truck(truckId)?.cargo.pop() ?? null;
      if (pallet) scanned('pallet', pallet.id, true, truck(truckId)!.dockId);
      return pallet;
    },
    laneInSlot: (dock) => laneIn[dock].lastIndexOf(null), // doorschuiven: de eerste pallet staat het verst de hal in
    async received(truckId, pallet, slot) {
      const t = truck(truckId);
      if (!t) return false;
      const { inId } = DOCKS[t.dock];
      // Een levering uit de WMS is daar al ontvangen (op de dockdeur); anders boekt het lossen de ontvangst.
      const r: WmsReply = t.wms
        ? { ok: true, linked: false }
        : await ask({ type: 'GoodsReceived', sku: pallet.sku, qty: pallet.qty, dockId: inId, palletId: pallet.id });
      scanned('pallet', pallet.id, r.ok, inId);
      if (!r.ok) return (say(`WMS weigert de ontvangst van ${what(pallet)} op ${inId}: ${r.error}`, 'err'), false);
      const lane = laneIn[t.dock];
      lane[lane[slot] ? lane.lastIndexOf(null) : slot] = { ...pallet, unloading: true };
      touch();
      say(`Chauffeur ${truckId}: ${what(pallet)} gelost op ${inId} (nog ${t.cargo.length} in de wagen).`);
      return true;
    },
    async unloadDone(truckId) {
      const t = truck(truckId);
      if (!t) return false;
      const d = DOCKS[t.dock];
      const pallets = laneIn[t.dock].filter((p) => p?.unloading).length;
      const r = await ask({ type: 'UnloadCompleted', truckId, dockId: d.id, pallets });
      if (!r.ok) return (say(`WMS weigert 'klaar met lossen' van ${truckId}: ${r.error}`, 'err'), false);
      for (const p of laneIn[t.dock]) if (p) delete p.unloading;
      if (laneIn[t.dock].some((p) => p)) checking.set(t.dock, { truckId });
      touch();
      say(`${truckId} is klaar met lossen op ${d.inId}: ${plural(pallets, 'pallet')}. De telrobot controleert de aantallen.`, 'ok');
      return true;
    },
    staged: (dock) => laneOut[dock].findIndex((id) => id),
    takeStaged(dock, slot) {
      const id = laneOut[dock][slot];
      const o = id ? order(id) : undefined;
      if (id && (!o || o.status === 'loaded' || o.status === 'shipped')) {
        // Een order die niet meer bestaat of al in een wagen staat: de plek vrijgeven, anders blijft de
        // chauffeur hem proberen te pakken
        laneOut[dock][slot] = null;
        touch();
        return null;
      }
      if (!o) return null;
      laneOut[dock][slot] = null;
      o.status = 'picked';
      scanned('order', o.id, true, DOCKS[dock].outId);
      touch();
      return o.id;
    },
    async loaded(truckId, orderId) {
      const t = truck(truckId);
      if (!t) return false;
      if (t.loaded.includes(orderId)) return true; // staat al in de wagen: de WMS zou het een tweede keer weigeren
      const r = await ask({ type: 'OrderLoaded', orderId, truckId, dockId: t.dockId });
      scanned('order', orderId, r.ok, t.dockId);
      if (!r.ok) return (say(`WMS weigert het laden van ${orderId} in ${truckId}: ${r.error}`, 'err'), false);
      const o = order(orderId);
      const now = truck(truckId);
      if (!o || !now) return false;
      now.loaded.push(orderId);
      o.status = 'loaded';
      touch();
      say(`Chauffeur ${truckId}: ${orderId} ingeladen.`);
      return true;
    },
    async loadDone(truckId) {
      const t = truck(truckId);
      if (!t) return false;
      const r = await ask({ type: 'LoadCompleted', truckId, dockId: t.dockId, orderIds: [...t.loaded] });
      if (!r.ok) return (say(`WMS weigert 'klaar met laden' van ${truckId}: ${r.error}`, 'err'), false);
      say(`${truckId} is klaar met laden: ${plural(t.loaded.length, 'order')}.`, 'ok');
      return true;
    },
    checkOut: async (truckId) => (await checkOut(truckId)).ok,
  });

  /** Heeft de telrobot alle pallets van een geloste levering geteld, dan is de telling bevestigd: de robots mogen ze wegzetten. */
  function confirmCounts() {
    for (const [dock, c] of checking) {
      const lane = laneIn[dock].filter((p): p is Pallet => !!p);
      if (c.busy || lane.some((p) => !p.counted)) continue;
      if (lane.length === 0) {
        checking.delete(dock);
        continue;
      }
      c.busy = true;
      const d = DOCKS[dock];
      const qty = lane.reduce((n, p) => n + p.qty, 0);
      void ask({ type: 'CountConfirmed', truckId: c.truckId, dockId: d.id, pallets: lane.length, qty }).then((r) => {
        if (checking.get(dock) !== c) return; // intussen is de hal gereset
        if (!r.ok) {
          say(`WMS weigert de telling van ${c.truckId}: ${r.error}`, 'err');
          return void setTimeout(() => (c.busy = false), 15000); // straks opnieuw
        }
        checking.delete(dock);
        touch();
        say(`Telling van ${c.truckId} klopt: ${plural(lane.length, 'pallet')}, ${qty} stuks op ${d.inId}. De robots zetten ze weg.`, 'ok');
      });
    }
  }

  /**
   * De leveringen die de WMS heeft aangemeld: elke nieuwe komt als vrachtwagen aanrijden aan zijn dock, al
   * aangemeld en met zijn pallets aan boord. Alleen de host doet dit; de rest krijgt ze via de gedeelde wereld.
   */
  function syncDeliveries(list: Delivery[]) {
    const robotLoads = new Set(robots.robots.flatMap((r) => (r.load ? [r.load.id] : [])));
    const inHall = (id: string) => racked.has(id) || transit.has(id) || robotLoads.has(id) || !!lanePallet(id);
    let changed = false;
    for (const d of list) {
      const dock = DOCKS.findIndex((x) => x.id === d.dockId);
      if (dock < 0 || truck(d.truckId) || departed.has(d.truckId)) continue;
      if (inbound().some((t) => t.dock === dock)) continue; // er staat nog een wagen: even wachten
      if (trucks.out?.dock === dock) {
        // De WMS heeft dit dock aan de levering gegeven: een uitgaande wagen die nog niet is aangemeld wijkt uit.
        if (trucks.out.status !== 'arriving' && trucks.out.status !== 'waiting') continue;
        outDock = chooseOutDock(dock);
        Object.assign(trucks.out, { dock: outDock, dockId: DOCKS[outDock].id, status: 'arriving', t: 0 });
      } else if (outDock === dock && !laneOut[dock].some((id) => id)) outDock = chooseOutDock(dock);
      const cargo = d.pallets
        .filter((p) => !p.palletId || !inHall(p.palletId)) // staat al in de hal: was al gelost
        .map((p): Pallet => (p.palletId ? { id: p.palletId, sku: p.sku, qty: p.qty } : { id: newPalletId(), sku: p.sku, qty: p.qty, unlabeled: true }));
      deliveries.push({ id: d.truckId, direction: 'in', dockId: d.dockId, dock, status: 'arriving', t: 0, cargo, loaded: [], wms: true });
      changed = true;
    }
    if (changed) touch();
  }

  // ========== Interacties rond de speler (E) ==========

  type Action = () => Promise<ScanResult> | ScanResult;
  const interaction = (label: string, point: Point, action?: Action): Interaction => ({
    label, point, enabled: !!action, run: action && (() => void guard(action)),
  });

  function truckInteraction(t: Truck | null): Interaction | null {
    if (!t || t.status === 'arriving' || t.status === 'departing') return null;
    const i = (label: string, action?: Action) => interaction(label, DOCKS[t.dock].truck, action);
    // De chauffeur regelt zijn wagen zelf: aanmelden, lossen of laden en afmelden
    const driver = drivers.at(t.dock);
    if (driver) return i(`Chauffeur ${t.id} ${drivers.statusText(driver)}`);
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
    for (const t of deliveries) push(truckInteraction(t), 2.2);
    push(truckInteraction(trucks.out), 2.2);

    // Per dock: inslaglocatie (pallets oppakken) en uitslaglocatie (orders klaarzetten of oppakken)
    const o = carriedOrder();
    // Met een pallet voor je uit kom je minder dicht bij een baan of een stelling: de pallet botst er eerder tegenaan
    const laneReach = carry ? 2.7 : 1.5;
    const reach = carry ? 2.9 : 1.8;
    for (const d of DOCKS) {
      if (Math.abs(pos.z - d.z) > 4.5) continue;
      const inPoint = lanePoint(d.laneIn, pos);
      const inSlot = laneIn[d.index].findLastIndex((p) => p); // de pallet aan de halkant eerst
      if (carry?.kind === 'pallet') {
        if (carry.fromId === d.inId) push(interaction(`Scan ${d.id}: pallet terugzetten op de inslagbaan`, inPoint, () => returnPallet(d)), laneReach);
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
        push(interaction(`Scan ${d.id}: ${o.id} klaarzetten op de uitslagbaan`, outPoint, () => stage(d.index)), laneReach);
      } else if (!carry && outSlot >= 0) {
        push(interaction(`Scan ${laneOut[d.index][outSlot]} op ${d.outId} en pak op`, outPoint, () => takeStaged(d, outSlot)), 1.5);
      }
    }

    // De stapel lege pallets: hier begin je aan de volgende order uit de WMS
    if (!carry) {
      const open = orders.find((x) => x.status === 'open');
      push(
        open
          ? interaction(`Pak een lege pallet voor ${open.id} (${plural(open.lines.length, 'regel')})`, POINTS.orderPallets, takeContainer)
          : interaction('Geen open orders in de WMS', POINTS.orderPallets),
        reach,
      );
    } else if (o?.status === 'picking') {
      push(interaction(`Pallet van ${o.id} terugzetten`, POINTS.orderPallets, returnContainer), reach);
    }

    // Stellingen: zonder scanner in de hand scan je met E de sectie waar je voor staat
    // de dichtstbijzijnde: rug-aan-rug staan twee rijen binnen bereik
    const section = shelfLocations()
      .filter((l) => l.level === 1 && dist(l, pos) < reach)
      .sort((a, b) => dist(a, pos) - dist(b, pos))[0];
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
          reach,
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
          reach,
        );
      } else {
        const bare = levels.flatMap((l) => palletsAt(l.id)).find((p) => p.unlabeled);
        push(
          bare
            ? interaction(`Plak een palletsticker op de pallet op ${bare.locationId} (${what(bare)})`, section, () => labelPallet(bare.id))
            : interaction(`Scan ${name}: wat staat hier?`, section, () => lookAt(section.id)),
          reach,
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
    const o = carriedOrder();
    const far = (reach: number, point: Point) =>
      dist(point, pos) > reach ? { ok: false, text: `Loop naar ${code} om daar iets te doen.` } : null;

    // Eén barcode per dock (onder het aanraakscherm): een afgemelde order gaat ermee naar de uitslagbaan,
    // een pallet die je van dit dock hebt opgepakt terug naar de inslagbaan
    const d = DOCKS.find((x) => x.id === code || x.outId === code);
    if (d) {
      // Bij het label zelf sta je verder van de banen dan DOCK_REACH: daar scannen telt ook
      const atDock = (lane: Point) => (dist(dockScreen(d), pos) <= DOCK_REACH ? null : far(DOCK_REACH, lanePoint(lane, pos)));
      if (carry?.kind === 'pallet') {
        if (carry.fromId !== d.inId) return { ok: false, text: `${carry.pallet.id} komt niet van ${d.id}: scan een stellinglocatie.` };
        return atDock(d.laneIn) ?? guard(() => returnPallet(d));
      }
      if (o?.status !== 'picked') return null;
      return atDock(d.laneOut) ?? guard(() => stage(d.index));
    }
    const loc = location(code);
    if (!loc || loc.type === 'dock') return null;
    if (carry?.kind === 'pallet') return far(REACH, loc) ?? guard(() => putaway(code));
    if (o?.status === 'picking') return far(REACH, loc) ?? guard(() => pickAt(code));
    return null;
  }

  // ========== Volgende stap voor de speler ==========

  function objective(): Objective | null {
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
      const d = laneOut[outDock].includes(null) ? DOCKS[outDock] : DOCKS.find((x) => laneOut[x.index].includes(null));
      return d ? { point: d.laneOut, text: `Zet ${o.id} klaar op de uitslagbaan: scan ${d.id}` } : null;
    }
    const unbooked = [...moved].find(([, m]) => m.at);
    if (unbooked) {
      const at = location(unbooked[1].at!);
      const text = racked.get(unbooked[0])?.unlabeled
        ? `Plak een sticker op de pallet op ${unbooked[1].at} en scan die om de verplaatsing te boeken`
        : `Scan de sticker van ${unbooked[0]} op ${unbooked[1].at} om de verplaatsing te boeken`;
      return { point: at, level: at?.level, text };
    }
    // De vrachtwagens regelen de chauffeurs zelf; staat er geen chauffeur bij, dan doet de speler het
    const mine = (t: Truck | null) => (t && !drivers.at(t.dock) ? t : null);
    const ti = mine(trucks.in);
    const to = mine(trucks.out);
    const inPoint = ti ? DOCKS[ti.dock].truck : undefined;
    const outPoint = to ? DOCKS[to.dock].truck : undefined;
    if (ti?.status === 'waiting') return { point: inPoint, text: `Meld ${ti.id} aan bij ${ti.dockId}` };
    if (ti?.status === 'checkedIn' && ti.cargo.length && laneIn[ti.dock].includes(null))
      return { point: inPoint, text: `Los ${ti.id} (${plural(ti.cargo.length, 'pallet')})` };
    // Staan de robots aan, dan tellen zij de pallets op de inslagbanen en zetten ze weg
    const full = automation() ? undefined : DOCKS.find((d) => laneIn[d.index].some((p) => p));
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
    if (orders.some((x) => x.status === 'open')) return { point: POINTS.orderPallets, text: 'Pak een lege pallet voor de volgende order' };
    if (to?.status === 'checkedIn' && to.loaded.length) return { point: outPoint, text: `Meld ${to.id} uit` };
    return null;
  }

  // ========== Tijd ==========

  /** Uitgaand dock: bij voorkeur waar al orders klaarstaan, nooit het dock van de lossende wagen. */
  function chooseOutDock(not = -1) {
    const taken = new Set([not, ...inbound().map((t) => t.dock)]);
    const staged = laneOut.findIndex((lane, i) => !taken.has(i) && lane.some((id) => id));
    if (staged >= 0) return staged;
    const free = DOCKS.map((d) => d.index).filter((i) => !taken.has(i));
    // Alle docks bezet: dan toch een willekeurig dock (de WMS weigert het aanmelden tot er een vrij is)
    return free.length ? free[rand(free.length)] : rand(DOCKS.length);
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
      t.t = Math.min(1, t.t + dt / truckSeconds(t.dock, false));
      if (t.t === 1) {
        t.status = 'waiting';
        say(`${t.id} staat aan ${t.dockId}: aanmelden.`);
      }
    } else if (t.status === 'departing') {
      t.t = Math.max(0, t.t - dt / truckSeconds(t.dock, true));
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
    for (let i = deliveries.length - 1; i >= 0; i--) {
      const t = deliveries[i];
      if (t.status === 'arriving') {
        t.t = Math.min(1, t.t + dt / truckSeconds(t.dock, false));
        if (t.t < 1) continue;
        t.status = 'checkedIn'; // de WMS heeft hem al aangemeld
        say(`${t.id} staat aan ${t.dockId}, aangemeld door de WMS (${plural(t.cargo.length, 'pallet')}).`);
      } else if (t.status === 'departing') {
        t.t = Math.max(0, t.t - dt / truckSeconds(t.dock, true));
        if (t.t > 0) continue;
        departed.add(t.id);
        deliveries.splice(i, 1);
      }
    }
    robots.update(dt);
    counter.update(dt);
    drivers.update(dt);
    if (!authority) return; // in multiplayer laat alleen de host nieuwe vrachtwagens en testorders ontstaan
    confirmCounts();
    // Meldt de WMS zelf leveringen aan, dan komen de inkomende wagens daarvandaan (syncDeliveries)
    if (!trucks.in && !deliveryFeed() && skus().length > 0 && (inTimer -= dt) <= 0) trucks.in = spawnTruck('in');
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
      deliveries,
      outDock,
      forks: [...moved],
      pallets: [...racked.values()],
      transit: [...transit],
      empties,
      robots: robots.shared(),
      counter: counter.shared(),
      drivers: drivers.shared(),
      articles: articles(),
      seq: { truckIn: seq.truckIn, truckOut: seq.truckOut },
    });
  }

  /** Neemt de gedeelde wereld van een andere speler over. Vraagt de WMS niets: dat deed die speler al. */
  function applyShared(s: ReturnType<typeof sharedState>) {
    foreign = true;
    stock.clear();
    // Een hal van vóór de dubbele stellingen heeft de oude stellingcodes (R1-01-1): omzetten naar R1A-01-1
    for (const [k, qty] of s.stock) {
      const [loc, sku] = k.split('|');
      stock.set(key(currentLocationId(loc), sku), qty);
    }
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
    // Een speler met een oudere versie stuurt geen leveringen en geen telrobot
    const before = [...deliveries];
    deliveries.splice(0, deliveries.length, ...(s.deliveries ?? []).map((next) => {
      const cur = before.find((t) => t.id === next.id && t.status === next.status);
      return cur ? { ...next, t: cur.t } : next; // rijdt hier al: niet verspringen
    }));
    counter.applyShared(s.counter);
    drivers.applyShared(s.drivers); // een speler met een oudere versie stuurt geen chauffeurs
    outDock = s.outDock;
    moved.clear();
    for (const [id, f] of s.forks ?? []) moved.set(id, { ...f, locationId: currentLocationId(f.locationId), at: f.at && currentLocationId(f.at) });
    racked.clear();
    for (const p of s.pallets ?? []) racked.set(p.id, { ...p, locationId: currentLocationId(p.locationId) });
    empties = s.empties ?? EMPTY_PALLETS.start; // een speler met een oudere versie telt de lege pallets niet
    seeding = !s.pallets; // een speler met een oudere versie stuurt geen pallets: palletize() maakt ze, met sticker
    restoring = true;
    palletize();
    restoring = seeding = false;
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

  /**
   * Zet de stellingvoorraad gelijk aan de WMS (alleen bij een reset: zie loadSnapshot). Pallets die de WMS
   * kent houden het nummer van hun sticker; wat er daarnaast los ligt komt op een pallet van de hal.
   */
  function setShelfStock(items: Item[], wmsPallets: (Pallet & { locationId: string })[]) {
    stock.clear();
    for (const it of items) if (isShelf(it.locationId) && it.qty > 0) add(it.locationId, it.sku, it.qty);
    for (const p of wmsPallets) {
      const slot = freeSlot(p.locationId);
      const room = qtyAt(p.locationId, p.sku) - palletsAt(p.locationId).reduce((n, x) => n + (x.sku === p.sku ? x.qty : 0), 0);
      if (!isShelf(p.locationId) || slot === undefined || p.qty <= 0 || room < p.qty) continue;
      racked.set(p.id, { id: p.id, sku: p.sku, qty: p.qty, locationId: p.locationId, slot });
    }
    for (const [k, qty] of stock) {
      const [loc, sku] = k.split('|');
      let rest = qty - palletsAt(loc).reduce((n, x) => n + (x.sku === sku ? x.qty : 0), 0);
      for (let slot = freeSlot(loc); rest > 0 && slot !== undefined; slot = freeSlot(loc)) {
        const p = { ...newPallet(sku, Math.min(rest, perPallet(sku))), locationId: loc, slot };
        racked.set(p.id, p);
        rest -= p.qty;
      }
    }
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
      // Een order waar al voor gepickt is (zijn pallet teruggevonden na een herstart) houdt wat erop ligt.
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
      if (o.status === 'picking') {
        o.status = 'open'; // zijn pallet staat weer bij de stapel, met wat er al op lag
        returnEmpty();
      }
      else if (o.status === 'picked') {
        // Staat hij op de pompwagen van een chauffeur, dan laadt die hem gewoon verder in
        if (drivers.drivers.some((d) => d.order === o.id)) continue;
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
   * @param wmsPallets De pallets met sticker zoals de WMS ze kent. Houdt de WMS pallets bij, dan heeft de rest
   *   van de voorraad geen sticker (de speler plakt die); zonder pallets uit de WMS stickert de hal alles zelf.
   */
  function loadSnapshot(items: Item[], wmsOrders: Order[], source: string, wmsPallets: (Pallet & { locationId: string })[] = []) {
    laneIn.forEach((lane) => lane.fill(null));
    laneOut.forEach((lane) => lane.fill(null));
    moved.clear();
    racked.clear();
    transit.clear();
    robots.reset();
    counter.reset();
    drivers.reset();
    checking.clear();
    // Leveringen die in de WMS nog zijn aangemeld komen bij de volgende stand opnieuw aanrijden
    deliveries.length = 0;
    departed.clear();
    carry = null;
    empties = EMPTY_PALLETS.start;
    restoring = true; // de voorraad wordt opnieuw opgebouwd: daarbij raakt geen pallet echt leeg
    foreign = false; // deze wereld komt uit de eigen WMS
    if (trucks.out) trucks.out.loaded = [];
    orders.length = 0;
    seeding = wmsPallets.length === 0; // kent de WMS geen pallets, dan heeft de beginvoorraad al stickers van de hal
    setShelfStock(items, wmsPallets);
    for (const it of items) {
      const lane = laneIn[DOCKS.findIndex((d) => d.inId === it.locationId)];
      if (!lane) continue;
      let rest = it.qty;
      const put = (p: Pallet) => {
        if (p.qty <= 0 || p.qty > rest || !lane.includes(null)) return;
        lane[lane.lastIndexOf(null)] = p;
        rest -= p.qty;
      };
      for (const p of wmsPallets) if (p.locationId === it.locationId && p.sku === it.sku) put({ id: p.id, sku: p.sku, qty: p.qty });
      put(newPallet(it.sku, rest)); // wat er los ligt
    }
    seeding = restoring = false;
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
    syncDeliveries,
    /** De inkomende vrachtwagens die de WMS heeft aangemeld. */
    get deliveries(): readonly Truck[] { return deliveries; },
    /** De telrobot bij de inslagbanen (src/sim/counter.ts). */
    counter,
    /** De chauffeurs die hun wagen zelf lossen en laden (src/sim/drivers.ts). */
    drivers,
    dropCarried,
    get trucks() { return trucks; },
    get laneIn() { return laneIn; },
    get laneOut() { return laneOut; },
    /** Index van het dock waar de volgende uitgaande wagen komt. */
    get outDock() { return outDock; },
    get carry() { return carry; },
    /** Hoeveel lege pallets er op de stapels langs de wand liggen. */
    get emptyPallets() { return empties; },
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
