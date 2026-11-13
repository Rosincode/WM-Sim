import * as THREE from 'three';
import { TRUCK } from '../../sim/drivers';

// De vrachtwagen aan het dock: een trekker met een trailer waar je in kunt kijken en rijden. De achterdeuren
// gaan open voordat hij tegen het dock staat; de chauffeur rijdt met de pompwagen over de laadklep naar binnen.
// Het nulpunt is de achterkant van de trailer op de grond; de cabine staat aan de kant van -x.

const mat = (color: string, roughness = 0.7, metalness = 0.1) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
const MATS = {
  in: mat('#3b6ea5'),
  out: mat('#2e7d32'),
  inside: mat('#d9dcde', 0.85, 0),
  floor: mat('#6b5a45', 0.9, 0),
  cab: mat('#eceff1'),
  glass: mat('#263238', 0.3, 0.3),
  dark: mat('#1c1e20', 0.8, 0.1),
  tyre: mat('#111111', 0.95, 0),
};
const UNIT = new THREE.BoxGeometry(1, 1, 1);
const WHEEL = new THREE.CylinderGeometry(1, 1, 1, 18).rotateX(Math.PI / 2);

/** Binnenmaat van de laadruimte: lengte, halve breedte en hoogte boven de laadvloer. */
export const TRAILER = { length: TRUCK.length, half: 1.25, height: 2.75 };

export function createTruck(direction: 'in' | 'out') {
  const group = new THREE.Group();
  const box = (parent: THREE.Object3D, m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(UNIT, m);
    mesh.scale.set(w, h, d);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const wheel = (x: number, z: number, radius: number, width: number) => {
    const mesh = new THREE.Mesh(WHEEL, MATS.tyre);
    mesh.scale.set(radius, radius, width);
    mesh.position.set(x, radius, z);
    mesh.castShadow = true;
    group.add(mesh);
  };
  const paint = MATS[direction];
  const { length: L, half, height } = TRAILER;
  const F = TRUCK.floor;
  const top = F + height;

  // Trailer: laadvloer, kopwand, zijwanden en dak; van achteren open
  box(group, MATS.floor, L, 0.1, half * 2, -L / 2, F - 0.05, 0);
  box(group, MATS.dark, L - 0.6, 0.16, 1.0, -L / 2, F - 0.18, 0); // chassisbalk
  box(group, paint, 0.06, height + 0.1, half * 2, -L + 0.03, F + height / 2 - 0.05, 0);
  box(group, paint, L, 0.06, half * 2, -L / 2, top + 0.03, 0);
  for (const side of [1, -1]) {
    box(group, paint, L, height + 0.1, 0.05, -L / 2, F + height / 2 - 0.05, side * (half - 0.025));
    box(group, MATS.inside, L - 0.1, height - 0.06, 0.012, -L / 2, F + height / 2, side * (half - 0.056)); // lichte binnenwand
    // wielkasten boven de assen
    box(group, MATS.inside, 2.3, 0.3, 0.26, -2.15, F + 0.15, side * (half - 0.18));
    for (const x of [-1.5, -2.8]) wheel(x, side * 1.06, 0.36, 0.26);
    wheel(-L - 0.9, side * 1.1, 0.45, 0.3);
  }
  // Achterdeuren: dicht onderweg, opengeklapt tegen de zijwanden aan het dock
  const doors = [1, -1].map((side) => {
    const hinge = new THREE.Group();
    hinge.position.set(0.03, 0, side * half);
    group.add(hinge);
    box(hinge, paint, 0.05, height, half - 0.01, 0, F + height / 2, (-side * half) / 2);
    return { hinge, side };
  });

  // Trekker
  const cabX = -L - 1.3;
  box(group, MATS.dark, 2.4, 0.3, 2.0, cabX + 0.2, 0.6, 0);
  box(group, MATS.cab, 2.2, 2.5, 2.4, cabX, 2.0, 0);
  box(group, MATS.glass, 0.05, 0.9, 2.0, cabX - 1.12, 2.5, 0);
  for (const side of [1, -1]) box(group, MATS.glass, 0.9, 0.7, 0.04, cabX - 0.45, 2.55, side * 1.2);

  group.visible = false;
  return {
    group,
    /** @param open 0 = achterdeuren dicht, 1 = opengeklapt tegen de zijwanden */
    setDoors(open: number) {
      for (const d of doors) d.hinge.rotation.y = -d.side * open * Math.PI * 1.5;
    },
  };
}
