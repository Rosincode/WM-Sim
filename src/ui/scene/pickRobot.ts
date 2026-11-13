import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { ROBOT_HITCH } from '../../sim/robots';
import { robotLogo } from './geekRobot';
import { STYLE } from './style';
import { UNIT_CYL } from './warehouse';

// De pickrobot: pickt orders zonder dat er een mens aan te pas komt. Een grijparm op een uitschuifbare mast
// pakt dozen van een pallet op elk niveau van de stelling; achter de robot staat de pallet van de order
// op een laadplateau (die pallet, met de gepickte dozen, zet src/ui/robots.ts erop). Vooruit (de arm) is +z. Alleen weergave; wat de robots doen staat in src/sim/robots.ts.

/** Halve breedte, achterkant, voorkant en hoogte van de robot zelf, voor botsingen. */
export const PICK_ROBOT_BODY = { x: 0.4, back: -0.46, front: 0.62, top: 2.86 };
/** Het laadplateau achter de robot: halve breedte, halve lengte en de hoogte waarop de pallet van de order staat. */
export const PICK_ROBOT_DECK = { x: 0.42, z: 0.6, top: 0.14 };
/** Lengte (m) van de vaste en van de uitschuivende mast. */
const MAST = 2.5;
/** Zo ver (m) schuift de arm uit naar de doos op de pallet. */
const ARM_OUT = 0.24;
/** Laagste stand van de arm: net boven de vloer. */
const ARM_MIN = 0.3;

const rb = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 3, r);
let geo: ReturnType<typeof makeGeo> | null = null;
const makeGeo = () => ({
  chassis: rb(0.8, 0.26, 0.7, 0.05),
  hood: rb(0.72, 0.5, 0.42, 0.06),
  band: rb(0.728, 0.03, 0.428, 0.012),
  mount: rb(0.12, 0.05, 0.12, 0.015),
  post: rb(0.06, MAST, 0.09, 0.012),
  inner: rb(0.045, MAST, 0.06, 0.01),
  tie: rb(0.6, 0.05, 0.05, 0.012),
  innerTie: rb(0.475, 0.045, 0.045, 0.01),
  plate: rb(0.5, 0.22, 0.04, 0.012),
  housing: rb(0.2, 0.14, 0.2, 0.03),
  boom: rb(0.07, 0.07, 0.45, 0.012),
  pad: rb(0.3, 0.26, 0.03, 0.012),
  carton: rb(0.3, 0.24, 0.3, 0.012),
  link: rb(0.2, 0.05, 0.2, 0.012),
  deck: rb(PICK_ROBOT_DECK.x * 2, 0.05, PICK_ROBOT_DECK.z * 2, 0.02),
});

export function createPickRobot() {
  const g = (geo ??= makeGeo());
  const group = new THREE.Group();
  const add = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geometry, mat);
    m.position.set(x, y, z);
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  /** Staaf of wiel: een cilinder langs de x-, y- of z-as. */
  const cyl = (parent: THREE.Object3D, mat: THREE.Material, axis: 'x' | 'y' | 'z', radius: number, length: number, x: number, y: number, z: number) => {
    const m = add(parent, UNIT_CYL, mat, x, y, z);
    if (axis === 'x') m.rotation.z = Math.PI / 2;
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    m.scale.set(radius, length, radius);
    return m;
  };

  // Onderstel met de wielen, daarop de kast met accu en besturing
  add(group, g.chassis, STYLE.dark, 0, 0.21, -0.11);
  for (const side of [1, -1]) {
    cyl(group, STYLE.rubber, 'x', 0.1, 0.08, side * 0.36, 0.1, 0.08);
    cyl(group, STYLE.rubber, 'x', 0.1, 0.08, side * 0.36, 0.1, -0.32);
  }
  add(group, g.hood, STYLE.blue, 0, 0.59, -0.2);
  // Lichtband rondom: de kleur laat zien wat de robot doet
  const ledMat = new THREE.MeshBasicMaterial({ color: '#3ddc84' });
  add(group, g.band, ledMat, 0, 0.42, -0.2);
  add(group, g.mount, STYLE.black, 0, 0.86, -0.25);
  cyl(group, STYLE.black, 'y', 0.07, 0.09, 0, 0.93, -0.25);
  const logo = robotLogo();
  for (const side of [1, -1]) {
    const m = new THREE.Mesh(logo.geometry, logo.material);
    m.position.set(side * 0.3605, 0.64, -0.2);
    m.rotation.y = (side * Math.PI) / 2;
    m.scale.setScalar(0.62);
    group.add(m);
  }

  // Vaste mast, met daarin de mast die mee omhoog schuift
  for (const side of [1, -1]) add(group, g.post, STYLE.dark, side * 0.27, 0.34 + MAST / 2, 0.2);
  add(group, g.tie, STYLE.dark, 0, 0.34 + MAST - 0.05, 0.125);
  const inner = new THREE.Group();
  group.add(inner);
  for (const side of [1, -1]) add(inner, g.inner, STYLE.steel, side * 0.215, 0.36 + MAST / 2, 0.21);
  add(inner, g.innerTie, STYLE.steel, 0, 0.36 + MAST - 0.04, 0.21);

  // De slede met de grijparm: een uitschuivende arm met een zuignap; het nulpunt is het midden van de zuignap
  const carriage = new THREE.Group();
  group.add(carriage);
  add(carriage, g.plate, STYLE.black, 0, 0, 0.27);
  add(carriage, g.housing, STYLE.white, 0, 0, 0.39);
  const arm = new THREE.Group();
  carriage.add(arm);
  add(arm, g.boom, STYLE.steel, 0, 0, 0.33);
  add(arm, g.pad, STYLE.black, 0, 0, 0.57);
  for (const [x, y] of [[-0.08, 0.06], [0.08, 0.06], [-0.08, -0.06], [0.08, -0.06]])
    cyl(arm, STYLE.rubber, 'z', 0.035, 0.03, x, y, 0.595);
  const carton = add(arm, g.carton, STYLE.carton, 0, 0, 0.765);
  carton.visible = false;

  // Laadplateau achter de robot: daar staat de pallet van de order op
  add(group, g.link, STYLE.dark, 0, 0.115, -0.5);
  add(group, g.deck, STYLE.dark, 0, PICK_ROBOT_DECK.top - 0.025, -ROBOT_HITCH);
  for (const side of [1, -1]) for (const dz of [-0.42, 0.42]) cyl(group, STYLE.rubber, 'x', 0.045, 0.04, side * 0.3, 0.045, -ROBOT_HITCH + dz);

  /**
   * @param height hoogte (m) van de zuignap
   * @param reach 0 = arm ingeschoven, 1 = tegen de doos op de pallet
   * @param holding de arm heeft een doos vast
   */
  function setArm(height: number, reach: number, holding: boolean) {
    const y = Math.max(ARM_MIN, height);
    carriage.position.y = y;
    inner.position.y = Math.max(0, y - ARM_MIN) / 2;
    arm.position.z = reach * ARM_OUT;
    carton.visible = holding;
  }
  setArm(0, 0, false);

  return {
    group,
    setLed(color: string) {
      ledMat.color.set(color);
    },
    setArm,
  };
}
