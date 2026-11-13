import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { STYLE } from './style';
import { UNIT_CYL } from './warehouse';

// De elektrische pompwagen die bij elk dock staat: de chauffeur van de vrachtwagen lost en laadt ermee.
// Hij loopt erachter met beide handen aan de dissel. Vooruit (de vorken) is +z; het nulpunt ligt tussen de
// vorken en de kast, op de vloer. Alleen weergave; wat de chauffeurs doen staat in src/sim/drivers.ts.

const rb = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 3, r);
let geo: ReturnType<typeof makeGeo> | null = null;
const makeGeo = () => ({
  fork: rb(0.16, 0.05, 1.15, 0.015),
  bridge: rb(0.56, 0.12, 0.08, 0.02),
  body: rb(0.62, 0.5, 0.36, 0.05),
  cover: rb(0.55, 0.06, 0.3, 0.02),
  drive: rb(0.4, 0.26, 0.24, 0.04),
  head: rb(0.36, 0.07, 0.1, 0.025),
});
/** De handgrepen aan de dissel, ten opzichte van de pompwagen. */
const GRIP = { x: 0.15, y: 1.08, z: -0.64 };

export function createElectricJack() {
  const g = (geo ??= makeGeo());
  const group = new THREE.Group();
  group.rotation.order = 'YXZ'; // eerst de rijrichting, dan de helling van de laadklep
  const add = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geometry, mat);
    m.position.set(x, y, z);
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const wheel = (parent: THREE.Object3D, x: number, z: number, radius: number, width: number) => {
    const m = add(parent, UNIT_CYL, STYLE.rubber, x, radius, z);
    m.rotation.z = Math.PI / 2;
    m.scale.set(radius, width, radius);
  };

  // Kast met accu en motor, het aandrijfwiel eronder
  add(group, g.body, STYLE.paint, 0, 0.38, -0.02);
  add(group, g.cover, STYLE.dark, 0, 0.655, -0.02);
  add(group, g.drive, STYLE.dark, 0, 0.21, -0.3);
  wheel(group, 0, -0.3, 0.11, 0.09);
  // Dissel met de handgrepen
  const from = new THREE.Vector3(0, 0.45, -0.38);
  const to = new THREE.Vector3(0, GRIP.y - 0.03, GRIP.z);
  const tiller = add(group, UNIT_CYL, STYLE.black, 0, 0, 0);
  tiller.position.copy(from).add(to).multiplyScalar(0.5);
  tiller.scale.set(0.022, from.distanceTo(to), 0.022);
  tiller.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
  add(group, g.head, STYLE.black, 0, GRIP.y, GRIP.z);
  // De vorken met de rollen eronder; ze komen een stukje omhoog onder een last
  const forks = new THREE.Group();
  group.add(forks);
  add(forks, g.bridge, STYLE.paint, 0, 0.12, 0.2);
  for (const side of [1, -1]) {
    add(forks, g.fork, STYLE.paint, side * 0.2, 0.085, 0.775);
    wheel(group, side * 0.2, 1.2, 0.04, 0.1);
  }

  const hand = new THREE.Vector3();
  return {
    group,
    /** up: 0 = vorken omlaag, 1 = last opgetild. */
    setLift(up: number) {
      forks.position.y = up * 0.09;
    },
    /** Waar de linker- (side 1) of rechterhand (side -1) de dissel vasthoudt, in de wereld. */
    grip(side: 1 | -1, out: THREE.Vector3) {
      return out.copy(hand.set(side * GRIP.x, GRIP.y, GRIP.z)).applyMatrix4(group.matrixWorld);
    },
  };
}
