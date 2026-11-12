// Vorm van het hoofd van de figuur en hoe een foto daarop past. Gedeeld door de figuur (character.ts), de
// foto-analyse (headPhoto.ts) en het fotovenster (facePhoto.ts): de hoofdvorm die je bij het maken van de foto
// ziet is precies het silhouet van het hoofd van de figuur, zodat ogen, neus en kin op de juiste plek terechtkomen.
// Alle maten in meters, t.o.v. het midden van het hoofd (x opzij, y omhoog, z naar voren).

/**
 * Het hoofd op ware grootte: halve breedte (hx) en halve hoogte (hy), diepte naar voren (gezicht) en naar
 * achteren (achterhoofd) en de plek van het midden t.o.v. het draaipunt in de nek.
 */
export const HEAD = { hx: 0.078, hy: 0.1175, front: 0.094, back: 0.104, y: 0.125, z: 0.012 };

// De foto is een staand beeld (3:4) met ruimte rond het hoofd: boven de kruin en opzij voor het haar, onder de kin
// voor de nek. Het hoofd staat erin van kruin (top) tot kin (chin), gemeten vanaf de bovenrand.
const TOP_V = 0.2;
const CHIN_V = 0.82;
const FRAME_H = (2 * HEAD.hy) / (CHIN_V - TOP_V);
const FRAME_W = FRAME_H * 0.75;
/** Het fotobeeld op het hoofd: kruin en kin (v), en de afmetingen in meters. */
export const PHOTO = { top: TOP_V, chin: CHIN_V, w: FRAME_W, h: FRAME_H };
/** Foto's van vóór de ruimere uitsnede (120×160): daarin vulde het hoofd het beeld bijna helemaal. */
export const OLD_PHOTO = { top: 0.06, h: (2 * HEAD.hy) / 0.86, w: ((2 * HEAD.hy) / 0.86) * 0.75 };

/** Plek op de foto (u naar rechts, v omlaag, beide 0..1) van een punt op het hoofd. */
export const photoUV = (x: number, y: number) => ({ u: 0.5 + x / FRAME_W, v: TOP_V + (HEAD.hy - y) / FRAME_H });

/** Hoogte op het hoofd van een plek op de foto. */
export const headY = (v: number) => HEAD.hy - (v - TOP_V) * FRAME_H;

// Plek van ogen, neuspunt en mond op het hoofd. De verhoudingen (t.o.v. de afstand ogen-kin) zijn het gemiddelde
// van echte gezichten, zodat een foto zo min mogelijk vervormd hoeft te worden om te passen.
const EYE_X = 0.0316;
const EYE_Y = 0;
const NOSE_Y = -0.04;
const MOUTH_Y = -0.0676;
/** Waar op de foto de ogen horen: hoogte, en afstand van elk oog tot het midden. */
export const EYES = { v: photoUV(0, EYE_Y).v, du: EYE_X / FRAME_W };
/** Hoogte op de foto van de neuspunt en van de mond. */
export const NOSE_V = photoUV(0, NOSE_Y).v;
export const MOUTH_V = photoUV(0, MOUTH_Y).v;

// Onder de ogen is het hoofd geen ei maar voller: een brede kaak en een stompe kin (superellips).
const JAW = 2.5;
const full = (g: number) => (g >= 0 ? Math.sqrt(1 - g * g) : (1 - (-g) ** JAW) ** (1 / JAW));
/** Factor op de breedte en diepte t.o.v. een bol, op hoogte g (-1 kin .. 1 kruin). */
const blunt = (g: number) => (g >= 0 ? 1 : full(g) / Math.max(1e-4, Math.sqrt(1 - g * g)));

/** Halve breedte van het hoofd (recht van voren gezien) op hoogte y. */
export function halfWidth(y: number) {
  return HEAD.hx * full(Math.max(-1, Math.min(1, y / HEAD.hy)));
}

/**
 * Punt op het hoofd in de richting (dx, dy, dz) vanuit het midden (lengte 1). Een ei-vorm met een volle
 * kaak, een kin die naar voren steekt, een achterhoofd dat naar de nek toe wegloopt, en in het gezicht een
 * neus, oogkassen, lippen en kin. Opzij en omhoog (x, y) volgen alleen uit dx en dy, zodat de foto er recht op past.
 */
export function headSurface(dx: number, dy: number, dz: number, out: { x: number; y: number; z: number }) {
  const t = Math.max(0, -dy);
  const b = blunt(dy);
  const x = HEAD.hx * dx * b;
  const y = HEAD.hy * dy;
  let z = dz >= 0 ? HEAD.front * dz * b * (1 - 0.1 * t * t) : HEAD.back * dz * b * (1 - 0.5 * t * t);
  z += 0.026 * t ** 2.2; // kaak en kin naar voren, de onderkant van de schedel naar de nek
  if (dz > 0) {
    const k = Math.min(1, dz / 0.35);
    const face = k * k * (3 - 2 * k);
    const s = y - NOSE_Y;
    const nose = 0.02 * Math.exp(-((x / 0.0125) ** 2)) * Math.exp(-((s / (s >= 0 ? 0.03 : 0.009)) ** 2)); // rug loopt op naar de punt
    const sockets = 0.006 * Math.exp(-(((Math.abs(x) - EYE_X) / 0.016) ** 2) - ((y - EYE_Y) / 0.01) ** 2);
    const lips = 0.004 * Math.exp(-((x / 0.02) ** 2) - ((y - MOUTH_Y) / 0.007) ** 2);
    const chin = 0.004 * Math.exp(-((x / 0.02) ** 2) - ((y + HEAD.hy - 0.02) / 0.012) ** 2);
    z += face * (nose - sockets + lips + chin);
  }
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/** Punt op de voorkant van het hoofd (het gezicht) recht voor (x, y). */
export function headFront(x: number, y: number, out = { x: 0, y: 0, z: 0 }) {
  const dy = Math.max(-1, Math.min(1, y / HEAD.hy));
  const dx = x / (HEAD.hx * blunt(dy));
  return headSurface(dx, dy, Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy)), out);
}

/** Omtrek van het hoofd op de foto, recht van voren gezien: punten (u, v) rond, beginnend bij de kruin. */
export function headOutline(steps = 40): [number, number][] {
  const right: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const y = HEAD.hy * Math.cos((i / steps) * Math.PI); // kruin .. kin
    const { u, v } = photoUV(halfWidth(y), y);
    right.push([u, v]);
  }
  return [...right, ...right.slice(1, -1).reverse().map(([u, v]): [number, number] => [1 - u, v])];
}

/**
 * Waar herkenningspunten van een gezicht op het hoofd horen (x opzij, y omhoog; links/rechts gespiegeld): hiermee
 * wordt een foto zo bijgetrokken dat ogen, neus, mond, kin en de rand van het gezicht op hun plek op het hoofd vallen.
 */
export const FACE_POINTS = {
  eye: [EYE_X, EYE_Y],
  nose: [0, NOSE_Y],
  mouth: [0, MOUTH_Y],
  chin: [0, 0.003 - HEAD.hy],
  forehead: [0, 0.051],
  side: [0.071, -0.017],
  jaw: [0.0578, -0.0785],
} satisfies Record<string, [number, number]>;
