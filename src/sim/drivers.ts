import { CANTEEN, DOCKS, DOCK_PITCH, HALL, ROOMS, ROOM_DOORS, dist, laneSlot, type Dock, type Point } from './layout';
import type { Pallet } from './warehouse';

// De chauffeurs. Elke vrachtwagen heeft een chauffeur die zelf lost of laadt, zonder hulp van het magazijn:
// hij stapt uit, loopt door de chauffeursdeur de hal in, meldt zich aan op het scherm bij zijn dock, zet de
// dockdeur open, pakt de elektrische pompwagen die bij het dock staat en rijdt de pallets één voor één uit de
// wagen naar de inslagbaan (of de klaargezette orders de wagen in). Daarna zet hij de pompwagen terug, meldt
// op het scherm dat hij klaar is, doet de dockdeur dicht, loopt terug naar zijn cabine en rijdt weg.
// Is een wagen te vroeg, of staat er nog een andere wagen aan zijn dock, dan parkeert hij eerst op een wachtplaats
// op het terrein. De chauffeur loopt naar de kantine, pakt een bekertje koffie en gaat zitten tot hij aan de beurt
// is; dan loopt hij terug en rijdt hij zijn wagen naar het dock.
// Zoals overal in de sim geldt: eerst de WMS, dan fysiek. Multiplayer: iedereen laat de chauffeurs lokaal
// lopen; alleen de host beslist.

export type DriverPhase =
  // koffiepauze: naar de kantine, een bekertje pakken, gaan zitten, en terug naar de wagen op de wachtplaats
  | 'toCanteen' | 'coffee' | 'toSeat' | 'drinking' | 'toTruck' | 'boarding'
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
  /** Wat er op de vorken staat: een pallet uit de wagen (lossen) of de pallet van een order (laden). */
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
  /** Heeft een bekertje koffie in de hand. */
  cup?: boolean;
  /** De stoel in de kantine (index in CANTEEN.seats) waar hij heen loopt of op zit; -1 = geen. */
  seat?: number;
  /** Telt elke beslissing; in multiplayer wint de hoogste stand. */
  v: number;
};

const BREAK: ReadonlySet<DriverPhase> = new Set(['toCanteen', 'coffee', 'toSeat', 'drinking', 'toTruck', 'boarding']);
/** Heeft koffiepauze: zijn wagen staat nog op een wachtplaats, niet aan het dock. */
export const onBreak = (d: Pick<Driver, 'phase'>) => BREAK.has(d.phase);
/** Zit op zijn stoel in de kantine. */
export const seated = (d: Driver) => d.phase === 'drinking' && d.path.length === 0 && (d.seat ?? -1) >= 0;

/** Iets waar een chauffeur voor blijft staan: een speler, de heftruck, een pallet die los op de vloer staat. */
export type DriverObstacle = Point & { rad: number };

export type DriverTruck = {
  id: string;
  dock: number;
  direction: 'in' | 'out';
  /** parking = rijdt naar een wachtplaats; parked = staat daar tot hij naar zijn dock mag. */
  status: 'parking' | 'parked' | 'arriving' | 'waiting' | 'checkedIn' | 'departing';
  /** De wachtplaats (index in WAIT_BAYS) waar hij heen rijdt, staat of vandaan komt. */
  bay?: number;
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
  /** Pakt de pallet van de order op die plek: hij staat daarna op de vorken. */
  takeStaged(dock: number, slot: number): string | null;
  /** Zet de order in de wagen: de WMS boekt het laden. */
  loaded(truckId: string, orderId: string): Promise<boolean>;
  /** 'Klaar met laden' op het scherm. */
  loadDone(truckId: string): Promise<boolean>;
  /** De wagen afmelden: daarna rijdt hij weg. */
  checkOut(truckId: string): Promise<boolean>;
  /**
   * Mag de wagen op de wachtplaats naar zijn dock: is het (bijna) zijn tijd en is het dock vrij? Bij true houdt
   * de wereld het dock voor hem vast en loopt de chauffeur terug naar zijn wagen.
   */
  callToDock(truckId: string): boolean;
  /** De chauffeur zit weer in zijn cabine: de wagen rijdt van de wachtplaats naar zijn dock. */
  driveToDock(truckId: string): void;
}

const X0 = -HALL.w / 2;
/**
 * De vrachtwagen aan het dock: de achterkant van de trailer (x), de hoogte van de laadvloer, en waar de
 * chauffeur uit zijn cabine stapt (x, en hoe ver naast het midden van het dock). clear = de vrije halve breedte
 * tussen de wielkasten in de laadruimte: pallets, de pompwagen en de chauffeur blijven daarbinnen (zie cargoSpot).
 */
export const TRUCK = { rear: X0 - 0.4, floor: 0.45, length: 8, cabX: X0 - 9.7, cabSide: 1.75, clear: 1.06 };
/** De noordrand (z) van het vrachtwagenterrein: voorbij de noordgevel, met ruimte voor de wachtplaatsen. */
export const YARD_NORTH = -HALL.d / 2 - 11.5;
/**
 * De wachtplaatsen op het terrein, in de noordwesthoek (voorbij het eerste dock, aan de overkant van de rijlijn):
 * hier parkeert een wagen die te vroeg is of waarvan het dock nog bezet is. Het punt is de achterkant van de
 * laadbak; de cabine wijst van het gebouw af (-x), net als aan het dock. De rijroutes staan in yard.ts.
 */
export const WAIT_BAYS: Point[] = (() => {
  const edge = YARD_NORTH;
  const bays: Point[] = [];
  // vanaf het vak van het eerste dock naar het noorden, zolang er achter de wagen ruimte is om achteruit weg te draaien
  for (let z = (DOCKS[0]?.z ?? 0) - DOCK_PITCH / 2 - 2; z >= edge + 10.5 && bays.length < 3; z -= 3.2) bays.push({ x: TRUCK.rear - 30.95, z });
  return bays;
})();

/** De laadklep: loopt van de halvloer (x = low) schuin op naar de laadvloer van de wagen (x = high). */
export const DOCK_RAMP = { low: X0 + 2.1, high: X0 - 0.35 };
/** Hoogte van de vloer waar de chauffeur en zijn pompwagen op rijden: de hal, de laadklep of de laadvloer. */
export function dockFloorY(x: number) {
  const t = (DOCK_RAMP.low - x) / (DOCK_RAMP.low - DOCK_RAMP.high);
  return TRUCK.floor * Math.max(0, Math.min(1, t));
}
/**
 * Palletplek i in de wagen: twee naast elkaar, vanaf de kopwand naar achteren. De lange kant van de pallet
 * (1,2 m) ligt in de lengte van de wagen; de korte kant (1,0 m) past zo tussen de wielkasten (TRUCK.clear).
 */
export function cargoSpot(dockZ: number, i: number): Point {
  const row = Math.min(Math.floor(i / 2), 5);
  return { x: TRUCK.rear - TRUCK.length + 0.85 + row * 1.3, z: dockZ + (i % 2 ? 0.52 : -0.52) };
}
/**
 * De chauffeursdeuren in de dockwand (z): één aan elke kant van de rij docks. De zuidelijke blijft vóór het
 * kantoor, dat daar in de hoek van de hal zit.
 */
export const DRIVER_DOORS = [...new Set([(DOCKS[0]?.z ?? 0) - 4.7, (DOCKS[DOCKS.length - 1]?.z ?? 0) + 4.7])]
  .map((z) => Math.max(-HALL.d / 2 + 1.2, Math.min(ROOMS.office.minZ - 0.9, z)));
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
/** Koffiepauze: zo lang (s) duurt het pakken van een bekertje, en zo lang zit hij minstens. */
const COFFEE_SECONDS = 4.5;
const SIT_SECONDS = 12;

const angle = (to: number, from: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

export function createDrivers(world: DriverWorld) {
  const drivers: Driver[] = [];
  /** Chauffeurs voor wie een vraag bij de WMS loopt. */
  const busy = new Set<string>();
  let resets = 0;
  /**
   * Een nieuwe chauffeur begint boven de stand van elke chauffeur die er eerder was: anders houden andere
   * spelers na een reset de oude chauffeur van dezelfde wagen aan, die dan blijft staan waar hij was.
   */
  let floor = 0;
  let snapshot: Driver[] = [];
  let snapshotAt = -1;
  let obstacles: () => DriverObstacle[] = () => [];

  const dockOf = (d: Driver) => DOCKS[d.dock];
  const truckOf = (d: Driver) => world.trucks().find((t) => t.id === d.id);
  const cab = (dock: Dock): Point => ({ x: TRUCK.cabX, z: dock.z + TRUCK.cabSide });
  /** De chauffeursdeur het dichtst bij z. */
  const doorNear = (at: number) => DRIVER_DOORS.reduce((best, z) => (Math.abs(z - at) < Math.abs(best - at) ? z : best));
  const doorZ = (dock: Dock) => doorNear(dock.z);
  const bayOf = (d: Driver) => WAIT_BAYS[truckOf(d)?.bay ?? -1];
  /** Waar de chauffeur uit zijn cabine stapt als de wagen op een wachtplaats staat. */
  const bayCab = (bay: Point): Point => ({ x: bay.x + TRUCK.cabX - TRUCK.rear, z: bay.z + TRUCK.cabSide });
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
   * Te voet van de wachtplaats naar het koffieapparaat: over het terrein voor de cabines langs naar de zuidelijke
   * chauffeursdeur (bij het kantoor), in de hal voor de kamers langs en door de deur van de kantine.
   */
  function toCanteen(bay: Point): Waypoint[] {
    const z = doorNear(HALL.d / 2);
    const door = ROOM_DOORS.canteen.x;
    // de looplijn (z) in de hal, voor de kamers langs: de deur komt daar al op uit
    return [
      { x: OUTSIDE_X, z: bayCab(bay).z }, { x: OUTSIDE_X, z }, { x: X0 - 1, z }, { x: X0 + 1, z }, { x: INSIDE_X, z },
      { x: door, z }, { x: door, z: CANTEEN.front + 1.3 },
      { x: CANTEEN.coffeeStand.x, z: CANTEEN.coffeeStand.z },
    ];
  }
  /** En terug naar de cabine, vanaf waar hij in de kantine zit of staat. */
  function toTruck(d: Driver, bay: Point): Waypoint[] {
    const back = toCanteen(bay).reverse().slice(1);
    return [{ x: CANTEEN.aisleX, z: d.z }, ...back, bayCab(bay)];
  }

  /**
   * Met de pompwagen naar een punt: eerst terug naar de rijlijn langs de docks, daarlangs naar de juiste hoogte
   * en dan recht de wagen, de baan of de parkeerplek in. @param back achteruit het laatste stuk in (parkeren)
   */
  function drive(d: Driver, target: Point, back = false): Waypoint[] {
    // Staat hij al in de wagen of op de baan waar hij moet zijn, dan rijdt hij er recht heen (achteruit als het
    // achter hem ligt) in plaats van eerst terug naar de rijlijn en weer naar binnen.
    if (Math.abs(d.z - target.z) < 0.01 && (d.x - INSIDE_X) * (target.x - INSIDE_X) > 0)
      return [{ ...target, back: back || (target.x - d.x) * Math.sin(d.r) < 0 }];
    const path: Waypoint[] = [];
    // ligt de rijlijn achter de pompwagen, dan rijdt hij er achteruit naartoe
    if (Math.abs(d.x - INSIDE_X) > 0.01) path.push({ x: INSIDE_X, z: d.z, back: (INSIDE_X - d.x) * Math.sin(d.r) < 0 });
    path.push({ x: INSIDE_X, z: target.z }, { ...target, back });
    return path;
  }

  // ========== Lopen en rijden (bij elke speler) ==========

  function move(d: Driver, dt: number, inWay: DriverObstacle[]) {
    const wp = d.path[0];
    if (!wp) return;
    const dx = wp.x - d.x;
    const dz = wp.z - d.z;
    const far = Math.hypot(dx, dz);
    if (far > 0.02) {
      const turn = angle(Math.atan2(dx, dz) + (wp.back ? Math.PI : 0), d.r);
      d.r += Math.max(-TURN * dt, Math.min(TURN * dt, turn));
      if (Math.abs(turn) > (d.jack ? 0.3 : 0.9)) return; // de pompwagen draait eerst op zijn plek
      // Staat er iets of iemand in de weg, dan wacht hij: hij loopt en rijdt nergens doorheen. Met de pompwagen
      // vooruit steekt de pallet voor hem uit; achteruit loopt hij zelf voorop.
      const reach = d.jack ? (wp.back ? 1.3 : 1.5) : 0.55;
      const width = d.jack ? 0.55 : 0.3;
      const blocked = inWay.some((o) => {
        const along = ((o.x - d.x) * dx + (o.z - d.z) * dz) / far;
        const side = ((o.x - d.x) * dz - (o.z - d.z) * dx) / far;
        return along > 0 && along < reach + o.rad && Math.abs(side) < width + o.rad;
      });
      if (blocked) return;
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

  /** Koffiepauze: de volgende stap. Zijn wagen staat op een wachtplaats. */
  function pause(d: Driver) {
    const bay = bayOf(d);
    if (!bay) return;
    switch (d.phase) {
      case 'toCanteen':
        d.r = CANTEEN.coffeeStand.r;
        return go(d, 'coffee', [], COFFEE_SECONDS);
      case 'coffee': {
        // met het bekertje naar een vrije stoel op de hoek van een tafel; is er geen, dan drinkt hij het staand op
        d.cup = true;
        d.seat = CANTEEN.cornerSeats.find((i) => !drivers.some((o) => o !== d && o.seat === i)) ?? -1;
        const seat = CANTEEN.seats[d.seat];
        const path = seat ? [{ x: CANTEEN.aisleX, z: seat.z }, { x: seat.x, z: seat.z }] : [{ x: CANTEEN.aisleX, z: d.z }];
        return go(d, 'toSeat', path);
      }
      case 'toSeat':
        d.r = CANTEEN.seats[d.seat ?? -1]?.r ?? d.r;
        return go(d, 'drinking', [], SIT_SECONDS);
      case 'drinking':
        // Is het zijn tijd en is het dock vrij, dan loopt hij terug; anders blijft hij nog even zitten
        if (!world.callToDock(d.id)) return void (d.timer = 2);
        d.cup = false;
        d.seat = -1;
        return go(d, 'toTruck', toTruck(d, bay));
      case 'toTruck':
        d.r = -Math.PI / 2;
        return go(d, 'boarding', [], 1.2);
      case 'boarding':
        // De wagen rijdt naar zijn dock; daar stapt de chauffeur weer uit (zie update)
        d.timer = 5;
        return world.driveToDock(d.id);
    }
  }

  /** De chauffeur is aangekomen of klaar met wachten: de volgende stap. */
  function step(d: Driver) {
    if (onBreak(d)) return pause(d);
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
        // Niets te pakken (iemand was hem voor): even blijven staan en dan opnieuw kijken, niet meteen wegrijden
        if (!d.load && !d.order) return go(d, 'waiting', [], 1.5);
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
    const inWay = drivers.length ? obstacles() : [];
    for (const d of drivers) move(d, dt, inWay);
    if (!world.authority()) return;
    const trucks = world.trucks();
    // Een wagen die aan het dock staat krijgt zijn chauffeur; rijdt de wagen weg, dan is de chauffeur mee
    // Staat de wagen op een wachtplaats, dan stapt de chauffeur daar uit voor een koffiepauze; rijdt de wagen
    // daarna naar zijn dock, dan is die chauffeur mee en stapt hij aan het dock opnieuw uit.
    const atDock = (t: DriverTruck) => t.status === 'waiting' || t.status === 'checkedIn';
    for (const t of trucks) {
      const bay = t.status === 'parked' ? WAIT_BAYS[t.bay ?? -1] : undefined;
      if ((!atDock(t) && !bay) || drivers.some((d) => d.id === t.id)) continue;
      const dock = DOCKS[t.dock];
      drivers.push({
        id: t.id, dock: t.dock, direction: t.direction, ...(bay ? bayCab(bay) : cab(dock)), r: -Math.PI / 2,
        phase: bay ? 'toCanteen' : 'toScreen', path: bay ? toCanteen(bay) : walkIn(dock),
        jack: false, load: null, order: null, door: false, target: 0, timer: 0.8, waited: 0, cup: false, seat: -1, v: floor,
      });
      world.touch();
    }
    for (let i = drivers.length - 1; i >= 0; i--) {
      const t = trucks.find((x) => x.id === drivers[i].id);
      if (t && (onBreak(drivers[i]) ? t.status === 'parked' : atDock(t))) continue;
      floor = Math.max(floor, drivers[i].v + 1);
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
      case 'toCanteen': return 'loopt naar de kantine';
      case 'coffee': return 'pakt een bekertje koffie';
      case 'toSeat': return 'zoekt een plekje in de kantine';
      case 'drinking': return 'drinkt koffie in de kantine';
      case 'toTruck': case 'boarding': return 'loopt terug naar zijn wagen';
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
    /** Waar de chauffeurs voor blijven staan: spelers, de heftruck, de pompwagen, losse pallets. */
    setObstacles(source: () => DriverObstacle[]) {
      obstacles = source;
    },
    /** De chauffeur die aan een dock bezig is (niet een die nog koffiepauze heeft), of undefined. */
    at: (dock: number) => drivers.find((d) => d.dock === dock && !onBreak(d)),
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
        floor = Math.max(floor, s.v + 1);
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
      for (const d of drivers) floor = Math.max(floor, d.v + 1);
      drivers.length = 0;
      snapshotAt = -1;
    },
  };
}

export type Drivers = ReturnType<typeof createDrivers>;
