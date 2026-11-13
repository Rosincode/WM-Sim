import { DOCKS, LANE_LENGTH, dist, type Point } from './layout';

// De telrobot. Hij rijdt langs de inslagbanen en telt elke pallet die daar is neergezet: pas na de telling
// mag een pallet naar de stellingen. Zit er nog geen sticker op, dan plakt hij die meteen (register_pallet).
// Zoals bij de andere robots laat elke speler hem lokaal rijden en beslist alleen de host.

export type CounterPhase = 'idle' | 'toPallet' | 'counting' | 'home';
export type Counter = {
  id: string;
  x: number;
  z: number;
  /** Rijrichting (radialen om de verticale as); vooruit = (sin r, cos r). */
  r: number;
  phase: CounterPhase;
  path: Point[];
  /** De pallet die hij gaat tellen of nu telt. */
  palletId: string | null;
  /** Seconden die het tellen nog duurt. */
  timer: number;
  /** Telt elke beslissing; in multiplayer wint de hoogste stand. */
  v: number;
};

/** Iets waar de telrobot voor stopt: een speler, een voertuig, een andere robot. */
export type CounterObstacle = Point & { rad: number };

/** Wat de telrobot van de fysieke wereld nodig heeft; ingevuld door src/sim/warehouse.ts. */
export interface CounterWorld {
  /** false: een andere speler is host en beslist. */
  authority(): boolean;
  revision(): number;
  /** Mag de telrobot werken? */
  enabled(): boolean;
  touch(): void;
  /** Pallets op de inslagbanen die nog niet geteld zijn, met het midden van hun palletplek. */
  uncounted(): (Point & { palletId: string })[];
  /** Telt de pallet en legt de telling vast; false = dat lukte (nu) niet. */
  count(palletId: string): Promise<boolean>;
}

const SPEED = 1.4;
const TURN = 4;
const COUNT_SECONDS = 2.5;
/** Na een mislukte telling probeert de robot dezelfde pallet pas na zoveel seconden opnieuw. */
const RETRY_SECONDS = 30;
/** De rijlijn (x) langs de koppen van de banen, aan de halkant. */
const RUN_X = (DOCKS[0]?.laneIn.x ?? 0) + LANE_LENGTH / 2 + 0.8;
/** Zo ver (m) naast het midden van de baan rijdt de robot: tussen deze inslagbaan en de uitslagbaan van het dock ernaast. */
const SIDE = 1.1;
export const COUNTER_HOME: Point = { x: RUN_X, z: (DOCKS[0]?.laneIn.z ?? 0) - 3 };

const angle = (to: number, from: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

export function createCounter(world: CounterWorld) {
  const parked = (): Counter => ({ id: 'TEL-01', ...COUNTER_HOME, r: Math.PI, phase: 'idle', path: [], palletId: null, timer: 0, v: 0 });
  const robot = parked();
  /** Er loopt een vraag bij de WMS. */
  let busy = false;
  let clock = 0;
  const retryAt = new Map<string, number>();
  let resets = 0;
  let snapshot = parked();
  let snapshotAt = -1;
  let obstacles: () => CounterObstacle[] = () => [];

  /** Eerst terug naar de rijlijn, daarlangs naar de baan, en dan naast de baan naar de pallet. */
  function pathTo(target: Point): Point[] {
    if (Math.abs(robot.z - target.z) < 0.05) return [target];
    return [{ x: RUN_X, z: robot.z }, { x: RUN_X, z: target.z }, target];
  }

  function drive(dt: number) {
    const wp = robot.path[0];
    if (!wp) return;
    const dx = wp.x - robot.x;
    const dz = wp.z - robot.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.02) {
      const turn = angle(Math.atan2(dx, dz), robot.r);
      robot.r += Math.max(-TURN * dt, Math.min(TURN * dt, turn));
      if (Math.abs(turn) > 0.25) return; // eerst draaien, dan rijden
      // Staat er iets of iemand in de weg, dan wacht hij: hij rijdt nergens doorheen
      const blocked = obstacles().some((o) => {
        const along = ((o.x - robot.x) * dx + (o.z - robot.z) * dz) / d;
        const side = ((o.x - robot.x) * dz - (o.z - robot.z) * dx) / d;
        return along > 0 && along < 0.6 + o.rad && Math.abs(side) < 0.3 + o.rad;
      });
      if (blocked) return;
      const step = Math.min(d, SPEED * dt);
      robot.x += (dx / d) * step;
      robot.z += (dz / d) * step;
      if (step < d) return;
    }
    robot.x = wp.x;
    robot.z = wp.z;
    robot.path.shift();
  }

  function decided() {
    robot.v++;
    world.touch();
  }

  /** Pallets die nu geteld kunnen worden. */
  const jobs = () => (world.enabled() ? world.uncounted().filter((p) => (retryAt.get(p.palletId) ?? 0) <= clock) : []);

  /** De volgende pallet om te tellen (de dichtstbijzijnde), of naar huis. */
  function next() {
    const job = jobs().sort((a, b) => dist(a, robot) - dist(b, robot))[0];
    if (job) {
      robot.phase = 'toPallet';
      robot.palletId = job.palletId;
      robot.path = pathTo({ x: job.x, z: job.z - SIDE });
      return decided();
    }
    if (robot.phase === 'idle') return;
    robot.palletId = null;
    const home = dist(robot, COUNTER_HOME) < 0.05;
    robot.phase = home ? 'idle' : 'home';
    robot.path = home ? [] : pathTo(COUNTER_HOME);
    decided();
  }

  async function count(palletId: string) {
    const before = resets;
    busy = true;
    const ok = await world.count(palletId);
    busy = false;
    if (resets !== before) return; // intussen is de hal gereset
    if (!ok) retryAt.set(palletId, clock + RETRY_SECONDS);
    next();
  }

  function update(dt: number) {
    clock += dt;
    drive(dt);
    if (robot.phase === 'counting') {
      robot.timer = Math.max(0, robot.timer - dt);
      robot.r += Math.max(-TURN * dt, Math.min(TURN * dt, angle(0, robot.r))); // kijkt naar de pallet (+z)
    }
    if (!world.authority() || busy) return;
    const here = () => world.uncounted().some((p) => p.palletId === robot.palletId);
    if ((robot.phase === 'idle' || robot.phase === 'home') && jobs().length) return next();
    if (robot.path.length || robot.phase === 'idle') return;
    if (robot.phase === 'home') {
      robot.phase = 'idle';
      return decided();
    }
    if (robot.phase === 'toPallet') {
      if (!here()) return next(); // de pallet is intussen weg
      robot.phase = 'counting';
      robot.timer = COUNT_SECONDS;
      return decided();
    }
    if (robot.phase === 'counting' && robot.timer === 0) {
      if (!here() || !robot.palletId) return next();
      void count(robot.palletId);
    }
  }

  return {
    /** De telrobot (alleen lezen). */
    robot: robot as Readonly<Counter>,
    update,
    /** Waar de telrobot voor stopt: spelers, voertuigen en de andere robots. */
    setObstacles(source: () => CounterObstacle[]) {
      obstacles = source;
    },
    statusText() {
      if (busy) return 'wacht op de WMS';
      if (robot.phase === 'toPallet') return `rijdt naar ${robot.palletId}`;
      if (robot.phase === 'counting') return `telt ${robot.palletId}`;
      return robot.phase === 'home' ? 'rijdt terug' : 'vrij';
    },
    /** Voor de gedeelde wereld; alleen ververst als de wereld verandert, zodat het rijden zelf niet als wijziging telt. */
    shared(): Counter {
      if (snapshotAt !== world.revision()) {
        snapshotAt = world.revision();
        snapshot = structuredClone(robot);
      }
      return snapshot;
    },
    /** Neemt de telrobot van een andere speler over, alleen als die verder is dan de eigen stand. */
    applyShared(s: Counter | undefined) {
      if (!s || !(s.v > robot.v) || !Array.isArray(s.path)) return;
      const here = dist(robot, s) < 1.5 ? { x: robot.x, z: robot.z, r: robot.r } : null; // niet verspringen
      Object.assign(robot, structuredClone(s), here);
      snapshotAt = -1;
    },
    /** De hal wordt gereset: terug naar zijn plek. */
    reset() {
      resets++;
      retryAt.clear();
      Object.assign(robot, parked(), { v: robot.v + 1 });
      snapshotAt = -1;
    },
  };
}

export type CounterRobot = ReturnType<typeof createCounter>;
