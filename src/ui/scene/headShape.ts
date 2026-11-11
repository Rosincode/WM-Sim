// Vorm van het hoofd van de figuur en hoe een foto daarop past. Gedeeld door de figuur (character.ts) en
// het fotovenster (facePhoto.ts): de hoofdvorm die je bij het maken van de foto ziet is precies het
// silhouet van het hoofd van de figuur, zodat ogen en kin op de juiste plek terechtkomen.

/** Het hoofd is een bol (straal r) die langwerpig is uitgerekt (sx, sy, sz) en op hoogte y boven de nek zit. */
export const HEAD = { r: 0.1, sx: 0.8, sy: 1.4, sz: 0.98, y: 0.105 };
/** Hoogte (t.o.v. de nek) van de onderrand van de helm: wat daarboven zit is niet te zien. */
export const BRIM_Y = 0.16;

/** Het hoofd loopt naar de kin smaller toe. g = hoogte op de bol, -1 (kin) .. 1 (kruin); geeft de factor op de breedte. */
export const taper = (g: number) => 1 - 0.36 * Math.max(0, -g) ** 2;

// De foto is een staand beeld (3:4). Daarin staat het hoofd van kruin (TOP_V) tot kin (CHIN_V), gemeten vanaf de bovenrand.
const TOP_V = 0.06;
const CHIN_V = 0.92;
const HEAD_TOP = HEAD.y + HEAD.r * HEAD.sy;
/** Afmetingen van het fotobeeld op het hoofd, in meters. */
const FRAME_H = (2 * HEAD.r * HEAD.sy) / (CHIN_V - TOP_V);
const FRAME_W = FRAME_H * 0.75;

/** Plek op de foto (u naar rechts, v omlaag, beide 0..1) van een punt op het hoofd (x opzij, y omhoog t.o.v. de nek). */
export const photoUV = (x: number, y: number) => ({ u: 0.5 + x / FRAME_W, v: TOP_V + (HEAD_TOP - y) / FRAME_H });

/** Hoogte op het hoofd (t.o.v. de nek) van een plek op de foto. */
export const headY = (v: number) => HEAD_TOP - (v - TOP_V) * FRAME_H;

/** Waar op de foto de ogen horen: hoogte, en afstand van elk oog tot het midden. */
export const EYES = { v: 0.49, du: 0.086 };
/** Hoogte op de foto van de neuspunt. */
export const NOSE_V = 0.61;
/** Midden van het hoofd op de foto. */
export const CENTER_V = (TOP_V + CHIN_V) / 2;

/** Omtrek van het hoofd op de foto, recht van voren gezien: punten (u, v) rond, beginnend bij de kruin. */
export function headOutline(steps = 40): [number, number][] {
  const right: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const g = Math.cos((i / steps) * Math.PI); // 1 (kruin) .. -1 (kin)
    const x = HEAD.r * HEAD.sx * Math.sqrt(1 - g * g) * taper(g);
    const { u, v } = photoUV(x, HEAD.y + HEAD.r * HEAD.sy * g);
    right.push([u, v]);
  }
  return [...right, ...right.slice(1, -1).reverse().map(([u, v]): [number, number] => [1 - u, v])];
}
