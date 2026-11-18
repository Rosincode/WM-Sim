// Camerastandpunten van de filmer per fragment (stilstaande beelden uit de rondleidingsvideo).
// pos/look in meters (zie de assen in koelhuis.ts); fov = verticale kijkhoek in graden (telefoon ≈ 50).

export type Env = 'buiten' | 'binnen' | 'vries';
export type Shot = { id: string; fragment: string; t: number; pos: [number, number, number]; look: [number, number, number]; fov?: number; env?: Env; handheld?: boolean };

const EYE = 1.6;
const OUT = 1.15; // ooghoogte op het terrein (0,45 m lager dan de hal)

export const SHOTS: Shot[] = [
  { id: 'F01', fragment: 'F01', t: 12, pos: [-6, OUT + 0.4, 64], look: [-11, 3.5, 25], fov: 52, env: 'buiten' },
  { id: 'F02', fragment: 'F02', t: 52, pos: [13, OUT, 33], look: [-14, 3, 25.5], fov: 52, env: 'buiten' },
  { id: 'F03a', fragment: 'F03', t: 78, pos: [12, 1.7, 15.5], look: [-30, 3, 21], fov: 55 },
  { id: 'F03b', fragment: 'F03', t: 100, pos: [16.5, 1.65, 24.4], look: [16.5, 2.8, 13], fov: 68 },
  { id: 'F04', fragment: 'F04', t: 122, pos: [-21.3, EYE, 18.3], look: [-25.5, 1.0, 23.5], fov: 52 },
  { id: 'F05', fragment: 'F05', t: 160, pos: [-23.78, 1.12, 21.75], look: [-24.28, 0.95, 21.75], fov: 34 },
  { id: 'F06', fragment: 'F06', t: 205, pos: [-32.3, 1.7, 16.4], look: [-33.8, 0.3, 21.5], fov: 52 },
  { id: 'F07', fragment: 'F07', t: 240, pos: [-20.0, 2.0, 13.8], look: [-26, 0.3, 19.5], fov: 58 },
  { id: 'F08a', fragment: 'F08', t: 272, pos: [8.0, EYE, 11.4], look: [-6, 3, 8.6], fov: 58 },
  { id: 'F08b', fragment: 'F08', t: 298, pos: [-1.5, EYE, 11.6], look: [-24, 3.2, 8.8], fov: 52 },
  { id: 'F09a', fragment: 'F09', t: 312, pos: [-19.5, EYE, 6.5], look: [-19.1, 3.2, -20], fov: 55 },
  { id: 'F09b', fragment: 'F09', t: 336, pos: [-19.4, EYE, -7.3], look: [-17.58, 5.54, -8.55], fov: 5 },
  { id: 'F10', fragment: 'F10', t: 355, pos: [-19.3, 1.3, -1.6], look: [-17.6, 0.9, -4.6], fov: 55 },
  { id: 'F11', fragment: 'F11', t: 395, pos: [-14.3, 1.7, -0.8], look: [-12, 3.6, -6.75], fov: 55 },
  { id: 'F12', fragment: 'F12', t: 430, pos: [-19.7, EYE, 4.8], look: [-18.3, 0.8, 1.35], fov: 55 },
  { id: 'F13', fragment: 'F13', t: 470, pos: [25, EYE, 12.4], look: [23, 4.0, -2], fov: 64, env: 'vries' },
  { id: 'F14', fragment: 'F14', t: 508, pos: [32, EYE, 9.5], look: [35, 1.0, 1], fov: 55, env: 'vries' },
  { id: 'F15a', fragment: 'F15', t: 544, pos: [17.6, 1.7, 10.8], look: [21.1, 1.9, 6.6], fov: 55, env: 'vries' },
  { id: 'F15b', fragment: 'F15', t: 560, pos: [22.1, 1.7, 11.3], look: [22.1, 1.85, 12.9], fov: 42, env: 'vries' },
  { id: 'F16', fragment: 'F16', t: 575, pos: [7.8, EYE, 23.6], look: [1.06, 1.7, 22.2], fov: 50 },
  { id: 'F17', fragment: 'F17', t: 625, pos: [-19.6, EYE, -3.2], look: [-18.6, 1.2, -8], fov: 55 },
  { id: 'F18', fragment: 'F18', t: 668, pos: [-19.9, EYE, -4.6], look: [-18, 1.0, -8.5], fov: 55 },
  { id: 'F19', fragment: 'F19', t: 690, pos: [-18.5, 1.85, 0.45], look: [-18.7, 1.3, -0.5], fov: 45 },
  { id: 'F20', fragment: 'F20', t: 728, pos: [19.5, EYE, 7.6], look: [19.5, 1.0, 11.3], fov: 55, env: 'vries' },
  { id: 'F21', fragment: 'F21', t: 755, pos: [5.6, 1.65, 13.6], look: [2, 1.0, 16], fov: 58 },
  { id: 'F22a', fragment: 'F22', t: 790, pos: [-11.2, 1.7, 13.5], look: [-13.5, 1.0, 21], fov: 58 },
  { id: 'F22b', fragment: 'F22', t: 805, pos: [-12.85, 1.5, 13.4], look: [-13.5, 1.3, 16.5], fov: 45 },
  { id: 'F23', fragment: 'F23', t: 836, pos: [-9.0, 1.7, 21.3], look: [-9.5, 1.3, 28], fov: 55 },
  { id: 'F24', fragment: 'F24', t: 875, pos: [-31.0, 1.7, -1.4], look: [-33, 1.0, -10], fov: 58 },
  { id: 'F25', fragment: 'F25', t: 915, pos: [-30.9, 1.7, 12.4], look: [-35.5, 0.8, 6], fov: 58 },
  { id: 'F26', fragment: 'F26', t: 950, pos: [-13.6, 1.55, 1.3], look: [-12, 0.7, -0.8], fov: 55, handheld: true },
  { id: 'F27', fragment: 'F27', t: 995, pos: [-3.3, 1.65, 13.8], look: [-8, 1.4, 19], fov: 58 },
];
