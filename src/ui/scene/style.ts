import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

// Eén stijl voor alle voertuigen en apparaten in de hal: strakke, ronde vormen in een paar effen
// materialen. Geen textures of normal maps; het detail zit in de vorm. Zie "Stijl van 3D-modellen" in CLAUDE.md.
// Alles is mat: weinig glans en weinig metaal, zodat een model met veel kleine vlakjes niet meer glimt dan een strak model.

const mat = (color: string, roughness: number, metalness: number) => new THREE.MeshStandardMaterial({ color, roughness, metalness });

export const STYLE = {
  /** Rode lak: kappen, frames, vorken van de pompwagen. */
  paint: mat('#c9381c', 0.65, 0.05),
  /** Donkergrijs gietwerk: onderstel, contragewicht, mast. */
  dark: mat('#2b2e32', 0.7, 0.1),
  /** Zwart: buizen, beugels, handgrepen. */
  black: mat('#1b1c1e', 0.7, 0.1),
  /** Blank staal: vorken, velgen, cilinders, assen. */
  steel: mat('#8a9097', 0.55, 0.45),
  /** Rubber: banden, wielen, matten. */
  rubber: mat('#151617', 0.9, 0),
  /** Bekleding: stoelen. */
  seat: mat('#25272b', 0.9, 0),
};

/**
 * Laag +1: zet een plat vlak dat óp een ander vlak ligt (sticker, label, bord, logo, scherm, vloermarkering)
 * bij het tekenen één laag vóór zijn ondergrond. Zonder dit flikkeren de twee door elkaar zodra je er wat
 * verder vanaf staat, hoe dun de spleet ertussen ook is. Ligt het vlak op iets dat zelf al een laag is
 * (een markering op vloerverf), geef dan een laag meer mee. Zie "Vlakken op vlakken" in CLAUDE.md.
 */
export function onTop<T extends THREE.Material>(material: T, layers = 1): T {
  material.polygonOffset = true;
  material.polygonOffsetFactor = -4 * layers;
  material.polygonOffsetUnits = -4 * layers;
  return material;
}

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
