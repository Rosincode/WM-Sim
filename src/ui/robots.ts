import * as THREE from 'three';
import { ROBOT_CHARGERS, ROBOT_FORK_REACH, ROBOT_KINDS, type Obstacle, type RobotFleet } from '../sim/robots';
import { menu } from './menu';
import type { RobotDispatch } from './robotDispatch';
import { FORK_ROBOT_BODY, createForkRobot } from './scene/forkRobot';
import { ROBOT_DECK, ROBOT_HALF, createGeekRobot, createRobotCharger } from './scene/geekRobot';
import type { Hall, Solid } from './scene/warehouse';

// De Geek+-robots in beeld: de tilrobots en de robot-heftrucks, de pallet die ze dragen, hun laadstations
// (één per pad, aan het eind ervan) en het onderdeel 'Robots' in het menu. Leest alleen de sim (src/sim/robots.ts); de opdrachten komen via src/ui/robotDispatch.ts.

const LED = { free: '#3ddc84', busy: '#35a7ff', waiting: '#ffa000' };
const KIND = { lift: 'tilrobot', fork: 'robot-heftruck' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function mountRobots({
  scene,
  hall,
  fleet,
  dispatch,
  obstacles,
}: {
  scene: THREE.Scene;
  hall: Hall;
  fleet: RobotFleet;
  dispatch: RobotDispatch;
  /** Waar de robots voor stoppen: de speler, de heftruck en de pompwagen. */
  obstacles: () => Obstacle[];
}) {
  fleet.setObstacles(obstacles);
  ROBOT_CHARGERS.forEach((c, i) => {
    const charger = createRobotCharger(ROBOT_KINDS[i] === 'fork');
    charger.position.set(c.x, 0, c.z);
    scene.add(charger);
  });

  const views = fleet.robots.map((robot) => {
    const fork = robot.kind === 'fork' ? createForkRobot() : null;
    const lifter = fork ? null : createGeekRobot();
    const mesh = fork ?? lifter!;
    scene.add(mesh.group);
    return {
      robot,
      mesh,
      fork,
      lifter,
      load: null as THREE.Object3D | null,
      loadKey: '',
      lift: 0,
      /** Botsvlakken voor de speler: de robot zelf (draait mee) en de pallet erop (draait met de robot mee). */
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
  const toggle = document.createElement('label');
  toggle.style.cssText = 'display:block;margin-top:10px;cursor:pointer';
  toggle.innerHTML = '<input type="checkbox" style="margin-right:6px">Robots laten werken zolang de WMS geen robotopdrachten uitgeeft';
  const box = toggle.querySelector('input')!;
  box.checked = dispatch.enabled;
  box.addEventListener('change', () => {
    dispatch.setEnabled(box.checked);
    box.blur();
  });
  panel.append(list, toggle);
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
      <div style="margin-bottom:8px">Elk pad heeft zijn eigen robot. Een tilrobot komt alleen bij de vloer; een robot-heftruck ook bij de hogere niveaus.</div>
      <h4>Geek+-robots</h4><table>${robots || '<tr><td>In deze hal is geen ruimte voor de robotbaan.</td></tr>'}</table>
      <h4>Opdrachten</h4><table>${tasks || '<tr><td>Geen lopende opdrachten</td></tr>'}</table>`;
    if (html === lastHtml) return;
    lastHtml = html;
    list.innerHTML = html;
  }

  let panelRefresh = 0;
  return {
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
    /** Waar de speler tegenaan loopt of op kan staan: de robots en de pallets die ze dragen. */
    solids(): Solid[] {
      const out: Solid[] = [];
      for (const v of views) {
        const { robot: r } = v;
        Object.assign(v.pose, { x: r.x, z: r.z, r: r.r });
        const b = FORK_ROBOT_BODY;
        if (v.fork) out.push({ pose: v.pose, minX: -b.x, maxX: b.x, minZ: b.back, maxZ: b.front, minY: 0, maxY: b.top });
        else out.push({ pose: v.pose, minX: -ROBOT_HALF.x, maxX: ROBOT_HALF.x, minZ: -ROBOT_HALF.z, maxZ: ROBOT_HALF.z, minY: 0, maxY: ROBOT_DECK });
        if (!r.load) continue;
        // De pallet: bij een tilrobot erbovenop, bij een robot-heftruck op de vorken ervoor
        const reach = v.fork ? ROBOT_FORK_REACH : 0;
        const base = v.fork ? r.fork : ROBOT_DECK;
        Object.assign(v.loadPose, { x: r.x + Math.sin(r.r) * reach, z: r.z + Math.cos(r.r) * reach, r: r.r + v.loadTurn });
        out.push({ pose: v.loadPose, minX: -0.6, maxX: 0.6, minZ: -0.5, maxZ: 0.5, minY: base, maxY: base + hall.loadHeight(r.load.sku, r.load.qty) });
      }
      return out;
    },
  };
}
