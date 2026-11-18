import { FURNITURE, HALL, type Point, type Pose, type Rect } from './layout';
import { ROAD } from './yard';

// De kantoormedewerkers. Vier collega's werken op het kantoor; er is er altijd minstens één met de auto weg, zodat
// er een bureau en een parkeervak vrij blijven. Ze komen aan met de auto, parkeren voor de deur, lopen door de
// entree en langs de parkeerplaats van de heftruck naar het kantoor (in de hal, tegen de voorgevel) en gaan achter een bureau zitten. Tussendoor halen ze
// koffie in de kantine (vaak) of pakken ze hun lunch uit de koelkast en eten die aan tafel op (af en toe). Na een
// tijd loopt er weer een naar zijn auto en rijdt weg; pas als die van het terrein is, komt de ander terug.
// Alleen aankleding: ze doen niets in de WMS. In multiplayer laat alleen de host ze lopen; hij stuurt hun stand
// rond (snapshot) en de andere spelers volgen die (follow). Wordt een ander host, dan neemt die de stand over (adopt).

/** De entree in de zuidgevel: hierdoor komen de kantoormedewerkers de hal in. */
export const ENTRANCE = { x: FURNITURE.exitDoor.x, z: HALL.d / 2 };

/** Het parkeerterrein voor de zuidgevel: één rij vakken met de neus naar het gebouw, een rijbaan en een inrit naar de weg. */
export const CAR_PARK = (() => {
  const pitch = 2.6;
  const count = 10;
  const minZ = HALL.d / 2 + 8;
  const maxX = ENTRANCE.x + 7.5;
  const minX = maxX - count * pitch - 1;
  const area: Rect = { minX, maxX, minZ, maxZ: minZ + 12 };
  const driveX = minX + 5;
  return {
    area,
    /** Het midden van elk vak. */
    bays: Array.from({ length: count }, (_, i): Point => ({ x: minX + 0.5 + (i + 0.5) * pitch, z: minZ + 2.7 })),
    /** De lijnen (x) tussen de vakken, 5 m lang vanaf de stoep. */
    lines: Array.from({ length: count + 1 }, (_, i) => minX + 0.5 + i * pitch),
    /** Het hart (z) van de rijbaan achter de vakken. */
    laneZ: minZ + 8.6,
    /** De inrit naar de weg: 8 m breed rond driveX. */
    driveX,
    drive: { minX: driveX - 4, maxX: driveX + 4 },
    /** Het hart (z) van de openbare weg (zie yard.ts). */
    roadZ: ROAD.z,
    /** De vakken van de kantoormedewerkers (bij de entree) en de vakken waar altijd een auto staat. */
    staffBays: [4, 5, 6, 7],
    parked: [0, 2, 9],
  };
})();

/** Waar de kamers staan; ingevuld door de hal (src/ui/scene/rooms.ts). Een stoel: x, z en de kijkrichting als je zit. */
export interface StaffSite {
  /** De lijn (z) in de hal voor de deuren van kantoor en kantine langs. */
  frontZ: number;
  office: {
    /** Midden (x) van de deur naar de hal, en z net binnen de kamer. */
    door: number;
    inZ: number;
    /** Het gangpad (x) tussen de bureaus. */
    aisle: number;
    desks: Pose[];
  };
  canteen: {
    door: number;
    inZ: number;
    /** Waar je staat voor het koffieapparaat, de koelkast en de spoelbak. */
    coffee: Pose;
    fridge: Pose;
    sink: Pose;
    seats: Pose[];
  };
  /** Zit er een speler op deze bureaustoel of kantinestoel? */
  deskBusy(i: number): boolean;
  seatBusy(i: number): boolean;
}

export type StaffAct = 'away' | 'drive' | 'alight' | 'board' | 'walk' | 'work' | 'machine' | 'fridge' | 'eat' | 'sink';
export type StaffCar = {
  /** Staat of rijdt op het terrein of de weg; false = weg. */
  here: boolean;
  x: number;
  z: number;
  /** Rijrichting van de neus (rad). */
  r: number;
  v: number;
};
export type Staff = {
  id: number;
  x: number;
  z: number;
  r: number;
  /** Wat hij nu doet; 'walk' zolang hij onderweg is. */
  act: StaffAct;
  /** Seconden dat hij al met deze handeling bezig is. */
  busy: number;
  /** De stoel waar hij op zit, anders null. */
  seat: Pose | null;
  /** Zit in zijn auto (of is weg): niet te zien. */
  inCar: boolean;
  /** Zijn koffiebeker: in de hand of op zijn bureau. */
  cup: 'none' | 'hand' | 'desk';
  /** Zijn lunchtrommel: in de hand of voor hem op tafel. */
  lunch: 'none' | 'hand' | 'table';
  /** Zijn bureau (index in site.office.desks), of -1. */
  desk: number;
  car: StaffCar;
};

export type StaffObstacle = Point & { rad: number };

/** Soort plek: zo weet een nieuwe host wat iemand daar aan het doen was. */
type SpotKind = 'desk' | 'coffee' | 'fridge' | 'sink' | 'table' | 'lot';
/** Een plek waar hij staat, met de route van daar naar de lijn in de hal voor de kamers langs. */
type Spot = { out: Point[]; r: number; k: SpotKind; i: number };
type Step = {
  /** Loopt eerst hierheen. */
  to?: Spot;
  act: StaffAct;
  /** Zo lang (s) duurt de handeling; of tot `done` waar is. */
  s?: number;
  done?: () => boolean;
  begin?: () => void;
  end?: () => void;
};
type Leg = { pts: Point[]; at: number[]; back: boolean; exit?: boolean };
type Member = Staff & {
  path: Point[];
  spot: Spot;
  queue: Step[];
  step: Step | null;
  left: number;
  blocked: number;
  side: number;
  /** Seconden tot hij weer trek heeft. */
  hungry: number;
  /** Seconden die hij nog wegblijft. */
  awayFor: number;
  /** Seconden sinds hij aankwam. */
  present: number;
  leaving: boolean;
  seatIndex: number;
  bay: number;
  legs: Leg[];
  leg: number;
  dist: number;
  pause: number;
};

/**
 * De stand van één collega zoals de host hem rondstuurt. seat: 'd3' = bureau 3, 't1' = kantinestoel 1, '' = staat.
 * Kort gehouden: dit gaat een paar keer per seconde over de lijn.
 */
export type StaffNet = {
  id: number; x: number; z: number; r: number; act: StaffAct; busy: number; seat: string; inCar: boolean;
  cup: Staff['cup']; lunch: Staff['lunch']; desk: number; ti: number; leaving: boolean; away: number; hungry: number; present: number;
  car: StaffCar;
};

const ACTS: readonly StaffAct[] = ['away', 'drive', 'alight', 'board', 'walk', 'work', 'machine', 'fridge', 'eat', 'sink'];
const WALK = 1.45;
const TURN = 5;
/** Zo lang (s) werkt iemand achter elkaar door voor hij koffie haalt of gaat eten. */
const WORK: [number, number] = [70, 160];
const LUNCH_EVERY: [number, number] = [420, 660];
const AWAY: [number, number] = [240, 420];
const ROAD_SPEED = 14;
const LOT_SPEED = 3.5;
const REVERSE_SPEED = 1.7;

const between = ([a, b]: [number, number]) => a + Math.random() * (b - a);
const angle = (to: number, from: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const same = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
/** De plek achter een stoel: daar sta je voor je gaat zitten en na het opstaan. */
export const behindSeat = (s: Pose): Point => ({ x: s.x - Math.sin(s.r) * 0.6, z: s.z - Math.cos(s.r) * 0.6 });

/** Een lijn door de punten met afgeronde bochten, in korte stukjes. */
function rounded(pts: Point[], radius: number): Point[] {
  const out: Point[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, p, b] = [pts[i - 1], pts[i], pts[i + 1]];
    const la = Math.hypot(a.x - p.x, a.z - p.z);
    const lb = Math.hypot(b.x - p.x, b.z - p.z);
    const d = Math.min(radius, la / 2, lb / 2);
    const from = { x: p.x + ((a.x - p.x) / la) * d, z: p.z + ((a.z - p.z) / la) * d };
    const to = { x: p.x + ((b.x - p.x) / lb) * d, z: p.z + ((b.z - p.z) / lb) * d };
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      const u = 1 - t;
      out.push({ x: u * u * from.x + 2 * u * t * p.x + t * t * to.x, z: u * u * from.z + 2 * u * t * p.z + t * t * to.z });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function leg(pts: Point[], radius: number, back = false, exit = false): Leg {
  const line = rounded(pts, radius);
  const at = [0];
  for (let i = 1; i < line.length; i++) at.push(at[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z));
  return { pts: line, at, back, exit };
}

/** Het punt op `s` meter langs de rijlijn. */
function along(l: Leg, s: number): Point {
  const total = l.at[l.at.length - 1];
  s = Math.max(0, Math.min(total, s));
  let i = 1;
  while (i < l.at.length - 1 && l.at[i] < s) i++;
  const t = (s - l.at[i - 1]) / Math.max(1e-6, l.at[i] - l.at[i - 1]);
  return { x: l.pts[i - 1].x + (l.pts[i].x - l.pts[i - 1].x) * t, z: l.pts[i - 1].z + (l.pts[i].z - l.pts[i - 1].z) * t };
}

const { area, laneZ, driveX, roadZ } = CAR_PARK;
/** Rechts rijden: naar het westen op de rijstrook aan de kant van het terrein; de inrit in aan de oostkant, uit aan de westkant. */
const ROAD_LANE = ROAD.westZ;
const IN_X = driveX + 2;
const OUT_X = driveX - 2;
/** Zo ver (m) over de weg komt een auto aanrijden en rijdt hij weg: tot in de mist. */
const FAR = 260;

/** De auto komt van het oosten over de weg, draait de inrit in en rijdt vooruit zijn vak in. */
const routeIn = (bay: Point): Leg[] => [
  leg([{ x: IN_X + FAR, z: ROAD_LANE }, { x: IN_X, z: ROAD_LANE }, { x: IN_X, z: laneZ }, { x: bay.x, z: laneZ }, bay], 3.6),
];
/** Achteruit het vak uit met de achterkant naar het oosten, dan vooruit naar de inrit en over de weg naar het westen. */
const routeOut = (bay: Point): Leg[] => [
  leg([bay, { x: bay.x, z: laneZ }, { x: bay.x + 4.6, z: laneZ }], 3.6, true),
  leg([{ x: bay.x + 4.6, z: laneZ }, { x: OUT_X, z: laneZ }, { x: OUT_X, z: ROAD_LANE }, { x: OUT_X - FAR, z: ROAD_LANE }], 3.6, false, true),
];

export function createStaff(site: StaffSite) {
  /** De lijn (z) in de hal waar de deuren van kantoor en kantine op uitkomen: tussen de stellingen en de kamers door. */
  const FRONT = site.frontZ;
  const { office, canteen } = site;

  // ========== Plekken en routes ==========

  function deskSpot(i: number): Spot {
    const s = office.desks[i];
    const b = behindSeat(s);
    return { k: 'desk', i, r: s.r, out: [b, { x: office.aisle, z: b.z }, { x: office.aisle, z: office.inZ + 0.3 }, { x: office.door, z: office.inZ }, { x: office.door, z: FRONT }] };
  }
  const canteenSpot = (p: Point, r: number, k: SpotKind, i = 0): Spot => ({ k, i, r, out: [p, { x: canteen.door, z: p.z }, { x: canteen.door, z: FRONT }] });
  const tableSpot = (i: number) => canteenSpot(behindSeat(canteen.seats[i]), canteen.seats[i].r, 'table', i);
  /** Naast het portier van zijn auto; van daar tussen de auto's door naar de stoep, de entree in en naar de lijn voor de kamers. */
  function lotSpot(bay: Point): Spot {
    return {
      k: 'lot',
      i: 0,
      r: Math.PI / 2,
      out: [
        { x: bay.x - 1.2, z: bay.z + 0.3 }, { x: bay.x - 1.3, z: area.minZ - 1 }, { x: ENTRANCE.x, z: ENTRANCE.z + 2.6 }, { x: ENTRANCE.x, z: ENTRANCE.z - 1.2 },
        { x: ENTRANCE.x, z: FRONT }, // over het looppad: van de entree recht de hal in, dan voor de kamers langs
      ],
    };
  }
  /** De looproute van de ene plek naar de andere: het stuk dat ze delen valt weg. */
  function route(a: Point[], b: Point[]): Point[] {
    let i = a.length;
    let j = b.length;
    while (i > 1 && j > 1 && same(a[i - 1], b[j - 1])) {
      i--;
      j--;
    }
    return [...a.slice(1, i), ...b.slice(0, j).reverse()];
  }

  // ========== De collega's ==========

  const bayOf = (id: number) => CAR_PARK.bays[CAR_PARK.staffBays[id % CAR_PARK.staffBays.length]];
  const staff = [0, 1, 2, 3].map((id): Member => {
    const bay = bayOf(id);
    const present = id < 3 && id < office.desks.length;
    const spot = present ? deskSpot(id) : lotSpot(bay);
    const seat = present ? office.desks[id] : null;
    return {
      id, x: seat?.x ?? bay.x, z: seat?.z ?? bay.z, r: seat?.r ?? 0, act: present ? 'work' : 'away', busy: 0, seat, inCar: !present,
      cup: present && id !== 1 ? 'desk' : 'none', lunch: 'none', desk: present ? id : -1,
      car: { here: present, x: bay.x, z: bay.z, r: Math.PI, v: 0 },
      path: [], spot, queue: [], step: null, left: 0, blocked: 0, side: 1,
      hungry: [200, 480, 60, 600][id], awayFor: present ? 0 : 45, present: [300, 200, 100, 0][id], leaving: false, seatIndex: -1, bay: id,
      legs: [], leg: 0, dist: 0, pause: 0,
    };
  });
  for (const m of staff) if (m.seat) plan(m, [{ act: 'work', s: 20 + m.id * 35, end: () => afterWork(m) }]);

  let obstacles: () => StaffObstacle[] = () => [];

  function plan(m: Member, steps: Step[]) {
    m.queue = steps;
  }

  function sit(m: Member, seat: Pose) {
    m.seat = seat;
    Object.assign(m, { x: seat.x, z: seat.z, r: seat.r });
  }
  function stand(m: Member) {
    if (!m.seat) return;
    const b = behindSeat(m.seat);
    m.seat = null;
    Object.assign(m, { x: b.x, z: b.z });
  }

  const freeDesk = (m: Member) => {
    const free = (i: number) => !site.deskBusy(i) && !staff.some((o) => o !== m && o.desk === i);
    if (m.desk >= 0 && free(m.desk)) return m.desk;
    return office.desks.findIndex((_, i) => free(i));
  };
  const freeSeat = (m: Member) => {
    const free = canteen.seats.map((_, i) => i).filter((i) => !site.seatBusy(i) && !staff.some((o) => o !== m && o.seatIndex === i));
    return free.length ? free[Math.floor(Math.random() * free.length)] : -1;
  };

  /** Naar zijn bureau en aan het werk. Is er geen bureau vrij (spelers zitten erop), dan haalt hij eerst koffie. */
  function toDesk(m: Member): Step[] {
    const d = freeDesk(m);
    if (d < 0) {
      m.desk = -1;
      return coffee(m);
    }
    m.desk = d;
    return [
      {
        to: deskSpot(d), act: 'walk',
        end: () => {
          // is er intussen een speler gaan zitten, dan zoekt hij een ander bureau
          if (site.deskBusy(d)) {
            m.desk = -1;
            return plan(m, toDesk(m));
          }
          sit(m, office.desks[d]);
          if (m.cup === 'hand') m.cup = 'desk';
        },
      },
      { act: 'work', s: between(WORK), end: () => afterWork(m) },
    ];
  }

  /** Koffie halen: met zijn beker naar het apparaat in de kantine en terug naar zijn bureau. */
  function coffee(m: Member): Step[] {
    return [
      {
        to: canteenSpot(canteen.coffee, canteen.coffee.r, 'coffee'), act: 'machine', s: 4.5,
        begin: () => {
          if (m.cup === 'desk') m.cup = 'hand';
        },
        end: () => {
          m.cup = 'hand';
          plan(m, toDesk(m));
        },
      },
    ];
  }

  /** Eten: de lunch uit de koelkast pakken, aan een tafel in de kantine opeten, opruimen bij de spoelbak. */
  function lunch(m: Member): Step[] {
    const t = freeSeat(m);
    if (t < 0) return coffee(m);
    m.seatIndex = t;
    const clear = clearUp(m);
    return [
      { to: canteenSpot(canteen.fridge, canteen.fridge.r, 'fridge'), act: 'fridge', s: 3.4, end: () => (m.lunch = 'hand') },
      {
        to: tableSpot(t), act: 'walk',
        end: () => {
          if (site.seatBusy(t)) {
            // een speler zit op zijn plek: een andere stoel, of anders staand opeten bij het aanrecht
            const other = freeSeat(m);
            m.seatIndex = other;
            if (other < 0) return plan(m, [clear]);
            return plan(m, eatAt(m, other, clear));
          }
          plan(m, eatAt(m, t, clear).slice(1));
          sit(m, canteen.seats[t]);
          m.lunch = 'table';
        },
      },
    ];
  }
  /** De lunchtrommel omspoelen bij de spoelbak, en terug naar zijn bureau. */
  function clearUp(m: Member): Step {
    return {
      to: canteenSpot(canteen.sink, canteen.sink.r, 'sink'), act: 'sink', s: 2.5,
      end: () => {
        m.lunch = 'none';
        m.hungry = between(LUNCH_EVERY);
        plan(m, toDesk(m));
      },
    };
  }
  function eatAt(m: Member, t: number, clear: Step): Step[] {
    return [
      {
        to: tableSpot(t), act: 'walk',
        end: () => {
          sit(m, canteen.seats[t]);
          m.lunch = 'table';
        },
      },
      {
        act: 'eat', s: between([35, 55]),
        end: () => {
          stand(m);
          m.lunch = 'hand';
          m.seatIndex = -1;
        },
      },
      clear,
    ];
  }

  /** Naar zijn auto en weg. */
  function leave(m: Member): Step[] {
    return [
      {
        to: lotSpot(bayOf(m.bay)), act: 'board', s: 1.6,
        begin: () => {
          m.cup = 'none';
          m.desk = -1;
        },
        end: () => {
          m.inCar = true;
          m.legs = routeOut(bayOf(m.bay));
          m.leg = m.dist = 0;
        },
      },
      {
        act: 'drive', done: () => m.leg >= m.legs.length,
        end: () => {
          m.car.here = false;
          m.leaving = false;
          m.awayFor = between(AWAY);
          m.act = 'away'; // meteen: anders stuurt de planning in deze tel nog iemand weg
          plan(m, [{ act: 'away', done: () => false }]);
        },
      },
    ];
  }

  /** Komt terug: rijdt het terrein op, parkeert, stapt uit en loopt naar het kantoor. */
  function arrive(m: Member) {
    const bay = bayOf(m.bay);
    m.legs = routeIn(bay);
    m.leg = m.dist = 0;
    m.present = 0;
    m.car.here = true;
    m.car.v = ROAD_SPEED;
    placeCar(m);
    m.step = null;
    plan(m, [
      { act: 'drive', done: () => m.leg >= m.legs.length },
      {
        act: 'alight', s: 1.4,
        begin: () => {
          m.spot = lotSpot(bay);
          Object.assign(m, { x: m.spot.out[0].x, z: m.spot.out[0].z, r: m.spot.r, inCar: false });
        },
        end: () => plan(m, toDesk(m)),
      },
    ]);
  }

  function afterWork(m: Member) {
    stand(m);
    plan(m, m.leaving ? leave(m) : m.hungry <= 0 ? lunch(m) : coffee(m));
  }

  // ========== Rijden ==========

  function placeCar(m: Member) {
    const l = m.legs[m.leg];
    if (!l) return;
    const p = along(l, m.dist);
    const a = along(l, m.dist - 0.7);
    const b = along(l, m.dist + 0.7);
    Object.assign(m.car, { x: p.x, z: p.z, r: Math.atan2(b.x - a.x, b.z - a.z) + (l.back ? Math.PI : 0) });
  }

  function drive(m: Member, dt: number, inWay: StaffObstacle[]) {
    const l = m.legs[m.leg];
    if (!l) return;
    if (m.pause > 0) return void (m.pause -= dt);
    const total = l.at[l.at.length - 1];
    const limit = (s: number) => (l.back ? REVERSE_SPEED : along(l, s).z > roadZ - 4.5 ? ROAD_SPEED : LOT_SPEED);
    let target = Math.min(limit(m.dist), limit(m.dist + 16));
    // aan het eind van de rijlijn staat hij stil, behalve als die het terrein af loopt
    if (!l.exit) target = Math.min(target, Math.max(0.4, Math.sqrt(2 * 1.6 * (total - m.dist))));
    // Loopt er iemand voor de auto (of erachter bij het achteruitrijden), dan stopt hij
    const dir = l.back ? -1 : 1;
    const fx = Math.sin(m.car.r) * dir;
    const fz = Math.cos(m.car.r) * dir;
    const reach = 3.2 + m.car.v * 0.9;
    if (inWay.some((o) => {
      const ahead = (o.x - m.car.x) * fx + (o.z - m.car.z) * fz;
      const aside = (o.x - m.car.x) * fz - (o.z - m.car.z) * fx;
      return ahead > 0 && ahead < reach + o.rad && Math.abs(aside) < 1.1 + o.rad;
    })) target = 0;
    m.car.v += Math.max(-8 * dt, Math.min(2.2 * dt, target - m.car.v));
    m.dist = Math.min(total, m.dist + m.car.v * dt);
    placeCar(m);
    if (m.dist < total) return;
    m.leg++;
    m.dist = 0;
    m.car.v = 0;
    m.pause = 0.7; // even stilstaan: schakelen, of de motor uit
    if (m.leg < m.legs.length) placeCar(m);
  }

  // ========== Lopen ==========

  function walk(m: Member, dt: number, inWay: StaffObstacle[]) {
    const wp = m.path[0];
    const dx = wp.x - m.x;
    const dz = wp.z - m.z;
    const far = Math.hypot(dx, dz);
    if (far > 0.02) {
      const turn = angle(Math.atan2(dx, dz), m.r);
      m.r += Math.max(-TURN * dt, Math.min(TURN * dt, turn));
      if (Math.abs(turn) > 0.9) return;
      // Staat er iets of iemand in de weg, dan wacht hij even. In de hal stapt hij er daarna omheen; blijft de weg
      // lang dicht (iemand staat in de deur), dan wringt hij zich er uiteindelijk langs.
      const stuck =
        m.blocked < 15 &&
        inWay.some((o) => {
          const ahead = ((o.x - m.x) * dx + (o.z - m.z) * dz) / far;
          const aside = ((o.x - m.x) * dz - (o.z - m.z) * dx) / far;
          return ahead > 0 && ahead < 0.6 + o.rad && Math.abs(aside) < 0.3 + o.rad;
        });
      if (stuck) {
        m.blocked += dt;
        const inHall = Math.abs(m.x) < HALL.w / 2 - 2.5 && Math.abs(m.z) < HALL.d / 2 - 2.5;
        if (m.blocked > 2 && inHall && far > 3 && m.path.length < 40) {
          // twee passen opzij en er schuin langs, om en om links en rechts
          m.side = -m.side;
          const [fx, fz] = [dx / far, dz / far];
          const [sx, sz] = [fz * m.side, -fx * m.side];
          m.path.unshift({ x: m.x + sx * 1.4, z: m.z + sz * 1.4 }, { x: m.x + sx * 1.4 + fx * 2.8, z: m.z + sz * 1.4 + fz * 2.8 });
          m.blocked = 0.5;
        }
        return;
      }
      const step = Math.min(far, WALK * dt);
      m.x += (dx / far) * step;
      m.z += (dz / far) * step;
      if (step < far) return;
    }
    m.x = wp.x;
    m.z = wp.z;
    m.blocked = 0;
    m.path.shift();
  }

  // ========== Multiplayer: de host stuurt, de anderen volgen ==========

  const r2 = (n: number) => Math.round(n * 100) / 100;
  function seatRef(m: Member) {
    if (!m.seat) return '';
    const d = office.desks.indexOf(m.seat);
    if (d >= 0) return `d${d}`;
    const t = canteen.seats.indexOf(m.seat);
    return t >= 0 ? `t${t}` : '';
  }
  function seatOf(ref: string): Pose | null {
    const i = Number(ref.slice(1));
    if (ref[0] === 'd') return office.desks[i] ?? null;
    if (ref[0] === 't') return canteen.seats[i] ?? null;
    return null;
  }

  /** De stand van alle collega's, om rond te sturen. */
  function snapshot(): StaffNet[] {
    return staff.map((m) => ({
      id: m.id, x: r2(m.x), z: r2(m.z), r: r2(m.r), act: m.act, busy: r2(m.busy), seat: seatRef(m), inCar: m.inCar,
      cup: m.cup, lunch: m.lunch, desk: m.desk, ti: m.seatIndex, leaving: m.leaving, away: Math.round(m.awayFor), hungry: Math.round(m.hungry),
      present: Math.round(m.present), car: { here: m.car.here, x: r2(m.car.x), z: r2(m.car.z), r: r2(m.car.r), v: r2(m.car.v) },
    }));
  }

  /** Waar de host ze laat staan; hier schuiven ze vloeiend naartoe. */
  const goal = new Map<number, { x: number; z: number; r: number; car: { x: number; z: number; r: number } }>();
  const fin = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const index = (v: unknown, length: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < length ? (v as number) : -1);
  const lerpAngle = (a: number, b: number, t: number) => a + angle(b, a) * t;

  /**
   * Neemt de stand van de host over (de broker is publiek: alles wordt gecontroleerd). Wie ver weg staat of gaat
   * zitten, staat er meteen; de rest schuift er in track() naartoe.
   */
  function follow(data: unknown) {
    if (!Array.isArray(data)) return;
    for (const n of data as Partial<StaffNet>[]) {
      if (!n || typeof n !== 'object') continue;
      const m = staff.find((s) => s.id === n.id);
      if (!m) continue;
      const car: Partial<StaffCar> = typeof n.car === 'object' && n.car ? n.car : m.car;
      const g = {
        x: fin(n.x, m.x), z: fin(n.z, m.z), r: fin(n.r, m.r),
        car: { x: fin(car.x, m.car.x), z: fin(car.z, m.car.z), r: fin(car.r, m.car.r) },
      };
      goal.set(m.id, g);
      if (n.act && ACTS.includes(n.act)) m.act = n.act;
      m.busy = fin(n.busy, m.busy);
      m.seat = typeof n.seat === 'string' ? seatOf(n.seat) : null;
      m.inCar = n.inCar === true;
      if (n.cup === 'none' || n.cup === 'hand' || n.cup === 'desk') m.cup = n.cup;
      if (n.lunch === 'none' || n.lunch === 'hand' || n.lunch === 'table') m.lunch = n.lunch;
      m.desk = index(n.desk, office.desks.length);
      m.seatIndex = index(n.ti, canteen.seats.length);
      m.leaving = n.leaving === true;
      m.awayFor = fin(n.away, m.awayFor);
      m.hungry = fin(n.hungry, m.hungry);
      m.present = fin(n.present, m.present);
      m.car.here = car.here === true;
      m.car.v = fin(car.v, 0);
      if (Math.hypot(g.x - m.x, g.z - m.z) > 3 || m.seat || m.inCar) Object.assign(m, { x: g.x, z: g.z, r: g.r });
      if (Math.hypot(g.car.x - m.car.x, g.car.z - m.car.z) > 20) Object.assign(m.car, g.car);
    }
  }

  /** Per frame zolang we de host volgen: naar de laatst ontvangen stand schuiven, zelf niets beslissen. */
  function track(dt: number) {
    const t = Math.min(1, dt * 8);
    for (const m of staff) {
      m.busy += dt;
      const g = goal.get(m.id);
      if (!g) continue;
      m.x += (g.x - m.x) * t;
      m.z += (g.z - m.z) * t;
      m.r = lerpAngle(m.r, g.r, t);
      m.car.x += (g.car.x - m.car.x) * t;
      m.car.z += (g.car.z - m.car.z) * t;
      m.car.r = lerpAngle(m.car.r, g.car.r, t);
    }
  }

  /**
   * We worden zelf host: verder vanaf de stand die we van de vorige host kregen. Wie onderweg was, gaat verder
   * vanaf de dichtstbijzijnde plek (een klein sprongetje, alleen op het moment van de wissel).
   */
  function adopt() {
    for (const m of staff) {
      const g = goal.get(m.id);
      if (g) {
        Object.assign(m, { x: g.x, z: g.z, r: g.r });
        Object.assign(m.car, g.car);
      }
      Object.assign(m, { path: [], step: null, queue: [], legs: [], leg: 0, dist: 0, pause: 0, blocked: 0 });
      m.car.v = 0;
      const bay = bayOf(m.bay);
      m.spot = lotSpot(bay);
      if (m.act === 'away' || !m.car.here || (m.inCar && m.leaving)) {
        // weg, of al aan het wegrijden: dan is hij nu weg
        Object.assign(m, { act: 'away', inCar: true, seat: null, desk: -1, seatIndex: -1, cup: 'none', lunch: 'none', leaving: false });
        m.car.here = false;
        if (m.awayFor <= 0) m.awayFor = between(AWAY);
        plan(m, [{ act: 'away', done: () => false }]);
        continue;
      }
      if (m.inCar) {
        // was aan het aankomen: de auto staat in zijn vak en hij stapt uit
        Object.assign(m.car, { x: bay.x, z: bay.z, r: Math.PI });
        plan(m, [{
          act: 'alight', s: 1.4,
          begin: () => Object.assign(m, { x: m.spot.out[0].x, z: m.spot.out[0].z, r: m.spot.r, inCar: false }),
          end: () => plan(m, toDesk(m)),
        }]);
        continue;
      }
      const desk = m.seat ? office.desks.indexOf(m.seat) : -1;
      const table = m.seat ? canteen.seats.indexOf(m.seat) : -1;
      if (desk >= 0) {
        m.desk = desk;
        m.spot = deskSpot(desk);
        plan(m, [{ act: 'work', s: m.leaving ? 1.5 : between(WORK) / 2, end: () => afterWork(m) }]);
        continue;
      }
      if (table >= 0) {
        m.seatIndex = table;
        m.spot = tableSpot(table);
        plan(m, eatAt(m, table, clearUp(m)).slice(1));
        continue;
      }
      // Staat of loopt: naar de dichtstbijzijnde plek en verder met wat daar hoort
      m.seat = null;
      const spots = [
        ...office.desks.map((_, i) => deskSpot(i)),
        canteenSpot(canteen.coffee, canteen.coffee.r, 'coffee'),
        canteenSpot(canteen.fridge, canteen.fridge.r, 'fridge'),
        canteenSpot(canteen.sink, canteen.sink.r, 'sink'),
        lotSpot(bay),
      ];
      const far = (s: Spot) => Math.hypot(s.out[0].x - m.x, s.out[0].z - m.z);
      const spot = spots.reduce((a, b) => (far(b) < far(a) ? b : a));
      m.spot = spot;
      Object.assign(m, { x: spot.out[0].x, z: spot.out[0].z, r: spot.r });
      if (m.leaving) plan(m, leave(m));
      else if (spot.k === 'coffee') plan(m, coffee(m));
      else if (spot.k === 'fridge' && m.lunch === 'none') plan(m, lunch(m));
      else if (spot.k === 'sink' || m.lunch !== 'none') plan(m, [clearUp(m)]);
      else plan(m, toDesk(m));
    }
    goal.clear();
  }

  // ========== Per frame ==========

  function advance(m: Member, dt: number, inWay: StaffObstacle[]) {
    if (!m.step) {
      const next = m.queue.shift();
      if (!next) return;
      m.step = next;
      next.begin?.();
      if (next.to) {
        m.path = route(m.spot.out, next.to.out);
        m.spot = next.to;
      }
      m.left = next.s ?? 0;
      m.busy = 0;
    }
    const s = m.step;
    if (m.path.length) {
      m.act = 'walk';
      return walk(m, dt, inWay);
    }
    // aangekomen: eerst met zijn gezicht naar wat hij gaat doen
    if (s.to && !m.seat) {
      const turn = angle(s.to.r, m.r);
      if (Math.abs(turn) > 0.05) {
        m.r += Math.max(-TURN * dt, Math.min(TURN * dt, turn));
        return;
      }
    }
    m.act = s.act;
    m.busy += dt;
    if (s.act === 'drive') drive(m, dt, inWay);
    if (s.done ? !s.done() : (m.left -= dt) > 0) return;
    m.step = null;
    s.end?.();
  }

  function update(dt: number) {
    const inWay = obstacles();
    for (const m of staff) {
      m.hungry -= dt;
      m.present += dt;
      if (m.act === 'away') m.awayFor -= dt;
      advance(m, dt, inWay);
    }
    // Er is altijd iemand weg. Is zijn tijd om, dan gaat eerst een ander weg (wie er het langst is en aan zijn
    // bureau zit); pas als die van het terrein is, komt hij terug. Zo blijft er altijd een vak en een bureau vrij.
    const away = staff.filter((m) => m.act === 'away');
    const due = away.find((m) => m.awayFor <= 0);
    if (!due) return;
    if (away.length >= 2) return arrive(due);
    if (staff.some((m) => m.leaving)) return;
    const next = staff.filter((m) => m.act === 'work' && m.seat).sort((a, b) => b.present - a.present)[0];
    if (!next) return;
    next.leaving = true;
    next.left = Math.min(next.left, 1.5); // hij rondt af en staat op
  }

  return {
    /** De collega's (alleen lezen). */
    staff: staff as readonly Staff[],
    update,
    snapshot,
    follow,
    track,
    adopt,
    /** Waar ze voor blijven staan: spelers, de heftruck, de pompwagen, losse pallets. */
    setObstacles(source: () => StaffObstacle[]) {
      obstacles = source;
    },
    /** Staat de koelkast open? */
    fridgeOpen: () => staff.some((m) => m.act === 'fridge' && m.busy > 0.3 && m.busy < 2.8),
    /** Is dit bureau of deze kantinestoel van een collega (hij zit er, of komt er zo weer zitten)? */
    deskTaken: (i: number) => staff.some((m) => m.desk === i),
    seatTaken: (i: number) => staff.some((m) => m.seatIndex === i),
  };
}

export type StaffSim = ReturnType<typeof createStaff>;
