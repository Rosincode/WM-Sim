import * as THREE from 'three';
import { CAR_PARK, createStaff, type Staff, type StaffObstacle } from '../sim/staff';
import type { Obstacle } from '../sim/robots';
import { CAR, CAR_PAINTS, createCar } from './scene/car';
import { createCharacter, type HandTarget } from './scene/character';
import { CHAIR_HEAD_Y, CHAIR_HIP_Y } from './scene/rooms';
import { STYLE } from './scene/style';
import type { Hall, Solid } from './scene/warehouse';

// De kantoormedewerkers in beeld: de figuren, hun auto's op het parkeerterrein, de koffiebeker en de lunchtrommel,
// en de koelkastdeur die voor hen opengaat. Leest alleen de sim (src/sim/staff.ts).

/** Hesjes van de vier collega's: elk een eigen kleur, zodat je ze uit elkaar houdt. */
const VESTS = ['#00897b', '#7b1fa2', '#c2185b', '#546e7a'];
/** Hoogte van een bureau- of tafelblad (m). */
const TABLE_TOP = 0.76;
const UP = new THREE.Vector3(0, 1, 0);

export function mountStaff({
  scene,
  hall,
  obstacles,
  playerSeat,
  seatUsed = () => false,
  skip = 0,
}: {
  scene: THREE.Scene;
  hall: Pick<Hall, 'staff' | 'seats'>;
  /** Waar ze voor blijven staan: spelers, de heftruck, de pompwagen en losse pallets. */
  obstacles: () => StaffObstacle[];
  /** De stoel waar de speler op zit, of null. */
  playerSeat: () => THREE.Object3D | null;
  /** Zit er al iemand anders (een chauffeur) op deze kantinestoel (index in CANTEEN.seats)? */
  seatUsed?: (i: number) => boolean;
  /** Handig bij testen: zoveel seconden laat de sim de collega's vooraf al lopen. */
  skip?: number;
}) {
  const { frontZ, office, canteen, deskSeats } = hall.staff;
  const sim = createStaff({
    frontZ,
    office,
    canteen,
    deskBusy: (i) => playerSeat() === hall.seats[i],
    seatBusy: (i) => playerSeat() === hall.seats[deskSeats + i] || seatUsed(i),
  });
  for (let t = 0; t < Math.min(skip, 3600); t += 0.1) sim.update(0.1);
  sim.setObstacles(obstacles);

  const cupGeo = new THREE.CylinderGeometry(0.036, 0.03, 0.09, 16);
  const boxGeo = new THREE.BoxGeometry(0.19, 0.07, 0.13);
  const hand = (): HandTarget => ({ point: new THREE.Vector3() });
  const flat = (): HandTarget => ({ point: new THREE.Vector3(), normal: UP });

  const views = sim.staff.map((m, i) => {
    const character = createCharacter(undefined, { vest: VESTS[i % VESTS.length] });
    const car = createCar(CAR_PAINTS[i % CAR_PAINTS.length]);
    const cup = new THREE.Mesh(cupGeo, STYLE.white);
    const lunch = new THREE.Mesh(boxGeo, [STYLE.blue, STYLE.paint, STYLE.green, STYLE.blue][i % 4]);
    scene.add(character.group, car, cup, lunch);
    const casters: THREE.Mesh[] = [];
    character.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.castShadow) casters.push(o as THREE.Mesh);
    });
    return { m, character, car, cup, lunch, casters, shadows: true, left: hand(), right: hand(), flatLeft: flat(), flatRight: flat(), carPose: { x: 0, z: 0, r: 0 } };
  });
  type View = (typeof views)[number];

  /**
   * Wie zit, werpt geen schaduw: hij ademt en typt, en dan zou de schaduwkaart van de hele hal elke frame opnieuw
   * getekend worden (zie refreshShadows in main.ts).
   */
  function setShadows(v: View, on: boolean) {
    if (v.shadows === on) return;
    v.shadows = on;
    for (const c of v.casters) c.castShadow = on;
  }

  let fridge = 0;
  let time = 0;

  function place(v: View, dt: number) {
    const m: Staff = v.m;
    v.car.visible = m.car.here;
    v.car.position.set(m.car.x, 0, m.car.z);
    v.car.rotation.y = m.car.r;
    Object.assign(v.carPose, { x: m.car.x, z: m.car.z, r: m.car.r });

    const g = v.character.group;
    g.visible = !m.inCar;
    v.cup.visible = v.lunch.visible = false;
    // Zijn beker staat op zijn bureau, ook als hij even weg is om te eten
    if (m.cup === 'desk' && m.desk >= 0) {
      const s = office.desks[m.desk];
      v.cup.visible = true;
      v.cup.position.set(s.x + Math.sin(s.r) * 0.52 - Math.cos(s.r) * 0.36, TABLE_TOP + 0.045, s.z + Math.cos(s.r) * 0.52 + Math.sin(s.r) * 0.36);
    }
    if (!g.visible) return;
    g.position.set(m.x, 0, m.z);
    g.rotation.y = m.r;
    setShadows(v, !m.seat);
    const fx = Math.sin(m.r);
    const fz = Math.cos(m.r);
    /** Punt voor (f), rechts van (s) en boven de vloer (y) ten opzichte van waar hij staat of zit. */
    const at = (out: THREE.Vector3, f: number, s: number, y: number) => out.set(m.x + fx * f - fz * s, y, m.z + fz * f + fx * s);
    let left: HandTarget | undefined;
    let right: HandTarget | undefined;

    if (m.act === 'work') {
      // typen: de handen op het toetsenbord, de vingers tikken
      const tap = (k: number) => 0.012 * Math.max(0, Math.sin(time * 9 + m.id * 2 + k));
      at(v.flatLeft.point, 0.43, -0.11, TABLE_TOP + 0.03 + tap(0));
      at(v.flatRight.point, 0.43, 0.11, TABLE_TOP + 0.03 + tap(2));
      left = v.flatLeft;
      right = v.flatRight;
    } else if (m.act === 'machine') {
      // de beker staat onder de uitloop, zijn hand eromheen
      v.cup.visible = true;
      v.cup.position.copy(canteen.coffee.hand);
      v.cup.position.y += 0.045;
      v.right.point.copy(v.cup.position);
      v.right.point.x -= 0.07;
      right = v.right;
    } else if (m.act === 'fridge') {
      if (m.busy > 0.7) {
        v.right.point.copy(canteen.fridge.hand);
        right = v.right;
      }
    } else if (m.act === 'sink') {
      v.right.point.copy(canteen.sink.hand);
      right = v.right;
      v.lunch.visible = m.lunch !== 'none';
      v.lunch.position.copy(canteen.sink.hand).setY(0.9 + 0.035);
      v.lunch.rotation.y = 0;
    } else if (m.act === 'eat') {
      // de trommel voor hem op tafel; om de paar tellen een hap
      v.lunch.visible = true;
      at(v.lunch.position, 0.46, 0, TABLE_TOP + 0.035);
      v.lunch.rotation.y = m.r;
      const bite = (time * 0.22 + m.id * 0.37) % 1 > 0.55;
      if (bite) at(v.right.point, 0.2, 0.03, CHAIR_HEAD_Y - 0.1);
      else at(v.right.point, 0.38, 0.08, TABLE_TOP + 0.1);
      at(v.flatLeft.point, 0.36, -0.2, TABLE_TOP);
      left = v.flatLeft;
      right = v.right;
    }
    if (m.act !== 'machine' && m.cup === 'hand') {
      // de beker in de rechterhand, voor zich
      at(v.right.point, 0.27, 0.2, 1.04);
      at(v.cup.position, 0.33, 0.2, 1.0);
      v.cup.visible = true;
      right = v.right;
    }
    if (m.lunch === 'hand' && m.act !== 'sink') {
      // de trommel in twee handen
      at(v.left.point, 0.27, -0.12, 1.0);
      at(v.right.point, 0.27, 0.12, 1.0);
      at(v.lunch.position, 0.34, 0, 0.99);
      v.lunch.rotation.y = m.r;
      v.lunch.visible = true;
      left = v.left;
      right = v.right;
    }
    v.character.update(dt, { seated: !!m.seat, seatHipY: CHAIR_HIP_Y, leftHand: left, rightHand: right, airborne: false });
  }

  for (const v of views) {
    v.cup.castShadow = v.lunch.castShadow = false;
    place(v, 0);
  }

  const onSite = () => views.filter((v) => !v.m.inCar);
  return {
    update(dt: number) {
      time += dt;
      sim.update(dt);
      const next = THREE.MathUtils.clamp(fridge + (sim.fridgeOpen() ? dt : -dt) / 0.5, 0, 1);
      if (next !== fridge) hall.staff.setFridge((fridge = next));
      for (const v of views) place(v, dt);
    },
    /** Waar de speler tegenaan loopt: de collega's en hun auto's. */
    solids(): Solid[] {
      const out: Solid[] = [];
      for (const v of views) {
        const { m } = v;
        if (!m.inCar) out.push({ minX: m.x - 0.26, maxX: m.x + 0.26, minZ: m.z - 0.26, maxZ: m.z + 0.26, minY: 0, maxY: m.seat ? 1.3 : 1.8 });
        if (!m.car.here || Math.abs(m.car.x - CAR_PARK.area.maxX) > 60) continue;
        out.push({ pose: v.carPose, minX: -CAR.width / 2, maxX: CAR.width / 2, minZ: -CAR.length / 2, maxZ: CAR.length / 2, minY: 0, maxY: 0.93 });
        out.push({ pose: v.carPose, minX: -0.8, maxX: 0.8, minZ: -1.98, maxZ: 1.08, minY: 0.93, maxY: 1.47 });
      }
      return out;
    },
    /** Waar de robots voor stoppen: de collega's die door de hal lopen. */
    obstacles: (): Obstacle[] => onSite().filter((v) => !v.m.seat).map((v) => ({ x: v.m.x, z: v.m.z, rad: 0.4 })),
    /** Wie er te voet is: voor hen gaat de entreedeur open. */
    walkers: () => onSite().map((v) => ({ x: v.m.x, z: v.m.z })),
    /** Is deze stoel van een collega (hij zit er, of komt er zo weer zitten)? */
    seatTaken(seat: THREE.Object3D) {
      const i = hall.seats.indexOf(seat);
      return i >= 0 && (i < deskSeats ? sim.deskTaken(i) : sim.seatTaken(i - deskSeats));
    },
  };
}
