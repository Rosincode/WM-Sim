import type { ProcessEvent } from './events';
import { AISLE_Z, HALL, LEVEL_Y, ROW_AISLE, ROW_Z, SECTION_PITCH, SECTION_X, dist, type Point } from './layout';
import type { Pallet } from './warehouse';
import type { WmsReply } from './wms';

// De Geek+-robots. Er zijn twee soorten:
// - de tilrobot (lift): een lage robot die onder een pallet rijdt, hem optilt en wegbrengt. Hij komt alleen bij
//   wat op de vloer staat: de inslagbanen bij de docks en de onderste laag van de stellingen.
// - de robot-heftruck (fork): een onbemande stapelaar met een mast. Hij pakt een pallet vanuit het pad met zijn
//   vorken en komt daarmee ook bij de hogere niveaus van de stellingen.
// De WMS stuurt ze aan met robotopdrachten (breng pallet X van locatie A naar locatie B). De game speelt de
// vlootsturing en de robots zelf: hij wijst een opdracht toe aan een vrije robot, laat die rijden en meldt
// elke stap terug aan de WMS (gestart, afgerond, mislukt). Zoals overal in de sim geldt: eerst de WMS, dan
// fysiek. Pas als de WMS het afronden heeft geaccepteerd zet de robot de pallet neer.
//
// Elk pad tussen de stellingen heeft zijn eigen robot (om en om een tilrobot en een robot-heftruck), met een
// laadstation aan het eind van dat pad tegen de oostwand. Ze rijden over de paden (één robot per pad tegelijk)
// en wisselen van pad via de robotbaan aan de oostkant van de hal.
// Multiplayer: iedereen laat de robots lokaal rijden; alleen de host beslist (oppakken, neerzetten, de WMS vragen).

/**
 * Een opdracht van de WMS: breng deze pallet van de ene locatie naar de andere.
 * kind 'unload' = lossen: van de vrachtwagen aan de dockdeur (fromLocationId = DOCK-NN) naar de inslagbaan.
 */
export type RobotTask = { id: string; palletId: string; fromLocationId: string; toLocationId: string; kind?: 'unload' };
/** idle = bij het laadstation; home = onderweg daarheen. */
export type RobotPhase = 'idle' | 'toPickup' | 'toDrop' | 'home';
export type RobotKind = 'lift' | 'fork';
/**
 * a = het pad waarin de robot is zodra hij dit punt bereikt (-1 = robotbaan of laadstation).
 * h = hoogte (m) van de vorken voordat de robot-heftruck naar dit punt rijdt (standaard 0: rijhoogte).
 * back = achteruit naar dit punt rijden: de robot-heftruck rijdt zo een stelling uit en zijn laadstation in.
 */
type Waypoint = Point & { a: number; detour?: boolean; h?: number; back?: boolean };
/** Een palletplek met zijn niveau in de stelling (1 = op de vloer). */
export type RobotSpot = Point & { level: number };
export type Robot = {
  id: string;
  kind: RobotKind;
  /** Hoogte (m) van de vorken van een robot-heftruck; 0 bij een tilrobot. */
  fork: number;
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
}

/** Rijsnelheid (m/s) en draaisnelheid (rad/s). */
const SPEED = 1.8;
const TURN = 3.5;
/** Hefsnelheid (m/s) van de vorken van een robot-heftruck. */
const LIFT_SPEED = 0.9;
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
/** De laadstations tegen de oostwand: één per pad, aan het eind van dat pad. Elk pad heeft zijn eigen robot. */
export const ROBOT_CHARGERS: Point[] = FITS ? ROBOT_AISLES.map((z) => ({ x: HALL.w / 2 - 1.2, z })) : [];
/** De soort robot per pad: om en om een tilrobot en een robot-heftruck. */
export const ROBOT_KINDS: RobotKind[] = ROBOT_CHARGERS.map((_, i) => (i % 2 ? 'fork' : 'lift'));
/**
 * Waar robot i bij zijn laadstation staat. De tilrobot staat er met zijn neus tegenaan; de robot-heftruck
 * staat er met zijn rug tegenaan, de vorken naar de hal.
 */
const parkPose = (i: number) =>
  ROBOT_KINDS[i] === 'fork'
    ? { x: ROBOT_CHARGERS[i].x - 0.25, z: ROBOT_CHARGERS[i].z, r: -Math.PI / 2 }
    : { ...ROBOT_CHARGERS[i], r: Math.PI / 2 };

const angle = (to: number, from: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const nearestAisle = (z: number) => ROBOT_AISLES.reduce((best, az, i) => (Math.abs(az - z) < Math.abs(ROBOT_AISLES[best] - z) ? i : best), 0);
/** Vanuit welke paden is dit punt te bereiken? Een stellingrij alleen vanuit zijn eigen pad, een inslagbaan vanuit het pad ervoor. */
function aislesFor(p: Point): number[] {
  const row = ROW_Z.findIndex((z) => Math.abs(z - p.z) < 0.01);
  return [row < 0 ? nearestAisle(p.z) : ROW_AISLE[row]];
}

export function createRobotFleet(world: RobotWorld) {
  const parked = (i: number): Robot => ({
    id: `${ROBOT_KINDS[i] === 'fork' ? 'GKF' : 'GKP'}-${String(i + 1).padStart(2, '0')}`,
    kind: ROBOT_KINDS[i],
    fork: 0,
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
  const local = new Map(robots.map((r) => [r.id, { wait: '', blocked: 0, busy: false }]));
  const state = (r: Robot) => local.get(r.id)!;
  /** Opdrachten van de WMS die nog geen robot hebben. */
  let open: RobotTask[] = [];
  /** Afgehandelde opdrachten: een stand uit de WMS van net daarvoor mag ze niet opnieuw aanbieden. */
  const finished = new Set<string>();
  let obstacles: () => Obstacle[] = () => [];
  /** Telt de resets van de hal: een antwoord van de WMS op een vraag van vóór de reset telt niet meer. */
  let resets = 0;

  // ========== Route ==========

  /**
   * Route over de paden en de robotbaan naar een palletplek (of, zonder plek, naar het eigen laadstation).
   * Een tilrobot rijdt tot onder de pallet; een robot-heftruck stopt ervoor, met de vorken op de hoogte van de plek.
   */
  function route(r: Robot, goal: RobotSpot | null): Waypoint[] {
    const path: Waypoint[] = [];
    const fork = r.kind === 'fork';
    const goalAisles = goal ? aislesFor(goal) : [];
    /** Het laatste stuk: vanaf het midden van het pad naar de pallet. */
    const reach = (a: number): Waypoint[] => {
      if (!goal) return [];
      const az = ROBOT_AISLES[a];
      if (!fork) return [{ x: goal.x, z: az, a }, { x: goal.x, z: goal.z, a }];
      const side = goal.z >= az ? 1 : -1;
      return [{ x: goal.x, z: az, a }, { x: goal.x, z: goal.z - side * ROBOT_FORK_REACH, a, h: LEVEL_Y[goal.level] ?? 0 }];
    };
    let z = r.z;
    const corridor = (toZ: number) => ROBOT_CORRIDOR_X + (toZ >= z ? LANE : -LANE);
    if (r.aisle >= 0) {
      const az = ROBOT_AISLES[r.aisle];
      if (Math.abs(r.z - az) > 0.01) {
        // Eerst terug naar het midden van het pad. Een robot-heftruck rijdt achteruit de stelling uit en laat
        // daar zijn vorken zakken voordat hij draait.
        if (fork) path.push({ x: r.x, z: az, a: r.aisle, back: true, h: r.fork }, { x: r.x, z: az, a: r.aisle, back: true });
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
    // Een robot-heftruck is langer (de vorken steken vooruit) en met een pallet ook breder
    const reach = r.kind === 'fork' ? (back ? 0.95 : 1.5) : 0.7;
    const width = r.kind === 'fork' ? 0.55 : 0.4;
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
    // De robot-heftruck zet zijn vorken op hoogte voordat hij verder rijdt
    const h = wp.h ?? 0;
    if (r.kind === 'fork' && r.fork !== h) {
      r.fork += Math.max(-LIFT_SPEED * dt, Math.min(LIFT_SPEED * dt, h - r.fork));
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
        const able = robots.filter((r) => !high || r.kind === 'fork');
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

  /** De robot is aangekomen: oppakken, neerzetten of parkeren. */
  function arrive(r: Robot) {
    const task = r.task;
    if (r.phase === 'home') {
      r.phase = 'idle';
      r.r = parkPose(robots.indexOf(r)).r;
      return decided(r);
    }
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
    for (const r of robots) if (r.path.length === 0 && r.phase !== 'idle' && !state(r).busy) arrive(r);
    if (open.length) assign();
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
    open = [];
    finished.clear();
    snapshotAt = -1;
  }

  /** Wat de robot nu doet, in gewone taal. */
  function statusText(r: Robot) {
    const l = state(r);
    if (l.wait) return `wacht: ${l.wait}`;
    if (l.busy) return 'wacht op de WMS';
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
