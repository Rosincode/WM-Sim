import * as THREE from 'three';
import { onTop } from './style';
import { UNIT_BOX, paint } from './warehouse';
import { canvasTexture } from './textures';

// De Geek+-robot: een lage, platte robot die onder een pallet rijdt en hem optilt. Vooruit is +z.
// Alleen weergave; wat de robots doen staat in src/sim/robots.ts.

/** Hoogte (m) waarop een opgetilde pallet op de robot staat. */
export const ROBOT_DECK = 0.24;
/** Halve breedte en halve lengte van de robot, voor botsingen. */
export const ROBOT_HALF = { x: 0.35, z: 0.5 };
/** Hoogte van de heftafel in rust: de bovenkant steekt net boven de kap uit, zodat de twee niet in één vlak liggen. */
const DECK_DOWN = 0.205;

let parts: ReturnType<typeof makeParts> | null = null;
function makeParts() {
  const logo = canvasTexture(256, 64, (g, w, h) => {
    g.fillStyle = '#1769e0';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.font = 'italic 800 44px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('Geek+', w / 2, h / 2 + 2);
  });
  return {
    skirt: paint('#1b1f24', 0.6, 0.3),
    shell: paint('#1769e0', 0.35, 0.2),
    trim: paint('#e9edf2', 0.4, 0.1),
    deck: paint('#2b3138', 0.5, 0.6),
    black: paint('#0b0d10', 0.3, 0.4),
    logo: onTop(new THREE.MeshStandardMaterial({ map: logo, roughness: 0.35, metalness: 0.2 })),
    logoGeo: new THREE.PlaneGeometry(0.44, 0.11),
  };
}

export function createGeekRobot() {
  const p = (parts ??= makeParts());
  const group = new THREE.Group();
  const part = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(UNIT_BOX, mat);
    m.scale.set(w, h, d);
    m.position.set(x, y, z);
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  part(p.skirt, 0.7, 0.09, 1.0, 0, 0.065, 0); // onderstel
  part(p.shell, 0.66, 0.1, 0.96, 0, 0.16, 0); // blauwe kap
  part(p.trim, 0.56, 0.05, 0.02, 0, 0.165, 0.481); // lichte neus
  part(p.black, 0.42, 0.028, 0.03, 0, 0.1, 0.495); // scanner in de neus
  part(p.black, 0.3, 0.02, 0.02, 0, 0.1, -0.5);
  // Lichtband rondom: de kleur laat zien wat de robot doet
  const ledMat = new THREE.MeshBasicMaterial({ color: '#3ddc84' });
  part(ledMat, 0.706, 0.014, 0.9, 0, 0.116, 0);
  part(ledMat, 0.5, 0.014, 1.006, 0, 0.116, 0);
  // Heftafel: komt omhoog onder de pallet
  const deck = part(p.deck, 0.54, 0.02, 0.8, 0, DECK_DOWN, 0);
  for (const side of [1, -1]) {
    const logo = new THREE.Mesh(p.logoGeo, p.logo);
    logo.position.set(side * 0.3305, 0.16, 0);
    logo.rotation.y = (side * Math.PI) / 2;
    group.add(logo);
  }
  const top = new THREE.Mesh(p.logoGeo, p.logo);
  top.rotation.x = -Math.PI / 2;
  top.position.set(0, 0.2105, -0.44); // achter de heftafel, op de kap
  top.scale.setScalar(0.6);
  group.add(top);

  return {
    group,
    setLed(color: string) {
      ledMat.color.set(color);
    },
    /** up: 0 = tafel omlaag, 1 = pallet opgetild. */
    setLift(up: number) {
      deck.position.y = DECK_DOWN + up * (ROBOT_DECK - 0.01 - DECK_DOWN);
    },
  };
}

/** Laadstation tegen de oostwand; de robot staat er met zijn neus tegenaan (hij kijkt naar +x). */
export function createRobotCharger() {
  const p = (parts ??= makeParts());
  const g = new THREE.Group();
  const part = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(UNIT_BOX, mat);
    m.scale.set(w, h, d);
    m.position.set(x, y, z);
    m.receiveShadow = true;
    g.add(m);
  };
  part(p.trim, 0.36, 0.5, 0.62, 0.84, 0.25, 0); // kast
  part(p.shell, 0.37, 0.07, 0.63, 0.84, 0.42, 0);
  part(p.black, 0.08, 0.05, 0.3, 0.62, 0.12, 0); // laadcontacten
  part(new THREE.MeshBasicMaterial({ color: '#3ddc84' }), 0.01, 0.03, 0.12, 0.655, 0.36, 0);
  const mark = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 1.0),
    onTop(new THREE.MeshStandardMaterial({ color: '#1769e0', transparent: true, opacity: 0.3, depthWrite: false })),
  );
  mark.rotation.x = -Math.PI / 2;
  mark.position.set(-0.05, 0.015, 0);
  g.add(mark);
  return g;
}
