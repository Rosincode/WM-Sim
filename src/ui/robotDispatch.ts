import { onProcessEvent } from '../sim/events';
import { DOCKS } from '../sim/layout';
import type { RobotFleet, RobotTask } from '../sim/robots';
import { robotApi } from './wmsGateway';

// Haalt de robotopdrachten op waar de Geek+-robots mee werken (src/sim/robots.ts).
// - Kent de WMS-client de robotacties (docs/wms/08), dan komen de opdrachten uit de WMS: die is leidend.
// - Zolang dat niet zo is (de mock, of een WMS waar de robots nog niet in zitten) speelt dit bestand de
//   robotsturing van de WMS na: elke pallet in een aangemelde vrachtwagen krijgt een losopdracht naar de inslagbaan
//   van dat dock, elke getelde pallet met sticker op een inslagbaan een opdracht naar een vrije locatie in de
//   stellingen (eerst de vloer, dan hoger), en een lege vloerlocatie wordt aangevuld met een pallet van erboven.
//   Het verplaatsen zelf wordt dan in de WMS geboekt met confirm_putaway.
// In multiplayer doet alleen de host dit; de andere spelers krijgen de robots via de gedeelde wereld.

const POLL_SECONDS = 2;
/** Zoveel nagespeelde opdrachten staan er hooguit te wachten op een robot: zo blijft het plan actueel. */
const MAX_WAITING = 3;
const ENABLED_KEY = 'wm-sim.robots';

export function createRobotDispatch({
  fleet,
  authority,
  bypass,
}: {
  fleet: RobotFleet;
  /** false: een andere speler is host. */
  authority: () => boolean;
  /** true: de WMS van deze speler loopt niet gelijk met de gedeelde wereld en wordt overgeslagen. */
  bypass: () => boolean;
}) {
  let timer = POLL_SECONDS;
  let polling = false;
  let error = '';
  let fromWms = false;
  let enabled = true;
  try {
    enabled = localStorage.getItem(ENABLED_KEY) !== 'off';
  } catch {
    // geen localStorage: de robots staan aan
  }
  let seq = 1;
  const stamp = Date.now().toString(36).slice(-4).toUpperCase();
  /** Nagespeelde opdrachten, en per pallet de locaties waar het wegzetten mislukte (die niet opnieuw proberen). */
  const issued = new Map<string, RobotTask>();
  const avoid = new Map<string, Set<string>>();
  onProcessEvent((e) => {
    if (e.type !== 'RobotTaskFailed' && e.type !== 'RobotTaskCompleted') return;
    const task = issued.get(e.taskId);
    issued.delete(e.taskId);
    if (!task || e.type !== 'RobotTaskFailed' || task.kind === 'unload') return; // lossen kan later opnieuw
    if (!avoid.has(task.palletId)) avoid.set(task.palletId, new Set());
    avoid.get(task.palletId)!.add(task.toLocationId);
  });

  /** De robotsturing van de WMS nagespeeld: pallets op de inslagbanen naar een vrije locatie, en lege vloerlocaties aanvullen. */
  function plan(): RobotTask[] {
    const tasks = fleet.tasks();
    const waiting: RobotTask[] = tasks.filter((t) => !t.robotId).map(({ robotId: _robot, ...t }) => t);
    const planned = new Set(tasks.map((t) => t.palletId));
    const targeted = new Map<string, number>();
    for (const t of tasks) targeted.set(t.toLocationId, (targeted.get(t.toLocationId) ?? 0) + 1);
    // Eerst de pallets die na een mislukte opdracht nog op een robot staan, dan de inslagbanen
    const work = [
      ...fleet.stranded().map((s) => ({ ...s, locationId: s.fromLocationId, floorOnly: s.kind !== 'fork', z: fleet.robots.find((r) => r.id === s.robotId)?.z ?? 0 })),
      ...fleet.inbound().map((p) => ({ ...p, floorOnly: false })),
    ];
    const add = (palletId: string, fromLocationId: string, toLocationId: string, kind?: 'unload') => {
      const task: RobotTask = { id: `RT-${stamp}-${String(seq++).padStart(3, '0')}`, palletId, fromLocationId, toLocationId, ...(kind && { kind }) };
      issued.set(task.id, task);
      waiting.push(task);
      planned.add(palletId);
      targeted.set(toLocationId, (targeted.get(toLocationId) ?? 0) + 1);
    };
    // Lossen: een pallet uit een aangemelde vrachtwagen naar de inslagbaan van dat dock, zolang daar plek is
    for (const u of fleet.unload()) {
      if (waiting.length >= MAX_WAITING) break;
      if (planned.has(u.palletId) || u.free <= (targeted.get(u.toLocationId) ?? 0)) continue;
      add(u.palletId, u.fromLocationId, u.toLocationId, 'unload');
    }
    for (const w of work) {
      if (waiting.length >= MAX_WAITING) break;
      if (planned.has(w.palletId)) continue;
      // Bij het lossen blijven steken (de baan was vol): alsnog naar de inslagbaan, daar wordt hij eerst geteld
      const door = DOCKS.find((d) => d.id === w.locationId);
      if (door) {
        if (fleet.laneRoom(door.inId) > (targeted.get(door.inId) ?? 0)) add(w.palletId, door.id, door.inId, 'unload');
        continue;
      }
      const spot = fleet
        .space(w.sku)
        // een pallet die op een tilrobot staat kan alleen naar de vloer
        .filter((s) => (!w.floorOnly || s.level === 1) && s.free > (targeted.get(s.locationId) ?? 0) && !avoid.get(w.palletId)?.has(s.locationId))
        // zo dicht mogelijk bij het dock, eerst de vloer, en dan bij voorkeur bij hetzelfde artikel
        .sort((a, b) => Math.abs(a.z - w.z) - Math.abs(b.z - w.z) || a.level - b.level || Number(b.sameSku) - Number(a.sameSku) || a.x - b.x)[0];
      if (spot) add(w.palletId, w.locationId, spot.locationId);
    }
    // Een lege vloerlocatie (de pickplek) aanvullen: een robot-heftruck haalt de pallet van erboven naar beneden
    for (const f of fleet.refill()) {
      if (waiting.length >= MAX_WAITING) break;
      if (planned.has(f.palletId) || targeted.get(f.toLocationId) || avoid.get(f.palletId)?.has(f.toLocationId)) continue;
      add(f.palletId, f.fromLocationId, f.toLocationId);
    }
    return waiting;
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const api = bypass() ? null : robotApi();
      fromWms = !!api;
      const tasks = api ? await api.getRobotTasks() : enabled ? plan() : [];
      if (authority()) fleet.setTasks(tasks);
      error = '';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      polling = false;
    }
  }

  return {
    update(dt: number) {
      if ((timer -= dt) > 0) return;
      timer = POLL_SECONDS;
      if (authority()) void poll();
    },
    /** true: de opdrachten komen uit de WMS; false: de game speelt de robotsturing na. */
    get fromWms() {
      return fromWms;
    },
    /** Waarom het ophalen van de opdrachten uit de WMS mislukte, of ''. */
    get error() {
      return error;
    },
    /** Staat de nagespeelde robotsturing aan? (Geldt alleen zolang de WMS zelf geen opdrachten uitgeeft.) */
    get enabled() {
      return enabled;
    },
    setEnabled(on: boolean) {
      enabled = on;
      timer = 0;
      try {
        localStorage.setItem(ENABLED_KEY, on ? 'on' : 'off');
      } catch {
        // niet bewaard: geldt dan alleen voor deze sessie
      }
    },
  };
}

export type RobotDispatch = ReturnType<typeof createRobotDispatch>;
