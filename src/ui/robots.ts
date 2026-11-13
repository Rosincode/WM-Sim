import * as THREE from 'three';
import {
  ROBOT_CHARGERS, ROBOT_CHARGER_PITCH, ROBOT_FORK_REACH, ROBOT_HITCH, ROBOT_PICK_SECONDS,
  type Obstacle, type RobotFleet, type RobotKind,
} from '../sim/robots';
import { menu } from './menu';
import type { RobotDispatch } from './robotDispatch';
import { COUNT_ROBOT_BODY, createCountRobot } from './scene/countRobot';
import { FORK_ROBOT_BODY, createForkRobot } from './scene/forkRobot';
import { ROBOT_DECK, ROBOT_HALF, createGeekRobot, createRobotCharger } from './scene/geekRobot';
import { PICK_ROBOT_BODY, PICK_ROBOT_DECK, createPickRobot } from './scene/pickRobot';
import type { Hall, Solid } from './scene/warehouse';
import type { SoundSource } from './sounds';
import { dropLoad, loadTop, type OrderLoads } from './warehouseView';

// De Geek+-robots in beeld: de tilrobots, de robot-heftrucks, de pickrobots en de voorraadteller, wat ze dragen,
// hun laadstations (per pad twee naast elkaar tegen de oostwand) en het onderdeel 'Robots' in het menu.
// Leest alleen de sim (src/sim/robots.ts); de palletopdrachten komen via src/ui/robotDispatch.ts.

const LED = { free: '#3ddc84', busy: '#35a7ff', waiting: '#ffa000' };
const KIND: Record<RobotKind, string> = { lift: 'tilrobot', fork: 'robot-heftruck', pick: 'pickrobot', count: 'voorraadteller' };
const AUTO_KEYS = { pick: 'wm-sim.robots.pick', count: 'wm-sim.robots.count' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const smooth = (t: number) => t * t * (3 - 2 * t);

export function mountRobots({
  scene,
  hall,
  fleet,
  dispatch,
  orderLoads,
  obstacles,
}: {
  scene: THREE.Scene;
  hall: Hall;
  fleet: RobotFleet;
  dispatch: RobotDispatch;
  /** De pallet van een order met de dozen die er al voor gepickt zijn: die staat achter op de pickrobot. */
  orderLoads: OrderLoads;
  /** Waar de robots voor stoppen: spelers, chauffeurs, de heftruck, de pompwagen en losse pallets. */
  obstacles: () => Obstacle[];
}) {
  fleet.setObstacles(obstacles);
  // Elk laadstation is hetzelfde en ze staan op één lijn: de vakken op de vloer sluiten bijna op elkaar aan
  for (const c of ROBOT_CHARGERS) {
    const charger = createRobotCharger(Math.min(1.8, ROBOT_CHARGER_PITCH - 0.4));
    charger.position.set(c.x, 0, c.z);
    scene.add(charger);
  }

  const views = fleet.robots.map((robot) => {
    const lifter = robot.kind === 'lift' ? createGeekRobot() : null;
    const fork = robot.kind === 'fork' ? createForkRobot() : null;
    const picker = robot.kind === 'pick' ? createPickRobot() : null;
    const counter = robot.kind === 'count' ? createCountRobot() : null;
    const mesh = (lifter ?? fork ?? picker ?? counter)!;
    scene.add(mesh.group);
    return {
      robot,
      mesh,
      lifter,
      fork,
      picker,
      counter,
      load: null as THREE.Object3D | null,
      loadKey: '',
      /** Pickrobot: de pallet van zijn order op het laadplateau. */
      order: null as THREE.Object3D | null,
      orderKey: '',
      lift: 0,
      /** Hoe lang (s) de pickrobot al met deze greep bezig is. */
      grab: 0,
      /** Hoe ver (0..1) de arm van de pickrobot is uitgeschoven. */
      reach: 0,
      /** Botsvlakken voor de speler: de robot zelf (draait mee) en wat hij draagt (draait met de robot mee). */
      pose: { x: 0, z: 0, r: 0 },
      loadPose: { x: 0, z: 0, r: 0 },
      /** Stand van de pallet ten opzichte van de robot: vastgelegd bij het optillen, zodat hij dan niet verspringt. */
      loadTurn: 0,
    };
  });

  // ---------- Menu: wat doen de robots, en waar komen hun opdrachten vandaan ----------
  const panel = document.createElement('div');
  panel.className = 'proc-side';
  const list = document.createElement('div');
  const checkbox = (text: string, checked: boolean, change: (on: boolean) => void) => {
    const label = document.createElement('label');
    label.style.cssText = 'display:block;margin-top:10px;cursor:pointer';
    label.innerHTML = '<input type="checkbox" style="margin-right:6px">';
    label.append(text);
    const box = label.querySelector('input')!;
    box.checked = checked;
    box.addEventListener('change', () => {
      change(box.checked);
      box.blur();
    });
    return label;
  };
  // De pickrobots en de voorraadteller werken uit zichzelf; hier zet je ze aan of uit (bewaard in deze browser)
  const auto = { pick: true, count: true };
  for (const k of ['pick', 'count'] as const) {
    try {
      auto[k] = localStorage.getItem(AUTO_KEYS[k]) !== 'off';
    } catch {
      // geen localStorage: de robots staan aan
    }
  }
  fleet.setAuto(auto);
  const setAuto = (k: 'pick' | 'count', on: boolean) => {
    auto[k] = on;
    fleet.setAuto(auto);
    try {
      localStorage.setItem(AUTO_KEYS[k], on ? 'on' : 'off');
    } catch {
      // niet bewaard: geldt dan alleen voor deze sessie
    }
  };
  panel.append(
    list,
    checkbox('Robots laten werken zolang de WMS geen robotopdrachten uitgeeft', dispatch.enabled, (on) => dispatch.setEnabled(on)),
    checkbox('Pickrobots open orders laten picken en klaarzetten', auto.pick, (on) => setAuto('pick', on)),
    checkbox('Voorraadteller zijn rondes door de stellingen laten rijden', auto.count, (on) => setAuto('count', on)),
  );
  menu.addSection('robots', 'Robots', panel, 5);

  let lastHtml = '';
  function renderPanel() {
    const source = dispatch.fromWms
      ? 'De robotopdrachten komen uit de WMS; elke stap wordt daar teruggemeld.'
      : dispatch.enabled
        ? 'De WMS geeft (nog) geen robotopdrachten uit. De game speelt de robotsturing na: elke pallet met sticker op een ' +
          'inslagbaan gaat naar een vrije locatie in de stellingen, en een lege vloerlocatie wordt aangevuld met een pallet ' +
          'van erboven. Het verplaatsen wordt in de WMS geboekt (confirm_putaway).'
        : 'De WMS geeft (nog) geen robotopdrachten uit en de robots staan uit.';
    const robots = fleet.robots
      .map((r) => `<tr><td><b>${r.id}</b></td><td>${KIND[r.kind]}</td><td>${esc(fleet.statusText(r))}</td><td style="text-align:right">${Math.round(r.battery)}%</td></tr>`)
      .join('');
    const tasks = fleet
      .tasks()
      .map((t) => `<tr><td>${esc(t.id)}</td><td>${esc(t.palletId)}</td><td>${esc(t.fromLocationId)} → ${esc(t.toLocationId)}</td>
        <td>${t.robotId ?? 'wacht op een robot'}</td></tr>`)
      .join('');
    const html = `<div style="margin-bottom:8px">${source}</div>
      ${dispatch.error ? `<div style="margin-bottom:8px;color:#ff8a80">Robotopdrachten ophalen mislukt: ${esc(dispatch.error)}</div>` : ''}
      <div style="margin-bottom:8px">Elk pad heeft twee robots voor pallets: een tilrobot voor alles op de vloer (wegzetten en halen) en een
        robot-heftruck voor alles op de hogere niveaus. De pickrobots picken open orders van elk niveau en zetten ze klaar op een uitslaglocatie; de voorraadteller
        scant de palletstickers in de stellingen en boekt verplaatste pallets. Alles gaat langs de WMS, zonder dat er iemand aan te pas komt.</div>
      <h4>Geek+-robots</h4><table>${robots || '<tr><td>In deze hal is geen ruimte voor de robotbaan.</td></tr>'}</table>
      <h4>Opdrachten</h4><table>${tasks || '<tr><td>Geen lopende opdrachten</td></tr>'}</table>`;
    if (html === lastHtml) return;
    lastHtml = html;
    list.innerHTML = html;
  }

  let panelRefresh = 0;
  return {
    /** Voor het geluid (src/ui/sounds.ts): waar elke robot is en hoe ver alles wat heft of uitschuift staat. */
    sources: views.map((v): SoundSource => ({
      get x() { return v.robot.x; },
      get z() { return v.robot.z; },
      get r() { return v.robot.r; },
      get lift() { return v.robot.fork + v.lift * 0.06 + v.reach * 0.3; },
      get waiting() { return fleet.waiting(v.robot); },
    })),
    update(dt: number) {
      for (const v of views) {
        const { robot: r, mesh } = v;
        mesh.group.position.set(r.x, 0, r.z);
        mesh.group.rotation.y = r.r;
        mesh.setLed(fleet.waiting(r) ? LED.waiting : r.phase === 'idle' ? LED.free : LED.busy);

        // De pallet op de robot: zelfde uiterlijk als in de stelling
        const key = r.load ? `${r.load.id}:${r.load.sku}:${r.load.qty}` : '';
        if (key !== v.loadKey) {
          v.loadKey = key;
          if (v.load) scene.remove(v.load);
          v.load = r.load ? hall.buildLoad(r.load.sku, r.load.qty, r.load.id, !r.load.unlabeled) : null;
          if (v.load) {
            // Geen schaduw: anders moet de schaduwkaart elke frame opnieuw voor een rijdende robot
            v.load.traverse((o) => (o.castShadow = false));
            scene.add(v.load);
            // De robot rijdt altijd recht onder de pallet (neus naar +z of -z): de pallet staat dus recht of een halve slag gedraaid
            v.loadTurn = -Math.round(r.r / Math.PI) * Math.PI;
          }
        }
        v.lift = THREE.MathUtils.clamp(v.lift + (r.load ? dt : -dt) / 0.4, 0, 1);
        v.lifter?.setLift(v.lift);
        v.fork?.setFork(r.fork, v.lift);
        v.counter?.setMast(r.fork);
        if (v.picker) {
          // Eén greep: de arm schuift uit naar de doos, pakt hem, trekt hem terug en legt hem op de pallet van de order
          v.grab = r.phase === 'picking' ? v.grab + dt : 0;
          const t = Math.min(1, v.grab / ROBOT_PICK_SECONDS);
          const reach = r.phase !== 'picking' ? 0 : t < 0.35 ? smooth(t / 0.35) : t < 0.5 ? 1 : t < 0.85 ? 1 - smooth((t - 0.5) / 0.35) : 0;
          v.reach = reach;
          v.picker.setArm(r.fork, reach, r.phase === 'picking' && t >= 0.45 && t < 0.9);
          // De pallet van de order op het laadplateau, met precies de dozen die er al voor gepickt zijn
          const orderKey = r.order ? orderLoads.key(r.order) : '';
          if (orderKey !== v.orderKey) {
            v.orderKey = orderKey;
            if (v.order) dropLoad(v.order);
            v.order = r.order ? orderLoads.build(r.order) : null;
            if (v.order) {
              v.order.traverse((o) => (o.castShadow = false)); // rijdt mee: geen schaduw (zie de pallet hierboven)
              v.order.position.set(0, PICK_ROBOT_DECK.top, -ROBOT_HITCH);
              v.order.rotation.y = Math.PI / 2; // de lange kant in de rijrichting, zoals hij op de uitslagbaan komt te staan
              v.picker.group.add(v.order);
            }
          }
        }
        // De pallet staat vast op de robot en draait dus mee; bij het neerzetten staat hij weer recht in de stelling
        if (v.fork) v.load?.position.set(r.x + Math.sin(r.r) * ROBOT_FORK_REACH, r.fork + 0.03 * v.lift, r.z + Math.cos(r.r) * ROBOT_FORK_REACH);
        else v.load?.position.set(r.x, ROBOT_DECK - 0.04 * (1 - v.lift), r.z);
        if (v.load) v.load.rotation.y = r.r + v.loadTurn;
      }
      if (menu.showing('robots') && (panelRefresh -= dt) <= 0) {
        panelRefresh = 0.4;
        renderPanel();
      }
    },
    /** Waar de speler tegenaan loopt of op kan staan: de robots en wat ze dragen. */
    solids(): Solid[] {
      const out: Solid[] = [];
      for (const v of views) {
        const { robot: r } = v;
        Object.assign(v.pose, { x: r.x, z: r.z, r: r.r });
        const box = (minX: number, maxX: number, minZ: number, maxZ: number, maxY: number) =>
          out.push({ pose: v.pose, minX, maxX, minZ, maxZ, minY: 0, maxY });
        if (v.fork) box(-FORK_ROBOT_BODY.x, FORK_ROBOT_BODY.x, FORK_ROBOT_BODY.back, FORK_ROBOT_BODY.front, FORK_ROBOT_BODY.top);
        else if (v.counter) box(-COUNT_ROBOT_BODY.x, COUNT_ROBOT_BODY.x, -COUNT_ROBOT_BODY.z, COUNT_ROBOT_BODY.z, COUNT_ROBOT_BODY.top + r.fork);
        else if (v.picker) {
          box(-PICK_ROBOT_BODY.x, PICK_ROBOT_BODY.x, PICK_ROBOT_BODY.back, PICK_ROBOT_BODY.front, PICK_ROBOT_BODY.top);
          // het laadplateau, met de pallet van de order als de robot er een heeft
          box(-PICK_ROBOT_DECK.x, PICK_ROBOT_DECK.x, -ROBOT_HITCH - PICK_ROBOT_DECK.z, -ROBOT_HITCH + PICK_ROBOT_DECK.z, PICK_ROBOT_DECK.top);
          if (v.order) out.push({ pose: v.pose, minX: -0.5, maxX: 0.5, minZ: -ROBOT_HITCH - 0.6, maxZ: -ROBOT_HITCH + 0.6, minY: PICK_ROBOT_DECK.top, maxY: PICK_ROBOT_DECK.top + loadTop(v.order) });
        } else box(-ROBOT_HALF.x, ROBOT_HALF.x, -ROBOT_HALF.z, ROBOT_HALF.z, ROBOT_DECK);
        if (!r.load) continue;
        // De pallet: bij een tilrobot erbovenop, bij een robot-heftruck op de vorken ervoor
        const reach = v.fork ? ROBOT_FORK_REACH : 0;
        const base = v.fork ? r.fork : ROBOT_DECK;
        Object.assign(v.loadPose, { x: r.x + Math.sin(r.r) * reach, z: r.z + Math.cos(r.r) * reach, r: r.r + v.loadTurn });
        out.push({ pose: v.loadPose, minX: -0.6, maxX: 0.6, minZ: -0.5, maxZ: 0.5, minY: base, maxY: base + hall.loadHeight(r.load.sku, r.load.qty) });
      }
      return out;
    },
    /** Waar de telrobot bij de docks voor stopt: de robots die niet zelf al voor iets stilstaan. */
    obstacles: (): Obstacle[] => fleet.robots.filter((r) => !fleet.blocked(r)).map((r) => ({ x: r.x, z: r.z, rad: 0.5 })),
  };
}
