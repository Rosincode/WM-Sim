import * as THREE from 'three';
import { arc, type P } from './forklift';
import { STYLE } from './style';
import { Parts, meshes, type Built } from './truck';

// Personenauto op het parkeerterrein: een compacte vijfdeurs in dezelfde stijl als de vrachtwagens (truck.ts):
// ronde vormen in een paar effen, matte materialen, het detail zit in de vorm. Het nulpunt is het midden op de
// grond, de voorkant wijst naar +z. De lak is een van de materialen uit STYLE.

/** Lengte en breedte van de auto (m). */
export const CAR = { length: 4.3, width: 1.78 };
/** De lakkleuren waarin de auto's er zijn. */
export const CAR_PAINTS: THREE.Material[] = [STYLE.paint, STYLE.blue, STYLE.white, STYLE.dark, STYLE.steel, STYLE.green];

const AXLE = 1.3; // de assen liggen zo ver voor en achter het midden
const WHEEL_R = 0.31;
const HALF = CAR.width / 2;

// Gebouwd langs x met de neus naar -x (zoals de vrachtwagen), daarna een kwartslag gedraaid.
function build(): Built {
  const p = new Parts();
  // Wielkast: een halve cirkel uit de onderrand van de carrosserie
  const arch = (x: number): P[] => arc(x, WHEEL_R, 0.39, Math.PI + 0.24, -0.24, 12);
  // Carrosserie tot de raamlijn: kofferklep, schouderlijn, aflopende motorkap, neus, en onderlangs de wielkasten
  p.side(
    'accent',
    [
      [2.12, 0.3, 0.06], [2.15, 0.62, 0.08], [2.08, 0.92, 0.1], [-0.95, 0.93, 0.2], [-1.95, 0.75, 0.14], [-2.15, 0.6, 0.08], [-2.12, 0.3, 0.06],
      [-1.74, 0.22], ...arch(-AXLE), ...arch(AXLE), [1.74, 0.22],
    ],
    CAR.width,
    0,
    0.05,
  );
  // Ruiten rondom als één donker blok, met het dak en de stijlen in de lak eroverheen
  p.side('tinted', [[1.98, 0.9], [1.6, 1.4, 0.1], [-0.3, 1.42, 0.12], [-1.08, 0.9]], 1.6, 0, 0.04);
  p.side('accent', [[1.66, 1.37], [1.56, 1.455, 0.05], [-0.27, 1.475, 0.06], [-0.4, 1.385]], 1.63, 0, 0.03);
  for (const s of [1, -1]) {
    p.box('accent', 0.11, 0.5, 0.03, 0.5, 1.15, s * 0.792, 0.012); // middenstijl
    p.box('black', 0.12, 0.03, 0.02, 0.28, 0.82, s * (HALF + 0.004), 0.006); // deurgrepen
    p.box('black', 0.12, 0.03, 0.02, 1.2, 0.82, s * (HALF + 0.004), 0.006);
    p.box('black', 0.07, 0.1, 0.17, -0.8, 0.99, s * (HALF + 0.05), 0.025); // spiegel
    p.box('lamp', 0.03, 0.09, 0.34, -2.128, 0.6, s * 0.6, 0.01); // koplamp
    p.box('tail', 0.03, 0.12, 0.3, 2.118, 0.76, s * 0.62, 0.01); // achterlicht
    for (const x of [-AXLE, AXLE]) p.wheel(x, s * (HALF - 0.115), WHEEL_R, 0.2);
  }
  p.box('black', 0.03, 0.13, 0.86, -2.125, 0.43, 0, 0.01); // grille
  p.box('dark', 0.05, 0.1, 1.5, 2.13, 0.36, 0, 0.02); // bumperstrip achter
  // Bodem: sluit de wielkasten van binnen af, zodat je niet dwars door de auto kijkt
  p.box('dark', 3.9, 0.4, 1.36, 0, 0.4, 0, 0.03);
  for (const x of [-AXLE, AXLE]) p.rod('steel', 'z', 0.04, 1.4, x, WHEEL_R, 0);
  const built = p.build();
  for (const b of built) b.geometry.rotateY(Math.PI / 2);
  return built;
}

let built: Built | null = null;

/** Een auto in de gegeven lak (een materiaal uit STYLE, zie CAR_PAINTS). */
export function createCar(paint: THREE.Material) {
  const group = new THREE.Group();
  meshes((built ??= build()), paint, group);
  return group;
}
