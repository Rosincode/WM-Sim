import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TRUCK } from '../../sim/drivers';
import { arc, profile, type P } from './forklift';
import { STYLE } from './style';

// De vrachtwagen aan het dock: een bakwagen met een lage laadvloer waar je in kunt kijken en rijden. De achterdeuren
// gaan open voordat hij tegen het dock staat; de chauffeur rijdt met de pompwagen over de laadklep naar binnen.
// Het nulpunt is de achterkant van de laadbak op de grond; de cabine staat aan de kant van -x.
// Zelfde stijl als alles in de hal (zie style.ts): ronde vormen in een paar effen, matte materialen. De cabine
// en de streep op de laadbak zijn blauw bij een wagen die komt lossen en rood bij een wagen die komt laden.
// Verderop staat de oplegger die geparkeerd op het terrein staat (createParkedTrailer).

/** Binnenmaat van de laadruimte: lengte, halve breedte en hoogte boven de laadvloer. */
export const TRAILER = { length: TRUCK.length, half: 1.3, height: 2.75 };

type Key = 'white' | 'accent' | 'dark' | 'black' | 'steel' | 'rubber' | 'wood' | 'tinted' | 'lamp' | 'tail' | 'marker';
const LIGHTS = {
  lamp: new THREE.MeshBasicMaterial({ color: '#fff4d6' }),
  tail: new THREE.MeshBasicMaterial({ color: '#d42a1a' }),
  marker: new THREE.MeshBasicMaterial({ color: '#ff9d1a' }),
};
const material = (key: Key, accent: THREE.Material): THREE.Material =>
  key === 'accent' ? accent : key === 'lamp' || key === 'tail' || key === 'marker' ? LIGHTS[key] : STYLE[key];

/** Verzamelt onderdelen per materiaal en voegt ze samen: een hele wagen is dan een handvol tekenopdrachten. */
export class Parts {
  private map = new Map<Key, THREE.BufferGeometry[]>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private one = new THREE.Vector3(1, 1, 1);

  add(key: Key, geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.applyMatrix4(this.m.compose(new THREE.Vector3(x, y, z), this.q.setFromEuler(this.e.set(rx, ry, rz)), this.one));
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    const list = this.map.get(key) ?? [];
    list.push(g);
    this.map.set(key, list);
    return this;
  }

  /** Afgeronde balk: lengte (x), hoogte (y), breedte (z). */
  box(key: Key, w: number, h: number, d: number, x: number, y: number, z: number, r = 0.012) {
    return this.add(key, new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2.01, h / 2.01, d / 2.01)), x, y, z);
  }

  /** Ronde staaf langs de x-, y- of z-as. */
  rod(key: Key, axis: 'x' | 'y' | 'z', radius: number, length: number, x: number, y: number, z: number) {
    const geo = new THREE.CylinderGeometry(radius, radius, length, 16);
    return this.add(key, geo, x, y, z, axis === 'z' ? Math.PI / 2 : 0, 0, axis === 'x' ? Math.PI / 2 : 0);
  }

  /** Zijaanzicht (x, y) met afgeronde hoeken, uitgetrokken over de breedte (z, rond het midden). */
  side(key: Key, pts: P[], width: number, z = 0, bevel = 0.012) {
    return this.add(key, profile(pts, width, bevel).rotateY(Math.PI / 2), 0, 0, z);
  }

  /** Wiel met de as langs z: band met ronde schouders, velg en naaf. */
  wheel(x: number, z: number, r: number, w: number) {
    const h = w / 2;
    const tyre = [[r * 0.56, -h], [r - 0.04, -h], [r - 0.01, -h + 0.025], [r, -h + 0.06], [r, h - 0.06], [r - 0.01, h - 0.025], [r - 0.04, h], [r * 0.56, h]];
    this.add('rubber', new THREE.LatheGeometry(tyre.map(([px, py]) => new THREE.Vector2(px, py)), 28), x, r, z, Math.PI / 2);
    this.add('steel', new THREE.CylinderGeometry(r * 0.58, r * 0.58, w * 0.72, 24), x, r, z, Math.PI / 2);
    this.add('dark', new THREE.CylinderGeometry(r * 0.22, r * 0.22, w * 0.86, 14), x, r, z, Math.PI / 2);
    return this;
  }

  build() {
    return [...this.map].map(([key, list]) => ({ key, geometry: mergeGeometries(list) }));
  }
}

export type Built = ReturnType<Parts['build']>;
/** Maakt van de samengevoegde onderdelen meshes; `accent` is de lak van dit voertuig. */
export function meshes(built: Built, accent: THREE.Material, parent: THREE.Object3D) {
  for (const { key, geometry } of built) {
    const mesh = new THREE.Mesh(geometry, material(key, accent));
    const light = key === 'lamp' || key === 'tail' || key === 'marker';
    mesh.castShadow = !light;
    mesh.receiveShadow = !light;
    parent.add(mesh);
  }
}

const { length: L, half, height: H } = TRAILER;
const F = TRUCK.floor;
const TOP = F + H;
/** Buitenkant van de zijwand (z). */
const OUT = half + 0.05;
/** De wielkasten in de laadruimte: van voor tot achter (x), en hoe hoog ze boven de grond komen. */
const ARCH = { from: -3.22, to: -1.08, top: 0.74 };
/** Het scharnier van een achterdeur zit net buiten de zijwand, zodat de open deur er vlak langs ligt. */
const HINGE_Z = OUT + 0.07;

function buildBody() {
  const p = new Parts();
  // Laadvloer: tussen de wielkasten over de hele lengte, ernaast alleen voor en achter de wielen
  const side = half - TRUCK.clear;
  p.box('wood', L, 0.1, TRUCK.clear * 2, -L / 2, F - 0.05, 0, 0.01);
  for (const s of [1, -1]) {
    const z = s * (TRUCK.clear + side / 2);
    p.box('wood', L + ARCH.from, 0.1, side, (ARCH.from - L) / 2, F - 0.05, z, 0.01);
    p.box('wood', -ARCH.to, 0.1, side, ARCH.to / 2, F - 0.05, z, 0.01);
    // Wielkast: een dichte kast over de achterwielen; pallets en de pompwagen blijven ertussen (TRUCK.clear)
    p.box('white', ARCH.to - ARCH.from, ARCH.top - F + 0.1, side + 0.01, (ARCH.from + ARCH.to) / 2, (ARCH.top + F - 0.1) / 2, s * (TRUCK.clear + (side + 0.01) / 2), 0.03);
    // Zijwand met een streep in de kleur van de wagen, en eronder een donkere rand tussen de wielen
    p.box('white', L, H + 0.1, 0.05, -L / 2, F + H / 2 - 0.05, s * (half + 0.025));
    p.box('accent', L - 0.5, 0.3, 0.02, -L / 2, F + 0.85, s * (OUT + 0.004), 0.008);
    p.box('dark', L + ARCH.from - 0.2, 0.16, 0.03, (ARCH.from - L) / 2, F - 0.18, s * (OUT - 0.02), 0.01);
    p.box('dark', -ARCH.to - 0.16, 0.16, 0.03, ARCH.to / 2 - 0.02, F - 0.18, s * (OUT - 0.02), 0.01);
    for (const x of [-7.2, -5.4, -3.7]) p.box('marker', 0.1, 0.04, 0.012, x, F - 0.18, s * (OUT - 0.001), 0.004);
    // Achterstijl van het deurkozijn
    p.box('steel', 0.06, H + 0.1, 0.06, -0.027, F + H / 2 - 0.05, s * (half + 0.025), 0.01);
    // Onderstel: langsligger, achterwielen in de wielkast en het voorwiel onder de cabine
    p.box('dark', 10, 0.14, 0.1, -5.2, 0.27, s * 0.42, 0.02);
    p.wheel(-1.55, s * (TRUCK.clear + 0.13), 0.33, 0.2);
    p.wheel(-2.75, s * (TRUCK.clear + 0.13), 0.33, 0.2);
    p.wheel(-9.5, s * 1.1, 0.42, 0.26);
    p.box('tail', 0.02, 0.07, 0.24, -0.025, 0.24, s * 1.0, 0.006);
  }
  p.box('white', 0.06, H + 0.1, half * 2, -L + 0.03, F + H / 2 - 0.05, 0); // kopwand
  p.box('white', L, 0.06, OUT * 2 + 0.02, -L / 2, TOP + 0.03, 0, 0.02); // dak
  p.box('steel', 0.06, 0.08, OUT * 2 + 0.01, -0.027, TOP + 0.025, 0, 0.01); // bovendorpel van het deurkozijn
  p.box('dark', 0.1, 0.12, 2.5, -0.08, 0.24, 0, 0.03); // bumperbalk achter
  p.rod('steel', 'z', 0.055, 2.0, -9.5, 0.42, 0);
  for (const x of [-0.6, -4.2, -6.4, -8.1]) p.box('dark', 0.08, 0.1, 0.84, x, 0.27, 0, 0.02);

  // Cabine: frontstuurder met een schuine voorruit, spatborden over de voorwielen en een spoiler op het dak
  p.side('accent', [[-8.15, 1.0, 0.05], [-8.15, 3.0, 0.12], [-9.7, 3.0, 0.3], [-10.45, 2.0, 0.18], [-10.45, 1.0, 0.08]], 2.5, 0, 0.03);
  p.side('accent', [[-8.2, 2.98], [-8.2, 3.26, 0.06], [-9.5, 2.98, 0.02]], 2.2, 0, 0.02);
  p.box('dark', 2.2, 0.5, 1.84, -9.3, 0.76, 0, 0.05);
  p.box('dark', 0.3, 0.42, 2.5, -10.36, 0.6, 0, 0.06); // bumper
  p.box('black', 0.03, 0.6, 1.7, -10.455, 1.45, 0); // grille
  // voorruit: ligt op het schuine vlak van de cabine
  p.add('tinted', new RoundedBoxGeometry(0.02, 0.62, 2.2, 2, 0.008), -10.0782, 2.5024, 0, 0, 0, -0.6435);
  const fender = [...arc(-9.5, 0.42, 0.52, 0.15, Math.PI - 0.15), ...arc(-9.5, 0.42, 0.46, Math.PI - 0.15, 0.15)];
  for (const s of [1, -1]) {
    p.side('accent', fender, 0.32, s * 1.1, 0.008);
    p.box('tinted', 0.8, 0.55, 0.02, -9.45, 2.4, s * 1.254, 0.008); // zijruit
    p.box('black', 0.14, 0.03, 0.02, -8.9, 1.95, s * 1.256, 0.006); // deurgreep
    p.box('black', 0.06, 0.42, 0.14, -10.2, 2.45, s * 1.42, 0.02); // spiegel
    p.box('black', 0.04, 0.03, 0.16, -10.2, 2.6, s * 1.33, 0.01);
    p.box('black', 0.5, 0.05, 0.26, -8.72, 0.6, s * 1.05); // opstap
    p.box('lamp', 0.02, 0.12, 0.36, -10.512, 0.66, s * 0.92, 0.008); // koplamp
  }
  return p.build();
}

/** Eén achterdeur, om zijn scharnier (de y-as): dicht ligt hij langs z naar het midden van de wagen. */
function buildDoor(side: number) {
  const p = new Parts();
  const w = HINGE_Z - 0.01;
  p.box('white', 0.05, H, w, 0, F + H / 2, (-side * w) / 2);
  for (const z of [0.42, 1.0]) {
    p.rod('steel', 'y', 0.012, H - 0.2, 0.035, F + H / 2, -side * z); // sluitstang
    p.box('black', 0.03, 0.04, 0.16, 0.04, F + 1.0, -side * (z + 0.06), 0.008);
  }
  return p.build();
}

let body: Built | null = null;
const doorParts = new Map<number, Built>();

export function createTruck(direction: 'in' | 'out') {
  const group = new THREE.Group();
  const accent = direction === 'in' ? STYLE.blue : STYLE.paint;
  meshes((body ??= buildBody()), accent, group);
  // Achterdeuren: dicht onderweg, opengeklapt langs de zijwanden aan het dock
  const doors = [1, -1].map((side) => {
    const hinge = new THREE.Group();
    hinge.position.set(0.03, 0, side * HINGE_Z);
    if (!doorParts.has(side)) doorParts.set(side, buildDoor(side));
    meshes(doorParts.get(side)!, accent, hinge);
    group.add(hinge);
    return { hinge, side };
  });

  group.visible = false;
  return {
    group,
    /** @param open 0 = achterdeuren dicht, 1 = opengeklapt langs de zijwanden */
    setDoors(open: number) {
      for (const d of doors) d.hinge.rotation.y = -d.side * open * Math.PI * 1.5;
    },
  };
}

let parked: Built | null = null;
function buildParked() {
  const p = new Parts();
  const len = 12;
  p.box('white', len, 2.7, 2.5, 0, 2.5, 0, 0.05); // laadbak
  p.box('steel', 0.05, 2.74, 2.54, len / 2 - 0.02, 2.5, 0, 0.012); // deurkozijn achter
  p.box('dark', 0.1, 0.12, 2.4, len / 2 - 0.1, 0.62, 0, 0.03); // bumperbalk
  for (const s of [1, -1]) {
    p.box('accent', len - 0.6, 0.3, 0.02, 0, 1.95, s * 1.254, 0.008);
    p.box('dark', len - 0.6, 0.2, 0.12, 0, 1.06, s * 0.5, 0.02); // langsligger
    p.box('steel', 0.1, 0.96, 0.1, -4.4, 0.5, s * 0.6, 0.015); // steunpoot
    p.box('dark', 0.24, 0.03, 0.24, -4.4, 0.015, s * 0.6, 0.008);
    p.box('dark', 0.06, 0.4, 0.06, len / 2 - 0.1, 0.84, s * 0.5, 0.012);
    p.box('tail', 0.02, 0.07, 0.24, len / 2 - 0.045, 0.62, s * 0.95, 0.006);
    for (const z of [0.3, 0.9]) p.rod('steel', 'y', 0.014, 2.5, len / 2 + 0.017, 2.5, s * z); // sluitstangen
    for (const x of [2.9, 4.1, 5.3]) p.wheel(x, s * 1.05, 0.5, 0.3);
  }
  p.box('steel', 0.06, 0.06, 1.2, -4.4, 0.7, 0, 0.012);
  for (const x of [2.9, 4.1, 5.3]) p.rod('steel', 'z', 0.06, 1.9, x, 0.5, 0);
  return p.build();
}

/** Een afgekoppelde oplegger op zijn steunpoten, voor op het terrein. Het nulpunt is het midden op de grond; de lengte ligt langs x. */
export function createParkedTrailer() {
  const group = new THREE.Group();
  meshes((parked ??= buildParked()), STYLE.blue, group);
  return group;
}
