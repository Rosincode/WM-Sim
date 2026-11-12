import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

// Eén stijl voor alle voertuigen en apparaten in de hal: strakke, ronde vormen in een paar effen
// materialen. Geen textures of normal maps; het detail zit in de vorm. Zie "Stijl van 3D-modellen" in CLAUDE.md.

const mat = (color: string, roughness: number, metalness: number) => new THREE.MeshStandardMaterial({ color, roughness, metalness });

export const STYLE = {
  /** Rode lak: kappen, frames, vorken van de pompwagen. */
  paint: mat('#c9381c', 0.42, 0.25),
  /** Donkergrijs gietwerk: onderstel, contragewicht, mast. */
  dark: mat('#2b2e32', 0.55, 0.35),
  /** Zwart: buizen, beugels, handgrepen. */
  black: mat('#1b1c1e', 0.6, 0.3),
  /** Blank staal: vorken, velgen, cilinders, assen. */
  steel: mat('#8a9097', 0.35, 0.8),
  /** Rubber: banden, wielen, matten. */
  rubber: mat('#151617', 0.85, 0),
  /** Bekleding: stoelen. */
  seat: mat('#25272b', 0.9, 0),
};

/**
 * Brengt een ingeladen model in de huisstijl: de materialen van hierboven (op naam van het materiaal in
 * het model) en opnieuw berekende normalen, zodat vlakken egaal zijn en alleen echte randen scherp blijven.
 * @param crease hoek (rad) waarboven een rand scherp blijft
 */
export function restyle(root: THREE.Object3D, byName: Record<string, THREE.Material>, crease = 0.6) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry = toCreasedNormals(mesh.geometry, crease);
    const swap = (m: THREE.Material) => byName[m.name] ?? m;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
}
