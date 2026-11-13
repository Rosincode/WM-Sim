import type { ProcessEvent } from './events';
import { AISLE_Z, HALL, LEVEL_Y, ROW_AISLE, ROW_Z, SECTION_PITCH, SECTION_X, dist, type Point } from './layout';
import type { Pallet } from './warehouse';
import type { WmsReply } from './wms';

// De Geek+-robots. Er zijn vier soorten:
// - de tilrobot (lift): een lage robot die onder een pallet rijdt, hem optilt en wegbrengt. Hij komt alleen bij
//   wat op de vloer staat: de inslagbanen bij de docks en de onderste laag van de stellingen.
// - de robot-heftruck (fork): een onbemande stapelaar met een mast. Hij pakt een pallet vanuit het pad met zijn
//   vorken en komt daarmee ook bij de hogere niveaus van de stellingen.
// - de pickrobot (pick): pickt orders zonder dat er een mens aan te pas komt. Hij heeft een grijparm op een mast
//   en pakt daarmee dozen van een pallet op elk niveau, legt ze in de rolcontainer die hij achter zich meevoert
//   en zet de order klaar op een uitslaglocatie. Elke stap gaat langs de WMS, net als bij een speler.
// - de voorraadteller (count): rijdt met een uitschuifbare cameramast door de paden en scant de palletstickers op alle
//   niveaus. Een pallet die verplaatst is en nog niet geboekt, boekt hij daarmee op de plek waar hij staat.
// De WMS stuurt ze aan met robotopdrachten (breng pallet X van locatie A naar locatie B). De game speelt de
// vlootsturing en de robots zelf: hij wijst een opdracht toe aan een vrije robot, laat die rijden en meldt
// elke stap terug aan de WMS (gestart, afgerond, mislukt). Zoals overal in de sim geldt: eerst de WMS, dan
// fysiek. Pas als de WMS het afronden heeft geaccepteerd zet de robot de pallet neer.
//
// Elk pad tussen de stellingen heeft zijn eigen robot (om en om een tilrobot en een robot-heftruck), met een
// laadstation aan het eind van dat pad tegen de oostwand. Ze rijden over de paden (één robot per pad tegelijk)
// en wisselen van pad via de robotbaan aan de oostkant van de hal. De pickrobots en de telrobot hebben hun
// laadstation tussen die van de paden in.
// Multiplayer: iedereen laat de robots lokaal rijden; alleen de host beslist (oppakken, neerzetten, de WMS vragen).

/**
 * Een opdracht van de WMS: breng deze pallet van de ene locatie naar de andere.
 * kind 'unload' = lossen: van de vrachtwagen aan de dockdeur (fromLocationId = DOCK-NN) naar de inslagbaan.
 */
export type RobotTask = { id: string; palletId: string; fromLocationId: string; toLocationId: string; kind?: 'unload' };
/** idle = bij het laadstation; home = onderweg daarheen. */
export type RobotPhase =
  | 'idle' | 'toPickup' | 'toDrop' | 'home'
  // pickrobot: naar een picklocatie, dozen pakken, naar de uitslaglocatie, of vastgelopen (probeert het later opnieuw)
  | 'toPick' | 'picking' | 'toStage' | 'stuck'
  // telrobot: op telronde
  | 'counting';
export type RobotKind = 'lift' | 'fork' | 'pick' | 'count';
/**
 * a = het pad waarin de robot is zodra hij dit punt bereikt (-1 = robotbaan of laadstation).
 * h = hoogte (m) van de vorken, de grijparm of de cameramast voordat de robot naar dit punt rijdt (standaard 0: rijhoogte).
 * back = achteruit naar dit punt rijden: zo rijdt een robot een stelling uit, of met zijn rug ergens naartoe.
 */
type Waypoint = Point & { a: number; detour?: boolean; h?: number; back?: boolean };
/**
 * Een palletplek met zijn niveau in de stelling (1 = op de vloer).
 * aisle = de robot blijft in het midden van dit pad staan (telrobot); stage = de plek op een uitslaglocatie
 * waar de pickrobot zijn rolcontainer achteruit neerzet.
 */
export type RobotSpot = Point & { level: number; aisle?: number; stage?: boolean };
export type Robot = {
  id: string;
  kind: RobotKind;
  /** Hoogte (m) van de vorken (robot-heftruck), de grijparm (pickrobot) of de cameramast (telrobot); 0 bij een tilrobot. */
  fork: number;
  /** Pickrobot: de order waarvan hij de rolcontainer meevoert. */
  order: string | null;
  /** Pickrobot: de locatie waar hij heen rijdt of bezig is. */
  goal: string;
  /** Telrobot: hoe ver hij is in zijn ronde. Pickrobot: het dock waar hij de order klaarzet. */
  step: number;
  x: number;
  z: number;
  /** Rijrichting (radialen om de verticale as); vooruit = (sin r, cos r). */
  r: number;
  /** Het pad tussen de stellingen waar de robot nu in rijdt (-1 = robotbaan of laadstation). */
  aisle: number;
  phase: RobotPhase;
  path: Waypoint[];
  task: RobotTask | null;
  load: Pallet | null;
  /** Waar de WMS de pallet op de robot heeft staan. */
  loadFrom: string | null;
  /** De palletplek op de doellocatie waar de robot heen rijdt. */
  slot: number;
  /** Accu in procenten. */
  battery: number;
  /** Telt elke beslissing over deze robot; in multiplayer wint de hoogste stand. */
  v: number;
};
/** Iets waar een robot voor stopt: een speler, de heftruck, de pompwagen. */
export type Obstacle = Point & { rad: number };

/** Wat de robots van de fysieke wereld nodig hebben; ingevuld door src/sim/warehouse.ts. */
export interface RobotWorld {
  /** false: een andere speler is host en beslist over de robots. */
  authority(): boolean;
  revision(): number;
  /** De wereld is veranderd (gaat in multiplayer naar de andere spelers). */
  touch(): void;
  say(text: string, kind?: 'info' | 'ok' | 'err'): void;
  ask(e: ProcessEvent): Promise<WmsReply>;
  /** Een geloste pallet staat boven de inslagbaan: de ontvangst boeken (als de WMS dat niet al deed). */
  received(pallet: Pallet, laneId: string, dockId: string): Promise<WmsReply>;
  /** Waar de pallet staat, of waarom de robot hem daar niet kan halen. */
  pickupSpot(palletId: string, fromLocationId: string): RobotSpot | string;
  /** Haalt de pallet fysiek van zijn plek; een tekst = dat kan niet (meer). */
  take(palletId: string, fromLocationId: string): Pallet | string;
  /** De vrije palletplek op de locatie, of waarom de pallet daar niet kan staan. */
  dropSpot(locationId: string, pallet: Pallet): (RobotSpot & { slot: number }) | string;
  /** Het niveau van een locatie (1 = op de vloer, ook voor de banen bij de docks). */
  level(locationId: string): number;
  drop(locationId: string, pallet: Pallet, slot: number): void;
  /** Pallets in aangemelde vrachtwagens die gelost kunnen worden, met het aantal vrije plekken op de inslagbaan. */
  unload(): { palletId: string; fromLocationId: string; toLocationId: string; free: number }[];
  /** Vrije palletplekken op een inslagbaan. */
  laneRoom(laneId: string): number;
  /** Getelde pallets met sticker op de inslagbanen: werk dat een robot kan doen. */
  inbound(): { palletId: string; sku: string; qty: number; locationId: string; z: number }[];
  /** Stellinglocaties waar nog een pallet van dit artikel bij kan (free = aantal vrije plekken). */
  space(sku: string): { locationId: string; level: number; free: number; x: number; z: number; sameSku: boolean }[];
  /** Lege vloerlocaties met voorraad erboven: de pallet die naar beneden kan om de pickplek aan te vullen. */
  refill(): { palletId: string; fromLocationId: string; toLocationId: string }[];
  /** Orders picken zonder speler. Een tekst als antwoord = waarom het niet lukte; null = gelukt. */
  orders: {
    /** De volgende open order die nog niemand heeft. */
    next(skip: Set<string>): string | null;
    status(orderId: string): 'picking' | 'picked' | 'other';
    start(orderId: string): Promise<string | null>;
    /** Waar de robot het volgende artikel van de order pakt; 'done' = alles is gepickt, null = nergens voorraad. */
    pickSpot(orderId: string, near: Point, avoid: Set<string>): (RobotSpot & { locationId: string }) | 'done' | null;
    pick(orderId: string, locationId: string): Promise<string | null>;
    finish(orderId: string): Promise<string | null>;
    /** De vrije plek op een uitslaglocatie waar de order klaargezet kan worden. */
    stageSpot(): (Point & { dock: number; slot: number; locationId: string }) | null;
    stage(orderId: string, dock: number): Promise<string | null>;
  };
  /** De telrobot scant de pallets in een sectie (x) van deze rijen (z), op alle niveaus. bare = zonder sticker. */
  count(x: number, rows: number[]): Promise<{ pallets: number; booked: number; bare: number }>;
}

/** Rijsnelheid (m/s) en draaisnelheid (rad/s). */
const SPEED = 1.8;
const TURN = 3.5;
/** Hefsnelheid (m/s) van de vorken, de grijparm of de cameramast. */
const LIFT_SPEED: Record<RobotKind, number> = { lift: 0, fork: 0.9, pick: 1.1, count: 1.6 };
/** Zo ver (m) voor de pallet stopt het midden van een pickrobot: zijn arm reikt de rest. */
const PICK_REACH = 1.35;
/** Zo hoog (m) boven de palletplek pakt de grijparm een doos. */
const PICK_HEIGHT = 0.3;
/** Zo ver (m) achter het midden van een pickrobot staat de rolcontainer. */
export const ROBOT_HITCH = 0.95;
/** Zo lang (s) is de grijparm bezig met één greep. */
export const ROBOT_PICK_SECONDS = 2.4;
/** Zo ver (m) schuift de cameramast van de telrobot uit in een pad. */
export const ROBOT_COUNT_TOP = 3;
/** Zo lang (s) laadt de telrobot tussen twee rondes. */
const COUNT_REST = 120;
/** Zo ver (m) voor het midden van een robot-heftruck staat de pallet op zijn vorken. */
export const ROBOT_FORK_REACH = 0.75;
/** Onder dit percentage neemt een robot geen nieuwe opdracht aan: eerst laden. */
const LOW_BATTERY = 25;
const RACK_MAX_X = SECTION_X[SECTION_X.length - 1] + SECTION_PITCH / 2;
/** De paden tussen de stellingen (z). De rijen staan rug-aan-rug: een pad heeft aan weerszijden een rij. */
export const ROBOT_AISLES = AISLE_Z;
/** De robotbaan (x) aan de oostkant: daar wisselen de robots van pad. Rijden naar +z gaat rechts, naar -z links. */
export const ROBOT_CORRIDOR_X = Math.min(RACK_MAX_X + 3, HALL.w / 2 - 3.4);
const LANE = 0.55;
/** Zo ver (m) naast de ingang van een pad wacht een robot tot het pad vrij is. */
const HOLD = 1.3;
/** Past de vloot in deze hal? Er moet een pad zijn, en ruimte voor de robotbaan naast de stellingen. */
const FITS = ROBOT_AISLES.length > 0 && ROBOT_CORRIDOR_X >= RACK_MAX_X + 1.4;
/** De robots die geen eigen pad hebben: ze staan tussen de laadstations van de paden in, het dichtst bij het midden. */
const EXTRA: RobotKind[] = ['count', 'pick', 'pick'];
const EXTRA_Z = (() => {
  const first = ROBOT_AISLES[0] ?? 0;
  const last = ROBOT_AISLES[ROBOT_AISLES.length - 1] ?? 0;
  const between = ROBOT_AISLES.slice(1)
    .map((z, i) => (ROBOT_AISLES[i] + z) / 2)
    .sort((a, b) => Math.abs(a - (first + last) / 2) - Math.abs(b - (first + last) / 2));
  return [...between, last + 2.5, first - 2.5, last + 5].filter((z) => Math.abs(z) < HALL.d / 2 - 1.5).slice(0, EXTRA.length);
})();
/**
 * De laadstations tegen de oostwand: één per pad, aan het eind van dat pad (elk pad heeft zijn eigen robot),
 * en daartussen die van de telrobot en de pickrobots.
 */
export const ROBOT_CHARGERS: Point[] = FITS ? [...ROBOT_AISLES, ...EXTRA_Z].map((z) => ({ x: HALL.w / 2 - 1.2, z })) : [];
/** De soort robot per laadstation: per pad om en om een tilrobot en een robot-heftruck, daarna de overige. */
export const ROBOT_KINDS: RobotKind[] = ROBOT_CHARGERS.map((_, i) =>
  i < ROBOT_AISLES.length ? (i % 2 ? 'fork' : 'lift') : EXTRA[i - ROBOT_AISLES.length],
);
const PREFIX: Record<RobotKind, string> = { lift: 'GKP', fork: 'GKF', pick: 'PCK', count: 'INV' };
/** Het nummer van robot i: dat van zijn pad, of het volgnummer binnen zijn soort. */
const robotId = (i: number) => {
  const n = i < ROBOT_AISLES.length ? i + 1 : ROBOT_KINDS.slice(ROBOT_AISLES.length, i + 1).filter((k) => k === ROBOT_KINDS[i]).length;
  return `${PREFIX[ROBOT_KINDS[i]]}-${String(n).padStart(2, '0')}`;
};
/**
 * Waar robot i bij zijn laadstation staat: met zijn neus ertegenaan. Alleen de robot-heftruck staat er met
 * zijn rug tegenaan, de vorken naar de hal.
 */
const parkPose = (i: number) =>
  ROBOT_KINDS[i] === 'fork'
    ? { x: ROBOT_CHARGERS[i].x - 0.25, z: ROBOT_CHARGERS[i].z, r: -Math.PI / 2 }
    : // de grijparm van de pickrobot steekt voor zijn neus uit
      { x: ROBOT_CHARGERS[i].x - (ROBOT_KINDS[i] === 'pick' ? 0.12 : 0), z: ROBOT_CHARGERS[i].z, r: Math.PI / 2 };

const angle = (to: number, from: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const nearestAisle = (z: number) => ROBOT_AISLES.reduce((best, az, i) => (Math.abs(az - z) < Math.abs(ROBOT_AISLES[best] - z) ? i : best), 0);
/** Vanuit welke paden is dit punt te bereiken? Een stellingrij alleen vanuit zijn eigen pad, een inslagbaan vanuit het pad ervoor. */
function aislesFor(p: Point): number[] {
  const row = ROW_Z.findIndex((z) => Math.abs(z - p.z) < 0.01);
  return [row < 0 ? nearestAisle(p.z) : ROW_AISLE[row]];
}

export function createRobotFleet(world: RobotWorld) {
  const parked = (i: number): Robot => ({
    id: robotId(i),
    kind: ROBOT_KINDS[i],
    fork: 0,
    order: null,
    goal: '',
    step: 0,
    ...parkPose(i),
    aisle: -1,
    phase: 'idle',
    path: [],
    task: null,
    load: null,
    loadFrom: null,
    slot: 0,
    battery: 100,
    v: 0,
  });
  const robots: Robot[] = ROBOT_CHARGERS.map((_, i) => parked(i));
  /** Wat alleen deze speler van een robot bijhoudt. busy = er loopt een vraag bij de WMS. */
  const local = new Map(
    robots.map((r) => [
      r.id,
      {
        wait: '', blocked: 0, busy: false,
        /** Aftellen (s): de greep van de pickrobot, een nieuwe poging na vastlopen, de rust van de telrobot. */
        timer: r.kind === 'count' ? 20 : 0,
        /** Waarom een pickrobot is vastgelopen. */
        why: '',
        /** Locaties waar de pick voor deze order mislukte. */
        avoid: new Set<string>(),
        /** Wat de telrobot deze ronde heeft gezien. */
        tally: { pallets: 0, booked: 0, bare: 0 },
      },
    ]),
  );
  const state = (r: Robot) => local.get(r.id)!;
  /** Opdrachten van de WMS die nog geen robot hebben. */
  let open: RobotTask[] = [];
  /** Afgehandelde opdrachten: een stand uit de WMS van net daarvoor mag ze niet opnieuw aanbieden. */
  const finished = new Set<string>();
  let obstacles: () => Obstacle[] = () => [];
  /** Telt de resets van de hal: een antwoord van de WMS op een vraag van vóór de reset telt niet meer. */
  let resets = 0;
  /** Mogen de pickrobots orders pakken en mag de telrobot zijn rondes rijden? */
  const auto = { pick: true, count: true };
  /** Orders waarvoor een pickrobot net de WMS om akkoord vraagt. */
  const claiming = new Set<string>();

  // ========== Route ==========

  /**
   * Route over de paden en de robotbaan naar een palletplek (of, zonder plek, naar het eigen laadstation).
   * Een tilrobot rijdt tot onder de pallet; een robot-heftruck en een pickrobot stoppen ervoor, met de vorken of
   * de grijparm op de hoogte van de plek. Een telrobot blijft in het midden van het pad.
   */
  function route(r: Robot, goal: RobotSpot | null): Waypoint[] {
    const path: Waypoint[] = [];
    const fork = r.kind === 'fork';
    const goalAisles = !goal ? [] : goal.aisle !== undefined ? [goal.aisle] : aislesFor(goal);
    /** Het laatste stuk: vanaf het midden van het pad naar de pallet. */
    const reach = (a: number): Waypoint[] => {
      if (!goal) return [];
      const az = ROBOT_AISLES[a];
      const mid = { x: goal.x, z: az, a };
      const side = goal.z >= az ? 1 : -1;
      const y = LEVEL_Y[goal.level] ?? 0;
      if (r.kind === 'count') return [{ ...mid, h: ROBOT_COUNT_TOP }];
      if (r.kind === 'fork') return [mid, { x: goal.x, z: goal.z - side * ROBOT_FORK_REACH, a, h: y }];
      if (r.kind === 'lift') return [mid, { x: goal.x, z: goal.z, a }];
      // De pickrobot: met zijn rug naar de uitslaglocatie om de rolcontainer neer te zetten, anders met zijn arm naar de pallet
      if (goal.stage) return [mid, { x: goal.x, z: goal.z - side * ROBOT_HITCH, a, back: true }];
      return [mid, { x: goal.x, z: goal.z - side * PICK_REACH, a, h: y + PICK_HEIGHT }];
    };
    let z = r.z;
    const corridor = (toZ: number) => ROBOT_CORRIDOR_X + (toZ >= z ? LANE : -LANE);
    if (r.aisle >= 0) {
      const az = ROBOT_AISLES[r.aisle];
      if (Math.abs(r.z - az) > 0.01) {
        // Eerst terug naar het midden van het pad. Een robot-heftruck en een pickrobot rijden achteruit de stelling
        // uit en laten daar hun vorken of arm zakken voordat ze draaien.
        const back = Math.cos(r.r) * (az - r.z) < 0; // het midden van het pad ligt achter de robot
        if (fork || r.kind === 'pick') path.push({ x: r.x, z: az, a: r.aisle, back, h: r.fork }, { x: r.x, z: az, a: r.aisle, back: true });
        else path.push({ x: r.x, z: az, a: r.aisle });
      }
      if (goal && goalAisles.includes(r.aisle)) return [...path, ...reach(r.aisle)];
      z = az;
    }
    const ga = goal ? goalAisles.reduce((best, a) => (Math.abs(ROBOT_AISLES[a] - z) < Math.abs(ROBOT_AISLES[best] - z) ? a : best)) : -1;
    const home = parkPose(robots.indexOf(r));
    const toZ = goal ? ROBOT_AISLES[ga] : home.z;
    const laneX = corridor(toZ);
    const dir = toZ >= z ? 1 : -1;
    const far = Math.abs(toZ - z) > 2 * HOLD;
    // Het pad blijft bezet tot de robot er op de robotbaan een stukje vandaan is: dan pas mag de volgende erin
    path.push({ x: laneX, z, a: r.aisle });
    if (r.aisle >= 0 && far) path.push({ x: laneX, z: z + dir * HOLD, a: -1 });
    if (goal) {
      // Wachten op een vrij pad doet de robot naast de ingang, niet ervoor: zo kan de robot die eruit komt erlangs
      if (far) path.push({ x: laneX, z: toZ - dir * HOLD, a: -1 });
      path.push({ x: laneX, z: toZ, a: ga }, ...reach(ga));
    } else {
      path.push({ x: laneX, z: toZ, a: -1 }, { x: home.x, z: home.z, a: -1, back: fork });
    }
    return path;
  }

  // ========== Rijden (bij elke speler) ==========

  /**
   * Staat er iets in de weg? along = afstand in de rijrichting, side = hoe ver naast de rijlijn (+ = rechts).
   * @param back de robot rijdt achteruit
   */
  function ahead(r: Robot, p: Point, rad: number, back = false) {
    const way = back ? -1 : 1;
    const hx = Math.sin(r.r) * way;
    const hz = Math.cos(r.r) * way;
    const dx = p.x - r.x;
    const dz = p.z - r.z;
    const along = dx * hx + dz * hz;
    const side = dx * hz - dz * hx;
    // Een robot-heftruck is langer (de vorken steken vooruit) en met een pallet ook breder; een pickrobot
    // heeft zijn rolcontainer achter zich
    const reach = r.kind === 'fork' ? (back ? 0.95 : 1.5) : r.kind === 'pick' ? (back ? 1.7 : 0.8) : 0.7;
    const width = r.kind === 'fork' ? 0.55 : r.kind === 'pick' ? 0.5 : 0.4;
    return along > 0 && along < reach + rad && Math.abs(side) < width + rad ? { along, side } : null;
  }

  function drive(r: Robot, dt: number) {
    const l = state(r);
    l.wait = '';
    const wp = r.path[0];
    if (!wp) return;
    // Eén robot per pad: wachten tot het pad vrij is
    if (wp.a >= 0 && r.aisle !== wp.a) {
      if (robots.some((o) => o !== r && o.aisle === wp.a)) return void (l.wait = 'pad bezet');
      r.aisle = wp.a;
    }
    const dx = wp.x - r.x;
    const dz = wp.z - r.z;
    const d = Math.hypot(dx, dz);
    const moving = d > 0.02;
    const back = !!wp.back;
    if (moving) {
      // Achteruit rijden: de rug naar het doel
      const turn = angle(Math.atan2(dx, dz) + (back ? Math.PI : 0), r.r);
      r.r += Math.max(-TURN * dt, Math.min(TURN * dt, turn));
      if (Math.abs(turn) > 0.25) return; // eerst op de plaats draaien, dan rijden
    }
    // Vorken, grijparm of cameramast gaan eerst op hoogte, dan pas rijdt de robot verder
    const h = wp.h ?? 0;
    if (r.kind !== 'lift' && r.fork !== h) {
      const lift = LIFT_SPEED[r.kind] * dt;
      r.fork += Math.max(-lift, Math.min(lift, h - r.fork));
      return;
    }
    if (moving) {
      // Voorrang: een robot wacht op een robot met een lager nummer (tenzij die zelf op een vrij pad wacht)
      if (robots.some((o) => o !== r && o.id < r.id && state(o).wait !== 'pad bezet' && ahead(r, o, 0.5, back))) return void (l.wait = 'robot voor');
      const list = obstacles();
      const hit = list.map((o) => ahead(r, o, o.rad, back)).find(Boolean);
      if (hit) {
        l.wait = 'obstakel';
        l.blocked += dt;
        if (back) {
          // achteruit rijdt de robot nergens omheen: hij wacht tot de weg vrij is
        } else if (wp.detour) {
          // Ook de omweg zit dicht: opnieuw proberen vanaf hier
          if (l.blocked > 6) {
            r.path = r.path.filter((p) => !p.detour);
            l.blocked = 0;
          }
        } else if (l.blocked > 2.5) {
          // Blijft het obstakel staan (een geparkeerde heftruck), dan rijdt de robot er met een boogje omheen
          l.blocked = 0;
          const hx = Math.sin(r.r);
          const hz = Math.cos(r.r);
          let past = 0;
          for (const o of list) {
            const along = (o.x - r.x) * hx + (o.z - r.z) * hz;
            const side = (o.x - r.x) * hz - (o.z - r.z) * hx;
            if (along > 0 && along < hit.along + 5 && Math.abs(side) < 0.4 + o.rad) past = Math.max(past, along + o.rad + 1.2);
          }
          // Ligt het doel vlak achter het obstakel, dan komt de robot er van opzij weer bij
          past = Math.min(past, d);
          const out = hit.side > 0 ? -1.25 : 1.25;
          const a = r.aisle;
          r.path.unshift(
            { x: r.x + hz * out, z: r.z - hx * out, a, detour: true },
            { x: r.x + hz * out + hx * past, z: r.z - hx * out + hz * past, a, detour: true },
            { x: r.x + hx * past, z: r.z + hz * past, a, detour: true },
          );
        }
        return;
      }
      l.blocked = 0;
      const step = Math.min(d, SPEED * dt);
      r.x += (dx / d) * step;
      r.z += (dz / d) * step;
      r.battery = Math.max(5, r.battery - dt * 0.04);
      if (step < d) return;
    }
    r.x = wp.x;
    r.z = wp.z;
    if (wp.a < 0) r.aisle = -1;
    r.path.shift();
  }

  // ========== Beslissen (alleen de host) ==========

  /** Legt een beslissing over een robot vast en deelt hem met de andere spelers. */
  function decided(r: Robot) {
    r.v++;
    world.touch();
  }

  function goHome(r: Robot) {
    r.phase = 'home';
    r.path = route(r, null);
    decided(r);
  }

  function goDrop(r: Robot) {
    const spot = world.dropSpot(r.task!.toLocationId, r.load!);
    if (typeof spot === 'string') return void fail(r, spot);
    if (spot.level > 1 && r.kind !== 'fork') return void fail(r, `${r.task!.toLocationId} ligt niet op de vloer: daar kan alleen een robot-heftruck bij`);
    r.phase = 'toDrop';
    r.slot = spot.slot;
    r.path = route(r, spot);
    decided(r);
  }

  /** Meldt de opdracht af als mislukt. Heeft de robot de pallet al, dan wacht hij ermee bij zijn laadstation op een nieuwe opdracht. */
  async function fail(r: Robot | null, reason: string, task = r?.task) {
    if (!task) return;
    finished.add(task.id);
    if (r) {
      r.task = null;
      state(r).busy = true;
      goHome(r);
    }
    world.say(`${r?.id ?? 'Robots'}: opdracht ${task.id} (${task.palletId} naar ${task.toLocationId}) mislukt: ${reason}`, 'err');
    await world.ask({ type: 'RobotTaskFailed', taskId: task.id, robotId: r?.id, reason, palletOnRobot: !!r?.load });
    if (r) state(r).busy = false;
  }

  /** De WMS om akkoord vragen en dan pas vertrekken. */
  async function start(r: Robot, task: RobotTask) {
    const l = state(r);
    const before = resets;
    l.busy = true;
    const reply = await world.ask({
      type: 'RobotTaskStarted', taskId: task.id, robotId: r.id,
      palletId: task.palletId, fromLocationId: task.fromLocationId, locationId: task.toLocationId,
    });
    l.busy = false;
    if (!reply.ok) {
      finished.add(task.id);
      return void world.say(`WMS weigert robotopdracht ${task.id}: ${reply.error}`, 'err');
    }
    if (r.task || resets !== before) return; // intussen is de hal gereset
    r.task = task;
    if (r.load?.id === task.palletId) return goDrop(r); // de pallet stond nog op de robot na een mislukte opdracht
    const spot = world.pickupSpot(task.palletId, task.fromLocationId);
    if (typeof spot === 'string') return void fail(r, spot);
    r.phase = 'toPickup';
    r.path = route(r, spot);
    decided(r);
  }

  /** Verdeelt de openstaande opdrachten over de vrije robots: de dichtstbijzijnde eerst. */
  function assign() {
    for (const task of [...open]) {
      const free = (r: Robot) => !r.task && !state(r).busy && (r.phase === 'idle' || r.phase === 'home');
      const holder = robots.find((r) => r.load?.id === task.palletId);
      let robot = holder;
      if (holder) {
        if (!free(holder)) continue;
      } else {
        const spot = world.pickupSpot(task.palletId, task.fromLocationId);
        if (typeof spot === 'string') {
          open = open.filter((t) => t !== task);
          void fail(null, spot, task);
          continue;
        }
        // Hoger dan de vloer kan alleen een robot-heftruck; werk op de vloer gaat eerst naar een tilrobot
        const high = spot.level > 1 || world.level(task.toLocationId) > 1;
        const able = robots.filter((r) => r.kind === 'fork' || (!high && r.kind === 'lift'));
        if (!able.length) {
          open = open.filter((t) => t !== task);
          void fail(null, 'er is geen robot-heftruck: de tilrobots komen alleen bij de vloer', task);
          continue;
        }
        robot = able
          .filter((r) => free(r) && !r.load && r.battery >= LOW_BATTERY)
          .sort((a, b) => (high ? 0 : Number(a.kind === 'fork') - Number(b.kind === 'fork')) || dist(a, spot) - dist(b, spot))[0];
      }
      if (!robot) continue;
      open = open.filter((t) => t !== task);
      void start(robot, task);
    }
  }

  // ========== Pickrobot: orders picken zonder speler (alleen de host) ==========

  /** Verder met de order van deze pickrobot: het volgende artikel pakken, afmelden, klaarzetten, of naar huis. */
  function resume(r: Robot) {
    const l = state(r);
    const o = r.order;
    const status = o ? world.orders.status(o) : 'other';
    if (!o || status === 'other') {
      // geen order (meer): hij is elders afgehandeld of de hal is opnieuw geladen
      r.order = null;
      return goHome(r);
    }
    if (status === 'picked') return goStage(r);
    const next = world.orders.pickSpot(o, r, l.avoid);
    if (next === 'done') return void finishOrder(r);
    if (!next) return stuck(r, `voor ${o} is nergens voorraad te vinden`);
    r.goal = next.locationId;
    r.phase = 'toPick';
    r.path = route(r, next);
    decided(r);
  }

  /** Het lukt nu niet: de pickrobot wacht bij zijn laadstation, met de order, en probeert het straks opnieuw. */
  function stuck(r: Robot, why: string) {
    const l = state(r);
    if (l.why !== why) world.say(`${r.id}: ${why}. Hij probeert het straks opnieuw.`, 'err');
    l.why = why;
    l.timer = 8;
    l.avoid.clear();
    r.phase = 'stuck';
    r.path = r.aisle < 0 && dist(r, parkPose(robots.indexOf(r))) < 0.1 ? [] : route(r, null); // staat hij al thuis, dan blijft hij staan
    decided(r);
  }

  /** Een vraag aan de WMS voor een pickrobot; false = de hal is intussen gereset of de robot doet iets anders. */
  async function asking(r: Robot, question: () => Promise<string | null>): Promise<{ error: string | null } | false> {
    const l = state(r);
    const before = resets;
    const order = r.order;
    l.busy = true;
    const error = await question();
    l.busy = false;
    return resets === before && r.order === order ? { error } : false;
  }

  async function takeOrder(r: Robot, orderId: string) {
    const l = state(r);
    const before = resets;
    claiming.add(orderId);
    l.busy = true;
    const error = await world.orders.start(orderId);
    l.busy = false;
    claiming.delete(orderId);
    if (resets !== before || r.order) return;
    if (error) {
      l.timer = 10; // niet meteen opnieuw vragen
      return void world.say(`${r.id} kan ${orderId} niet starten: ${error}`, 'err');
    }
    r.order = orderId;
    l.avoid.clear();
    l.why = '';
    world.say(`${r.id} pickt ${orderId}.`);
    resume(r);
  }

  /** De grijparm heeft de doos: de pick boeken in de WMS en dan door naar het volgende artikel. */
  async function pickHere(r: Robot) {
    const done = await asking(r, () => world.orders.pick(r.order!, r.goal));
    if (!done) return;
    if (done.error) {
      state(r).avoid.add(r.goal); // hier lukt het niet: een andere locatie proberen
      world.say(`${r.id}: pick op ${r.goal} mislukt: ${done.error}`, 'err');
    }
    resume(r);
  }

  async function finishOrder(r: Robot) {
    const done = await asking(r, () => world.orders.finish(r.order!));
    if (!done) return;
    if (done.error) return stuck(r, `${r.order} afmelden mislukt: ${done.error}`);
    goStage(r);
  }

  function goStage(r: Robot) {
    const spot = world.orders.stageSpot();
    if (!spot) return stuck(r, 'alle uitslaglocaties staan vol');
    r.goal = spot.locationId;
    r.step = spot.dock;
    r.slot = spot.slot;
    r.phase = 'toStage';
    r.path = route(r, { x: spot.x, z: spot.z, level: 1, stage: true });
    decided(r);
  }

  async function stageHere(r: Robot) {
    const spot = world.orders.stageSpot();
    if (!spot || spot.dock !== r.step || spot.slot !== r.slot) return goStage(r); // de plek is intussen bezet
    const order = r.order!;
    const done = await asking(r, () => world.orders.stage(order, spot.dock));
    if (!done) return;
    if (done.error) return stuck(r, `${order} klaarzetten op ${spot.locationId} mislukt: ${done.error}`);
    r.order = null;
    state(r).why = '';
    world.say(`${r.id} heeft ${order} klaargezet op ${spot.locationId}.`, 'ok');
    goHome(r);
  }

  // ========== Telrobot: de palletstickers in alle paden scannen (alleen de host) ==========

  /** De stops van een telronde: per pad elke sectie, van de robotbaan af de hal in. */
  const COUNT_STOPS = ROBOT_AISLES.flatMap((_, a) => SECTION_X.map((_x, i) => ({ a, s: SECTION_X.length - 1 - i })));
  /** De rijen (z) die de telrobot vanuit een pad scant; een rij die aan twee paden ligt telt hij maar één keer. */
  const countRows = (a: number) => ROW_Z.filter((z) => aislesFor({ x: 0, z })[0] === a);

  function goCount(r: Robot) {
    const l = state(r);
    const stop = COUNT_STOPS[r.step];
    if (!stop || !auto.count) {
      if (!stop) {
        const t = l.tally;
        world.say(
          `${r.id} heeft de hal geteld: ${t.pallets} pallets gescand, ${t.booked} verplaatsing${t.booked === 1 ? '' : 'en'} geboekt` +
            (t.bare ? `, ${t.bare} zonder sticker.` : '.'),
          t.bare ? 'info' : 'ok',
        );
      }
      l.tally = { pallets: 0, booked: 0, bare: 0 };
      l.timer = COUNT_REST;
      r.step = 0;
      return goHome(r);
    }
    r.phase = 'counting';
    r.path = route(r, { x: SECTION_X[stop.s], z: ROBOT_AISLES[stop.a], level: 1, aisle: stop.a });
    decided(r);
  }

  async function countHere(r: Robot) {
    const l = state(r);
    const stop = COUNT_STOPS[r.step];
    const before = resets;
    l.busy = true;
    const seen = await world.count(SECTION_X[stop.s], countRows(stop.a));
    l.busy = false;
    if (resets !== before || r.phase !== 'counting') return;
    l.tally.pallets += seen.pallets;
    l.tally.booked += seen.booked;
    l.tally.bare += seen.bare;
    r.step++;
    goCount(r);
  }

  /** De robot is aangekomen: oppakken, neerzetten, picken, tellen of parkeren. */
  function arrive(r: Robot, dt: number) {
    const task = r.task;
    const l = state(r);
    if (r.phase === 'home') {
      r.phase = 'idle';
      r.r = parkPose(robots.indexOf(r)).r;
      return decided(r);
    }
    if (r.phase === 'toPick') {
      r.phase = 'picking';
      l.timer = ROBOT_PICK_SECONDS;
      return decided(r);
    }
    if (r.phase === 'picking') return void ((l.timer -= dt) <= 0 && pickHere(r));
    if (r.phase === 'stuck') return void ((l.timer -= dt) <= 0 && resume(r));
    if (r.phase === 'toStage') return void stageHere(r);
    if (r.phase === 'counting') return void countHere(r);
    if (!task) return;
    if (r.phase === 'toPickup') {
      const pallet = world.take(task.palletId, task.fromLocationId);
      if (typeof pallet === 'string') return void fail(r, pallet);
      r.load = pallet;
      r.loadFrom = task.fromLocationId;
      return goDrop(r);
    }
    if (r.phase === 'toDrop') void deliver(r, task);
  }

  async function deliver(r: Robot, task: RobotTask) {
    const pallet = r.load;
    if (!pallet) return void fail(r, 'de pallet staat niet meer op de robot');
    const spot = world.dropSpot(task.toLocationId, pallet);
    if (typeof spot === 'string') return void fail(r, spot);
    if (spot.slot !== r.slot) return goDrop(r); // de plek is intussen bezet: door naar de volgende plek op deze locatie
    const l = state(r);
    l.busy = true;
    const unload = task.kind === 'unload';
    const reply = unload
      ? await world.received(pallet, task.toLocationId, task.fromLocationId)
      : await world.ask({
          type: 'RobotTaskCompleted', taskId: task.id, robotId: r.id, palletId: pallet.id,
          sku: pallet.sku, qty: pallet.qty, fromLocationId: r.loadFrom ?? task.fromLocationId, locationId: task.toLocationId,
        });
    l.busy = false;
    if (r.task !== task || r.load !== pallet) return; // intussen is de hal gereset
    if (!reply.ok) return void fail(r, `de WMS weigert: ${reply.error}`);
    const now = world.dropSpot(task.toLocationId, pallet);
    world.drop(task.toLocationId, pallet, typeof now === 'string' ? spot.slot : now.slot);
    finished.add(task.id);
    r.load = null;
    r.loadFrom = null;
    r.task = null;
    world.say(`${r.id} heeft ${pallet.id} ${unload ? 'gelost' : 'weggezet'} op ${task.toLocationId}.`, 'ok');
    goHome(r);
  }

  function update(dt: number) {
    for (const r of robots) {
      drive(r, dt);
      if (r.phase === 'idle') r.battery = Math.min(100, r.battery + dt * 1.5);
    }
    if (!world.authority()) return;
    for (const r of robots) if (r.path.length === 0 && r.phase !== 'idle' && !state(r).busy) arrive(r, dt);
    if (open.length) assign();
    // Vrije pickrobots pakken de volgende open order; de telrobot begint na zijn rust aan een nieuwe ronde
    for (const r of robots) {
      const l = state(r);
      if (r.kind !== 'pick' && r.kind !== 'count') continue;
      const free = !l.busy && (r.phase === 'idle' || (r.phase === 'home' && r.kind === 'pick'));
      if (!free || (l.timer -= dt) > 0 || r.battery < LOW_BATTERY) continue;
      if (r.kind === 'count') {
        if (auto.count) goCount(r);
      } else if (r.order) {
        resume(r); // de order stond nog op de robot (overgenomen van een andere host)
      } else if (auto.pick) {
        const taken = new Set([...claiming, ...robots.flatMap((x) => (x.order ? [x.order] : []))]);
        const id = world.orders.next(taken);
        if (id) void takeOrder(r, id);
      }
    }
  }

  // ========== Multiplayer ==========

  let snapshot: Robot[] = [];
  let snapshotAt = -1;
  /**
   * De robots voor de gedeelde wereld. De stand wordt alleen ververst als de wereld verandert: zo telt het
   * rijden zelf niet als wijziging (elke speler laat de robots lokaal rijden).
   */
  function shared(): Robot[] {
    if (snapshotAt !== world.revision()) {
      snapshotAt = world.revision();
      snapshot = structuredClone(robots);
    }
    return snapshot;
  }

  /** Neemt de robots van een andere speler over, per robot alleen als die verder is dan de eigen stand. */
  function applyShared(list: Robot[] | undefined) {
    for (const s of list ?? []) {
      const r = robots.find((x) => x.id === s.id);
      if (!r || !(s.v > r.v) || !Array.isArray(s.path)) continue;
      const here = dist(r, s) < 1.5 ? { x: r.x, z: r.z, r: r.r } : null; // staat hij hier al bijna goed, dan niet verspringen
      Object.assign(r, structuredClone(s), here);
    }
    snapshotAt = -1;
  }

  /** De hal wordt gereset: alle robots leeg terug naar hun laadstation. */
  function reset() {
    resets++;
    robots.forEach((r, i) => Object.assign(r, parked(i), { battery: r.battery, v: r.v + 1 }));
    for (const l of local.values()) {
      Object.assign(l, { busy: false, why: '', timer: 5, tally: { pallets: 0, booked: 0, bare: 0 } });
      l.avoid.clear();
    }
    claiming.clear();
    open = [];
    finished.clear();
    snapshotAt = -1;
  }

  /** Wat de robot nu doet, in gewone taal. */
  function statusText(r: Robot) {
    const l = state(r);
    if (l.wait) return `wacht: ${l.wait}`;
    if (l.busy) return 'wacht op de WMS';
    if (r.phase === 'toPick') return `pickt ${r.order}: rijdt naar ${r.goal}`;
    if (r.phase === 'picking') return `pickt ${r.order}: pakt van ${r.goal}`;
    if (r.phase === 'toStage') return `zet ${r.order} klaar op ${r.goal}`;
    if (r.phase === 'stuck') return `wacht met ${r.order}: ${l.why}`;
    if (r.phase === 'counting') return `telt pad ${(COUNT_STOPS[r.step]?.a ?? 0) + 1} van ${ROBOT_AISLES.length}`;
    if (r.phase === 'toPickup') return `haalt ${r.task?.palletId} op van ${r.task?.fromLocationId}`;
    if (r.phase === 'toDrop') return `brengt ${r.load?.id ?? r.task?.palletId} naar ${r.task?.toLocationId}`;
    if (r.load) return `wacht met ${r.load.id} op een nieuwe opdracht`;
    if (r.phase === 'home') return 'rijdt naar het laadstation';
    return r.battery < 99.5 ? 'laadt op' : 'vrij';
  }

  return {
    /** De robots (alleen lezen). */
    robots: robots as readonly Robot[],
    update,
    /**
     * De openstaande robotopdrachten uit de WMS. Opdrachten die al een robot hebben of al zijn afgehandeld
     * vallen eruit; wat de WMS niet meer aanbiedt vervalt.
     */
    setTasks(list: RobotTask[]) {
      open = list.filter((t) => !finished.has(t.id) && !robots.some((r) => r.task?.id === t.id));
    },
    /** Alle opdrachten die nog lopen: wachtend op een robot, of onderweg. */
    tasks: (): (RobotTask & { robotId?: string })[] => [
      ...robots.filter((r) => r.task).map((r) => ({ ...r.task!, robotId: r.id })),
      ...open,
    ],
    /** Pallets die na een mislukte opdracht nog op een robot staan: de WMS moet er een nieuwe opdracht voor geven. */
    stranded: () =>
      robots
        .filter((r) => r.load && !r.task && !state(r).busy)
        .map((r) => ({ robotId: r.id, kind: r.kind, palletId: r.load!.id, sku: r.load!.sku, fromLocationId: r.loadFrom ?? '' })),
    unload: world.unload,
    laneRoom: world.laneRoom,
    inbound: world.inbound,
    space: world.space,
    refill: world.refill,
    statusText,
    /** Wacht de robot ergens op (obstakel, bezet pad, de WMS)? */
    waiting: (r: Robot) => !!state(r).wait || state(r).busy,
    /** Mogen de pickrobots orders pakken, en mag de telrobot zijn rondes rijden? Een lopende order maakt de robot af. */
    setAuto(on: { pick: boolean; count: boolean }) {
      Object.assign(auto, on);
    },
    /** Waar de robots voor moeten stoppen: spelers en voertuigen. */
    setObstacles(source: () => Obstacle[]) {
      obstacles = source;
    },
    shared,
    applyShared,
    reset,
  };
}

export type RobotFleet = ReturnType<typeof createRobotFleet>;
