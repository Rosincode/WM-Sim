// Vorm van het hoofd van de figuur en hoe een foto daarop past. Gedeeld door de figuur (character.ts), de
// foto-analyse (headPhoto.ts) en het fotovenster (facePhoto.ts): de hoofdvorm die je bij het maken van de foto
// ziet is precies het silhouet van het hoofd van de figuur, zodat ogen, neus en kin op de juiste plek terechtkomen.
// Alle maten in meters, t.o.v. het midden van het hoofd (x opzij, y omhoog, z naar voren).

/**
 * Het hoofd op ware grootte: halve breedte (hx) en halve hoogte (hy), diepte naar voren (gezicht) en naar
 * achteren (achterhoofd) en de plek van het midden t.o.v. het draaipunt in de nek.
 */
export const HEAD = { hx: 0.078, hy: 0.1175, front: 0.094, back: 0.104, y: 0.125, z: 0.012 };

// De foto is een staand beeld (3:4). Daarin staat het hoofd van kruin (top) tot kin (chin), gemeten vanaf de bovenrand.
const TOP_V = 0.06;
const CHIN_V = 0.92;
const FRAME_H = (2 * HEAD.hy) / (CHIN_V - TOP_V);
const FRAME_W = FRAME_H * 0.75;
/** Het fotobeeld op het hoofd: kruin en kin (v), en de afmetingen in meters. */
export const PHOTO = { top: TOP_V, chin: CHIN_V, w: FRAME_W, h: FRAME_H };

/** Plek op de foto (u naar rechts, v omlaag, beide 0..1) van een punt op het hoofd. */
export const photoUV = (x: number, y: number) => ({ u: 0.5 + x / FRAME_W, v: TOP_V + (HEAD.hy - y) / FRAME_H });

/** Hoogte op het hoofd van een plek op de foto. */
export const headY = (v: number) => HEAD.hy - (v - TOP_V) * FRAME_H;

const EYE_X = 0.031;
/** Waar op de foto de ogen horen: hoogte, en afstand van elk oog tot het midden. */
export const EYES = { v: 0.49, du: EYE_X / FRAME_W };
/** Hoogte op de foto van de neuspunt en van de mond. */
export const NOSE_V = 0.64;
export const MOUTH_V = 0.745;

const EYE_Y = headY(EYES.v);
const NOSE_Y = headY(NOSE_V);
const MOUTH_Y = headY(MOUTH_V);

/** Het hoofd loopt naar de kin smaller toe. g = hoogte, -1 (kin) .. 1 (kruin); geeft de factor op de breedte. */
const taper = (g: number) => 1 - 0.3 * Math.max(0, -g) ** 2;

/** Halve breedte van het hoofd (recht van voren gezien) op hoogte y. */
export function halfWidth(y: number) {
  const g = Math.max(-1, Math.min(1, y / HEAD.hy));
  return HEAD.hx * Math.sqrt(1 - g * g) * taper(g);
}

/**
 * Punt op het hoofd in de richting (dx, dy, dz) vanuit het midden (lengte 1). Een ei-vorm met een smallere
 * kaak, een kin die naar voren steekt, een achterhoofd dat naar de nek toe wegloopt, en in het gezicht een
 * neus, oogkassen, lippen en kin. Opzij en omhoog (x, y) volgen alleen uit dx en dy, zodat de foto er recht op past.
 */
export function headSurface(dx: number, dy: number, dz: number, out: { x: number; y: number; z: number }) {
  const t = Math.max(0, -dy);
  const x = HEAD.hx * dx * taper(dy);
  const y = HEAD.hy * dy;
  let z = dz >= 0 ? HEAD.front * dz * (1 - 0.12 * t * t) : HEAD.back * dz * (1 - 0.5 * t * t);
  z += 0.05 * t ** 2.2; // kaak en kin naar voren, de onderkant van de schedel naar de nek
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
  const dx = x / (HEAD.hx * taper(dy));
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
