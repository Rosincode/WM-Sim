import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { robotLogo } from './geekRobot';
import { STYLE } from './style';
import { UNIT_CYL } from './warehouse';

// De telrobot: rijdt door de paden met een uitschuifbare cameramast en scant de palletstickers op alle niveaus
// van de stellingen aan weerszijden. Vooruit is +z; de camera's kijken opzij.
// Alleen weergave; wat de robots doen staat in src/sim/robots.ts.

/** Halve breedte, halve lengte en hoogte (mast ingeschoven) van de robot, voor botsingen. */
export const COUNT_ROBOT_BODY = { x: 0.31, z: 0.4, top: 2.36 };
/** Lengte (m) van elk van de drie delen van de mast. */
const STAGE = 1.5;

const rb = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 3, r);
let geo: ReturnType<typeof makeGeo> | null = null;
const makeGeo = () => ({
  chassis: rb(0.62, 0.22, 0.8, 0.05),
  hood: rb(0.56, 0.3, 0.6, 0.06),
  band: rb(0.568, 0.03, 0.608, 0.012),
  stage1: rb(0.22, STAGE, 0.22, 0.03),
  stage2: rb(0.16, STAGE, 0.16, 0.025),
  stage3: rb(0.1, STAGE, 0.1, 0.02),
  pod: rb(0.36, 0.07, 0.12, 0.02),
  head: rb(0.4, 0.12, 0.16, 0.03),
});

export function createCountRobot() {
  const g = (geo ??= makeGeo());
  const group = new THREE.Group();
  const add = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geometry, mat);
    m.position.set(x, y, z);
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const lensMat = new THREE.MeshBasicMaterial({ color: '#8fd3ff' });
  /** Camerabalk dwars op de rijrichting, met aan elk eind een lens die de stelling in kijkt. */
  const cameras = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, width: number, y: number) => {
    add(parent, geometry, STYLE.black, 0, y, 0);
    for (const side of [1, -1]) {
      const lens = add(parent, UNIT_CYL, lensMat, side * (width / 2 + 0.002), y, 0);
      lens.rotation.z = Math.PI / 2;
      lens.scale.set(0.028, 0.012, 0.028);
    }
  };

  // Onderstel met de wielen en de kast
  add(group, g.chassis, STYLE.dark, 0, 0.19, 0);
  for (const side of [1, -1])
    for (const z of [0.24, -0.24]) {
      const w = add(group, UNIT_CYL, STYLE.rubber, side * 0.27, 0.09, z);
      w.rotation.z = Math.PI / 2;
      w.scale.set(0.09, 0.07, 0.09);
    }
  add(group, g.hood, STYLE.white, 0, 0.45, -0.05);
  // Lichtband rondom: de kleur laat zien wat de robot doet
  const ledMat = new THREE.MeshBasicMaterial({ color: '#3ddc84' });
  add(group, g.band, ledMat, 0, 0.36, -0.05);
  const logo = robotLogo();
  for (const side of [1, -1]) {
    const m = new THREE.Mesh(logo.geometry, logo.material);
    m.position.set(side * 0.2805, 0.48, -0.05);
    m.rotation.y = (side * Math.PI) / 2;
    m.scale.setScalar(0.8);
    group.add(m);
  }

  // De mast: drie delen die in elkaar schuiven, elk met camera's bovenaan
  const mast = new THREE.Group();
  mast.position.set(0, 0.6, -0.05);
  group.add(mast);
  add(mast, g.stage1, STYLE.blue, 0, STAGE / 2, 0);
  cameras(mast, g.pod, 0.36, STAGE - 0.04);
  const stage2 = new THREE.Group();
  const stage3 = new THREE.Group();
  mast.add(stage2, stage3);
  add(stage2, g.stage2, STYLE.white, 0, STAGE / 2, 0);
  cameras(stage2, g.pod, 0.36, STAGE - 0.04);
  add(stage3, g.stage3, STYLE.dark, 0, STAGE / 2, 0);
  cameras(stage3, g.head, 0.4, STAGE + 0.02);

  /** @param out hoe ver (m) de mast is uitgeschoven */
  function setMast(out: number) {
    stage2.position.y = 0.12 + out / 2;
    stage3.position.y = 0.24 + out;
  }
  setMast(0);

  return {
    group,
    setLed(color: string) {
      ledMat.color.set(color);
    },
    setMast,
  };
}
