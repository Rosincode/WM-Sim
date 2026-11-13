import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { STYLE } from './style';

// Het koffieapparaat in de kantine en het bekertje dat je eruit pakt. Het apparaat staat op het keukenblok: een
// bonenmachine met een bonenreservoir, een bedieningspaneel met scherm en knoppen, een uitloop boven het
// lekrooster en ernaast een stapel bekertjes. Zelfde stijl als alles in de hal (zie style.ts): effen, matte
// materialen, het detail zit in de vorm. Het nulpunt is het midden van het apparaat op de vloer; de voorkant is +z.

/** Bovenkant van het werkblad waar het apparaat op staat (m boven de vloer). */
const TOP = 0.9;
/** Hoogte van een bekertje. */
export const CUP_HEIGHT = 0.09;
/**
 * Punten op het apparaat, ten opzichte van zijn nulpunt (x opzij, y boven de vloer, z naar voren): waar het
 * bekertje onder de uitloop staat, de knop waarmee je koffie kiest, en de stapel bekertjes ernaast.
 */
export const COFFEE_SPOTS = {
  cup: new THREE.Vector3(0, TOP + 0.059, 0.08),
  button: new THREE.Vector3(0.075, TOP + 0.47, 0.18),
  stack: new THREE.Vector3(0.27, TOP + 0.24, 0.02),
};

type Part = [THREE.Material, THREE.BufferGeometry];
const rb = (w: number, h: number, d: number, r: number, x: number, y: number, z: number) => new RoundedBoxGeometry(w, h, d, 2, r).translate(x, TOP + y, z);
const cyl = (bottom: number, top: number, h: number, x: number, y: number, z: number) => new THREE.CylinderGeometry(top, bottom, h, 20).translate(x, TOP + y, z);
/** Ronde knop of lampje op het front: de as wijst naar voren. */
const knob = (r: number, depth: number, x: number, y: number, z: number) => new THREE.CylinderGeometry(r, r, depth, 18).rotateX(Math.PI / 2).translate(x, TOP + y, z);

const SCREEN = new THREE.MeshBasicMaterial({ color: '#8fd3ff' });
const READY = new THREE.MeshBasicMaterial({ color: '#63d17c' });

export function coffeeMachine(): Part[] {
  const stack = COFFEE_SPOTS.stack;
  return [
    // Voet met lekbak, en het rooster waar het bekertje op staat
    [STYLE.dark, rb(0.34, 0.05, 0.42, 0.012, 0, 0.025, -0.05)],
    [STYLE.steel, rb(0.2, 0.012, 0.14, 0.004, 0, 0.053, 0.08)],
    ...[-0.06, -0.02, 0.02, 0.06].map((x): Part => [STYLE.black, rb(0.012, 0.004, 0.12, 0.001, x, 0.061, 0.08)]),
    // Rug en kop: de kop steekt over de ruimte voor het bekertje heen
    [STYLE.black, rb(0.34, 0.5, 0.2, 0.03, 0, 0.3, -0.16)],
    [STYLE.black, rb(0.34, 0.22, 0.42, 0.03, 0, 0.45, -0.05)],
    [STYLE.steel, rb(0.3, 0.012, 0.16, 0.004, 0, 0.2, -0.057)], // spatplaat achter het bekertje, tegen de rug
    // Bedieningspaneel: scherm, drie keuzeknoppen en een lampje
    [STYLE.steel, rb(0.3, 0.16, 0.014, 0.006, 0, 0.45, 0.161)],
    [STYLE.dark, rb(0.13, 0.085, 0.008, 0.003, -0.07, 0.465, 0.169)],
    [SCREEN, rb(0.112, 0.068, 0.004, 0.001, -0.07, 0.465, 0.174)],
    [STYLE.paint, knob(0.015, 0.012, 0.03, 0.47, 0.172)],
    [STYLE.white, knob(0.015, 0.012, 0.075, 0.47, 0.172)],
    [STYLE.white, knob(0.015, 0.012, 0.12, 0.47, 0.172)],
    [READY, knob(0.006, 0.008, 0.12, 0.405, 0.17)],
    // Uitloop met twee tuitjes
    [STYLE.steel, rb(0.08, 0.05, 0.07, 0.012, 0, 0.32, 0.08)],
    ...[-0.02, 0.02].map((x): Part => [STYLE.black, cyl(0.007, 0.009, 0.03, x, 0.285, 0.085)]),
    // Bonenreservoir bovenop: een glazen bak met bonen en een deksel
    [STYLE.coffee, rb(0.2, 0.07, 0.17, 0.02, 0, 0.6, -0.11)],
    [STYLE.glass, rb(0.23, 0.13, 0.2, 0.03, 0, 0.62, -0.11)],
    [STYLE.black, rb(0.24, 0.022, 0.21, 0.01, 0, 0.693, -0.11)],
    // Ernaast: een stapel bekertjes (ondersteboven) op een voet, en een bakje roerstaafjes
    [STYLE.dark, cyl(0.055, 0.055, 0.014, stack.x, 0.007, stack.z)],
    [STYLE.white, cyl(0.037, 0.028, 0.24, stack.x, 0.134, stack.z)],
    ...[0.03, 0.065, 0.1, 0.135, 0.17].map((y): Part => [STYLE.white, cyl(0.039, 0.039, 0.006, stack.x, y, stack.z)]),
    [STYLE.steel, cyl(0.03, 0.034, 0.08, stack.x + 0.02, 0.04, stack.z + 0.14)],
    ...[-0.012, 0, 0.012].map((dx, i): Part => [STYLE.wood, cyl(0.002, 0.002, 0.12, stack.x + 0.02 + dx, 0.07, stack.z + 0.14 + (i - 1) * 0.008)]),
  ];
}

const lathe = (pts: [number, number][]) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 24);
const CUP_GEO = lathe([[0, 0], [0.026, 0], [0.027, 0.004], [0.036, CUP_HEIGHT - 0.004], [0.0375, CUP_HEIGHT - 0.002], [0.036, CUP_HEIGHT], [0.033, CUP_HEIGHT], [0.032, CUP_HEIGHT - 0.012], [0, CUP_HEIGHT - 0.012]]);
const SLEEVE_GEO = lathe([[0.0305, 0.022], [0.0325, 0.022], [0.0368, 0.062], [0.0348, 0.062]]);
const FILL_GEO = new THREE.CircleGeometry(0.0322, 24).rotateX(-Math.PI / 2).translate(0, CUP_HEIGHT - 0.009, 0);

/** Een kartonnen bekertje koffie; het nulpunt is het midden van de bodem. */
export function createCup() {
  const cup = new THREE.Group();
  for (const [geo, mat] of [[CUP_GEO, STYLE.white], [SLEEVE_GEO, STYLE.carton], [FILL_GEO, STYLE.coffee]] as const) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    cup.add(m);
  }
  return cup;
}

/** Het straaltje koffie uit de uitloop in het bekertje eronder; het nulpunt is dat van het apparaat. */
export function createCoffeeStream() {
  const stream = new THREE.Group();
  for (const x of [-0.02, 0.02]) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.14, 8), STYLE.coffee);
    m.position.set(x, TOP + 0.2, 0.085);
    stream.add(m);
  }
  return stream;
}
