import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { STYLE } from '../scene/style';
import { UNIT_BOX, UNIT_CYL, palletGeometry } from '../scene/warehouse';
import { Parts, meshes, type Built } from '../scene/truck';

// Modellen voor het koelhuis van de videoscan-test, in de stijl van de heftruck (src/ui/scene/forklift.ts):
// ronde vormen, effen matte materialen uit STYLE, op ware grootte in meters, voorkant naar +Z.

export const rb = (w: number, h: number, d: number, r = 0.02) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2.01, h / 2.01, d / 2.01));

export function part(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  parent.add(m);
  return m;
}

/** Ronde staaf van a naar b. */
export function rod(parent: THREE.Object3D, mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, r: number) {
  const m = part(parent, UNIT_CYL, mat, 0, 0, 0);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.scale.set(r, a.distanceTo(b), r);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------------------------------------
// Pallets met lading: alles samen in een paar InstancedMeshes (er staan duizenden pallets).

export type LoadKind = 'doos' | 'tray' | 'krat' | 'vries';
const KINDS: Record<LoadKind, { nx: number; nz: number; h: number; colors: string[] }> = {
  doos: { nx: 3, nz: 2, h: 0.26, colors: ['#b98f62', '#a9805a', '#c49a6c', '#b0875c'] },
  tray: { nx: 4, nz: 3, h: 0.2, colors: ['#e4e6e8', '#dfe3e6'] },
  krat: { nx: 2, nz: 2, h: 0.3, colors: ['#1e4f9c', '#7f868d'] },
  vries: { nx: 3, nz: 2, h: 0.22, colors: ['#e4e6e8', '#c49a6c', '#b98f62'] },
};
const BOX = rb(1, 1, 1, 0.04);

export class Loads {
  private pallets: THREE.Matrix4[] = [];
  private boxes: { m: THREE.Matrix4; c: THREE.Color }[] = [];
  private wraps: THREE.Matrix4[] = [];
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private seed = 1;
  private rnd() {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  /**
   * Pallet op (x, y, z) (onderkant), lange kant langs x bij ry = 0.
   * @param layers aantal volle lagen; frac = deel van de bovenste laag (0..1)
   */
  pallet(x: number, y: number, z: number, ry: number, kind: LoadKind, layers: number, frac = 1, wrapped = false, colorIndex?: number) {
    const rot = this.q.setFromEuler(this.e.set(0, ry, 0)).clone();
    const at = (lx: number, ly: number, lz: number) => v(lx, ly, lz).applyQuaternion(rot).add(v(x, y, z));
    this.pallets.push(new THREE.Matrix4().compose(v(x, y, z), rot, v(1, 1, 1)));
    const k = KINDS[kind];
    const color = new THREE.Color(k.colors[colorIndex ?? Math.floor(this.rnd() * k.colors.length)]);
    const bw = 1.2 / k.nx;
    const bd = 0.8 / k.nz;
    const total = k.nx * k.nz;
    for (let l = 0; l <= layers; l++) {
      const n = l < layers ? total : Math.round(total * frac);
      for (let i = 0; i < n; i++) {
        const ix = i % k.nx;
        const iz = Math.floor(i / k.nx);
        const p = at(-0.6 + bw * (ix + 0.5), 0.144 + k.h * (l + 0.5), -0.4 + bd * (iz + 0.5));
        const c = color.clone().offsetHSL(0, 0, (this.rnd() - 0.5) * 0.03);
        this.boxes.push({ m: new THREE.Matrix4().compose(p, rot, v(bw - 0.012, k.h - 0.008, bd - 0.012)), c });
      }
    }
    const top = 0.144 + k.h * (layers + (frac > 0 ? 1 : 0));
    if (wrapped) this.wraps.push(new THREE.Matrix4().compose(at(0, (0.15 + top) / 2, 0), rot, v(1.215, top - 0.14, 0.815)));
    return top;
  }

  build(parent: THREE.Object3D) {
    const wood = new THREE.InstancedMesh(palletGeometry(), STYLE.wood, this.pallets.length);
    this.pallets.forEach((m, i) => wood.setMatrixAt(i, m));
    const boxes = new THREE.InstancedMesh(BOX, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85 }), this.boxes.length);
    this.boxes.forEach((b, i) => {
      boxes.setMatrixAt(i, b.m);
      boxes.setColorAt(i, b.c);
    });
    const wrapMat = new THREE.MeshStandardMaterial({ color: '#eef4f8', roughness: 0.25, transparent: true, opacity: 0.22, depthWrite: false });
    const wraps = new THREE.InstancedMesh(UNIT_BOX, wrapMat, Math.max(1, this.wraps.length));
    this.wraps.forEach((m, i) => wraps.setMatrixAt(i, m));
    wraps.count = this.wraps.length;
    for (const m of [wood, boxes]) {
      m.castShadow = m.receiveShadow = true;
      m.computeBoundingSphere();
    }
    wraps.computeBoundingSphere();
    parent.add(wood, boxes, wraps);
  }
}

// ---------------------------------------------------------------------------------------------
// Rolcontainer: 0,72 breed (x), 0,80 diep (z), 1,80 hoog. Achter- en zijwanden van gaas, voorkant open.

export const ROLCO = { w: 0.72, d: 0.8, h: 1.8 };
let rolcoBuilt: Built | null = null;
function buildRolco() {
  const p = new Parts();
  const { w, d, h } = ROLCO;
  p.box('steel', w, 0.05, d, 0, 0.17, 0, 0.01); // bodemplaat
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const x = sx * (w / 2 - 0.06);
      const z = sz * (d / 2 - 0.08);
      p.box('steel', 0.05, 0.04, 0.05, x, 0.13, z, 0.008);
      p.add('rubber', new THREE.CylinderGeometry(0.055, 0.055, 0.04, 16), x, 0.055, z, 0, 0, Math.PI / 2);
    }
  const R = 0.008;
  // staanders op de hoeken en bovenrand
  for (const [x, z] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) p.rod('steel', 'y', 0.012, h - 0.2, x, 0.2 + (h - 0.2) / 2, z);
  // gaas achterwand (z = -d/2) en zijwanden (x = ±w/2)
  for (let y = 0.3; y <= h + 0.01; y += 0.25) {
    p.rod('steel', 'x', R, w, 0, y, -d / 2);
    for (const sx of [-1, 1]) p.rod('steel', 'z', R, d, (sx * w) / 2, y, 0);
  }
  for (let x = -w / 2 + 0.1; x < w / 2 - 0.05; x += 0.1) p.rod('steel', 'y', R * 0.7, h - 0.2, x, 0.2 + (h - 0.2) / 2, -d / 2);
  for (const sx of [-1, 1]) for (let z = -d / 2 + 0.1; z < d / 2 - 0.05; z += 0.1) p.rod('steel', 'y', R * 0.7, h - 0.2, (sx * w) / 2, 0.2 + (h - 0.2) / 2, z);
  // legbord halverwege
  p.box('steel', w - 0.02, 0.02, d - 0.02, 0, 0.98, 0, 0.005);
  return p.build();
}

export type RolcoOpts = { fill?: number; kind?: LoadKind; wrap?: boolean; cover?: boolean; label?: THREE.Object3D; seed?: number };

/** Rolcontainer, met lading tot `fill` (0..1) van de hoogte. */
export function createRolco(opts: RolcoOpts = {}) {
  const group = new THREE.Group();
  meshes((rolcoBuilt ??= buildRolco()), STYLE.paint, group);
  const fill = opts.fill ?? 0;
  if (fill > 0 && !opts.cover) {
    const kind = KINDS[opts.kind ?? 'doos'];
    let s = opts.seed ?? 3;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const top = 0.2 + fill * (ROLCO.h - 0.25);
    for (const shelf of [0.2, 1.0]) {
      if (shelf > top) break;
      let y = shelf;
      while (y + kind.h * 0.8 < Math.min(top, shelf === 0.2 ? 0.97 : top)) {
        for (let ix = 0; ix < 2; ix++)
          for (let iz = 0; iz < 2; iz++) {
            if (r() < 0.12) continue;
            const c = new THREE.Color(kind.colors[Math.floor(r() * kind.colors.length)]);
            const box = part(group, BOX, new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 }), -0.17 + ix * 0.34, y + kind.h * 0.4, -0.19 + iz * 0.38);
            box.scale.set(0.32, kind.h * 0.8, 0.36);
          }
        y += kind.h * 0.8 + 0.005;
      }
    }
  }
  if (opts.wrap) {
    const wrap = new THREE.Mesh(UNIT_BOX, new THREE.MeshStandardMaterial({ color: '#eef4f8', roughness: 0.25, transparent: true, opacity: 0.3, depthWrite: false }));
    wrap.scale.set(ROLCO.w + 0.04, ROLCO.h - 0.15, ROLCO.d + 0.04);
    wrap.position.y = 0.2 + (ROLCO.h - 0.15) / 2;
    group.add(wrap);
  }
  if (opts.cover) {
    const cover = part(group, rb(ROLCO.w + 0.08, ROLCO.h - 0.1, ROLCO.d + 0.08, 0.06), STYLE.cover, 0, 0.17 + (ROLCO.h - 0.1) / 2, 0);
    // rits aan de voorkant
    part(group, UNIT_BOX, STYLE.black, 0, 0, 0).scale.set(0.02, ROLCO.h - 0.2, 0.01);
    group.children[group.children.length - 1].position.set(0.2, 0.17 + (ROLCO.h - 0.1) / 2, ROLCO.d / 2 + 0.045);
    void cover;
  }
  if (opts.label) {
    opts.label.position.set(0.12, 1.45, ROLCO.d / 2 + (opts.cover ? 0.05 : opts.wrap ? 0.025 : 0.01));
    group.add(opts.label);
  }
  return group;
}

// ---------------------------------------------------------------------------------------------
// Orderpicktruck: elektrische pallettruck met lange vorken (twee rolcontainers achter elkaar) en een sta-plateau.

export function createOrderPicker(screen?: THREE.Object3D) {
  const group = new THREE.Group();
  // aandrijfkast, achter de vorken (vorken wijzen naar +z)
  part(group, rb(0.8, 0.95, 0.6, 0.06), STYLE.paint, 0, 0.6, -0.35);
  part(group, rb(0.74, 0.06, 0.52, 0.02), STYLE.dark, 0, 1.09, -0.35);
  part(group, rb(0.7, 0.12, 0.6, 0.03), STYLE.dark, 0, 0.1, -0.95); // sta-plateau
  part(group, rb(0.7, 0.25, 0.08, 0.03), STYLE.dark, 0, 0.18, -1.25); // stootrand
  // rugsteun en beugels
  for (const sx of [-1, 1]) rod(group, STYLE.black, v(sx * 0.33, 0.2, -1.22), v(sx * 0.33, 1.15, -1.22), 0.02);
  rod(group, STYLE.black, v(-0.33, 1.15, -1.22), v(0.33, 1.15, -1.22), 0.02);
  part(group, rb(0.5, 0.3, 0.06, 0.03), STYLE.seat, 0, 1.0, -1.18);
  // stuurkop
  rod(group, STYLE.black, v(0.15, 1.08, -0.62), v(0.15, 1.25, -0.72), 0.025);
  part(group, rb(0.36, 0.07, 0.12, 0.03), STYLE.black, 0.15, 1.27, -0.74);
  // wielen
  for (const [x, z, r] of [[0, -0.5, 0.12], [-0.3, -0.75, 0.06], [0.3, -0.75, 0.06]]) {
    const w = part(group, UNIT_CYL, STYLE.rubber, x, r, z);
    w.rotation.z = Math.PI / 2;
    w.scale.set(r, 0.08, r);
  }
  // vorken: 2,4 m, met rollen voorin
  for (const sx of [-1, 1]) {
    part(group, rb(0.17, 0.06, 2.4, 0.015), STYLE.paint, sx * 0.24, 0.1, 1.2 - 0.05);
    const w = part(group, UNIT_CYL, STYLE.rubber, sx * 0.24, 0.04, 2.25);
    w.rotation.z = Math.PI / 2;
    w.scale.set(0.04, 0.1, 0.04);
  }
  // terminal op een paal
  rod(group, STYLE.black, v(-0.3, 1.1, -0.5), v(-0.3, 1.45, -0.6), 0.015);
  const term = part(group, rb(0.3, 0.22, 0.05, 0.02), STYLE.black, -0.3, 1.5, -0.62);
  term.rotation.x = -0.35;
  if (screen) {
    screen.position.set(0, 0, -0.027);
    screen.rotation.y = Math.PI;
    term.add(screen);
  }
  return group;
}

// ---------------------------------------------------------------------------------------------
// Reachtruck: zijwaarts zittende bestuurder, uitschuifbare mast tussen de steunpoten.

export function createReachTruck(opts: { lift?: number; reach?: number; cabin?: boolean; screen?: THREE.Object3D; load?: (forks: THREE.Group) => void } = {}) {
  const group = new THREE.Group();
  const lift = opts.lift ?? 0.1;
  // romp met accu, achter de mast
  part(group, rb(1.2, 0.85, 1.05, 0.08), STYLE.paint, 0, 0.55, -0.65);
  part(group, rb(1.1, 0.05, 0.55, 0.02), STYLE.dark, 0.0, 0.99, -0.92);
  part(group, rb(0.5, 0.12, 0.5, 0.03), STYLE.dark, 0.32, 1.02, -0.45); // stoelvoet
  part(group, rb(0.45, 0.1, 0.45, 0.04), STYLE.seat, 0.32, 1.12, -0.45); // zitting
  part(group, rb(0.08, 0.5, 0.42, 0.04), STYLE.seat, 0.56, 1.38, -0.45); // rugleuning (bestuurder kijkt naar -x/zijwaarts)
  // beschermdak
  for (const [x, z] of [[-0.55, -1.12], [0.55, -1.12], [-0.55, -0.18], [0.55, -0.18]]) rod(group, STYLE.black, v(x, 1.0, z), v(x, 2.22, z), 0.03);
  part(group, rb(1.2, 0.06, 1.05, 0.03), STYLE.black, 0, 2.24, -0.65);
  if (opts.cabin) {
    for (const [w, d, x, z] of [[0.02, 0.9, -0.57, -0.65], [0.02, 0.9, 0.57, -0.65], [1.12, 0.02, 0, -0.17], [1.12, 0.02, 0, -1.13]] as const)
      part(group, UNIT_BOX, STYLE.glass, x, 1.62, z).scale.set(w, 1.2, d);
    part(group, rb(1.24, 0.12, 1.1, 0.04), STYLE.paint, 0, 2.3, -0.65);
  }
  // steunpoten met lastwielen
  for (const sx of [-1, 1]) {
    part(group, rb(0.14, 0.24, 1.35, 0.03), STYLE.dark, sx * 0.52, 0.17, 0.55);
    const w = part(group, UNIT_CYL, STYLE.rubber, sx * 0.52, 0.09, 1.1);
    w.rotation.z = Math.PI / 2;
    w.scale.set(0.09, 0.1, 0.09);
  }
  const drive = part(group, UNIT_CYL, STYLE.rubber, -0.3, 0.17, -0.85);
  drive.rotation.z = Math.PI / 2;
  drive.scale.set(0.17, 0.14, 0.17);
  // mast (schuift naar voren tussen de poten)
  const mast = new THREE.Group();
  mast.position.z = (opts.reach ?? 0) * 0.8;
  group.add(mast);
  const outerH = 2.6;
  for (const sx of [-1, 1]) part(mast, rb(0.1, outerH, 0.14, 0.02), STYLE.dark, sx * 0.36, outerH / 2 + 0.08, 0);
  part(mast, rb(0.82, 0.1, 0.14, 0.02), STYLE.dark, 0, outerH + 0.04, 0);
  const innerTop = Math.max(outerH, lift + 1.3);
  if (innerTop > outerH + 0.01) {
    for (const sx of [-1, 1]) part(mast, rb(0.08, innerTop - 0.4, 0.1, 0.02), STYLE.steel, sx * 0.28, 0.4 + (innerTop - 0.4) / 2, 0.08);
    part(mast, rb(0.66, 0.08, 0.1, 0.02), STYLE.steel, 0, innerTop, 0.08);
  }
  // cilinder in het midden
  part(mast, UNIT_CYL, STYLE.steel, 0, 0, 0).scale.set(0.04, 0, 0.04);
  const cyl = mast.children[mast.children.length - 1];
  cyl.scale.y = Math.max(0.5, lift + 0.6);
  cyl.position.set(0, 0.3 + cyl.scale.y / 2, -0.04);
  // vorkenbord met vorken
  const forks = new THREE.Group();
  forks.position.set(0, lift, 0.14);
  mast.add(forks);
  part(forks, rb(0.84, 0.55, 0.06, 0.02), STYLE.dark, 0, 0.3, 0);
  for (const sx of [-1, 1]) {
    part(forks, rb(0.1, 0.05, 1.1, 0.012), STYLE.steel, sx * 0.25, 0.025, 0.58);
    part(forks, rb(0.1, 0.5, 0.05, 0.012), STYLE.steel, sx * 0.25, 0.28, 0.05);
  }
  opts.load?.(forks);
  // terminal naast de bestuurder
  rod(group, STYLE.black, v(-0.45, 1.0, -0.2), v(-0.42, 1.45, -0.25), 0.015);
  const term = part(group, rb(0.3, 0.22, 0.05, 0.02), STYLE.black, -0.4, 1.55, -0.28);
  term.rotation.set(-0.2, -1.1, 0);
  if (opts.screen) {
    opts.screen.position.set(0, 0, 0.027);
    term.add(opts.screen);
  }
  return group;
}

// ---------------------------------------------------------------------------------------------
// Kleine inrichting

/** Stapel kratten op een dolly. */
export function crateStack(parent: THREE.Object3D, x: number, z: number, n: number, mat: THREE.Material) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  part(g, rb(0.62, 0.06, 0.42, 0.01), STYLE.plastic, 0, 0.1, 0);
  for (const [dx, dz] of [[-0.25, -0.16], [0.25, -0.16], [-0.25, 0.16], [0.25, 0.16]]) {
    const w = part(g, UNIT_CYL, STYLE.rubber, dx, 0.035, dz);
    w.rotation.z = Math.PI / 2;
    w.scale.set(0.035, 0.03, 0.035);
  }
  for (let i = 0; i < n; i++) part(g, rb(0.6, 0.15, 0.4, 0.015), mat, 0, 0.13 + 0.075 + i * 0.15, 0);
  parent.add(g);
  return g;
}

/** Wikkelmachine voor rolcontainers: draaiplateau in de vloer met een mast en een rol folie. */
export function createWrapper() {
  const g = new THREE.Group();
  const plate = part(g, UNIT_CYL, STYLE.dark, 0, 0.03, 0);
  plate.scale.set(0.75, 0.06, 0.75);
  const rim = part(g, UNIT_CYL, STYLE.steel, 0, 0.035, 0);
  rim.scale.set(0.7, 0.062, 0.7);
  part(g, rb(0.3, 2.2, 0.3, 0.04), STYLE.paint, 1.05, 1.1, 0);
  part(g, rb(0.5, 0.25, 0.25, 0.04), STYLE.dark, 0.9, 1.2, 0);
  const roll = part(g, UNIT_CYL, STYLE.white, 0.72, 1.2, 0);
  roll.scale.set(0.06, 0.5, 0.06);
  part(g, rb(0.5, 0.8, 0.5, 0.04), STYLE.paint, 1.05, 0.4, -0.45);
  return g;
}

/** Acculader aan de wand met een groen lampje en een kabel. */
export function createCharger(lamp: THREE.Material) {
  const g = new THREE.Group();
  part(g, rb(0.45, 0.6, 0.25, 0.03), STYLE.white, 0, 1.4, 0.125);
  const l = new THREE.Mesh(new THREE.SphereGeometry(0.025, 12, 8), lamp);
  l.position.set(0.15, 1.6, 0.255);
  g.add(l);
  rod(g, STYLE.black, v(-0.1, 1.1, 0.2), v(-0.1, 0.3, 0.6), 0.015);
  return g;
}

/** Handscanner (in beeld vlak voor de camera). */
export function createHandheld(screen: THREE.Object3D) {
  const g = new THREE.Group();
  part(g, rb(0.085, 0.17, 0.03, 0.012), STYLE.black, 0, 0, 0);
  part(g, rb(0.06, 0.03, 0.025, 0.01), STYLE.paint, 0, -0.06, 0.012);
  screen.position.set(0, 0.03, 0.0155);
  g.add(screen);
  return g;
}
