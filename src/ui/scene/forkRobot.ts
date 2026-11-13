import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { robotLogo } from './geekRobot';
import { STYLE } from './style';
import { UNIT_CYL } from './warehouse';

// De Geek+-robot-heftruck: een onbemande stapelaar met een uitschuifbare mast en vorken. Hij pakt pallets
// vanuit het pad en komt daarmee ook bij de hogere niveaus van de stellingen. Vooruit (de vorken) is +z.
// Alleen weergave; wat de robots doen staat in src/sim/robots.ts.

/** Halve breedte, achterkant en voorkant (zonder vorken) en hoogte van de kast, voor botsingen. */
export const FORK_ROBOT_BODY = { x: 0.45, back: -0.78, front: 0.2, top: 1.16 };
/** Lengte (m) van de vaste en van de uitschuivende mast. */
const MAST = 2.3;
/** Bovenkant van de vorken boven de hoogte waarop de pallet staat: de vorken steken in de openingen van de pallet. */
const BLADE_TOP = 0.07;

const rb = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 3, r);
let geo: ReturnType<typeof makeGeo> | null = null;
const makeGeo = () => ({
  chassis: rb(0.9, 0.3, 0.9, 0.05),
  hood: rb(0.84, 0.72, 0.5, 0.07),
  band: rb(0.848, 0.03, 0.508, 0.012),
  post: rb(0.07, MAST, 0.1, 0.012),
  inner: rb(0.05, MAST, 0.07, 0.01),
  tie: rb(0.73, 0.06, 0.05, 0.012),
  innerTie: rb(0.57, 0.05, 0.05, 0.01),
  plate: rb(0.7, 0.3, 0.04, 0.012),
  shank: rb(0.12, 0.42, 0.04, 0.01),
  blade: rb(0.12, 0.04, 1.1, 0.012),
  guardBar: rb(0.03, 0.5, 0.03, 0.008),
  guardTop: rb(0.7, 0.03, 0.03, 0.008),
  mount: rb(0.12, 0.05, 0.12, 0.015),
});

export function createForkRobot() {
  const g = (geo ??= makeGeo());
  const group = new THREE.Group();
  const add = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geometry, mat);
    m.position.set(x, y, z);
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const wheel = (x: number, z: number, radius: number, width: number) => {
    const m = add(group, UNIT_CYL, STYLE.rubber, x, radius, z);
    m.rotation.z = Math.PI / 2;
    m.scale.set(radius, width, radius);
  };

  // Onderstel met de wielen, daarop de kast met accu en besturing
  add(group, g.chassis, STYLE.dark, 0, 0.23, -0.33);
  for (const side of [1, -1]) {
    wheel(side * 0.38, -0.02, 0.11, 0.09);
    wheel(side * 0.25, -0.6, 0.1, 0.08);
  }
  add(group, g.hood, STYLE.blue, 0, 0.74, -0.5);
  // Lichtband rondom: de kleur laat zien wat de robot doet
  const ledMat = new THREE.MeshBasicMaterial({ color: '#3ddc84' });
  add(group, g.band, ledMat, 0, 0.47, -0.5);
  // Scanner bovenop
  add(group, g.mount, STYLE.black, 0, 1.12, -0.5);
  const scanner = add(group, UNIT_CYL, STYLE.black, 0, 1.19, -0.5);
  scanner.scale.set(0.07, 0.09, 0.07);
  const logo = robotLogo();
  for (const side of [1, -1]) {
    const m = new THREE.Mesh(logo.geometry, logo.material);
    m.position.set(side * 0.4205, 0.82, -0.5);
    m.rotation.y = (side * Math.PI) / 2;
    m.scale.setScalar(0.75);
    group.add(m);
  }

  // Vaste mast, met daarin de mast die mee omhoog schuift
  for (const side of [1, -1]) add(group, g.post, STYLE.dark, side * 0.33, 0.3 + MAST / 2, 0.075);
  add(group, g.tie, STYLE.dark, 0, 0.3 + MAST - 0.05, 0);
  const inner = new THREE.Group();
  group.add(inner);
  for (const side of [1, -1]) add(inner, g.inner, STYLE.steel, side * 0.26, 0.34 + MAST / 2, 0.09);
  add(inner, g.innerTie, STYLE.steel, 0, 0.34 + MAST - 0.04, 0.09);

  // Vorkenbord met de vorken en het rek waar de lading tegenaan staat; het nulpunt is de bovenkant van de vorken
  const carriage = new THREE.Group();
  group.add(carriage);
  add(carriage, g.plate, STYLE.black, 0, 0.17, 0.165);
  for (const side of [1, -1]) {
    add(carriage, g.shank, STYLE.steel, side * 0.26, 0.17, 0.205);
    add(carriage, g.blade, STYLE.steel, side * 0.26, -0.02, 0.75);
    add(carriage, g.guardBar, STYLE.black, side * 0.335, 0.56, 0.165);
  }
  add(carriage, g.guardTop, STYLE.black, 0, 0.815, 0.165);

  /**
   * @param height hoogte (m) waarop de pallet op de vorken staat
   * @param up 0 = vorken net onder de pallet, 1 = pallet opgetild
   */
  function setFork(height: number, up: number) {
    carriage.position.y = height + BLADE_TOP + up * 0.03;
    inner.position.y = height / 2;
  }
  setFork(0, 0);

  return {
    group,
    setLed(color: string) {
      ledMat.color.set(color);
    },
    setFork,
  };
}
