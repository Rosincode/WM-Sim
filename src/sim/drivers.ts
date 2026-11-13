import { DOCKS, HALL, dist, laneSlot, type Dock, type Point } from './layout';
import type { Pallet } from './warehouse';

// De chauffeurs. Elke vrachtwagen heeft een chauffeur die zelf lost of laadt, zonder hulp van het magazijn:
// hij stapt uit, loopt door de chauffeursdeur de hal in, meldt zich aan op het scherm bij zijn dock, zet de
// dockdeur open, pakt de elektrische pompwagen die bij het dock staat en rijdt de pallets één voor één uit de
// wagen naar de inslagbaan (of de klaargezette orders de wagen in). Daarna zet hij de pompwagen terug, meldt
// op het scherm dat hij klaar is, doet de dockdeur dicht, loopt terug naar zijn cabine en rijdt weg.
// Zoals overal in de sim geldt: eerst de WMS, dan fysiek. Multiplayer: iedereen laat de chauffeurs lokaal
// lopen; alleen de host beslist.

export type DriverPhase =
  | 'toScreen' | 'checkIn' | 'opening' | 'toJack'
  // lossen: naar de pallet in de wagen, optillen, naar de inslagbaan, neerzetten
  | 'toCargo' | 'lifting' | 'toLane'
  // laden: naar de klaargezette order, optillen, de wagen in, neerzetten
  | 'toStaged' | 'toTrailer'
  | 'dropping' | 'waiting'
  | 'parkJack' | 'toScreenDone' | 'checkOut' | 'closing' | 'toCab' | 'leave';
/** back = achteruit naar dit punt (alleen met de pompwagen). */
type Waypoint = Point & { back?: boolean };
export type Driver = {
  /** Het nummer van zijn vrachtwagen. */
  id: string;
  dock: number;
  direction: 'in' | 'out';
  /** Waar hij loopt; met de pompwagen in de hand is dit het midden van de pompwagen. */
  x: number;
  z: number;
  /** Looprichting (radialen om de verticale as); vooruit = (sin r, cos r). */
  r: number;
  phase: DriverPhase;
  path: Waypoint[];
  /** Heeft de pompwagen van zijn dock in de hand. */
  jack: boolean;
  /** Wat er op de vorken staat: een pallet (lossen) of de rolcontainer van een order (laden). */
  load: Pallet | null;
  order: string | null;
  /** De dockdeur van zijn dock staat open. */
  door: boolean;
  /** De palletplek waar hij heen rijdt: in de wagen of op de baan. */
  target: number;
  /** Seconden die de huidige handeling nog duurt, of tot hij het opnieuw probeert. */
  timer: number;
  /** Seconden die hij al op klaargezette orders wacht. */
  waited: number;
  /** Telt elke beslissing; in multiplayer wint de hoogste stand. */
  v: number;
};

export type DriverTruck = {
  id: string;
  dock: number;
  direction: 'in' | 'out';
  status: 'arriving' | 'waiting' | 'checkedIn' | 'departing';
  cargo: Pallet[];
  loaded: string[];
};

/** Wat de chauffeurs van de fysieke wereld nodig hebben; ingevuld door src/sim/warehouse.ts. true = gelukt. */
export interface DriverWorld {
  /** false: een andere speler is host en beslist. */
  authority(): boolean;
  revision(): number;
  touch(): void;
  trucks(): DriverTruck[];
  /** Aanmelden op het scherm bij het dock. */
  checkIn(truckId: string): Promise<boolean>;
  /** De achterste pallet uit de wagen: hij staat daarna op de vorken. */
  takeCargo(truckId: string): Pallet | null;
  /** De vrije palletplek op de inslagbaan van het dock (de verste de hal in), of -1 als de baan vol is. */
  laneInSlot(dock: number): number;
  /** Zet de pallet op de inslagbaan: de WMS boekt de ontvangst. */
  received(truckId: string, pallet: Pallet, slot: number): Promise<boolean>;
  /** 'Klaar met lossen' op het scherm: de WMS laat daarna de telrobot de pallets controleren. */
  unloadDone(truckId: string): Promise<boolean>;
  /** De plek op de uitslagbaan met de eerstvolgende klaargezette order, of -1. */
  staged(dock: number): number;
  /** Pakt de rolcontainer van die plek: hij staat daarna op de vorken. */
  takeStaged(dock: number, slot: number): string | null;
  /** Zet de order in de wagen: de WMS boekt het laden. */
  loaded(truckId: string, orderId: string): Promise<boolean>;
  /** 'Klaar met laden' op het scherm. */
  loadDone(truckId: string): Promise<boolean>;
  /** De wagen afmelden: daarna rijdt hij weg. */
  checkOut(truckId: string): Promise<boolean>;
}

const X0 = -HALL.w / 2;
/**
 * De vrachtwagen aan het dock: de achterkant van de trailer (x), de hoogte van de laadvloer, en waar de
 * chauffeur uit zijn cabine stapt (x, en hoe ver naast het midden van het dock).
 */
export const TRUCK = { rear: X0 - 0.4, floor: 0.45, length: 8, cabX: X0 - 9.7, cabSide: 1.75 };
/** De laadklep: loopt van de halvloer (x = low) schuin op naar de laadvloer van de wagen (x = high). */
export const DOCK_RAMP = { low: X0 + 2.1, high: X0 - 0.35 };
/** Hoogte van de vloer waar de chauffeur en zijn pompwagen op rijden: de hal, de laadklep of de laadvloer. */
export function dockFloorY(x: number) {
  const t = (DOCK_RAMP.low - x) / (DOCK_RAMP.low - DOCK_RAMP.high);
  return TRUCK.floor * Math.max(0, Math.min(1, t));
}
/** Palletplek i in de wagen: twee naast elkaar, vanaf de kopwand naar achteren. */
export function cargoSpot(dockZ: number, i: number): Point {
  const row = Math.min(Math.floor(i / 2), 5);
  return { x: TRUCK.rear - TRUCK.length + 0.85 + row * 1.3, z: dockZ + (i % 2 ? 0.52 : -0.52) };
}
/** De chauffeursdeuren in de dockwand (z): één aan elke kant van de rij docks. */
export const DRIVER_DOORS = [...new Set([(DOCKS[0]?.z ?? 0) - 4.7, (DOCKS[DOCKS.length - 1]?.z ?? 0) + 4.7])]
  .map((z) => Math.max(-HALL.d / 2 + 1.2, Math.min(HALL.d / 2 - 1.2, z)));
/** Zo ver (m) voor het midden van de pompwagen staat wat hij draagt, en zo ver erachter loopt de chauffeur. */
export const JACK_REACH = 0.75;
export const JACK_HANDLE = 0.85;
/**
 * Waar de elektrische pompwagen van een dock geparkeerd staat: in zijn eigen vak naast de dockdeur, bij het
 * scherm van dat dock, de vorken de hal in.
 */
export const jackPark = (d: Dock) => ({ x: X0 + 1.85, z: d.z - 2.5, r: Math.PI / 2 });
/** Het parkeervak van die pompwagen op de vloer: midden, lengte (langs x) en breedte (langs z). */
export const jackBay = (d: Dock) => ({ x: jackPark(d).x + 0.35, z: jackPark(d).z, w: 2.4, d: 0.9 });
/** Het scherm naast de dockdeur (aan de wand), en waar de chauffeur staat om het te bedienen. */
export const dockScreen = (d: Dock): Point => ({ x: X0, z: d.z - 1.95 });
const screenStand = (d: Dock): Point => ({ x: X0 + 0.75, z: d.z - 1.72 });

/** De rijlijn (x) langs de docks, binnen: van hieruit rijdt de pompwagen de wagen, een baan of zijn parkeerplek in. */
const INSIDE_X = X0 + 3.4;
/** De looplijn (x) buiten, voor de cabines langs. */
const OUTSIDE_X = TRUCK.rear - 11.8;
const WALK = 1.7;
const JACK_SPEED = 1.5;
const TURN = 4;
/** Zo lang (s) wacht een chauffeur hooguit op orders die nog klaargezet moeten worden. */
const MAX_WAIT = 240;

const angle = (to: number, from: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

export function createDrivers(world: DriverWorld) {
  const drivers: Driver[] = [];
  /** Chauffeurs voor wie een vraag bij de WMS loopt. */
  const busy = new Set<string>();
  let resets = 0;
  let snapshot: Driver[] = [];
  let snapshotAt = -1;

  const dockOf = (d: Driver) => DOCKS[d.dock];
  const truckOf = (d: Driver) => world.trucks().find((t) => t.id === d.id);
  const cab = (dock: Dock): Point => ({ x: TRUCK.cabX, z: dock.z + TRUCK.cabSide });
  const doorZ = (dock: Dock) => DRIVER_DOORS.reduce((best, z) => (Math.abs(z - dock.z) < Math.abs(best - dock.z) ? z : best));
  const jackStand = (dock: Dock): Point => ({ x: jackPark(dock).x - JACK_HANDLE, z: jackPark(dock).z });

  // ========== Routes ==========

  /** Te voet van de cabine naar het scherm bij het dock: voor de cabines langs en door de chauffeursdeur. */
  function walkIn(dock: Dock): Waypoint[] {
    const z = doorZ(dock);
    const stand = screenStand(dock);
    return [
      { x: OUTSIDE_X, z: dock.z + TRUCK.cabSide }, { x: OUTSIDE_X, z }, { x: X0 - 1, z }, { x: X0 + 1, z },
      { x: INSIDE_X, z }, { x: INSIDE_X, z: stand.z }, stand,
    ];
  }
  const walkOut = (dock: Dock): Waypoint[] => [...walkIn(dock).reverse().slice(1), cab(dock)];

  /**
   * Met de pompwagen naar een punt: eerst terug naar de rijlijn langs de docks, daarlangs naar de juiste hoogte
   * en dan recht de wagen, de baan of de parkeerplek in. @param back achteruit het laatste stuk in (parkeren)
   */
  function drive(d: Driver, target: Point, back = false): Waypoint[] {
    const path: Waypoint[] = [];
    // ligt de rijlijn achter de pompwagen, dan rijdt hij er achteruit naartoe
    if (Math.abs(d.x - INSIDE_X) > 0.01) path.push({ x: INSIDE_X, z: d.z, back: (INSIDE_X - d.x) * Math.sin(d.r) < 0 });
    path.push({ x: INSIDE_X, z: target.z }, { ...target, back });
    return path;
  }

  // ========== Lopen en rijden (bij elke speler) ==========

  function move(d: Driver, dt: number) {
    const wp = d.path[0];
    if (!wp) return;
    const dx = wp.x - d.x;
    const dz = wp.z - d.z;
    const far = Math.hypot(dx, dz);
    if (far > 0.02) {
      const turn = angle(Math.atan2(dx, dz) + (wp.back ? Math.PI : 0), d.r);
      d.r += Math.max(-TURN * dt, Math.min(TURN * dt, turn));
      if (Math.abs(turn) > (d.jack ? 0.3 : 0.9)) return; // de pompwagen draait eerst op zijn plek
      const step = Math.min(far, (d.jack ? JACK_SPEED : WALK) * dt);
      d.x += (dx / far) * step;
      d.z += (dz / far) * step;
      if (step < far) return;
    }
    d.x = wp.x;
    d.z = wp.z;
    d.path.shift();
  }

  // ========== Beslissen (alleen de host) ==========

  function decided(d: Driver) {
    d.v++;
    world.touch();
  }

  function go(d: Driver, phase: DriverPhase, path: Waypoint[] = [], timer = 0) {
    d.phase = phase;
    d.path = path;
    d.timer = timer;
    decided(d);
  }

  /** Een vraag aan de WMS; mislukt hij, dan probeert de chauffeur het na `retry` seconden opnieuw. */
  async function ask(d: Driver, question: () => Promise<boolean>, then: () => void, retry = 15) {
    const before = resets;
    busy.add(d.id);
    const ok = await question();
    busy.delete(d.id);
    if (resets !== before || !drivers.includes(d)) return;
    if (ok) then();
    else d.timer = retry;
  }

  /** Met de pompwagen in de hand: de volgende pallet of order, of klaar. */
  function next(d: Driver) {
    const t = truckOf(d);
    const dock = dockOf(d);
    if (!t) return;
    if (d.load) {
      const slot = world.laneInSlot(d.dock);
      if (slot < 0) return go(d, 'waiting', drive(d, { x: INSIDE_X, z: dock.laneIn.z }), 2); // de baan is vol: even wachten
      d.target = slot;
      return go(d, 'toLane', drive(d, { x: laneSlot(dock.laneIn, slot).x - JACK_REACH, z: dock.laneIn.z }));
    }
    if (d.order) {
      d.target = t.loaded.length;
      const spot = cargoSpot(dock.z, d.target);
      return go(d, 'toTrailer', drive(d, { x: spot.x + JACK_REACH, z: spot.z }));
    }
    if (d.direction === 'in') {
      if (t.cargo.length === 0) return park(d);
      d.target = t.cargo.length - 1; // de achterste pallet eerst
      const spot = cargoSpot(dock.z, d.target);
      return go(d, 'toCargo', drive(d, { x: spot.x + JACK_REACH, z: spot.z }));
    }
    const slot = world.staged(d.dock);
    if (slot >= 0) {
      d.target = slot;
      return go(d, 'toStaged', drive(d, { x: laneSlot(dock.laneOut, slot).x - JACK_REACH, z: dock.laneOut.z }));
    }
    // Niets (meer) klaargezet: weg met wat erin staat, of nog even wachten op de eerste order
    if (t.loaded.length > 0 || d.waited >= MAX_WAIT) return park(d);
    d.waited += 2;
    go(d, 'waiting', drive(d, { x: INSIDE_X, z: dock.laneOut.z }), 2);
  }

  function park(d: Driver) {
    const p = jackPark(dockOf(d));
    go(d, 'parkJack', drive(d, { x: p.x, z: p.z }, true));
  }

  /** De chauffeur is aangekomen of klaar met wachten: de volgende stap. */
  function step(d: Driver) {
    const t = truckOf(d);
    const dock = dockOf(d);
    if (!t) return;
    switch (d.phase) {
      case 'toScreen':
        return go(d, 'checkIn', [], 1.6);
      case 'checkIn':
        return void ask(d, () => world.checkIn(d.id), () => {
          d.door = true;
          go(d, 'opening', [], 2.6);
        });
      case 'opening':
        return go(d, 'toJack', [{ x: jackStand(dock).x, z: d.z }, jackStand(dock)]);
      case 'toJack': {
        // de pompwagen in de hand: vanaf nu is zijn plek die van de pompwagen
        const p = jackPark(dock);
        Object.assign(d, { jack: true, x: p.x, z: p.z, r: p.r });
        return next(d);
      }
      case 'toCargo':
        return go(d, 'lifting', [], 1.2);
      case 'toStaged':
        return go(d, 'lifting', [], 1.2);
      case 'lifting':
        if (d.direction === 'in') d.load = world.takeCargo(d.id);
        else d.order = world.takeStaged(d.dock, d.target);
        return next(d);
      case 'toLane': {
        const pallet = d.load;
        if (!pallet || world.laneInSlot(d.dock) !== d.target) return next(d); // de plek is intussen bezet
        return void ask(d, () => world.received(d.id, pallet, d.target), () => {
          d.load = null;
          go(d, 'dropping', [], 0.9);
        });
      }
      case 'toTrailer': {
        const order = d.order;
        if (!order) return next(d);
        return void ask(d, () => world.loaded(d.id, order), () => {
          d.order = null;
          go(d, 'dropping', [], 0.9);
        });
      }
      case 'dropping':
      case 'waiting':
        return next(d);
      case 'parkJack': {
        // de pompwagen staat weer op zijn plek: te voet verder
        const stand = jackStand(dock);
        Object.assign(d, { jack: false, x: stand.x, z: stand.z });
        return go(d, 'toScreenDone', [{ x: stand.x, z: screenStand(dock).z }, screenStand(dock)]);
      }
      case 'toScreenDone':
        return go(d, 'checkOut', [], 1.6);
      case 'checkOut':
        return void ask(d, () => (d.direction === 'in' ? world.unloadDone(d.id) : world.loadDone(d.id)), () => {
          d.door = false;
          go(d, 'closing', [], 2.6);
        });
      case 'closing':
        return go(d, 'toCab', walkOut(dock));
      case 'toCab':
        return go(d, 'leave');
      case 'leave':
        // Is de wagen afgemeld, dan rijdt hij weg en verdwijnt de chauffeur (zie update)
        return void ask(d, () => world.checkOut(d.id), () => undefined, 30);
    }
  }

  function update(dt: number) {
    for (const d of drivers) move(d, dt);
    if (!world.authority()) return;
    const trucks = world.trucks();
    // Een wagen die aan het dock staat krijgt zijn chauffeur; rijdt de wagen weg, dan is de chauffeur mee
    for (const t of trucks) {
      if ((t.status !== 'waiting' && t.status !== 'checkedIn') || drivers.some((d) => d.id === t.id)) continue;
      const dock = DOCKS[t.dock];
      drivers.push({
        id: t.id, dock: t.dock, direction: t.direction, ...cab(dock), r: -Math.PI / 2,
        phase: 'toScreen', path: walkIn(dock), jack: false, load: null, order: null, door: false, target: 0, timer: 0.8, waited: 0, v: 0,
      });
      world.touch();
    }
    for (let i = drivers.length - 1; i >= 0; i--) {
      const t = trucks.find((x) => x.id === drivers[i].id);
      if (t && (t.status === 'waiting' || t.status === 'checkedIn')) continue;
      drivers.splice(i, 1);
      world.touch();
    }
    for (const d of drivers) {
      if (d.path.length || busy.has(d.id)) continue;
      if (d.timer > 0) d.timer = Math.max(0, d.timer - dt);
      else step(d);
    }
  }

  /** Wat de chauffeur nu doet, in gewone taal. */
  function statusText(d: Driver) {
    const what = d.direction === 'in' ? 'lossen' : 'laden';
    switch (d.phase) {
      case 'toScreen': return 'loopt naar het dock';
      case 'checkIn': return 'meldt zich aan';
      case 'opening': return 'zet de dockdeur open';
      case 'toJack': return 'pakt de pompwagen';
      case 'waiting': return d.direction === 'in' ? 'wacht: de inslagbaan is vol' : 'wacht op klaargezette orders';
      case 'parkJack': return 'zet de pompwagen terug';
      case 'toScreenDone': case 'checkOut': return `meldt: klaar met ${what}`;
      case 'closing': return 'doet de dockdeur dicht';
      case 'toCab': return 'loopt terug naar zijn wagen';
      case 'leave': return 'meldt zich af';
      default: return `is aan het ${what}`;
    }
  }

  return {
    /** De chauffeurs die nu bezig zijn (alleen lezen). */
    drivers: drivers as readonly Driver[],
    update,
    statusText,
    /** De chauffeur aan een dock, of undefined. */
    at: (dock: number) => drivers.find((d) => d.dock === dock),
    /** Voor de gedeelde wereld; alleen ververst als de wereld verandert, zodat het lopen zelf niet als wijziging telt. */
    shared(): Driver[] {
      if (snapshotAt !== world.revision()) {
        snapshotAt = world.revision();
        snapshot = structuredClone(drivers);
      }
      return snapshot;
    },
    /** Neemt de chauffeurs van een andere speler over, per chauffeur alleen als die verder is dan de eigen stand. */
    applyShared(list: Driver[] | undefined) {
      if (!Array.isArray(list)) return;
      for (let i = drivers.length - 1; i >= 0; i--) if (!list.some((s) => s.id === drivers[i].id)) drivers.splice(i, 1);
      for (const s of list) {
        if (!Array.isArray(s.path)) continue;
        const d = drivers.find((x) => x.id === s.id);
        if (!d) drivers.push(structuredClone(s));
        else if (s.v > d.v) Object.assign(d, structuredClone(s), dist(d, s) < 1.5 ? { x: d.x, z: d.z, r: d.r } : null); // niet verspringen
      }
      snapshotAt = -1;
    },
    /** De hal wordt gereset: de chauffeurs beginnen opnieuw bij hun cabine. */
    reset() {
      resets++;
      busy.clear();
      drivers.length = 0;
      snapshotAt = -1;
    },
  };
}

export type Drivers = ReturnType<typeof createDrivers>;
