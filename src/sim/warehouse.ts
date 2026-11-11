import type { Item, Order } from '../shared/contract';
import { publish, type Direction } from './events';
import {
  DOCK_IN, DOCK_OUT, LANE_SLOTS, LOCATIONS, POINTS, SKUS, SKU_NAMES,
  dist, location, shelfLocations, type Point,
} from './layout';

// De fysieke wereld van het magazijn: vrachtwagens, pallets, voorraad op locaties en orders.
// Elke handeling van de speler is een processtap die als event wordt gepubliceerd.

export type Pallet = { id: string; sku: string; qty: number };
export type TruckStatus = 'arriving' | 'waiting' | 'checkedIn' | 'departing';
export type Truck = {
  id: string;
  direction: Direction;
  dockId: string;
  status: TruckStatus;
  /** 0 = op de weg, 1 = tegen de dockdeur. */
  t: number;
  cargo: Pallet[];
  loaded: string[];
};
export type PickTask = { sku: string; qty: number; locationId: string; done: boolean };
export type SimOrderStatus = 'open' | 'picking' | 'picked' | 'staged' | 'loaded' | 'shipped';
export type SimOrder = { id: string; lines: { sku: string; qty: number }[]; status: SimOrderStatus; tasks: PickTask[] };
export type Carry = { kind: 'pallet'; pallet: Pallet; targetId: string } | { kind: 'order'; orderId: string } | null;
export type Message = { text: string; kind: 'info' | 'ok' | 'err'; at: number };
export type Interaction = { label: string; point: Point; enabled: boolean; run?: () => void };
export type Objective = { point: Point; level?: number; text: string };

const DRIVE_SECONDS = 4;
const ORDER_INTERVAL = 45;
const MAX_OPEN_ORDERS = 2;

const rand = (n: number) => Math.floor(Math.random() * n);
const pad = (n: number, w = 3) => String(n).padStart(w, '0');
const stamp = Date.now().toString(36).slice(-4).toUpperCase(); // uniek per sessie, voor order-id's in de echte WMS

export function createWarehouse() {
  const stock = new Map<string, number>(); // sleutel: locationId|sku
  const orders: SimOrder[] = [];
  const laneIn: (Pallet | null)[] = Array(LANE_SLOTS).fill(null);
  const laneOut: (string | null)[] = Array(LANE_SLOTS).fill(null);
  const trucks: { in: Truck | null; out: Truck | null } = { in: null, out: null };
  const messages: Message[] = [];
  let carry: Carry = null;
  let clock = 0;
  let inTimer = 3;
  let outTimer = 5;
  let orderTimer = 8;
  const seq = { truckIn: 1, truckOut: 1, pallet: 1, order: 1 };

  // --- Berichten ---
  function say(text: string, kind: Message['kind'] = 'info') {
    messages.push({ text, kind, at: clock });
    if (messages.length > 6) messages.shift();
  }

  // --- Voorraad ---
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
  const shelfQty = (sku: string) =>
    shelfLocations().reduce((n, l) => n + qtyAt(l.id, sku), 0);

  /** Vrij beschikbaar: voorraad in de stellingen minus wat open orders nog nodig hebben. */
  function available(sku: string) {
    let claimed = 0;
    for (const o of orders) {
      if (o.status === 'open') claimed += o.lines.filter((l) => l.sku === sku).reduce((n, l) => n + l.qty, 0);
      if (o.status === 'picking') claimed += o.tasks.filter((t) => !t.done && t.sku === sku).reduce((n, t) => n + t.qty, 0);
    }
    return shelfQty(sku) - claimed;
  }

  function seed() {
    const shelves = shelfLocations();
    for (let i = 0; i < 25; i++) add(shelves[rand(shelves.length)].id, SKUS[rand(SKUS.length)], 5 + rand(46));
  }
  seed();

  // --- Wegzetten: locatie kiezen ---
  function putawayTarget(sku: string): string | null {
    const shelves = shelfLocations();
    const same = shelves.find((l) => qtyAt(l.id, sku) > 0 && stockAt(l.id).length === 1);
    if (same) return same.id;
    const empty = shelves.filter((l) => stockAt(l.id).length === 0);
    return (empty.find((l) => l.type === 'rack') ?? empty[0])?.id ?? null;
  }

  // --- Picken: bronlocaties volgens dezelfde regel als de WMS (eerst pick, dan rack, op id) ---
  function pickTasks(o: SimOrder): PickTask[] | string {
    const rank = (id: string) => (location(id)?.type === 'pick' ? 0 : 1);
    const tasks: PickTask[] = [];
    for (const line of o.lines) {
      const sources = shelfLocations()
        .filter((l) => qtyAt(l.id, line.sku) > 0)
        .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
      let rest = line.qty;
      for (const s of sources) {
        const take = Math.min(rest, qtyAt(s.id, line.sku));
        tasks.push({ sku: line.sku, qty: take, locationId: s.id, done: false });
        rest -= take;
        if (rest === 0) break;
      }
      if (rest > 0) return `Onvoldoende voorraad ${line.sku}: nodig ${line.qty}, aanwezig ${line.qty - rest}.`;
    }
    return tasks;
  }

  const order = (id: string) => orders.find((o) => o.id === id);
  const carriedOrder = () => (carry?.kind === 'order' ? order(carry.orderId) : undefined);
  const nextTask = (o?: SimOrder) => o?.tasks.find((t) => !t.done);

  // ========== Acties ==========

  function createOrder() {
    const candidates = SKUS.filter((s) => available(s) > 0).sort(() => Math.random() - 0.5);
    if (candidates.length === 0) {
      say('Geen vrije voorraad voor een nieuwe order.', 'err');
      return;
    }
    const lines = candidates
      .slice(0, 1 + rand(Math.min(3, candidates.length)))
      .map((sku) => ({ sku, qty: 1 + rand(Math.min(5, available(sku))) }));
    const id = `ORD-${stamp}-${pad(seq.order++)}`;
    orders.push({ id, lines, status: 'open', tasks: [] });
    say(`Nieuwe order ${id} (${lines.length} regel${lines.length > 1 ? 's' : ''}).`);
    publish({ type: 'OrderCreated', order: { id, lines: structuredClone(lines), status: 'open' } });
  }

  function checkIn(t: Truck) {
    t.status = 'checkedIn';
    publish({ type: 'Scanned', kind: 'truck', barcode: t.id, ok: true, locationId: t.dockId });
    publish({ type: 'TruckCheckedIn', truckId: t.id, direction: t.direction, dockId: t.dockId });
    say(`${t.id} aangemeld aan ${t.dockId}.`, 'ok');
  }

  function checkOut(t: Truck) {
    t.status = 'departing';
    for (const id of t.loaded) {
      const o = order(id);
      if (o) o.status = 'shipped';
    }
    publish({ type: 'Scanned', kind: 'truck', barcode: t.id, ok: true, locationId: t.dockId });
    publish({ type: 'TruckCheckedOut', truckId: t.id, direction: t.direction, dockId: t.dockId, orderIds: [...t.loaded] });
    say(`${t.id} uitgemeld${t.loaded.length ? ` met ${t.loaded.length} order(s)` : ''}.`, 'ok');
  }

  function unload(t: Truck) {
    const slot = laneIn.indexOf(null);
    const pallet = t.cargo.shift()!;
    laneIn[slot] = pallet;
    add(DOCK_IN, pallet.sku, pallet.qty);
    publish({ type: 'Scanned', kind: 'pallet', barcode: pallet.id, ok: true, locationId: DOCK_IN });
    publish({ type: 'GoodsReceived', sku: pallet.sku, qty: pallet.qty, dockId: DOCK_IN, palletId: pallet.id });
    say(`Ontvangen: ${pallet.id}, ${pallet.qty}× ${pallet.sku}.`, 'ok');
  }

  function pickUpPallet(slot: number) {
    const pallet = laneIn[slot]!;
    const targetId = putawayTarget(pallet.sku);
    publish({ type: 'Scanned', kind: 'pallet', barcode: pallet.id, ok: !!targetId, locationId: DOCK_IN });
    if (!targetId) {
      say('Geen vrije stellinglocatie voor deze pallet.', 'err');
      return;
    }
    laneIn[slot] = null;
    carry = { kind: 'pallet', pallet, targetId };
    say(`${pallet.id} opgepakt. Wegzetten naar ${targetId}.`);
  }

  function returnPallet() {
    if (carry?.kind !== 'pallet') return;
    laneIn[laneIn.indexOf(null)] = carry.pallet;
    say(`${carry.pallet.id} teruggezet in de inslagbaan.`);
    carry = null;
  }

  function putaway(locId: string) {
    if (carry?.kind !== 'pallet') return;
    const { pallet } = carry;
    add(DOCK_IN, pallet.sku, -pallet.qty);
    add(locId, pallet.sku, pallet.qty);
    publish({ type: 'Scanned', kind: 'location', barcode: locId, ok: true, locationId: locId });
    publish({
      type: 'PutawayDone', sku: pallet.sku, qty: pallet.qty,
      fromLocationId: DOCK_IN, locationId: locId, palletId: pallet.id,
    });
    say(`${pallet.id} weggezet op ${locId}.`, 'ok');
    carry = null;
  }

  function wrongScan(locId: string, expected: string) {
    publish({ type: 'Scanned', kind: 'location', barcode: locId, ok: false, locationId: locId });
    say(`Verkeerde locatie ${locId}: verwacht ${expected}.`, 'err');
  }

  function infoScan(sectionLocId: string) {
    const loc = location(sectionLocId)!;
    const levels = LOCATIONS.filter((l) => l.x === loc.x && l.z === loc.z && l.type !== 'dock');
    publish({ type: 'Scanned', kind: 'location', barcode: loc.id, ok: true, locationId: loc.id });
    const text = levels
      .map((l) => `${l.id}: ${stockAt(l.id).map((s) => `${s.qty}× ${s.sku}`).join(', ') || 'leeg'}`)
      .join(' · ');
    say(text);
  }

  function startPick(o: SimOrder) {
    const tasks = pickTasks(o);
    publish({ type: 'Scanned', kind: 'order', barcode: o.id, ok: typeof tasks !== 'string' });
    if (typeof tasks === 'string') {
      say(`${o.id}: ${tasks}`, 'err');
      return;
    }
    o.tasks = tasks;
    o.status = 'picking';
    carry = { kind: 'order', orderId: o.id };
    publish({ type: 'PickStarted', orderId: o.id });
    say(`Picken gestart: ${o.id}, ${tasks.length} pickopdracht(en).`);
  }

  function pickLine(o: SimOrder, task: PickTask) {
    add(task.locationId, task.sku, -task.qty);
    task.done = true;
    publish({ type: 'Scanned', kind: 'location', barcode: task.locationId, ok: true, locationId: task.locationId });
    publish({ type: 'PickLineConfirmed', orderId: o.id, sku: task.sku, qty: task.qty, locationId: task.locationId });
    if (nextTask(o)) {
      say(`Gepickt: ${task.qty}× ${task.sku} van ${task.locationId}.`, 'ok');
    } else {
      o.status = 'picked';
      publish({ type: 'PickCompleted', orderId: o.id });
      say(`${o.id} compleet gepickt. Breng naar de uitgaande baan of vrachtwagen.`, 'ok');
    }
  }

  function stage(o: SimOrder) {
    laneOut[laneOut.indexOf(null)] = o.id;
    o.status = 'staged';
    carry = null;
    publish({ type: 'Scanned', kind: 'location', barcode: DOCK_OUT, ok: true, locationId: DOCK_OUT });
    publish({ type: 'OrderStaged', orderId: o.id, dockId: DOCK_OUT });
    say(`${o.id} klaargezet in de uitgaande baan.`, 'ok');
  }

  function takeStaged(slot: number) {
    const o = order(laneOut[slot]!)!;
    laneOut[slot] = null;
    o.status = 'picked';
    carry = { kind: 'order', orderId: o.id };
    publish({ type: 'Scanned', kind: 'order', barcode: o.id, ok: true, locationId: DOCK_OUT });
    say(`${o.id} opgepakt voor inladen.`);
  }

  function load(t: Truck, o: SimOrder) {
    t.loaded.push(o.id);
    o.status = 'loaded';
    carry = null;
    publish({ type: 'Scanned', kind: 'order', barcode: o.id, ok: true, locationId: t.dockId });
    publish({ type: 'OrderLoaded', orderId: o.id, truckId: t.id, dockId: t.dockId });
    say(`${o.id} ingeladen in ${t.id}.`, 'ok');
  }

  // ========== Heftruck: hele pallets tussen stellinglocaties verplaatsen ==========

  /** Haalt (maximaal maxQty van) het grootste artikel van een locatie; de pallet staat daarna op de vorken. */
  function forkliftTake(locId: string, maxQty: number): Pallet | null {
    const top = stockAt(locId).sort((a, b) => b.qty - a.qty)[0];
    if (!top) return null;
    const qty = Math.min(maxQty, top.qty);
    add(locId, top.sku, -qty);
    say(`Heftruck: ${qty}× ${top.sku} van ${locId} gepakt.`);
    return { id: `PAL-${stamp}-${pad(seq.pallet++, 4)}`, sku: top.sku, qty };
  }

  /** Zet een pallet van de vorken op een stellinglocatie; verplaatsen geldt als wegzetten (confirm_putaway). */
  function forkliftPlace(locId: string, pallet: Pallet, fromLocationId: string) {
    add(locId, pallet.sku, pallet.qty);
    if (fromLocationId === locId) {
      say(`${pallet.id} teruggezet op ${locId}.`);
      return;
    }
    publish({ type: 'Scanned', kind: 'location', barcode: locId, ok: true, locationId: locId });
    publish({ type: 'PutawayDone', sku: pallet.sku, qty: pallet.qty, fromLocationId, locationId: locId, palletId: pallet.id });
    say(`${pallet.id} verplaatst van ${fromLocationId} naar ${locId}.`, 'ok');
  }

  // ========== Interacties rond de speler ==========

  function truckInteraction(t: Truck | null, point: Point): Interaction | null {
    if (!t || t.status === 'arriving' || t.status === 'departing') return null;
    const i = (label: string, run?: () => void): Interaction => ({ label, point, enabled: !!run, run });
    if (t.status === 'waiting') return i(`Aanmelden ${t.id}`, () => checkIn(t));
    if (carry?.kind === 'pallet') return i('Zet eerst je pallet weg');

    if (t.direction === 'in') {
      if (carry) return i('Handen vol');
      if (t.cargo.length === 0) return i(`Uitmelden ${t.id}`, () => checkOut(t));
      if (!laneIn.includes(null)) return i('Inslagbaan vol: eerst wegzetten');
      const p = t.cargo[0];
      return i(`Scan ${p.id} en los (${p.qty}× ${p.sku}, nog ${t.cargo.length})`, () => unload(t));
    }

    const o = carriedOrder();
    if (o) return o.status === 'picked' ? i(`Scan ${o.id} en laad in`, () => load(t, o)) : i(`${o.id} is nog niet compleet`);
    if (t.loaded.length === 0) return i('Laad eerst een gepickte order in');
    return i(`Uitmelden ${t.id} (${t.loaded.length} order${t.loaded.length > 1 ? 's' : ''})`, () => checkOut(t));
  }

  function candidates(pos: Point): (Interaction & { radius: number })[] {
    const list: (Interaction & { radius: number })[] = [];
    const push = (it: Interaction | null, radius: number) => it && list.push({ ...it, radius });

    push(truckInteraction(trucks.in, POINTS.truckIn), 2.6);
    push(truckInteraction(trucks.out, POINTS.truckOut), 2.6);

    // Inslagbaan
    const inSlot = laneIn.findIndex((p) => p);
    if (carry?.kind === 'pallet') {
      push({ label: 'Pallet terugzetten in inslagbaan', point: POINTS.laneIn, enabled: true, run: returnPallet }, 2.2);
    } else if (!carry && inSlot >= 0) {
      const p = laneIn[inSlot]!;
      push({ label: `Scan ${p.id} en pak op (${p.qty}× ${p.sku})`, point: POINTS.laneIn, enabled: true, run: () => pickUpPallet(inSlot) }, 2.2);
    }

    // Uitgaande baan
    const o = carriedOrder();
    const outSlot = laneOut.findIndex((id) => id);
    if (o?.status === 'picked' && laneOut.includes(null)) {
      push({ label: `${o.id} afzetten in uitgaande baan`, point: POINTS.laneOut, enabled: true, run: () => stage(o) }, 2.2);
    } else if (!carry && outSlot >= 0) {
      push({ label: `Scan ${laneOut[outSlot]} en pak op`, point: POINTS.laneOut, enabled: true, run: () => takeStaged(outSlot) }, 2.2);
    }

    // Orderterminal
    const open = orders.find((x) => x.status === 'open');
    if (!carry) {
      push(
        open
          ? { label: `Start picken ${open.id} (${open.lines.length} regel${open.lines.length > 1 ? 's' : ''})`, point: POINTS.terminal, enabled: true, run: () => startPick(open) }
          : { label: 'Geen open orders: maak een testorder', point: POINTS.terminal, enabled: true, run: createOrder },
        2,
      );
    } else if (o?.status === 'picking') {
      push({ label: `Bezig met ${o.id}`, point: POINTS.terminal, enabled: false }, 2);
    }

    // Stellingen: doel-locatie scannen, of een andere locatie (fout / info)
    const target =
      carry?.kind === 'pallet' ? carry.targetId : o?.status === 'picking' ? nextTask(o)?.locationId : undefined;
    const targetLoc = target ? location(target) : undefined;
    if (targetLoc) {
      const task = nextTask(o);
      push({
        label: carry?.kind === 'pallet'
          ? `Scan ${target} en zet weg`
          : `Scan ${target} en pick ${task!.qty}× ${task!.sku}`,
        point: targetLoc,
        enabled: true,
        run: () => (carry?.kind === 'pallet' ? putaway(target!) : pickLine(o!, task!)),
      }, 2.8);
    }
    const section = shelfLocations()
      .filter((l) => l.level === 1)
      .find((l) => dist(l, pos) < 1.8 && !(targetLoc && l.x === targetLoc.x && l.z === targetLoc.z));
    if (section) {
      push(
        target
          ? { label: `Scan ${section.id.slice(0, -2)}: verkeerde locatie`, point: section, enabled: true, run: () => wrongScan(section.id, target) }
          : { label: `Scan ${section.id.slice(0, -2)}: voorraad bekijken`, point: section, enabled: true, run: () => infoScan(section.id) },
        1.8,
      );
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

  // ========== Volgende stap voor de speler ==========

  function objective(): Objective | null {
    const ti = trucks.in;
    const to = trucks.out;
    const o = carriedOrder();
    if (carry?.kind === 'pallet') {
      const l = location(carry.targetId)!;
      return { point: l, level: l.level, text: `Breng ${carry.pallet.id} naar ${l.id}` };
    }
    if (o?.status === 'picking') {
      const t = nextTask(o)!;
      const l = location(t.locationId)!;
      return { point: l, level: l.level, text: `Pick ${t.qty}× ${t.sku} (${SKU_NAMES[t.sku]}) op ${l.id}` };
    }
    if (o?.status === 'picked') {
      return to?.status === 'checkedIn'
        ? { point: POINTS.truckOut, text: `Laad ${o.id} in ${to.id}` }
        : { point: POINTS.laneOut, text: `Zet ${o.id} in de uitgaande baan` };
    }
    if (ti?.status === 'waiting') return { point: POINTS.truckIn, text: `Meld ${ti.id} aan bij ${DOCK_IN}` };
    if (ti?.status === 'checkedIn' && ti.cargo.length && laneIn.includes(null))
      return { point: POINTS.truckIn, text: `Los ${ti.id} (${ti.cargo.length} pallet${ti.cargo.length > 1 ? 's' : ''})` };
    if (laneIn.some((p) => p)) return { point: POINTS.laneIn, text: 'Zet de pallets uit de inslagbaan weg' };
    if (ti?.status === 'checkedIn' && !ti.cargo.length) return { point: POINTS.truckIn, text: `Meld ${ti.id} uit` };
    if (to?.status === 'waiting') return { point: POINTS.truckOut, text: `Meld ${to.id} aan bij ${DOCK_OUT}` };
    if (to?.status === 'checkedIn' && laneOut.some((id) => id))
      return { point: POINTS.laneOut, text: 'Pak een klaargezette order op om in te laden' };
    if (orders.some((x) => x.status === 'open')) return { point: POINTS.terminal, text: 'Start een order op de pc' };
    if (to?.status === 'checkedIn' && to.loaded.length) return { point: POINTS.truckOut, text: `Meld ${to.id} uit` };
    return null;
  }

  // ========== Tijd ==========

  function spawnTruck(direction: Direction): Truck {
    const id = direction === 'in' ? `IN-${pad(seq.truckIn++)}` : `UIT-${pad(seq.truckOut++)}`;
    const cargo: Pallet[] =
      direction === 'in'
        ? Array.from({ length: 2 + rand(3) }, () => ({
            id: `PAL-${stamp}-${pad(seq.pallet++, 4)}`,
            sku: SKUS[rand(SKUS.length)],
            qty: 5 * (2 + rand(5)),
          }))
        : [];
    return { id, direction, dockId: direction === 'in' ? DOCK_IN : DOCK_OUT, status: 'arriving', t: 0, cargo, loaded: [] };
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
        if (slot === 'in') inTimer = 20;
        else outTimer = 8;
      }
    }
  }

  function update(dt: number) {
    clock += dt;
    if (!trucks.in && (inTimer -= dt) <= 0) trucks.in = spawnTruck('in');
    const outboundWork = orders.some((o) => ['picking', 'picked', 'staged'].includes(o.status));
    if (!trucks.out && outboundWork && (outTimer -= dt) <= 0) trucks.out = spawnTruck('out');
    driveTruck('in', dt);
    driveTruck('out', dt);
    if ((orderTimer -= dt) <= 0) {
      orderTimer = ORDER_INTERVAL;
      if (orders.filter((o) => o.status === 'open').length < MAX_OPEN_ORDERS) createOrder();
    }
  }

  // ========== WMS is leidend: voorraad en open orders overnemen ==========

  function loadSnapshot(items: Item[], wmsOrders: Order[], source: string) {
    stock.clear();
    laneIn.fill(null);
    laneOut.fill(null);
    carry = null;
    if (trucks.out) trucks.out.loaded = [];
    for (const it of items) {
      if (!location(it.locationId) || it.qty <= 0) continue;
      add(it.locationId, it.sku, it.qty);
      if (it.locationId === DOCK_IN && laneIn.includes(null)) {
        laneIn[laneIn.indexOf(null)] = { id: `PAL-${stamp}-${pad(seq.pallet++, 4)}`, sku: it.sku, qty: it.qty };
      }
    }
    orders.length = 0;
    for (const o of wmsOrders) {
      orders.push({ id: o.id, lines: structuredClone(o.lines), status: 'open', tasks: [] });
    }
    say(`Voorraad (${items.length} regels) en ${wmsOrders.length} open order(s) geladen uit ${source}.`, 'ok');
  }

  return {
    update,
    interact,
    interactionAt,
    objective,
    loadSnapshot,
    createOrder,
    get trucks() { return trucks; },
    get laneIn() { return laneIn; },
    get laneOut() { return laneOut; },
    get carry() { return carry; },
    get orders() { return orders; },
    get messages() { return messages; },
    get clock() { return clock; },
    stockList,
    stockAt,
    forkliftTake,
    forkliftPlace,
    order,
  };
}

export type Warehouse = ReturnType<typeof createWarehouse>;
