import * as THREE from 'three';
import { DRIVER_DOORS, JACK_HANDLE, JACK_REACH, dockFloorY, dockScreen, jackPark, type Driver, type DriverObstacle, type Drivers } from '../sim/drivers';
import { DOCKS, HALL } from '../sim/layout';
import type { Obstacle } from '../sim/robots';
import type { Truck } from '../sim/warehouse';
import { createCharacter, type HandTarget } from './scene/character';
import { createDockScreen, type DockScreenState } from './scene/dockScreen';
import { createElectricJack } from './scene/electricJack';
import type { Solid } from './scene/warehouse';
import { dropLoad, loadTop, type OrderLoads, type PalletLoads } from './warehouseView';

// De chauffeurs in beeld: de figuur zelf, de elektrische pompwagen bij elk dock, het aanraakscherm naast elke
// dockdeur, en de deuren die voor hem open en dicht gaan. Leest alleen de sim (src/sim/drivers.ts).

const X0 = -HALL.w / 2;
/** Hoogte (m) van het scherm aan de wand. */
const SCREEN_Y = 1.45;
/** Zo lang (s) duurt het openen of sluiten van een dockdeur. */
const DOOR_SECONDS = 2.4;

export function mountDrivers({
  scene,
  hall,
  exterior,
  drivers,
  trucks,
  palletLoads,
  orderLoads,
  obstacles,
}: {
  scene: THREE.Scene;
  hall: { setDockDoor(i: number, open: number): void; setDriverDoor(i: number, open: number): void };
  exterior: { setDockDoor(i: number, open: number): void };
  drivers: Drivers;
  /** De vrachtwagens die nu op het terrein zijn. */
  trucks: () => Truck[];
  /** De pallet uit de wagen (met zijn dozen) en de pallet van een order (met de gepickte dozen), voor op de vorken. */
  palletLoads: PalletLoads;
  orderLoads: OrderLoads;
  /** Waar de chauffeurs voor blijven staan: spelers, de heftruck, de pompwagen en losse pallets. */
  obstacles: () => DriverObstacle[];
}) {
  drivers.setObstacles(obstacles);
  // Per dock: de pompwagen met wat erop staat, het scherm en hoe ver de deur open is
  const docks = DOCKS.map((d) => {
    const jack = createElectricJack();
    const screen = createDockScreen();
    const at = dockScreen(d);
    screen.group.position.set(at.x + 0.035, SCREEN_Y, at.z);
    screen.group.rotation.y = Math.PI / 2;
    scene.add(jack.group, screen.group);
    return {
      jack, screen, open: 0, lift: 0,
      /** Wat er op de vorken staat: de pallet uit de wagen of de pallet van een order, met zijn dozen. */
      load: null as THREE.Object3D | null,
      loadKey: '',
      /** Botsvlakken voor de speler: de pompwagen en wat erop staat draaien mee. */
      pose: { x: 0, z: 0, r: 0 },
    };
  });
  const doors = DRIVER_DOORS.map(() => 0);

  /** De figuren van de chauffeurs, op het nummer van hun vrachtwagen. */
  const people = new Map<string, { character: ReturnType<typeof createCharacter>; left: HandTarget; right: HandTarget }>();
  function person(id: string) {
    let p = people.get(id);
    if (!p) {
      p = { character: createCharacter(undefined, { vest: '#1565c0' }), left: { point: new THREE.Vector3() }, right: { point: new THREE.Vector3() } };
      scene.add(p.character.group);
      people.set(id, p);
    }
    return p;
  }

  function screenState(i: number): DockScreenState {
    const t = trucks().find((x) => x.dock === i);
    const d = drivers.at(i);
    const job = t?.direction === 'out' ? 'laden' : 'lossen';
    const base = { dock: `DOCK ${i + 1}`, truck: t?.id ?? '', job, checkedIn: false, done: false } as const;
    if (!t) return { ...base, status: 'Geen vrachtwagen aan dit dock' };
    if (t.status === 'arriving') return { ...base, status: 'Vrachtwagen komt eraan' };
    if (t.status === 'departing') return { ...base, checkedIn: true, done: true, status: 'Afgemeld. Goede reis!' };
    if (t.status === 'waiting') return { ...base, status: 'Welkom. Tik op Aanmelden.' };
    const done = !!d && ['closing', 'toCab', 'leave'].includes(d.phase);
    const status = done
      ? `Klaar met ${job}. Sluit de dockdeur.`
      : t.direction === 'in'
        ? `Bezig met lossen: nog ${t.cargo.length} pallet${t.cargo.length === 1 ? '' : 's'} in de wagen`
        : `Bezig met laden: ${t.loaded.length} order${t.loaded.length === 1 ? '' : 's'} in de wagen`;
    return { ...base, checkedIn: true, done, status };
  }

  /** Zet de pompwagen van een dock neer: in de hand van de chauffeur, of op zijn parkeerplek. */
  function placeJack(i: number, d: Driver | undefined, dt: number) {
    const v = docks[i];
    const held = d?.jack ? d : null;
    const pose = held ?? jackPark(DOCKS[i]);
    const fx = Math.sin(pose.r);
    const fz = Math.cos(pose.r);
    // Op de laadklep staat de pompwagen schuin: de helling volgt uit de vloerhoogte voor en achter
    const front = held ? dockFloorY(pose.x + fx * 1.1) : 0;
    const back = held ? dockFloorY(pose.x - fx * 0.3) : 0;
    v.jack.group.position.set(pose.x, held ? dockFloorY(pose.x) : 0, pose.z);
    v.jack.group.rotation.set(-Math.atan2(front - back, 1.4), pose.r, 0);
    v.jack.group.updateMatrixWorld();
    const carrying = !!held && (!!held.load || !!held.order);
    v.lift = THREE.MathUtils.clamp(v.lift + (carrying ? dt : -dt) / 0.5, 0, 1);
    v.jack.setLift(v.lift);
    Object.assign(v.pose, { x: pose.x, z: pose.z, r: pose.r });
    // Wat er op de vorken staat: de pallet uit de wagen of de pallet van een order, met precies zijn dozen
    const key = held?.load ? palletLoads.key(held.load) : held?.order ? `order:${orderLoads.key(held.order)}` : '';
    if (key !== v.loadKey) {
      v.loadKey = key;
      if (v.load) dropLoad(v.load);
      v.load = held?.load ? palletLoads.build(held.load) : held?.order ? orderLoads.build(held.order) : null;
      if (v.load) {
        // Geen schaduw: anders moet de schaduwkaart elke frame opnieuw voor een rijdende pompwagen
        v.load.traverse((o) => (o.castShadow = false));
        scene.add(v.load);
      }
    }
    if (!held || !v.load) return;
    // De vorken steken onder de dwarsplanken van de pallet. Zijn lange kant ligt in de rijrichting: zo past hij
    // tussen de wielkasten van de vrachtwagen en staat hij recht op de baan.
    const x = held.x + fx * JACK_REACH;
    const z = held.z + fz * JACK_REACH;
    v.load.position.set(x, dockFloorY(x) + 0.012 + 0.09 * v.lift, z);
    v.load.rotation.y = held.r - Math.PI / 2;
  }

  let screenRefresh = 0;
  return {
    update(dt: number) {
      const near = doors.map(() => false);
      const seen = new Set<string>();
      for (const d of drivers.drivers) {
        seen.add(d.id);
        const p = person(d.id);
        const g = p.character.group;
        const fx = Math.sin(d.r);
        const fz = Math.cos(d.r);
        // Met de pompwagen in de hand loopt hij erachter, over de laadklep de wagen in
        const x = d.jack ? d.x - fx * JACK_HANDLE : d.x;
        const z = d.jack ? d.z - fz * JACK_HANDLE : d.z;
        g.position.set(x, d.jack ? dockFloorY(x) : 0, z);
        g.rotation.y = d.r;
        DRIVER_DOORS.forEach((dz, i) => (near[i] ||= Math.hypot(x - X0, z - dz) < 2));
      }
      for (const [id, p] of people) {
        if (seen.has(id)) continue;
        p.character.group.removeFromParent();
        people.delete(id);
      }
      DOCKS.forEach((_, i) => {
        const v = docks[i];
        const d = drivers.at(i);
        const target = d?.door ? 1 : 0;
        if (v.open !== target) {
          v.open = THREE.MathUtils.clamp(v.open + (target ? dt : -dt) / DOOR_SECONDS, 0, 1);
          hall.setDockDoor(i, v.open);
          exterior.setDockDoor(i, v.open);
        }
        placeJack(i, d, dt);
      });
      doors.forEach((open, i) => {
        const next = THREE.MathUtils.clamp(open + (near[i] ? dt : -dt) / 0.6, 0, 1);
        if (next === open) return;
        doors[i] = next;
        hall.setDriverDoor(i, next);
      });
      // De figuren, na de pompwagens: hun handen liggen op de dissel
      for (const d of drivers.drivers) {
        const p = person(d.id);
        const v = docks[d.dock];
        let left: HandTarget | undefined;
        let right: HandTarget | undefined;
        if (d.jack && v) {
          v.jack.grip(1, p.left.point);
          v.jack.grip(-1, p.right.point);
          left = p.left;
          right = p.right;
        } else if (d.phase === 'checkIn' || d.phase === 'checkOut') {
          // tikt op het scherm
          const at = dockScreen(DOCKS[d.dock]);
          p.right.point.set(at.x + 0.07, SCREEN_Y - 0.04, at.z);
          right = p.right;
        } else if (d.phase === 'opening' || d.phase === 'closing') {
          // bedient de knop van de dockdeur, op de stijl naast het scherm
          p.right.point.set(X0 + 0.2, 1.3, DOCKS[d.dock].z - 1.6);
          right = p.right;
        }
        p.character.update(dt, { leftHand: left, rightHand: right, airborne: false });
      }
      if ((screenRefresh -= dt) <= 0) {
        screenRefresh = 0.3;
        docks.forEach((v, i) => v.screen.set(screenState(i)));
      }
    },
    /** Waar de speler tegenaan loopt: de chauffeurs, de pompwagens bij de docks en wat er op hun vorken staat. */
    solids(): Solid[] {
      const out: Solid[] = [];
      for (const d of drivers.drivers) {
        const g = people.get(d.id)?.character.group;
        if (g) out.push({ minX: g.position.x - 0.28, maxX: g.position.x + 0.28, minZ: g.position.z - 0.28, maxZ: g.position.z + 0.28, minY: g.position.y, maxY: g.position.y + 1.8 });
      }
      for (const v of docks) {
        const y = v.jack.group.position.y;
        out.push({ pose: v.pose, minX: -0.32, maxX: 0.32, minZ: -0.45, maxZ: 0.2, minY: y, maxY: y + 0.7 });
        out.push({ pose: v.pose, minX: -0.3, maxX: 0.3, minZ: 0.2, maxZ: 1.36, minY: y, maxY: y + 0.12 });
        if (v.load) out.push({ pose: v.pose, minX: -0.5, maxX: 0.5, minZ: JACK_REACH - 0.6, maxZ: JACK_REACH + 0.6, minY: y, maxY: y + 0.1 + loadTop(v.load) });
      }
      return out;
    },
    /** Waar de robots voor stoppen: de chauffeurs en hun pompwagens. */
    obstacles(): Obstacle[] {
      return drivers.drivers.flatMap((d) => {
        if (!d.jack) return [{ x: d.x, z: d.z, rad: 0.4 }];
        const fx = Math.sin(d.r);
        const fz = Math.cos(d.r);
        return [
          { x: d.x - fx * JACK_HANDLE, z: d.z - fz * JACK_HANDLE, rad: 0.4 },
          { x: d.x + fx * JACK_REACH, z: d.z + fz * JACK_REACH, rad: 0.7 },
        ];
      });
    },
  };
}
