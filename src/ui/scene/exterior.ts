import * as THREE from 'three';
import { DRIVER_DOORS, WAIT_BAYS } from '../../sim/drivers';
import { DOCKS, DOCK_PITCH, ROOMS } from '../../sim/layout';
import logoUrl from '../assets/robodu-logo.jpg';
import { onTop } from './style';
import * as tex from './textures';
import { ROOM_HEIGHT, ROOM_WINDOWS } from './rooms';
import { CAR_PARK } from '../../sim/staff';
import { CAR, CAR_PAINTS, createCar } from './car';
import { createParkedTrailer } from './truck';
import { Batch, EXIT_X, HALL, UNIT_BOX, UNIT_CYL, paint, type Solid } from './warehouse';

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
  /** De aanbouw met kantoor en kantine, buiten tegen de noordgevel (zie rooms.ts). */
  const ANNEX: Rect = { minX: ROOMS.office.minX, maxX: ROOMS.canteen.maxX, minZ: ROOMS.office.minZ, maxZ: ROOMS.office.maxZ };
  const root = new THREE.Group();
  scene.add(root);
  /** Waar de speler buiten tegenaan loopt: auto's, opleggers, de portiersloge, palen en bomen. */
  const solids: Solid[] = [];
  const solid = (x: number, z: number, w: number, d: number, minY: number, maxY: number) =>
    solids.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, minY, maxY });

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
  // Het parkeerterrein voor de voorgevel: de maten komen uit de sim (de kantoormedewerkers rijden er in en uit)
  const PARKING: Rect = CAR_PARK.area;
  const PARK_DRIVE: Rect = { ...CAR_PARK.drive, minZ: PARKING.maxZ, maxZ: ROAD.minZ };
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
  // Wachtplaatsen voor vrachtwagens die te vroeg zijn of waarvan het dock nog bezet is (src/sim/drivers.ts)
  WAIT_BAYS.forEach((b, i) => {
    line(b.x - 5.2, b.z + 1.6, 12.4, 0.14);
    if (i === WAIT_BAYS.length - 1) line(b.x - 5.2, b.z - 1.6, 12.4, 0.14);
  });
  // Parkeervakken: één rij met de neus naar het gebouw, de rijbaan erachter
  for (const x of CAR_PARK.lines) line(x, PARKING.minZ + 2.6, 0.12, 5);
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

  // Nummers van de wachtplaatsen, achter de wagen (aan de kant van de rijlijn)
  const bayGeo = new THREE.PlaneGeometry(4.4, 1.1);
  WAIT_BAYS.forEach((b, i) => {
    const m = new THREE.Mesh(
      bayGeo,
      onTop(new THREE.MeshStandardMaterial({ map: tex.floorText(`P${i + 1}`), color: '#e9e9e2', transparent: true, depthWrite: false, roughness: 0.8 }), 3),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(b.x + 3.4, -0.005, b.z);
    root.add(m);
  });

  // ---------- Gevels ----------
  const panelTex = tex.wallPanel();
  /**
   * Gevelvlak met het midden op (x, z), van hoogte `from` tot de dakrand.
   * @param holes openingen (deuren) [van, tot, bovenkant], langs de gevel gemeten vanuit het midden
   */
  function facade(x: number, z: number, ry: number, len: number, from = 0, holes: [number, number, number][] = []) {
    const t = panelTex.clone();
    t.repeat.set(len, (TOP - from) / TOP);
    t.offset.y = from / TOP;
    t.needsUpdate = true;
    const h = TOP - from;
    let geo: THREE.BufferGeometry = new THREE.PlaneGeometry(len, h);
    if (holes.length) {
      const rect = (a: number, b: number, y0: number, y1: number) =>
        [new THREE.Vector2(a, y0), new THREE.Vector2(b, y0), new THREE.Vector2(b, y1), new THREE.Vector2(a, y1)];
      const shape = new THREE.Shape(rect(-len / 2, len / 2, -h / 2, h / 2));
      // het gat blijft 2 mm boven de onderrand, anders deelt het een zijde met de omtrek
      for (const [a, b, top] of holes) shape.holes.push(new THREE.Path(rect(a, b, 0.002 - h / 2, top - from - h / 2)));
      geo = new THREE.ShapeGeometry(shape);
      const p = geo.attributes.position;
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, p.getX(i) / len + 0.5, p.getY(i) / h + 0.5);
    }
    const m = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ map: t, color: '#eef1f4', roughness: 0.55, metalness: 0.25 }),
    );
    m.position.set(x, (TOP + from) / 2, z);
    m.rotation.y = ry;
    m.receiveShadow = true;
    root.add(m);
  }
  // Dockgevel: open gaten voor de dockdeuren en de chauffeursdeuren (langs deze gevel loopt het vlak naar +z)
  const openings: [number, number, number][] = [
    ...DOCKS.map((d): [number, number, number] => [d.z - 1.5, d.z + 1.5, 3.5]),
    ...DRIVER_DOORS.map((z): [number, number, number] => [z - 0.5, z + 0.5, 2.1]),
  ].sort((a, b) => a[0] - b[0]);
  facade(X0 - 0.03, 0, -Math.PI / 2, D, 0, openings);
  facade(W / 2 + 0.03, 0, Math.PI / 2, D);
  facade(0, D / 2 + 0.03, 0, W, 0, [[EXIT_X - 0.5, EXIT_X + 0.5, 2.1]]); // open gat voor de entreedeur
  // Noordgevel: waar de aanbouw (kantoor en kantine) ertegenaan staat begint de gevel pas boven het dak daarvan
  facade((ANNEX.minX + ANNEX.maxX) / 2, -D / 2 - 0.03, Math.PI, ANNEX.maxX - ANNEX.minX, ROOM_HEIGHT);
  facade((ANNEX.maxX + W / 2) / 2, -D / 2 - 0.03, Math.PI, W / 2 - ANNEX.maxX);
  // Binnenkant van de dakrand: het stuk gevel boven de halwanden. Zonder dak (overzicht) kijk je daar van
  // binnenuit tegenaan; een gevelvlak kijkt alleen naar buiten, dus zonder dit vlak kijk je er dwars doorheen.
  facade(X0 - 0.03, 0, Math.PI / 2, D, H);
  facade(W / 2 + 0.03, 0, -Math.PI / 2, D, H);
  facade(0, D / 2 + 0.03, Math.PI, W, H);
  facade(0, -D / 2 - 0.03, 0, W, H);

  // Dakrand (donkerblauw), accentstreep (blauw) en plint, rondom
  const trimNavy = new Batch();
  const trimBlue = new Batch();
  const plinth = new Batch();
  const thin = (v: number, f: number) => (v < 1 ? v * f : v - 0.1); // dikte iets smaller, lengte iets korter
  for (const [x, z, sx, sz] of [
    [X0 - 0.06, 0, 0.3, D + 0.4],
    [W / 2 + 0.06, 0, 0.3, D + 0.4],
    [0, D / 2 + 0.06, W + 0.4, 0.3],
    [0, -D / 2 - 0.06, W + 0.4, 0.3],
  ]) {
    trimNavy.add(x, TOP - 0.3, z, sx, 0.6, sz);
    trimBlue.add(x, TOP - 0.72, z, thin(sx, 0.8), 0.16, thin(sz, 0.8));
    // de plint van de noordgevel loopt alleen naast de aanbouw: erachter zitten de deuren naar de hal
    if (z < 0 && sx > 1) plinth.add((ANNEX.maxX + W / 2 + 0.15) / 2, 0.25, z, W / 2 + 0.15 - ANNEX.maxX, 0.5, thin(sz, 0.7));
    else if (x < 0 && sz > 1) {
      // de plint van de dockgevel loopt niet door voor de deuren langs
      let from = -thin(sz, 0.7) / 2;
      for (const [a, b] of [...openings, [thin(sz, 0.7) / 2, 0]]) {
        if (a - from > 0.01) plinth.add(x, 0.25, (from + a) / 2, thin(sx, 0.7), 0.5, a - from);
        from = b;
      }
    } else if (z > 0 && sx > 1) {
      // de plint van de voorgevel loopt niet door voor de entree langs
      const half = thin(sx, 0.7) / 2;
      for (const [a, b] of [[-half, EXIT_X - 0.95], [EXIT_X + 0.95, half]]) plinth.add((a + b) / 2, 0.25, z, b - a, 0.5, thin(sz, 0.7));
    } else plinth.add(x, 0.25, z, thin(sx, 0.7), 0.5, thin(sz, 0.7));
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
  const doorMat = paint('#c3c8cc', 0.5, 0.35);
  /** Per dock de deur: hij hangt aan zijn bovenkant en rolt daar op. */
  const dockDoors: THREE.Group[] = [];
  const seals = new Batch();
  const signGeo = new THREE.PlaneGeometry(1.3, 0.65);
  DOCKS.forEach((d, i) => {
    const door = new THREE.Group();
    door.position.set(X0 - 0.08, 3.5, d.z);
    for (let s = 0; s < 4; s++) {
      const panel = new THREE.Mesh(UNIT_BOX, doorMat);
      panel.scale.set(0.06, 0.86, 3.0);
      panel.position.y = 0.44 + s * 0.875 - 3.5;
      panel.castShadow = panel.receiveShadow = true;
      door.add(panel);
    }
    root.add(door);
    dockDoors.push(door);
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
  root.add(seals.build(UNIT_BOX, paint('#17181a', 0.9, 0)));

  // ---------- Entree en kantoorramen in de voorgevel ----------
  const glass = new THREE.MeshStandardMaterial({ color: '#27425e', roughness: 0.12, metalness: 0.7 });
  const windows = new Batch();
  const ZF = D / 2 + 0.06;
  for (let x = 6; x <= 26; x += 2.9) {
    windows.add(x, 5.6, ZF, 2.2, 1.5, 0.06);
    if (Math.abs(x - EXIT_X) > 2.6) windows.add(x, 2.0, ZF, 2.2, 1.5, 0.06);
  }
  // Entree: de deur zelf zit in de hal (hij gaat open, zie warehouse.ts); hier het glas ernaast en erboven
  for (const dx of [-0.74, 0.74]) windows.add(EXIT_X + dx, 1.2, ZF, 0.42, 2.4, 0.06);
  windows.add(EXIT_X, 2.27, ZF, 1.06, 0.26, 0.06);
  const canopy = new Batch();
  canopy.add(EXIT_X, 2.85, D / 2 + 1.1, 4.2, 0.16, 2.2);
  for (const dx of [-1.9, 1.9]) {
    canopy.add(EXIT_X + dx, 1.4, D / 2 + 2.05, 0.12, 2.8, 0.12);
    solid(EXIT_X + dx, D / 2 + 2.05, 0.12, 0.12, 0, 2.8);
  }
  root.add(windows.build(UNIT_BOX, glass, false), canopy.build(UNIT_BOX, paint(NAVY, 0.5, 0.3)));
  // Ramen van het kantoor en de kantine (de aanbouw): van buiten donker glas. Een vlak dat alleen naar buiten
  // kijkt, zodat je er van binnenuit doorheen naar het terrein kijkt.
  for (const w of ROOM_WINDOWS) {
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(w.to - w.from, w.y1 - w.y0), glass);
    const mid = (w.from + w.to) / 2;
    if (w.wall === 'west') pane.position.set(w.at - 0.02, (w.y0 + w.y1) / 2, mid);
    else pane.position.set(mid, (w.y0 + w.y1) / 2, w.at - 0.02);
    pane.rotation.y = w.wall === 'west' ? -Math.PI / 2 : Math.PI;
    root.add(pane);
  }

  // ---------- Geparkeerde auto's ----------
  const rand = tex.rng(303);
  // Zelfde stijl als de vrachtwagens (src/ui/scene/car.ts). Een paar auto's staan er altijd; de vakken bij de
  // entree zijn van de kantoormedewerkers, die komen en gaan (src/ui/staff.ts).
  CAR_PARK.parked.forEach((bay, i) => {
    const b = CAR_PARK.bays[bay];
    const x = b.x + (rand() - 0.5) * 0.2;
    const z = b.z + (rand() - 0.5) * 0.4;
    const car = createCar(CAR_PAINTS[(i * 2 + 3) % CAR_PAINTS.length]);
    car.position.set(x, 0, z);
    car.rotation.y = Math.PI; // neus naar het gebouw
    root.add(car);
    solid(x, z, CAR.width, CAR.length, 0, 0.93);
    solid(x, z + 0.4, 1.6, 2.6, 0.93, 1.47);
  });

  // ---------- Geparkeerde opleggers op het terrein ----------
  // Zelfde stijl als de vrachtwagens aan de docks (src/ui/scene/truck.ts)
  for (const [x, z] of [[X0 - 12, YARD.minZ + 3], [X0 - 12, YARD.minZ + 7], [X0 - 14, YARD.maxZ - 3.5]]) {
    const trailer = createParkedTrailer();
    trailer.position.set(x, 0, z);
    root.add(trailer);
    solid(x, z, 12, 2.5, 0, 3.85);
  }

  // ---------- Portiersloge met slagboom bij de inrit van het terrein ----------
  const lodge = new Batch();
  const gateX = (YARD_DRIVE.minX + YARD_DRIVE.maxX) / 2;
  const gateZ = YARD.maxZ + 6;
  lodge.add(YARD_DRIVE.maxX + 2.2, 1.4, gateZ, 3, 2.8, 3.4);
  const lodgeRoof = new Batch();
  lodgeRoof.add(YARD_DRIVE.maxX + 2.2, 2.9, gateZ, 3.6, 0.2, 4);
  const barrier = new Batch();
  barrier.add(YARD_DRIVE.maxX - 0.2, 0.6, gateZ, 0.3, 1.2, 0.3);
  // De boom zelf scharniert aan zijn paal en gaat omhoog als er een vrachtwagen aankomt (setGate)
  const barrierMat = paint('#c8231c', 0.5, 0.2);
  const boomLength = YARD_DRIVE.maxX - YARD_DRIVE.minX - 0.6;
  const boom = new THREE.Group();
  boom.position.set(YARD_DRIVE.maxX - 0.2, 1.05, gateZ);
  const boomArm = new THREE.Mesh(UNIT_BOX, barrierMat);
  boomArm.scale.set(boomLength, 0.12, 0.12);
  boomArm.position.x = gateX - boom.position.x;
  boomArm.castShadow = boomArm.receiveShadow = true;
  boom.add(boomArm);
  root.add(boom);
  solid(YARD_DRIVE.maxX + 2.2, gateZ, 3, 3.4, 0, 3);
  solid(gateX, gateZ, YARD_DRIVE.maxX - YARD_DRIVE.minX - 0.6, 0.3, 0.9, 1.11); // de slagboom: daar loop je niet onderdoor
  solid(YARD_DRIVE.maxX - 0.2, gateZ, 0.3, 0.3, 0, 1.2);
  root.add(
    lodge.build(UNIT_BOX, paint('#e2e5e8', 0.7, 0.1)),
    lodgeRoof.build(UNIT_BOX, paint(NAVY, 0.5, 0.3)),
    barrier.build(UNIT_BOX, barrierMat),
  );

  // ---------- Lantaarnpalen ----------
  const poles = new Batch();
  const heads = new Batch();
  const lampSpots: [number, number, number][] = []; // x, z, richting van de arm (rad)
  for (const z of [-27, -9, 9, 27]) lampSpots.push([YARD.minX + 1, z, 0]);
  for (const x of [PARKING.minX - 0.8, (PARK_DRIVE.maxX + PARKING.maxX) / 2, PARKING.maxX + 0.8]) lampSpots.push([x, PARKING.maxZ + 0.8, Math.PI / 2]);
  for (let x = -200; x <= 200; x += 40) lampSpots.push([x, ROAD.maxZ + 1.2, Math.PI / 2]);
  for (const [x, z, a] of lampSpots) {
    poles.add(x, 4.5, z, 0.09, 9, 0.09);
    solid(x, z, 0.18, 0.18, 0, 9);
    const dx = Math.cos(a) * 0.9;
    const dz = -Math.sin(a) * 0.9;
    heads.add(x + dx, 8.95, z + dz, 1.9, 0.12, 0.34, 0, a, 0);
  }
  root.add(poles.build(UNIT_CYL, paint('#7d858c', 0.5, 0.6)), heads.build(UNIT_BOX, paint('#2b2e32', 0.5, 0.5)));

  // ---------- Bomen ----------
  const building: Rect = { minX: X0, maxX: W / 2, minZ: -D / 2, maxZ: D / 2 };
  const blocked = (x: number, z: number, margin: number) =>
    [...paved, building, ANNEX].some((r) => x > r.minX - margin && x < r.maxX + margin && z > r.minZ - margin && z < r.maxZ + margin);
  const trunks = new Batch();
  const crowns = new Batch();
  const crownTints: THREE.Color[] = [];
  function tree(x: number, z: number) {
    const s = 0.8 + rand() * 0.7;
    trunks.add(x, 1.5 * s, z, 0.22 * s, 3 * s, 0.22 * s);
    solid(x, z, 0.44 * s, 0.44 * s, 0, 3 * s);
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

  // ---------- Waar de speler buiten mag lopen ----------
  // Het hele terrein rond het gebouw en de aanbouw (de gevels zijn massief), plus de deuren waardoor je naar
  // buiten komt: de chauffeursdeuren in de dockgevel en de entree (nooduitgang) in de voorgevel.
  const EDGE = 220; // zo ver van het midden houdt het terrein voor de speler op
  const M = 0.5; // zo ver blijf je met je middelpunt van een gevel
  const walkable: Rect[] = [
    { minX: -EDGE, maxX: X0 - M, minZ: -EDGE, maxZ: EDGE },
    { minX: W / 2 + M, maxX: EDGE, minZ: -EDGE, maxZ: EDGE },
    { minX: -EDGE, maxX: EDGE, minZ: D / 2 + M, maxZ: EDGE },
    { minX: -EDGE, maxX: EDGE, minZ: -EDGE, maxZ: ANNEX.minZ - M },
    { minX: ANNEX.maxX + M, maxX: EDGE, minZ: -EDGE, maxZ: -D / 2 - M },
    ...DRIVER_DOORS.map((z): Rect => ({ minX: X0 - M - 0.1, maxX: X0 + 0.7, minZ: z - 0.3, maxZ: z + 0.3 })),
    { minX: EXIT_X - 0.3, maxX: EXIT_X + 0.3, minZ: D / 2 - 0.7, maxZ: D / 2 + M + 0.1 },
  ];
  const within = (r: Rect, x: number, z: number) => x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ;

  return {
    root,
    walkable,
    solids,
    /** Staat dit punt in de open lucht (niet in de hal of de aanbouw)? */
    isOutside: (x: number, z: number) => !within(building, x, z) && !within(ANNEX, x, z),
    /** De slagboom bij de inrit van het terrein. @param open 0 = dicht, 1 = omhoog */
    setGate(open: number) {
      boom.rotation.z = -open * 1.4;
    },
    /** @param open 0 = dockdeur dicht, 1 = open */
    setDockDoor(i: number, open: number) {
      if (dockDoors[i]) dockDoors[i].scale.y = 1 - 0.97 * open;
    },
  };
}
