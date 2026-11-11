import type { Item, Order } from '../shared/contract';
import { publish, type Direction } from './events';
import {
  DOCKS, LANE_SLOTS, LOCATIONS, POINTS, SKUS, SKU_NAMES,
  dist, lanePoint, location, shelfLocations, type Dock, type Point,
} from './layout';

// De fysieke wereld van het magazijn: vrachtwagens, pallets, voorraad op locaties en orders.
// Elke handeling van de speler is een processtap die als event wordt gepubliceerd.

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
export type PickTask = { sku: string; qty: number; locationId: string; done: boolean };
export type SimOrderStatus = 'open' | 'picking' | 'picked' | 'staged' | 'loaded' | 'shipped';
export type SimOrder = { id: string; lines: { sku: string; qty: number }[]; status: SimOrderStatus; tasks: PickTask[] };
export type Carry = { kind: 'pallet'; pallet: Pallet; targetId: string; fromId: string } | { kind: 'order'; orderId: string } | null;
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
  // Per dock een inslagbaan (pallets) en een uitslagbaan (order-id's).
  const laneIn: (Pallet | null)[][] = DOCKS.map(() => Array(LANE_SLOTS).fill(null));
  const laneOut: (string | null)[][] = DOCKS.map(() => Array(LANE_SLOTS).fill(null));
  const trucks: { in: Truck | null; out: Truck | null } = { in: null, out: null };
  const messages: Message[] = [];
  let carry: Carry = null;
  let clock = 0;
  let inTimer = 3;
  let outTimer = 5;
  let orderTimer = 8;
  /** Dock waar de volgende (of huidige) uitgaande vrachtwagen komt; daar zet je orders klaar. */
  let outDock = rand(DOCKS.length);
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
    for (let i = 0; i < 70; i++) add(shelves[rand(shelves.length)].id, SKUS[rand(SKUS.length)], 5 + rand(46));
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
    const { inId } = DOCKS[t.dock];
    const lane = laneIn[t.dock];
    const pallet = t.cargo.shift()!;
    lane[lane.lastIndexOf(null)] = pallet; // doorschuiven: de eerste pallet staat het verst de hal in
    add(inId, pallet.sku, pallet.qty);
    publish({ type: 'Scanned', kind: 'pallet', barcode: pallet.id, ok: true, locationId: inId });
    publish({ type: 'GoodsReceived', sku: pallet.sku, qty: pallet.qty, dockId: inId, palletId: pallet.id });
    say(`Ontvangen op ${inId}: ${pallet.id}, ${pallet.qty}× ${pallet.sku}.`, 'ok');
  }

  function pickUpPallet(d: Dock, slot: number) {
    const pallet = laneIn[d.index][slot]!;
    const targetId = putawayTarget(pallet.sku);
    publish({ type: 'Scanned', kind: 'pallet', barcode: pallet.id, ok: !!targetId, locationId: d.inId });
    if (!targetId) {
      say('Geen vrije stellinglocatie voor deze pallet.', 'err');
      return;
    }
    laneIn[d.index][slot] = null;
    carry = { kind: 'pallet', pallet, targetId, fromId: d.inId };
    say(`${pallet.id} opgepakt. Wegzetten naar ${targetId}.`);
  }

  function returnPallet(d: Dock) {
    if (carry?.kind !== 'pallet') return;
    const lane = laneIn[d.index];
    lane[lane.lastIndexOf(null)] = carry.pallet;
    say(`${carry.pallet.id} teruggezet op ${d.inId}.`);
    carry = null;
  }

  function putaway(locId: string) {
    if (carry?.kind !== 'pallet') return;
    const { pallet, fromId } = carry;
    add(fromId, pallet.sku, -pallet.qty);
    add(locId, pallet.sku, pallet.qty);
    publish({ type: 'Scanned', kind: 'location', barcode: locId, ok: true, locationId: locId });
    publish({
      type: 'PutawayDone', sku: pallet.sku, qty: pallet.qty,
      fromLocationId: fromId, locationId: locId, palletId: pallet.id,
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
      say(`${o.id} compleet gepickt. Breng naar een uitslaglocatie of de vrachtwagen.`, 'ok');
    }
  }

  function stage(o: SimOrder, d: Dock) {
    const lane = laneOut[d.index];
    lane[lane.indexOf(null)] = o.id;
    o.status = 'staged';
    carry = null;
    publish({ type: 'Scanned', kind: 'location', barcode: d.outId, ok: true, locationId: d.outId });
    publish({ type: 'OrderStaged', orderId: o.id, dockId: d.outId });
    say(`${o.id} klaargezet op ${d.outId}.`, 'ok');
  }

  function takeStaged(d: Dock, slot: number) {
    const o = order(laneOut[d.index][slot]!)!;
    laneOut[d.index][slot] = null;
    o.status = 'picked';
    carry = { kind: 'order', orderId: o.id };
    publish({ type: 'Scanned', kind: 'order', barcode: o.id, ok: true, locationId: d.outId });
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

  function truckInteraction(t: Truck | null): Interaction | null {
    if (!t || t.status === 'arriving' || t.status === 'departing') return null;
    const point = DOCKS[t.dock].truck;
    const i = (label: string, run?: () => void): Interaction => ({ label, point, enabled: !!run, run });
    if (t.status === 'waiting') return i(`Aanmelden ${t.id}`, () => checkIn(t));
    if (carry?.kind === 'pallet') return i('Zet eerst je pallet weg');

    if (t.direction === 'in') {
      if (carry) return i('Handen vol');
      if (t.cargo.length === 0) return i(`Uitmelden ${t.id}`, () => checkOut(t));
      if (!laneIn[t.dock].includes(null)) return i(`${DOCKS[t.dock].inId} vol: eerst wegzetten`);
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

    push(truckInteraction(trucks.in), 2.2);
    push(truckInteraction(trucks.out), 2.2);

    // Per dock: inslaglocatie (pallets oppakken) en uitslaglocatie (orders klaarzetten of oppakken)
    const o = carriedOrder();
    for (const d of DOCKS) {
      if (Math.abs(pos.z - d.z) > 4.5) continue;
      const inPoint = lanePoint(d.laneIn, pos);
      const inSlot = laneIn[d.index].findLastIndex((p) => p); // de pallet aan de halkant eerst
      if (carry?.kind === 'pallet') {
        if (carry.fromId === d.inId)
          push({ label: `Pallet terugzetten op ${d.inId}`, point: inPoint, enabled: true, run: () => returnPallet(d) }, 1.5);
      } else if (!carry && inSlot >= 0) {
        const p = laneIn[d.index][inSlot]!;
        push({ label: `Scan ${p.id} op ${d.inId} en pak op (${p.qty}× ${p.sku})`, point: inPoint, enabled: true, run: () => pickUpPallet(d, inSlot) }, 1.5);
      }

      const outPoint = lanePoint(d.laneOut, pos);
      const outSlot = laneOut[d.index].findIndex((id) => id);
      if (o?.status === 'picked' && laneOut[d.index].includes(null)) {
        push({ label: `${o.id} klaarzetten op ${d.outId}`, point: outPoint, enabled: true, run: () => stage(o, d) }, 1.5);
      } else if (!carry && outSlot >= 0) {
        push({ label: `Scan ${laneOut[d.index][outSlot]} op ${d.outId} en pak op`, point: outPoint, enabled: true, run: () => takeStaged(d, outSlot) }, 1.5);
      }
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
      if (to?.status === 'checkedIn') return { point: DOCKS[to.dock].truck, text: `Laad ${o.id} in ${to.id} (${to.dockId})` };
      const d = laneOut[outDock].includes(null) ? DOCKS[outDock] : DOCKS.find((x) => laneOut[x.index].includes(null));
      return d ? { point: d.laneOut, text: `Zet ${o.id} klaar op ${d.outId}` } : null;
    }
    const inPoint = ti ? DOCKS[ti.dock].truck : null;
    const outPoint = to ? DOCKS[to.dock].truck : null;
    if (ti?.status === 'waiting') return { point: inPoint!, text: `Meld ${ti.id} aan bij ${ti.dockId}` };
    if (ti?.status === 'checkedIn' && ti.cargo.length && laneIn[ti.dock].includes(null))
      return { point: inPoint!, text: `Los ${ti.id} (${ti.cargo.length} pallet${ti.cargo.length > 1 ? 's' : ''})` };
    const full = DOCKS.find((d) => laneIn[d.index].some((p) => p));
    if (full) return { point: full.laneIn, text: `Zet de pallets van ${full.inId} weg` };
    if (ti?.status === 'checkedIn' && !ti.cargo.length) return { point: inPoint!, text: `Meld ${ti.id} uit` };
    if (to?.status === 'waiting') return { point: outPoint!, text: `Meld ${to.id} aan bij ${to.dockId}` };
    if (to?.status === 'checkedIn') {
      const staged = [DOCKS[to.dock], ...DOCKS].find((d) => laneOut[d.index].some((id) => id));
      if (staged) return { point: staged.laneOut, text: `Pak de order op ${staged.outId} op om in te laden` };
    }
    if (orders.some((x) => x.status === 'open')) return { point: POINTS.terminal, text: 'Start een order bij de orderterminal' };
    if (to?.status === 'checkedIn' && to.loaded.length) return { point: outPoint!, text: `Meld ${to.id} uit` };
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
    const cargo: Pallet[] =
      direction === 'in'
        ? Array.from({ length: 2 + rand(3) }, () => ({
            id: `PAL-${stamp}-${pad(seq.pallet++, 4)}`,
            sku: SKUS[rand(SKUS.length)],
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
        if (slot === 'in') inTimer = 20;
        else {
          outTimer = 8;
          outDock = chooseOutDock();
        }
      }
    }
  }

  function update(dt: number) {
    clock += dt;
    driveTruck('in', dt);
    driveTruck('out', dt);
    if (!authority) return; // in multiplayer laat alleen de host nieuwe vrachtwagens en orders ontstaan
    if (!trucks.in && (inTimer -= dt) <= 0) trucks.in = spawnTruck('in');
    const outboundWork = orders.some((o) => ['picking', 'picked', 'staged'].includes(o.status));
    if (!trucks.out && outboundWork && (outTimer -= dt) <= 0) trucks.out = spawnTruck('out');
    if ((orderTimer -= dt) <= 0) {
      orderTimer = ORDER_INTERVAL;
      if (orders.filter((o) => o.status === 'open').length < MAX_OPEN_ORDERS) createOrder();
    }
  }

  // ========== Multiplayer: de wereld die alle spelers delen ==========

  let authority = true;

  /** Alles wat spelers delen. Wat je zelf draagt (carry) en je berichten blijven lokaal. */
  function sharedState() {
    return structuredClone({
      stock: [...stock],
      orders,
      laneIn,
      laneOut,
      trucks,
      outDock,
      seq: { truckIn: seq.truckIn, truckOut: seq.truckOut },
    });
  }

  /** Neemt de gedeelde wereld van een andere speler over. Publiceert geen events: dat deed die speler al. */
  function applyShared(s: ReturnType<typeof sharedState>) {
    stock.clear();
    for (const [k, qty] of s.stock) stock.set(k, qty);
    orders.splice(0, orders.length, ...s.orders);
    laneIn.splice(0, laneIn.length, ...s.laneIn);
    laneOut.splice(0, laneOut.length, ...s.laneOut);
    for (const slot of ['in', 'out'] as const) {
      const cur = trucks[slot];
      const next = s.trucks[slot];
      if (cur && next && cur.id === next.id && cur.status === next.status) next.t = cur.t; // rijdt hier al: niet verspringen
      trucks[slot] = next;
    }
    outDock = s.outDock;
    seq.truckIn = Math.max(seq.truckIn, s.seq.truckIn);
    seq.truckOut = Math.max(seq.truckOut, s.seq.truckOut);
    // Draag je een order die een ander inmiddels heeft afgehandeld of teruggezet, dan ben je hem kwijt.
    if (carry?.kind === 'order') {
      const o = order(carry.orderId);
      if (!o || (o.status !== 'picking' && o.status !== 'picked')) carry = null;
    }
  }

  // ========== WMS is leidend: voorraad en open orders overnemen ==========

  function loadSnapshot(items: Item[], wmsOrders: Order[], source: string) {
    stock.clear();
    laneIn.forEach((lane) => lane.fill(null));
    laneOut.forEach((lane) => lane.fill(null));
    carry = null;
    if (trucks.out) trucks.out.loaded = [];
    for (const it of items) {
      if (!location(it.locationId) || it.qty <= 0) continue;
      add(it.locationId, it.sku, it.qty);
      const lane = laneIn[DOCKS.findIndex((d) => d.inId === it.locationId)];
      if (lane?.includes(null)) {
        lane[lane.lastIndexOf(null)] = { id: `PAL-${stamp}-${pad(seq.pallet++, 4)}`, sku: it.sku, qty: it.qty };
      }
    }
    orders.length = 0;
    for (const o of wmsOrders) {
      orders.push({ id: o.id, lines: structuredClone(o.lines), status: 'open', tasks: [] });
    }
    say(`Voorraad (${items.length} regels) en ${wmsOrders.length} open order(s) geladen uit ${source}.`, 'ok');
  }

  // ========== Afstemmen met de WMS ==========

  /** Gepickt, maar nog niet bij de WMS afgeboekt: dat gebeurt pas als de order compleet is (confirm_pick). */
  function pickedUnconfirmed(): Item[] {
    return orders
      .filter((o) => o.status === 'picking')
      .flatMap((o) => o.tasks.filter((t) => t.done).map((t) => ({ locationId: t.locationId, sku: t.sku, qty: t.qty })));
  }

  /** Zet de voorraad gelijk aan `target`: de stand volgens de WMS, zonder wat nog onderweg is. */
  function syncStock(target: Item[], note: string) {
    const before = new Map(stock);
    stock.clear();
    for (const it of target) if (location(it.locationId) && it.qty > 0) add(it.locationId, it.sku, it.qty);
    // Klopt een inslaglocatie niet meer, dan staan daar de pallets die de WMS kent.
    for (const d of DOCKS) {
      const lines = stockAt(d.inId);
      const had = [...before.keys()].filter((k) => k.startsWith(`${d.inId}|`)).length;
      if (lines.length === had && lines.every((l) => before.get(key(d.inId, l.sku)) === l.qty)) continue;
      const lane = laneIn[d.index];
      lane.fill(null);
      for (const l of lines) {
        const carried = carry?.kind === 'pallet' && carry.fromId === d.inId && carry.pallet.sku === l.sku ? carry.pallet.qty : 0;
        if (l.qty - carried > 0 && lane.includes(null)) {
          lane[lane.lastIndexOf(null)] = { id: `PAL-${stamp}-${pad(seq.pallet++, 4)}`, sku: l.sku, qty: l.qty - carried };
        }
      }
    }
    say(note, 'ok');
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
    /** Index van het dock waar de volgende uitgaande wagen komt. */
    get outDock() { return outDock; },
    get carry() { return carry; },
    get orders() { return orders; },
    get messages() { return messages; },
    get clock() { return clock; },
    stockList,
    stockAt,
    forkliftTake,
    forkliftPlace,
    pickedUnconfirmed,
    syncStock,
    order,
    sharedState,
    applyShared,
    /** false: een andere speler is host en laat vrachtwagens en orders ontstaan. */
    setAuthority(on: boolean) {
      authority = on;
    },
  };
}

export type Warehouse = ReturnType<typeof createWarehouse>;
export type SharedState = ReturnType<Warehouse['sharedState']>;
