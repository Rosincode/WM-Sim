import * as THREE from 'three';
import { DOCKS, DOCK_PITCH } from '../../sim/layout';
import logoUrl from '../assets/robodu-logo.jpg';
import { onTop } from './style';
import * as tex from './textures';
import { ROOM_WINDOWS } from './rooms';
import { Batch, EXIT_X, HALL, UNIT_BOX, UNIT_CYL, paint } from './warehouse';

// Buitenkant van het magazijn: gevels met het RoBoDu-logo, het vrachtwagenterrein voor de docks,
// wegen, parkeerplaats, groen en verlichting. Alleen aankleding: geen sim-logica.

const NAVY = '#10224a';
const BLUE = '#1583f0';
/** Verhouding (breedte / hoogte) van het bijgesneden logo in src/ui/assets. */
const LOGO_ASPECT = 1024 / 718;

type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

export function createExterior(scene: THREE.Scene) {
  const { w: W, d: D, h: H } = HALL;
  const X0 = -W / 2; // dockgevel (west)
  const TOP = H + 2.5; // gevel met dakrand
  const root = new THREE.Group();
  scene.add(root);

  // ---------- Terrein ----------
  // Lagen (onTop in style.ts): asfalt +1 op het gras, beton +2, belijning en cijfers +3
  const grassMat = new THREE.MeshStandardMaterial({ map: tex.grass(), roughness: 1 });
  const asphaltMat = onTop(new THREE.MeshStandardMaterial({ map: tex.asphalt(), roughness: 0.95 }));
  const concreteMat = onTop(new THREE.MeshStandardMaterial({ color: '#b5b3ac', roughness: 0.9 }), 2);

  function ground(r: Rect, y: number, mat: THREE.Material, tile: number) {
    const w = r.maxX - r.minX;
    const d = r.maxZ - r.minZ;
    const geo = new THREE.PlaneGeometry(w, d);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w) / tile, (uv.getY(i) * d) / tile);
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set((r.minX + r.maxX) / 2, y, (r.minZ + r.maxZ) / 2);
    m.receiveShadow = true;
    root.add(m);
  }

  const YARD: Rect = { minX: X0 - 46, maxX: X0, minZ: -D / 2 - 8, maxZ: D / 2 + 8 };
  const ROAD_Z = D / 2 + 38; // hart van de openbare weg
  const ROAD_HALF = 1500; // net als het grasvlak: de weg loopt door tot voorbij de mist
  const ROAD: Rect = { minX: -ROAD_HALF, maxX: ROAD_HALF, minZ: ROAD_Z - 4, maxZ: ROAD_Z + 4 };
  const YARD_DRIVE: Rect = { minX: X0 - 44, maxX: X0 - 34, minZ: YARD.maxZ, maxZ: ROAD.minZ };
  const PARKING: Rect = { minX: -14, maxX: 28, minZ: D / 2 + 8, maxZ: D / 2 + 24 };
  const PARK_DRIVE: Rect = { minX: 4, maxX: 12, minZ: PARKING.maxZ, maxZ: ROAD.minZ };
  const PLAZA: Rect = { minX: X0, maxX: W / 2 + 2, minZ: D / 2, maxZ: D / 2 + 8 };
  const APRON: Rect = { minX: X0 - 6, maxX: X0, minZ: -D / 2 + 1, maxZ: D / 2 - 1 };
  const paved = [YARD, ROAD, YARD_DRIVE, PARKING, PARK_DRIVE, PLAZA];

  // Ruim groter dan het zicht (mist dicht op 520 m, camera tot 260 m uit het midden),
  // zodat de rand van het vlak altijd in de mist verdwijnt.
  ground({ minX: -1500, maxX: 1500, minZ: -1500, maxZ: 1500 }, -0.2, grassMat, 34);
  for (const r of [YARD, ROAD, YARD_DRIVE, PARKING, PARK_DRIVE]) ground(r, -0.02, asphaltMat, 9);
  ground(PLAZA, -0.012, concreteMat, 1);
  ground(APRON, -0.012, concreteMat, 1);

  // ---------- Belijning ----------
  const lines = new Batch();
  const line = (x: number, z: number, sx: number, sz: number) => lines.add(x, -0.006, z, sx, 0.004, sz);
  line(0, ROAD.minZ + 0.35, ROAD_HALF * 2, 0.15);
  line(0, ROAD.maxZ - 0.35, ROAD_HALF * 2, 0.15);
  for (let x = -ROAD_HALF + 2; x <= ROAD_HALF - 2; x += 8) line(x, ROAD_Z, 3, 0.15);
  // Dockvakken op het terrein
  for (let i = 0; i <= DOCKS.length; i++) line(X0 - 10.5, DOCKS[0].z - DOCK_PITCH / 2 + i * DOCK_PITCH, 19, 0.14);
  // Parkeervakken: twee rijen met een rijbaan ertussen
  const bays: { x: number; z: number }[] = [];
  for (let x = PARKING.minX + 1.5; x <= PARKING.maxX - 1; x += 2.6) {
    line(x, PARKING.minZ + 2.6, 0.12, 5);
    const drive = x > PARK_DRIVE.minX - 1 && x < PARK_DRIVE.maxX + 1;
    if (!drive) line(x, PARKING.maxZ - 2.6, 0.12, 5);
    if (x + 2.6 <= PARKING.maxX - 1) {
      bays.push({ x: x + 1.3, z: PARKING.minZ + 2.7 });
      if (x + 2.6 < PARK_DRIVE.minX - 1 || x > PARK_DRIVE.maxX + 1) bays.push({ x: x + 1.3, z: PARKING.maxZ - 2.7 });
    }
  }
  root.add(
    lines.build(UNIT_BOX, onTop(new THREE.MeshStandardMaterial({ color: '#e9e9e2', roughness: 0.8 }), 3), false),
  );

  // Docknummers op het asfalt (leesbaar vanuit het overzicht)
  const numberGeo = new THREE.PlaneGeometry(11, 2.75);
  DOCKS.forEach((d, i) => {
    const m = new THREE.Mesh(
      numberGeo,
      onTop(new THREE.MeshStandardMaterial({ map: tex.floorText(String(i + 1)), color: '#f0c20a', transparent: true, depthWrite: false, roughness: 0.8 }), 3),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(X0 - 22.5, -0.005, d.z);
    root.add(m);
  });

  // ---------- Gevels ----------
  const panelTex = tex.wallPanel();
  function facade(x: number, z: number, ry: number, len: number) {
    const t = panelTex.clone();
    t.repeat.set(len, 1);
    t.needsUpdate = true;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(len, TOP),
      new THREE.MeshStandardMaterial({ map: t, color: '#eef1f4', roughness: 0.55, metalness: 0.25 }),
    );
    m.position.set(x, TOP / 2, z);
    m.rotation.y = ry;
    m.receiveShadow = true;
    root.add(m);
  }
  facade(X0 - 0.03, 0, -Math.PI / 2, D);
  facade(W / 2 + 0.03, 0, Math.PI / 2, D);
  facade(0, D / 2 + 0.03, 0, W);
  facade(0, -D / 2 - 0.03, Math.PI, W);

  // Dakrand (donkerblauw), accentstreep (blauw) en plint, rondom
  const trimNavy = new Batch();
  const trimBlue = new Batch();
  const plinth = new Batch();
  for (const [x, z, sx, sz] of [
    [X0 - 0.06, 0, 0.3, D + 0.4],
    [W / 2 + 0.06, 0, 0.3, D + 0.4],
    [0, D / 2 + 0.06, W + 0.4, 0.3],
    [0, -D / 2 - 0.06, W + 0.4, 0.3],
  ]) {
    const thin = (v: number, f: number) => (v < 1 ? v * f : v - 0.1); // dikte iets smaller, lengte iets korter
    trimNavy.add(x, TOP - 0.3, z, sx, 0.6, sz);
    trimBlue.add(x, TOP - 0.72, z, thin(sx, 0.8), 0.16, thin(sz, 0.8));
    plinth.add(x, 0.25, z, thin(sx, 0.7), 0.5, thin(sz, 0.7));
  }
  root.add(
    trimNavy.build(UNIT_BOX, paint(NAVY, 0.5, 0.3)),
    trimBlue.build(UNIT_BOX, paint(BLUE, 0.45, 0.2)),
    plinth.build(UNIT_BOX, paint('#5a5d60', 0.9, 0)),
  );

  // ---------- Logo op de gevel ----------
  const logoTex = new THREE.TextureLoader().load(logoUrl);
  logoTex.colorSpace = THREE.SRGBColorSpace;
  logoTex.anisotropy = 8;
  const logoMat = onTop(new THREE.MeshStandardMaterial({ map: logoTex, roughness: 0.6, metalness: 0 }));
  const frameMat = paint(NAVY, 0.5, 0.3);
  /** Logobord; (x, z) is het midden op de gevel, ry de richting waarin het bord kijkt. */
  function logo(x: number, y: number, z: number, ry: number, height: number) {
    const w = height * LOGO_ASPECT;
    const g = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, height + 0.4, 0.14), frameMat);
    frame.castShadow = true;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w, height), logoMat);
    face.position.z = 0.08;
    g.add(frame, face);
    g.position.set(x, y, z);
    g.rotation.y = ry;
    root.add(g);
  }
  logo(X0 - 0.14, 7.5, 0, -Math.PI / 2, 5); // boven de docks
  logo(-6, 5.8, D / 2 + 0.14, 0, 6.6); // voorgevel (zuid)

  // ---------- Docks van buiten: deur, afdichting, stootblokken, nummer ----------
  const doors = new Batch();
  const seals = new Batch();
  const signGeo = new THREE.PlaneGeometry(1.3, 0.65);
  DOCKS.forEach((d, i) => {
    for (let s = 0; s < 4; s++) doors.add(X0 - 0.08, 0.44 + s * 0.875, d.z, 0.06, 0.86, 3.0);
    for (const dz of [-1.72, 1.72]) seals.add(X0 - 0.3, 1.95, d.z + dz, 0.5, 3.9, 0.36);
    seals.add(X0 - 0.3, 3.9, d.z, 0.5, 0.45, 3.8);
    for (const dz of [-1.05, 1.05]) seals.add(X0 - 0.16, 0.32, d.z + dz, 0.22, 0.45, 0.3);
    const s = new THREE.Mesh(
      signGeo,
      onTop(new THREE.MeshStandardMaterial({ map: tex.sign(String(i + 1), NAVY, '#ffffff'), roughness: 0.5 })),
    );
    s.rotation.y = -Math.PI / 2;
    s.position.set(X0 - 0.1, 4.45, d.z);
    root.add(s);
  });
  root.add(doors.build(UNIT_BOX, paint('#c3c8cc', 0.5, 0.35)), seals.build(UNIT_BOX, paint('#17181a', 0.9, 0)));

  // ---------- Entree en kantoorramen in de voorgevel ----------
  const glass = new THREE.MeshStandardMaterial({ color: '#27425e', roughness: 0.12, metalness: 0.7 });
  const windows = new Batch();
  const ZF = D / 2 + 0.06;
  for (let x = 6; x <= 26; x += 2.9) {
    windows.add(x, 5.6, ZF, 2.2, 1.5, 0.06);
    if (Math.abs(x - EXIT_X) > 2.6) windows.add(x, 2.0, ZF, 2.2, 1.5, 0.06);
  }
  windows.add(EXIT_X, 1.2, ZF, 1.9, 2.4, 0.06); // glazen entreedeur
  const canopy = new Batch();
  canopy.add(EXIT_X, 2.85, D / 2 + 1.1, 4.2, 0.16, 2.2);
  for (const dx of [-1.9, 1.9]) canopy.add(EXIT_X + dx, 1.4, D / 2 + 2.05, 0.12, 2.8, 0.12);
  root.add(windows.build(UNIT_BOX, glass, false), canopy.build(UNIT_BOX, paint(NAVY, 0.5, 0.3)));
  // Ramen van het kantoor en de kantine: van buiten donker glas. Een vlak dat alleen naar buiten kijkt,
  // zodat je er van binnenuit doorheen naar het terrein kijkt.
  for (const w of ROOM_WINDOWS) {
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(w.to - w.from, w.y1 - w.y0), glass);
    const mid = (w.from + w.to) / 2;
    if (w.wall === 'west') pane.position.set(X0 - 0.05, (w.y0 + w.y1) / 2, mid);
    else pane.position.set(mid, (w.y0 + w.y1) / 2, -D / 2 - 0.05);
    pane.rotation.y = w.wall === 'west' ? -Math.PI / 2 : Math.PI;
    root.add(pane);
  }

  // ---------- Geparkeerde auto's ----------
  const rand = tex.rng(303);
  const CAR_COLORS = ['#c9ced3', '#22262b', '#8d1f1f', '#1f4e8d', '#e8e8e4', '#56616b', '#2d6b4a'];
  const bodies = new Batch();
  const cabins = new Batch();
  const wheels = new Batch();
  const carTints: THREE.Color[] = [];
  for (const b of bays) {
    if (rand() > 0.55) continue;
    const x = b.x + (rand() - 0.5) * 0.2;
    const z = b.z + (rand() - 0.5) * 0.4;
    bodies.add(x, 0.58, z, 1.8, 0.7, 4.3);
    cabins.add(x, 1.2, z + 0.2, 1.6, 0.56, 2.3);
    for (const dx of [-0.86, 0.86]) for (const dz of [-1.35, 1.35]) wheels.add(x + dx, 0.32, z + dz, 0.32, 0.2, 0.32, 0, 0, Math.PI / 2);
    carTints.push(new THREE.Color(CAR_COLORS[Math.floor(rand() * CAR_COLORS.length)]));
  }
  const tyre = paint('#141414', 0.9, 0);

  // ---------- Geparkeerde opleggers op het terrein ----------
  const trailers = new Batch();
  const chassis = new Batch();
  for (const [x, z] of [[X0 - 30, YARD.minZ + 3], [X0 - 30, YARD.minZ + 7], [X0 - 14, YARD.maxZ - 3.5]]) {
    trailers.add(x, 2.5, z, 12, 2.7, 2.5);
    chassis.add(x, 0.95, z, 11.6, 0.3, 2.2);
    chassis.add(x - 4.6, 0.4, z, 0.2, 0.8, 1.6); // steunpoten
    for (const dx of [3.2, 4.5]) for (const dz of [-1.05, 1.05]) wheels.add(x + dx, 0.5, z + dz, 0.5, 0.3, 0.5, Math.PI / 2, 0, 0);
  }

  const carBodies = bodies.build(UNIT_BOX, paint('#ffffff', 0.35, 0.5));
  carTints.forEach((c, i) => carBodies.setColorAt(i, c));
  root.add(
    carBodies,
    cabins.build(UNIT_BOX, glass),
    wheels.build(UNIT_CYL, tyre),
    trailers.build(UNIT_BOX, paint('#e6e9ec', 0.6, 0.1)),
    chassis.build(UNIT_BOX, paint('#2b2e32', 0.6, 0.4)),
  );

  // ---------- Portiersloge met slagboom bij de inrit van het terrein ----------
  const lodge = new Batch();
  const gateX = (YARD_DRIVE.minX + YARD_DRIVE.maxX) / 2;
  const gateZ = YARD.maxZ + 6;
  lodge.add(YARD_DRIVE.maxX + 2.2, 1.4, gateZ, 3, 2.8, 3.4);
  const lodgeRoof = new Batch();
  lodgeRoof.add(YARD_DRIVE.maxX + 2.2, 2.9, gateZ, 3.6, 0.2, 4);
  const barrier = new Batch();
  barrier.add(gateX, 1.05, gateZ, YARD_DRIVE.maxX - YARD_DRIVE.minX - 0.6, 0.12, 0.12);
  barrier.add(YARD_DRIVE.maxX - 0.2, 0.6, gateZ, 0.3, 1.2, 0.3);
  root.add(
    lodge.build(UNIT_BOX, paint('#e2e5e8', 0.7, 0.1)),
    lodgeRoof.build(UNIT_BOX, paint(NAVY, 0.5, 0.3)),
    barrier.build(UNIT_BOX, paint('#c8231c', 0.5, 0.2)),
  );

  // ---------- Lantaarnpalen ----------
  const poles = new Batch();
  const heads = new Batch();
  const lampSpots: [number, number, number][] = []; // x, z, richting van de arm (rad)
  for (const z of [-27, -9, 9, 27]) lampSpots.push([YARD.minX + 1, z, 0]);
  for (const x of [-11, 2, 15, 27]) lampSpots.push([x, PARKING.maxZ + 0.8, Math.PI / 2]);
  for (let x = -200; x <= 200; x += 40) lampSpots.push([x, ROAD.maxZ + 1.2, Math.PI / 2]);
  for (const [x, z, a] of lampSpots) {
    poles.add(x, 4.5, z, 0.09, 9, 0.09);
    const dx = Math.cos(a) * 0.9;
    const dz = -Math.sin(a) * 0.9;
    heads.add(x + dx, 8.95, z + dz, 1.9, 0.12, 0.34, 0, a, 0);
  }
  root.add(poles.build(UNIT_CYL, paint('#7d858c', 0.5, 0.6)), heads.build(UNIT_BOX, paint('#2b2e32', 0.5, 0.5)));

  // ---------- Bomen ----------
  const building: Rect = { minX: X0, maxX: W / 2, minZ: -D / 2, maxZ: D / 2 };
  const blocked = (x: number, z: number, margin: number) =>
    [...paved, building].some((r) => x > r.minX - margin && x < r.maxX + margin && z > r.minZ - margin && z < r.maxZ + margin);
  const trunks = new Batch();
  const crowns = new Batch();
  const crownTints: THREE.Color[] = [];
  function tree(x: number, z: number) {
    const s = 0.8 + rand() * 0.7;
    trunks.add(x, 1.5 * s, z, 0.22 * s, 3 * s, 0.22 * s);
    crowns.add(x, (3 + 1.9) * s, z, 2.3 * s, 2.7 * s, 2.3 * s, 0, rand() * 6, 0);
    crownTints.push(new THREE.Color().setHSL(0.27 + rand() * 0.06, 0.42 + rand() * 0.15, 0.24 + rand() * 0.1));
  }
  for (let x = -210; x <= 210; x += 15) if (!blocked(x, ROAD.minZ - 3.5, 2)) tree(x, ROAD.minZ - 3.5); // laan langs de weg
  for (let i = 0; i < 400 && crownTints.length < 150; i++) {
    const x = (rand() - 0.5) * 380;
    const z = (rand() - 0.5) * 380;
    if (!blocked(x, z, 5)) tree(x, z);
  }
  const crownMesh = crowns.build(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, flatShading: true }));
  crownTints.forEach((c, i) => crownMesh.setColorAt(i, c));
  root.add(trunks.build(UNIT_CYL, paint('#5b4532', 0.95, 0)), crownMesh);

  return { root };
}
