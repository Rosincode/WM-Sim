import { TRUCK } from './drivers';
import { DOCKS, HALL } from './layout';

// Het buitenterrein als rijroute: de openbare weg, de inrit met de slagboom, het vrachtwagenterrein voor de docks.
// Een vrachtwagen komt altijd over de weg aanrijden, draait de inrit op, rijdt het terrein op tot voorbij zijn
// dock en steekt dan achteruit het dock in (achteruit insturen, vooruit rechtzetten, recht achteruit). Vertrekken
// gaat vooruit het dock uit, via de inrit de weg op.
// Een route is een rij rechte stukken en bochten (createRoute) met een snelheid per stuk; daaruit volgt waar het
// voertuig op elk moment is. Dezelfde bouwer is bruikbaar voor andere voertuigen (auto's naar de parkeerplaats).
// De maten hier horen bij het terrein dat src/ui/scene/exterior.ts tekent.

const X0 = -HALL.w / 2;
/** De openbare weg (langs x): het hart, en de rijstroken naar het westen (kant van de hal) en naar het oosten. */
export const ROAD = { z: HALL.d / 2 + 38, westZ: HALL.d / 2 + 37, eastZ: HALL.d / 2 + 40 };
/** De inrit van het terrein (langs z): de stroken het terrein op en af, en waar hij op het terrein uitkomt. */
export const YARD_DRIVE = { minX: X0 - 44, maxX: X0 - 34, inX: X0 - 37.5, outX: X0 - 41, yardZ: HALL.d / 2 + 8 };
/** De slagboom over de inrit. */
export const GATE = { z: YARD_DRIVE.yardZ + 6 };
/** De rijlijn (x) over het terrein langs de docks: van hieruit steekt een wagen zijn dock in. */
const LANE_X = X0 - 21;
/** Zo ver (m) rijdt een voertuig over de weg voor het de inrit bereikt, of nadat het de weg op is gedraaid. */
const ROAD_RUN = 220;
/** Bochtstraal (m) van een vrachtwagen, gemeten op de achteras. */
const RADIUS = 8;
/** Zo ver (m) zit de achteras voor de achterkant van de laadbak (het nulpunt van het model). */
const AXLE = 2.15;
/** Snelheden (m/s): op de weg, op het terrein, in een bocht, achteruit. */
const SPEED = { road: 20, yard: 6, turn: 4, steer: 2.6, back: 2.4 };

/** Waar een voertuig staat: het nulpunt van het model, de draaiing om y, en hoe ver de achterdeuren open zijn (0..1). */
export type VehiclePose = { x: number; z: number; r: number; doors: number };
type Sample = { t: number; x: number; z: number; a: number; doors: number };
export type Route = { seconds: number; at(seconds: number): VehiclePose };

/**
 * Bouwt een rijroute vanaf een beginpunt. Het punt dat de route volgt is de achteras; de kijkrichting `a` is de hoek
 * van de rijrichting in het vlak (cos a langs x, sin a langs z). Stukken: rechtuit, een bocht (links of rechts
 * sturen, vooruit of achteruit) en stilstaan. Tussen vooruit en achteruit, bij stilstaan en aan het eind (tenzij
 * `rolling`) staat het voertuig stil; ertussen trekt het op en remt het af.
 * @param axle afstand van het gevolgde punt tot het nulpunt van het model (dat ligt erachter)
 */
export function createRoute(start: { x: number; z: number; a: number; doors?: number; rolling?: boolean }, axle = AXLE) {
  const STEP = 0.25;
  const ACCEL = 1.2;
  const BRAKE = 1.8;
  /** Punten op gelijke afstand langs de route; `stop` = hier staat het voertuig stil, `wait` = zo lang (s). */
  type Node = { x: number; z: number; a: number; limit: number; stop: boolean; wait: number; doors: number };
  let { x, z, a } = start;
  let doors = start.doors ?? 0;
  let reverse = false;
  const nodes: Node[] = [{ x, z, a, limit: 0, stop: !start.rolling, wait: 0, doors }];
  const last = () => nodes[nodes.length - 1];

  function move(length: number, speed: number, back: boolean, turn: number) {
    if (length <= 0) return api;
    if (back !== reverse) last().stop = true;
    reverse = back;
    const n = Math.max(1, Math.round(length / STEP));
    const ds = length / n;
    for (let i = 0; i < n; i++) {
      // midden van het stapje als richting: zo blijft een bocht een nette cirkel
      const mid = a + (turn * ds) / 2;
      const dir = back ? -1 : 1;
      x += Math.cos(mid) * ds * dir;
      z += Math.sin(mid) * ds * dir;
      a += turn * ds;
      nodes.push({ x, z, a, limit: speed, stop: false, wait: 0, doors });
    }
    return api;
  }

  const api = {
    /** Rechtuit, `back` = achteruit. */
    straight: (length: number, speed: number, back = false) => move(length, speed, back, 0),
    /**
     * Een bocht van `angle` (rad) met het stuur naar links of rechts. Vooruit draait de neus naar die kant; achteruit
     * zwenkt de achterkant ernaartoe.
     */
    turn(side: 'left' | 'right', angle: number, radius: number, speed: number, back = false) {
      const steer = (side === 'left' ? -1 : 1) * (back ? -1 : 1);
      return move(angle * radius, speed, back, steer / radius);
    },
    /** Stilstaan; met `doorsTo` gaan intussen de achterdeuren open (1) of dicht (0). */
    pause(seconds: number, doorsTo = doors) {
      const n = last();
      n.stop = true;
      n.wait += seconds;
      n.doors = doors = doorsTo;
      return api;
    },
    /** @param rolling het voertuig rijdt aan het eind door (het verdwijnt uit beeld) in plaats van te stoppen */
    build(rolling = false): Route {
      if (!rolling) last().stop = true;
      // Snelheid per punt: nooit boven de limiet van het stuk, en zo dat optrekken en remmen haalbaar zijn
      const v = nodes.map((n, i) => (n.stop ? 0 : Math.min(n.limit || Infinity, nodes[i + 1]?.limit ?? n.limit)));
      const gap = (i: number) => Math.hypot(nodes[i + 1].x - nodes[i].x, nodes[i + 1].z - nodes[i].z);
      for (let i = 1; i < v.length; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * ACCEL * gap(i - 1)));
      for (let i = v.length - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * BRAKE * gap(i)));
      const samples: Sample[] = [];
      let t = 0;
      let open = start.doors ?? 0;
      nodes.forEach((n, i) => {
        if (i > 0) t += gap(i - 1) / Math.max(0.2, (v[i - 1] + v[i]) / 2);
        samples.push({ t, x: n.x, z: n.z, a: n.a, doors: open });
        if (n.wait > 0) samples.push({ t: (t += n.wait), x: n.x, z: n.z, a: n.a, doors: (open = n.doors) });
      });
      const seconds = t;
      return {
        seconds,
        at(time) {
          const s = Math.max(0, Math.min(seconds, time));
          let lo = 0;
          let hi = samples.length - 1;
          while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (samples[mid].t <= s) lo = mid;
            else hi = mid;
          }
          const p = samples[lo];
          const q = samples[hi];
          const f = q.t > p.t ? (s - p.t) / (q.t - p.t) : 0;
          const angle = p.a + (q.a - p.a) * f;
          return {
            x: p.x + (q.x - p.x) * f - Math.cos(angle) * axle,
            z: p.z + (q.z - p.z) * f - Math.sin(angle) * axle,
            r: Math.PI - angle, // het model kijkt naar -x
            doors: p.doors + (q.doors - p.doors) * f,
          };
        },
      };
    },
  };
  return api;
}

// ========== Vrachtwagens ==========

const WEST = Math.PI;
const QUARTER = Math.PI / 2;
/** Het steken: zo ver (rad) draait de wagen achteruit in, de rest van de kwartslag trekt hij vooruit recht. */
const STEER_IN = Math.PI / 3;
/** De achteras van een wagen die tegen het dock staat. */
const DOCKED_X = TRUCK.rear - AXLE;

/** Over de weg vanuit het oosten, de inrit op, het terrein over, steken en achteruit tegen het dock. */
function arrival(dockZ: number): Route {
  const R = RADIUS;
  // Na het steken staat de wagen weer op de rijlijn, recht voor zijn dock: daarvoor moet hij er zo ver voorbij
  const past = R * Math.sin(STEER_IN) - R * (1 - Math.sin(STEER_IN));
  const laneFromZ = YARD_DRIVE.yardZ - 2 * R;
  return createRoute({ x: YARD_DRIVE.inX + R + ROAD_RUN, z: ROAD.westZ, a: WEST, rolling: true })
    .straight(ROAD_RUN, SPEED.road)
    .turn('right', QUARTER, R, SPEED.turn) // de inrit op
    .straight(ROAD.westZ - R - YARD_DRIVE.yardZ, SPEED.yard) // onder de slagboom door
    .turn('right', QUARTER, R, SPEED.turn)
    .straight(LANE_X - R - (YARD_DRIVE.inX + R), SPEED.yard)
    .turn('left', QUARTER, R, SPEED.turn) // de rijlijn langs de docks op
    .straight(Math.max(0, laneFromZ - (dockZ - past)), SPEED.yard) // tot voorbij het dock
    .pause(1)
    .turn('right', STEER_IN, R, SPEED.back, true) // achteruit insturen: de achterkant zwenkt naar het dock
    .pause(0.8)
    .turn('left', QUARTER - STEER_IN, R, SPEED.steer) // vooruit rechtzetten
    .pause(2.2, 1) // de chauffeur zet de achterdeuren open
    .straight(DOCKED_X - LANE_X, SPEED.back, true)
    .build();
}

/** Vooruit het dock uit, over het terrein naar de inrit en de weg op naar het oosten. */
function departure(dockZ: number): Route {
  const R = RADIUS;
  return createRoute({ x: DOCKED_X, z: dockZ, a: WEST, doors: 1 })
    .pause(0.5)
    .straight(4, SPEED.steer) // een stukje van het dock af, dan de deuren dicht
    .pause(2, 0)
    .straight(DOCKED_X - 4 - (YARD_DRIVE.outX + R), SPEED.yard)
    .turn('left', QUARTER, R, SPEED.turn)
    .straight(Math.max(0, ROAD.eastZ - R - (dockZ + R)), SPEED.yard) // de inrit af, onder de slagboom door
    .turn('left', QUARTER, R, SPEED.turn) // de weg op
    .straight(ROAD_RUN, SPEED.road)
    .build(true);
}

const routes = new Map<string, Route>();
function truckRoute(dock: number, departing: boolean) {
  const key = `${dock}|${departing}`;
  let r = routes.get(key);
  if (!r) routes.set(key, (r = (departing ? departure : arrival)(DOCKS[dock]?.z ?? 0)));
  return r;
}

/** Zo lang (s) doet een vrachtwagen over aankomen bij, of vertrekken van, dit dock. */
export const truckSeconds = (dock: number, departing: boolean) => truckRoute(dock, departing).seconds;

/**
 * Waar de vrachtwagen van een dock staat. @param t de voortgang uit de sim: 0 = op de weg, 1 = tegen het dock
 * (bij aankomen loopt hij op, bij vertrekken terug).
 */
export function truckPose(dock: number, departing: boolean, t: number): VehiclePose {
  if (t >= 1) return { x: TRUCK.rear, z: DOCKS[dock]?.z ?? 0, r: 0, doors: 1 };
  const route = truckRoute(dock, departing);
  return route.at((departing ? 1 - t : t) * route.seconds);
}

/** Staat er een voertuig bij de slagboom (dan gaat hij open)? */
export const atGate = (p: { x: number; z: number }) =>
  p.x > YARD_DRIVE.minX - 1 && p.x < YARD_DRIVE.maxX + 1 && p.z > GATE.z - 22 && p.z < GATE.z + 20;
