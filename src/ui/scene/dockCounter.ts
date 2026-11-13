import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { STYLE } from './style';

// De telrobot bij de ontvangst: een klein rijdend onderstel met een mast en een scannerkop, die de pallets op de
// inslagbanen telt. Vooruit is +z. Alleen weergave; wat hij doet staat in src/sim/counter.ts.

const rb = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 3, r);

let parts: ReturnType<typeof makeParts> | null = null;
function makeParts() {
  const wheel = new THREE.CylinderGeometry(0.09, 0.09, 0.06, 20);
  wheel.rotateZ(Math.PI / 2);
  const lens = new THREE.CylinderGeometry(0.036, 0.036, 0.02, 20);
  lens.rotateX(Math.PI / 2);
  return {
    base: rb(0.56, 0.2, 0.7, 0.05),
    cap: rb(0.48, 0.06, 0.6, 0.025),
    wheel,
    mast: new THREE.CylinderGeometry(0.035, 0.035, 1.02, 16),
    collar: new THREE.CylinderGeometry(0.06, 0.07, 0.08, 16),
    head: rb(0.3, 0.16, 0.16, 0.04),
    lens,
    led: new THREE.BoxGeometry(0.4, 0.022, 0.012),
    // De scanbundel: een platte waaier van de kop schuin omlaag naar de pallet voor de robot
    beam: new THREE.PlaneGeometry(0.9, 1.0),
  };
}

export function createDockCounter() {
  const p = (parts ??= makeParts());
  const group = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  add(p.base, STYLE.dark, 0, 0.2, 0); // onderstel
  add(p.cap, STYLE.white, 0, 0.325, 0); // kap
  for (const x of [-0.3, 0.3]) for (const z of [-0.22, 0.22]) add(p.wheel, STYLE.rubber, x, 0.09, z);
  add(p.collar, STYLE.black, 0, 0.39, -0.16);
  add(p.mast, STYLE.steel, 0, 0.9, -0.16);
  add(p.head, STYLE.black, 0, 1.45, -0.13); // scannerkop
  add(p.lens, STYLE.steel, 0, 1.45, -0.042);
  const ledMat = new THREE.MeshBasicMaterial({ color: '#3ddc84' });
  const led = add(p.led, ledMat, 0, 0.24, 0.353);
  led.castShadow = false;
  const beamMat = new THREE.MeshBasicMaterial({ color: '#35a7ff', transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
  const beam = new THREE.Mesh(p.beam, beamMat);
  // van de lens (y 1,45) naar het midden van de pallet, ruim een meter voor de robot
  beam.position.set(0, 1.0, 0.42);
  beam.rotation.x = -Math.PI / 2 + 1.0;
  beam.visible = false;
  group.add(beam);

  return {
    group,
    setLed(color: string) {
      ledMat.color.set(color);
    },
    /** on = hij telt; pulse (0 t/m 1) laat de bundel flikkeren. */
    setScan(on: boolean, pulse = 0) {
      beam.visible = on;
      beamMat.opacity = 0.14 + 0.14 * pulse;
    },
  };
}
