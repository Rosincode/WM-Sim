import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { STYLE } from './style';

/**
 * Jetpack op de rug: rugplaat, twee tanks in rode lak, stalen straalpijpen, zwarte schouderbanden en vlammen.
 * Lokaal assenstelsel van de romp van de figuur (heupen = 0, voorkant +Z): hang hem aan `character.back`.
 */
export function createJetpack() {
  const group = new THREE.Group();
  group.visible = false;
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = group) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(x, y, z);
    o.castShadow = o.receiveShadow = true;
    parent.add(o);
    return o;
  };

  const BACK = -0.125; // net achter het hesje
  // rugplaat met daarop de tanks
  add(new RoundedBoxGeometry(0.28, 0.4, 0.04, 3, 0.012), STYLE.dark, 0, 0.27, BACK - 0.02);
  const nozzles: THREE.Vector3[] = [];
  for (const side of [-1, 1]) {
    const x = side * 0.078;
    const z = BACK - 0.04 - 0.07;
    add(new THREE.CapsuleGeometry(0.068, 0.3, 6, 20), STYLE.paint, x, 0.29, z);
    // spanbanden om de tank
    for (const y of [0.17, 0.41]) add(new THREE.TorusGeometry(0.07, 0.006, 6, 24), STYLE.black, x, y, z).rotation.x = Math.PI / 2;
    // straalpijp onder de tank
    add(new THREE.CylinderGeometry(0.036, 0.05, 0.08, 18), STYLE.steel, x, 0.06, z);
    nozzles.push(new THREE.Vector3(x, 0.02, z));
    // schouderband over de schouder naar voren
    const strap = add(new THREE.TorusGeometry(0.115, 0.011, 6, 20, Math.PI), STYLE.black, side * 0.11, 0.47, -0.005);
    strap.rotation.y = Math.PI / 2;
  }
  // kop met het ventiel tussen de tanks
  add(new THREE.CylinderGeometry(0.022, 0.022, 0.07, 14), STYLE.steel, 0, 0.47, BACK - 0.11).rotation.z = Math.PI / 2;

  // Vlammen: licht van zichzelf, geen schaduw. Lengte volgt de stuwkracht.
  const flameMat = new THREE.MeshBasicMaterial({ color: '#ffb347', transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending });
  const coreMat = new THREE.MeshBasicMaterial({ color: '#fff3c4', transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
  const flameGeo = new THREE.ConeGeometry(0.042, 1, 16, 1, true).rotateX(Math.PI).translate(0, -0.5, 0); // voet bij y=0, punt omlaag
  const flames = nozzles.map((n) => {
    const outer = new THREE.Mesh(flameGeo, flameMat);
    const inner = new THREE.Mesh(flameGeo, coreMat);
    inner.scale.set(0.5, 0.6, 0.5);
    outer.add(inner);
    outer.position.copy(n);
    group.add(outer);
    return outer;
  });

  let flicker = 0;
  return {
    group,
    /** @param thrust 0 = uit, 1 = vol gas omhoog */
    update(dt: number, thrust: number) {
      flicker += dt * 40;
      flames.forEach((f, i) => {
        const len = thrust * (0.35 + 0.08 * Math.sin(flicker + i * 2.1) + 0.05 * Math.sin(flicker * 2.7 + i));
        f.visible = thrust > 0.02;
        f.scale.set(0.7 + 0.3 * thrust, Math.max(0.01, len), 0.7 + 0.3 * thrust);
      });
    },
  };
}
