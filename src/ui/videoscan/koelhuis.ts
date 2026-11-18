import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { STYLE, onTop } from '../scene/style';
import { Batch, UNIT_BOX, paint } from '../scene/warehouse';
import * as tex from '../scene/textures';
import { createTruck, createParkedTrailer, TRAILER } from '../scene/truck';
import { createElectricJack } from '../scene/electricJack';
import { createCharacter, type CharacterState } from '../scene/character';
import { board, checkDigit, labelAtlas, palletLabel, planningScreen, screen, textBoard } from './art';
import { Loads, ROLCO, createCharger, createHandheld, createOrderPicker, createReachTruck, createRolco, createWrapper, crateStack, part, rb, type LoadKind } from './models';

// Het koelhuis uit de videoscan-test (src/sim/videoscan/voorbeeld-koelhuis.json), nagebouwd zoals het in de
// rondleiding beschreven wordt. Assen: x over de breedte (dock 1 links), z van achter (-) naar de dockgevel (+),
// y omhoog. De dockgevel ligt op z = +25, de grond buiten ligt 0,45 m lager dan de hal (laadvloer).

export const H = 10;
export const W = 72;
export const D = 50;
export const FRONT = D / 2; // dockgevel
export const CELL_Z = 13; // wand tussen dockzone en cellen
export const STRIP_X = -30; // acculaadruimte + leeggoed links daarvan
export const VRIES_X = 14; // wand tussen koel- en vriescel
export const GROUND = -0.45;
/** Dock n (1..8): midden x. */
export const dockX = (n: number) => -29.5 + (n - 1) * 4;
export const KOEL_DOOR_X = 8;
export const VRIES_DOOR_X = 25;
export const ACCU_DOOR_X = -33;
export const OFFICE = { x0: 1, x1: 9, z0: 19, z1: FRONT - 0.125 };

// Koelcel: veertien rijen, van voor (z = 9) naar achter, twaalf vakken van 2,7 m.
export const RACK_FRONT = 9;
export const BAY = 2.7;
export const BEAMS = [2.0, 3.8, 5.6, 7.4];
export type Row = { name: string; x: number; face: 1 | -1 };
export const ROWS: Row[] = (() => {
  const rows: Row[] = [];
  let x = -27.5;
  const single = (name: string, face: 1 | -1) => {
    rows.push({ name, x: x + 0.55, face });
    x += 1.1;
  };
  const aisle = () => (x += 3.2);
  single('A', 1);
  for (const [a, b] of [['B', 'C'], ['D', 'E'], ['F', 'G'], ['H', 'J'], ['K', 'L'], ['M', 'N']]) {
    aisle();
    rows.push({ name: a, x: x + 0.55, face: -1 });
    rows.push({ name: b, x: x + 1.85, face: 1 });
    x += 2.4;
  }
  aisle();
  single('O', -1);
  return rows;
})();
export const row = (name: string) => ROWS.find((r) => r.name === name)!;
/** Midden van gangpad n (1..7). */
export const aisleX = (n: number) => {
  const left = ROWS.filter((r) => r.face === 1)[n - 1];
  return left.x + 0.55 + 1.6;
};
/** Midden (z) van vak v (1..12). */
export const bayZ = (v: number) => RACK_FRONT - (v - 0.5) * BAY;
/** Plaats p (1..3) in een vak: plaats 1 is links als je vanuit het gangpad naar de stelling kijkt. */
export const slotZ = (r: Row, v: number, p: number) => bayZ(v) + (r.face === 1 ? 1 : -1) * (2 - p) * 0.9;
export const levelY = (n: number) => (n === 0 ? 0 : BEAMS[n - 1]);
/** Voorkant van de liggers (x) aan de gangpadkant. */
export const faceX = (r: Row) => r.x + r.face * 0.53;

// Vriescel: twee blokken drive-in, banen van 1,45 m; rij Z langs de rechtermuur.
export const LANE_W = 1.45;
export const LANE_X0 = 14.6;
export const laneX = (k: number) => LANE_X0 + (k + 0.5) * LANE_W; // k = 0..11
export const BLOCKS = [{ z0: 7, first: 1 }, { z0: -7, first: 13 }];
export const RAILS = [1.9, 3.7, 5.5];
export const ROW_Z = { x: 35.45, face: -1 as const, front: 11, beams: [2.0, 3.8, 5.6] };

export type Actor = { obj: THREE.Object3D; only: string[] };

export function buildKoelhuis(scene: THREE.Scene) {
  const actors: Actor[] = [];
  const actor = (obj: THREE.Object3D, only: string[]) => {
    scene.add(obj);
    actors.push({ obj, only });
    return obj;
  };
  const loads = new Loads();
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const blue = paint('#1e4f9c', 0.6, 0.15);
  const orange = paint('#e2601a', 0.6, 0.1);
  const steelGrey = paint('#8b9399', 0.6, 0.3);
  const glow = (c: string, k = 1) => {
    const m = new THREE.MeshBasicMaterial({ color: c });
    m.color.multiplyScalar(k);
    return m;
  };

  // ---------- Vloer en terrein ----------
  const floorTex = tex.concreteFloor();
  floorTex.map.repeat.set(W / 10, D / 10);
  floorTex.roughnessMap.repeat.set(W / 7, D / 7);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: floorTex.map, roughnessMap: floorTex.roughnessMap, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const asphalt = tex.asphalt();
  asphalt.wrapS = asphalt.wrapT = THREE.RepeatWrapping;
  asphalt.repeat.set(30, 30);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, GROUND - 0.002, 0);
  ground.receiveShadow = true;
  scene.add(ground);
  // fundering tussen het terrein en de halvloer
  const plinthMat = paint('#9a9b96', 0.9, 0);
  for (const [x, z, w, d] of [[0, FRONT + 0.05, W + 0.6, 0.35], [0, -D / 2 - 0.05, W + 0.6, 0.35], [-W / 2 - 0.05, 0, 0.35, D], [W / 2 + 0.05, 0, 0.35, D]])
    part(scene, UNIT_BOX, plinthMat, x, GROUND / 2, z).scale.set(w, -GROUND, d);

  // ---------- Vloermarkering ----------
  const paintGeos = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const paintMats = new Map<string, THREE.Material>();
  function mark(x: number, z: number, w: number, d: number, color: string, text?: string, turn = 0) {
    const key = color + (text ?? '');
    let mat = paintMats.get(key);
    if (!mat) {
      mat = onTop(new THREE.MeshStandardMaterial({ color, map: text ? tex.floorText(text) : null, transparent: !!text, depthWrite: !text, roughness: 0.55 }));
      paintMats.set(key, mat);
    }
    const geo = new THREE.PlaneGeometry(w, d).rotateZ(turn).rotateX(-Math.PI / 2).translate(x, 0.003, z);
    paintGeos.set(mat, [...(paintGeos.get(mat) ?? []), geo]);
  }
  /** Rechthoekige omlijning. */
  const outline = (x0: number, z0: number, x1: number, z1: number, color: string, t = 0.08) => {
    mark((x0 + x1) / 2, z0, x1 - x0 + t, t, color);
    mark((x0 + x1) / 2, z1, x1 - x0 + t, t, color);
    mark(x0, (z0 + z1) / 2, t, z1 - z0 - t, color);
    mark(x1, (z0 + z1) / 2, t, z1 - z0 - t, color);
  };
  const GREEN = '#3a9a5c';
  const BLUE = '#2e6fd8';
  const RED = '#c8231c';
  const YELLOW = '#e3b505';

  // ---------- Wanden ----------
  const panel = tex.wallPanel();
  panel.wrapS = panel.wrapT = THREE.RepeatWrapping;
  panel.repeat.set(1, 1 / H);
  const wallMat = new THREE.MeshStandardMaterial({ map: panel, color: '#f4f6f7', roughness: 0.7, metalness: 0.05 });
  type Hole = [number, number, number, number];
  function slab(along: 'x' | 'z', at: number, from: number, to: number, holes: Hole[] = [], t = 0.2, h = H, y0 = 0, mat: THREE.Material = wallMat) {
    const rect = (a: number, b: number, c: number, d: number) => [new THREE.Vector2(a, c), new THREE.Vector2(b, c), new THREE.Vector2(b, d), new THREE.Vector2(a, d)];
    const shape = new THREE.Shape(rect(from, to, y0, h));
    for (const [a, b, c, d] of holes) shape.holes.push(new THREE.Path(rect(a, b, Math.max(c, y0 + 0.002), d)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
    if (along === 'x') geo.translate(0, 0, at - t / 2);
    else geo.rotateY(-Math.PI / 2).translate(at + t / 2, 0, 0);
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
  const DOOR_H = 3.4;
  // dockgevel: docks, loket, personeelsdeur
  slab('x', FRONT, -W / 2 - 0.125, W / 2 + 0.125, [
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n): Hole => [dockX(n) - 1.5, dockX(n) + 1.5, 0, DOOR_H]),
    [2.0, 3.2, 1.0, 2.0], // loket
    [10.5, 11.5, 0, 2.1], // personeelsdeur
  ], 0.25, H, GROUND);
  slab('x', -D / 2, -W / 2 - 0.125, W / 2 + 0.125, [], 0.25, H, GROUND);
  slab('z', -W / 2, -D / 2, D / 2, [], 0.25, H, GROUND);
  slab('z', W / 2, -D / 2, D / 2, [], 0.25, H, GROUND);
  // binnenwanden
  slab('x', CELL_Z, -W / 2, W / 2, [
    [KOEL_DOOR_X - 1.8, KOEL_DOOR_X + 1.8, 0, 4.2],
    [VRIES_DOOR_X - 1.8, VRIES_DOOR_X + 1.8, 0, 4.2],
    [ACCU_DOOR_X - 1.4, ACCU_DOOR_X + 1.4, 0, 2.8],
  ]);
  slab('z', VRIES_X, -D / 2, CELL_Z, [], 0.3);
  slab('z', STRIP_X, -D / 2, CELL_Z, [[-9, -5, 0, 4]]);
  slab('x', 1, -W / 2, STRIP_X, [[-34, -32, 0, 2.6]]);

  // ---------- Dak en licht ----------
  const deckTex = tex.roofDeck();
  deckTex.repeat.set(W, 1);
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: deckTex, roughness: 0.7, metalness: 0.2 }));
  deck.rotation.x = Math.PI / 2;
  deck.position.y = H;
  scene.add(deck);
  const roofTop = new THREE.Mesh(new THREE.PlaneGeometry(W + 0.6, D + 0.6), paint('#5d6166', 0.9, 0));
  roofTop.rotation.x = -Math.PI / 2;
  roofTop.position.y = H + 0.02;
  scene.add(roofTop);
  const housings = new Batch();
  const lamps = new Batch();
  const lampAt: [number, number][] = [];
  const lampRow = (x: number, z0: number, z1: number, pitch: number) => {
    for (let z = z0; z >= z1; z -= pitch) {
      housings.add(x, 9.3, z, 0.32, 0.07, 1.25);
      lamps.add(x, 9.26, z, 0.24, 0.012, 1.15);
      lampAt.push([x, z]);
    }
  };
  for (let n = 1; n <= 7; n++) lampRow(aisleX(n), 7, -22, 5.8);
  lampRow(-3, 11, 11, 1);
  for (const x of [-26, -14, -2, 10, 22, 32]) lampRow(x, 21, 16, 5);
  for (const x of [19, 26, 33]) lampRow(x, 10, -22, 8);
  lampRow(-33, 8, -22, 7.5);
  scene.add(housings.build(UNIT_BOX, STYLE.dark, false), lamps.build(UNIT_BOX, glow('#fffbe8', 4), false));
  // puntlichten: niet bij elke lamp, wel genoeg om alles te verlichten
  const pointLights: THREE.PointLight[] = [];
  lampAt.forEach(([x, z], i) => {
    if (i % 2 && Math.abs(z - 11) > 1) return;
    const p = new THREE.PointLight('#fff4e2', 70, 26, 2);
    p.position.set(x, 8.8, z);
    scene.add(p);
    pointLights.push(p);
  });

  // ---------- Docks ----------
  const doorMat = paint('#c3c8cc', 0.55, 0.3);
  const leveller = onTop(new THREE.MeshStandardMaterial({ map: tex.treadPlate(), roughness: 0.5, metalness: 0.6 }));
  const OPEN = [2, 6];
  /** Bord boven het begin van een baan, leesbaar vanuit de hal. */
  const hangSign = (x: number, text: string, color: string) => {
    const b = textBoard(0.75, 0.38, [text], color, '#ffffff');
    b.position.set(x, 3.4, 21.6);
    b.rotation.y = Math.PI;
    scene.add(b);
    const back = part(scene, UNIT_BOX, STYLE.dark, x, 3.4, 21.62);
    back.scale.set(0.78, 0.41, 0.02);
    part(scene, UNIT_BOX, STYLE.black, x, 3.6 + (H - 3.6) / 2, 21.62).scale.set(0.015, H - 3.6, 0.015);
  };
  for (let n = 1; n <= 8; n++) {
    const x = dockX(n);
    const inbound = n <= 3;
    // laadklep binnen
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.1), leveller);
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(x, 0.004, FRONT - 1.2);
    plate.receiveShadow = true;
    scene.add(plate);
    // deur: dicht, of opgerold bij de docks waar een wagen staat
    const roll = part(scene, rb(3.2, 0.5, 0.5, 0.08), doorMat, x, DOOR_H + 0.35, FRONT - 0.45);
    void roll;
    if (!OPEN.includes(n)) {
      for (let s = 0; s < 4; s++) part(scene, UNIT_BOX, doorMat, x, 0.43 + s * 0.85, FRONT - 0.2).scale.set(3.0, 0.84, 0.05);
      for (const dx of [-0.9, 0, 0.9]) {
        const win = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.28), onTop(glow('#5d7186')));
        win.position.set(x + dx, 2.2, FRONT - 0.17);
        win.rotation.y = Math.PI;
        scene.add(win);
      }
    }
    // gele palen en stootrand
    for (const dx of [-1.65, 1.65]) part(scene, UNIT_BOX, paint('#f0c20a', 0.5, 0.1), x + dx, 0.6, FRONT - 0.3).scale.set(0.14, 1.2, 0.14);
    // bord binnen
    const inside = textBoard(1.5, 0.6, [`DOCK ${n}`], '#17346b', '#ffffff');
    inside.position.set(x, 4.35, FRONT - 0.13);
    inside.rotation.y = Math.PI;
    scene.add(inside);
    // buiten: dockshelter, nummerbord, ontvangst/expeditie, stootbuffers, lamp
    const shelter = STYLE.dark;
    part(scene, rb(3.6, 0.7, 0.6, 0.05), shelter, x, DOOR_H + 0.3, FRONT + 0.42);
    for (const dx of [-1.6, 1.6]) part(scene, rb(0.45, DOOR_H + 0.45, 0.6, 0.05), shelter, x + dx, (DOOR_H + 0.45) / 2 + GROUND + 0.02, FRONT + 0.42);
    for (const dx of [-1.1, 1.1]) part(scene, rb(0.25, 0.3, 0.15, 0.03), STYLE.rubber, x + dx, -0.2, FRONT + 0.2);
    const num = textBoard(1.0, 0.8, [String(n)], '#f0c20a', '#111111');
    num.position.set(x, 5.0, FRONT + 0.13);
    scene.add(num);
    const kind = textBoard(1.6, 0.36, [inbound ? 'ONTVANGST' : 'EXPEDITIE'], inbound ? GREEN : BLUE, '#ffffff', { border: false });
    kind.position.set(x, 4.35, FRONT + 0.13);
    scene.add(kind);
    part(scene, rb(0.5, 0.12, 0.3, 0.03), STYLE.dark, x, 5.75, FRONT + 0.25);
    const bulb = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.2), glow('#fff3d6', 3));
    bulb.rotation.x = Math.PI / 2;
    bulb.position.set(x, 5.68, FRONT + 0.25);
    scene.add(bulb);
    const outLight = new THREE.PointLight('#ffe7c4', 30, 16, 2);
    outLight.position.set(x, 5.4, FRONT + 1.2);
    scene.add(outLight);
    // binnen: banen
    if (inbound) {
      for (const [dx, letter] of [[-0.8, 'A'], [0.8, 'B']] as const) {
        outline(x + dx - 0.55, 14.5, x + dx + 0.55, 22.3, GREEN);
        mark(x + dx, 14.1, 1.0, 0.3, GREEN, `O${n}-${letter}`, Math.PI);
        hangSign(x + dx, `O${n}-${letter}`, GREEN);
      }
    } else {
      for (let l = 1; l <= 3; l++) {
        const lx = x + (l - 2) * 1.2;
        outline(lx - 0.52, 13.3, lx + 0.52, 22.3, BLUE);
        mark(lx, 22.6, 0.95, 0.28, BLUE, `E${n}-${l}`, Math.PI);
        hangSign(lx, `E${n}-${l}`, BLUE);
      }
    }
  }
  // quarantaine in de hoek bij dock 1
  outline(-35.6, 20.4, -32.0, 23.3, RED, 0.1);
  mark(-33.8, 21.85, 3.6, 0.06, RED);
  for (const xx of [-34.7, -33.8, -32.9]) mark(xx, 21.85, 0.06, 2.8, RED);
  mark(-33.8, 19.7, 1.4, 1.0, RED, 'Q', Math.PI);
  const qBoard = textBoard(1.6, 0.8, ['QUARANTAINE', 'GEBLOKKEERDE VOORRAAD'], RED, '#ffffff');
  qBoard.position.set(-35.86, 2.4, 21.85);
  qBoard.rotation.y = Math.PI / 2;
  scene.add(qBoard);
  // gearceerd vak voor de celdeuren
  for (const dx of [KOEL_DOOR_X, VRIES_DOOR_X]) outline(dx - 1.8, 13.15, dx + 1.8, 15.2, YELLOW);

  // printer op de paal tussen dock 2 en 3
  {
    const x = (dockX(2) + dockX(3)) / 2;
    part(scene, UNIT_BOX, paint('#f0c20a', 0.5, 0.1), x, 1.2, 23.6).scale.set(0.16, 2.4, 0.16);
    part(scene, rb(0.42, 0.28, 0.36, 0.03), STYLE.white, x, 1.25, 23.35);
    part(scene, rb(0.3, 0.02, 0.12, 0.005), STYLE.black, x, 1.3, 23.16);
  }

  // ---------- Celdeuren (snelroldeuren, open) en borden ----------
  for (const [x, text, color] of [[KOEL_DOOR_X, 'KOELCEL  2-4 °C', '#2e6fd8'], [VRIES_DOOR_X, 'VRIESCEL  -22 °C', '#17346b']] as const) {
    for (const s of [-1, 1]) for (const z of [CELL_Z + 0.15, CELL_Z - 0.15]) part(scene, rb(0.2, 4.4, 0.18, 0.03), STYLE.dark, x + s * 1.9, 2.2, z);
    part(scene, rb(4.2, 0.55, 0.55, 0.1), STYLE.dark, x, 4.55, CELL_Z + 0.4);
    const curtain = part(scene, UNIT_BOX, paint('#e4e6e8', 0.8, 0), x, 4.0, CELL_Z + 0.33);
    curtain.scale.set(3.6, 0.4, 0.02);
    const b = textBoard(3.4, 0.7, [text], color, '#ffffff');
    b.position.set(x, 5.4, CELL_Z + 0.105);
    scene.add(b);
  }
  const accu = textBoard(2.0, 0.45, ['ACCULAADRUIMTE'], '#2b2e32', '#ffffff');
  accu.position.set(ACCU_DOOR_X, 3.2, CELL_Z + 0.105);
  scene.add(accu);
  part(scene, UNIT_BOX, doorMat, ACCU_DOOR_X, 2.65, CELL_Z + 0.25).scale.set(2.8, 0.3, 0.3);
  // regel voor de vriescel, binnen naast de deur
  const rule = textBoard(1.4, 0.9, ['MAX 20 MIN AANEEN', 'DAN 10 MIN OPWARMEN'], '#ffffff', '#c8231c');
  rule.position.set(VRIES_DOOR_X - 2.9, 1.9, CELL_Z - 0.105);
  rule.rotation.y = Math.PI;
  scene.add(rule);
  const rule2 = rule.clone();
  rule2.position.set(VRIES_DOOR_X + 2.9, 1.9, CELL_Z + 0.105);
  rule2.rotation.y = 0;
  scene.add(rule2);

  // ---------- Koelcel: stellingen ----------
  const uprights = new Batch();
  const beams = new Batch();
  const ties = new Batch();
  const plainLabels = new Batch();
  const BACK = RACK_FRONT - 12 * BAY;
  const LEGBORD = new Set(['A-11', 'A-12', 'O-11', 'O-12']);
  const atlasCodes: string[] = [];
  const atlasSpots: { x: number; y: number; z: number; ry: number; w: number; h: number }[] = [];
  const labelled = new Set(['B', 'C', 'D', 'E', 'F', 'G', 'A', 'Z']);
  const ARTICLES = [
    'Halfvolle melk 1L', 'Volle yoghurt 1L', 'Vla vanille 1L', 'Karnemelk 1L', 'Griekse yoghurt 500g', 'Kwark mager 500g', 'Slagroom 250ml', 'Boter 250g',
    'Jong belegen 48+ plakken', 'Oude kaas blok', 'Geitenkaas 150g', 'Mozzarella 125g', 'Rookvlees 100g', 'Achterham 150g', 'Kipfilet gerookt', 'Salami 80g',
    'Huzarensalade 400g', 'Eiersalade 175g', 'Hummus 200g', 'Verse pasta 400g', 'Pizzadeeg', 'Sinaasappelsap 1L', 'Smoothie mango', 'Eieren 10st',
  ];
  const cards: { text: string; x: number; y: number; z: number; ry: number }[] = [];
  for (const r of ROWS) {
    const fx = r.x + r.face * 0.5;
    const bx = r.x - r.face * 0.5;
    for (let k = 0; k <= 12; k++) {
      const z = RACK_FRONT - k * BAY;
      for (const ux of [fx, bx]) uprights.add(ux, 4.4, z, 0.09, 8.8, 0.08);
      for (let y = 0.6; y < 8.6; y += 1.4) ties.add(r.x, y, z, 0.95, 0.04, 0.03);
    }
    for (const ux of [fx, bx]) for (const y of BEAMS) beams.add(ux + (ux === fx ? r.face : -r.face) * 0.0, y - 0.06, (RACK_FRONT + BACK) / 2, 0.05, 0.12, 12 * BAY);
    const ry = r.face === 1 ? Math.PI / 2 : -Math.PI / 2;
    for (let v = 1; v <= 12; v++) {
      const code2 = `${r.name}-${String(v).padStart(2, '0')}`;
      if (LEGBORD.has(code2)) {
        // legbordstelling: vier planken, twaalf kleine locaties
        for (let s = 0; s < 4; s++) {
          const y = 0.35 + s * 0.42;
          part(scene, rb(1.0, 0.03, BAY - 0.1, 0.005), steelGrey, r.x, y, bayZ(v));
          for (let i = 0; i < 3; i++) {
            const z = bayZ(v) + (r.face === 1 ? 1 : -1) * (1 - i) * 0.9;
            for (let b = 0; b < 3; b++) if (rnd() < 0.8) part(scene, rb(0.28, 0.2, 0.25, 0.02), new THREE.MeshStandardMaterial({ color: ['#b98f62', '#e4e6e8', '#c49a6c'][b], roughness: 0.85 }), r.x + r.face * (0.3 - b * 0.3), y + 0.115, z + (rnd() - 0.5) * 0.3);
            atlasCodes.push(`${code2}-0-${'ABCDEFGHIJKL'[s * 3 + i]}`);
            atlasSpots.push({ x: faceX(r) + r.face * 0.0, y: y - 0.04, z, ry, w: 0.2, h: 0.07 });
          }
        }
      }
      for (let lv = 0; lv <= 4; lv++) {
        for (let p = 1; p <= 3; p++) {
          const z = slotZ(r, v, p);
          const code = `${code2}-${lv}-${p}`;
          const y = lv === 0 ? 1.83 : BEAMS[lv - 1] - 0.06;
          if (!(lv === 0 && LEGBORD.has(code2))) {
            if (labelled.has(r.name)) {
              atlasCodes.push(code);
              atlasSpots.push({ x: faceX(r), y, z, ry, w: 0.2, h: 0.07 });
            } else plainLabels.add(faceX(r), y, z, 0.003, 0.07, 0.2);
          }
          // pallets
          if (lv === 0) {
            if (LEGBORD.has(code2)) continue;
            const kinds: LoadKind[] = ['doos', 'tray', 'krat', 'doos'];
            const kind = kinds[Math.floor(rnd() * kinds.length)];
            if (code === 'D-06-0-1') loads.pallet(r.x, 0, z, 0, 'doos', 0, 2 / 6);
            else loads.pallet(r.x, 0, z, 0, kind, code === 'D-07-0-2' ? 3 : Math.floor(rnd() * 4), rnd());
            if (r.name === 'C' || r.name === 'D')
              cards.push({ text: `${ARTICLES[(v * 3 + p + (r.name === 'D' ? 7 : 0)) % ARTICLES.length]}|${(100000 + ((v * 7919 + p * 131 + r.name.charCodeAt(0) * 17) % 899999)).toString()}`, x: faceX(r), y: 1.68, z, ry });
          } else if (rnd() < 0.82 && !(r.name === 'F' && v === 6 && lv === 3 && p === 1)) {
            const kinds: LoadKind[] = ['doos', 'doos', 'tray', 'krat'];
            const kind = kinds[Math.floor(rnd() * kinds.length)];
            const layers = { doos: 4, tray: 5, krat: 3, vries: 5 }[kind];
            loads.pallet(r.x, BEAMS[lv - 1], z, 0, kind, layers, rnd() < 0.3 ? rnd() : 1, true);
          }
        }
      }
    }
  }
  // rijborden aan de kop van de rijen
  for (let i = 0; i < ROWS.length; i++) {
    const r = ROWS[i];
    const pair = r.face === -1 && ROWS[i + 1]?.face === 1 && Math.abs(ROWS[i + 1].x - r.x - 1.3) < 0.01 ? ROWS[i + 1] : null;
    if (r.face === 1 && i > 0 && ROWS[i - 1].face === -1 && Math.abs(r.x - ROWS[i - 1].x - 1.3) < 0.01) continue;
    const x = pair ? (r.x + pair.x) / 2 : r.x;
    const sign = textBoard(pair ? 2.2 : 1.1, 0.8, [pair ? `${r.name} | ${pair.name}` : r.name], '#17346b', '#ffffff');
    sign.position.set(x, 3.2, RACK_FRONT + 0.06);
    scene.add(sign);
    part(scene, UNIT_BOX, STYLE.dark, x, 3.2, RACK_FRONT + 0.03).scale.set(pair ? 2.25 : 1.15, 0.85, 0.04);
  }
  // gangpadnummers boven de gangpaden
  for (let n = 1; n <= 7; n++) {
    const s = textBoard(1.2, 0.6, [`GANG ${n}`], '#f0c20a', '#111111');
    s.position.set(aisleX(n), 6.5, RACK_FRONT + 0.4);
    scene.add(s);
  }

  // ---------- Vriescel: drive-in ----------
  for (const { z0, first } of BLOCKS) {
    for (let k = 0; k <= 12; k++) {
      const x = LANE_X0 + k * LANE_W;
      for (let j = 0; j <= 8; j++) uprights.add(x, 3.7, z0 - j * 1.25, 0.09, 7.4, 0.08);
      for (const y of RAILS) for (const s of k === 0 ? [1] : k === 12 ? [-1] : [-1, 1]) beams.add(x + s * 0.07, y - 0.04, z0 - 5, 0.12, 0.08, 10);
    }
    for (let j = 0; j <= 8; j++) beams.add(LANE_X0 + 6 * LANE_W, 7.35, z0 - j * 1.25, 12 * LANE_W, 0.1, 0.06);
    for (let k = 0; k < 12; k++) {
      const n = first + k;
      const s = textBoard(0.9, 0.45, [`V${String(n).padStart(2, '0')}`], '#17346b', '#ffffff');
      s.position.set(laneX(k), 6.9, z0 + 0.06);
      scene.add(s);
      mark(laneX(k), z0 + 0.45, 0.9, 0.3, '#e9e9e2', `V${String(n).padStart(2, '0')}`);
      for (let lv = 0; lv < 4; lv++) {
        const y = lv === 0 ? 0 : RAILS[lv - 1];
        const count = n === 5 && lv === 0 ? 3 : Math.floor(rnd() * 9);
        const kind: LoadKind = 'vries';
        const ci = Math.floor(rnd() * 3);
        for (let j = 0; j < count; j++) loads.pallet(laneX(k), y, z0 - 10 + 0.625 + j * 1.25, Math.PI / 2, kind, 5, 1, true, ci);
      }
    }
  }
  // rij Z langs de rechtermuur
  {
    const { x, front, beams: zb } = ROW_Z;
    const fx = x - 0.5;
    for (let k = 0; k <= 10; k++) {
      const z = front - k * BAY;
      for (const ux of [fx, x + 0.5]) uprights.add(ux, 3.6, z, 0.09, 7.2, 0.08);
    }
    for (const ux of [fx, x + 0.5]) for (const y of zb) beams.add(ux, y - 0.06, front - 5 * BAY, 0.05, 0.12, 10 * BAY);
    for (let v = 1; v <= 10; v++)
      for (let lv = 0; lv <= 3; lv++)
        for (let p = 1; p <= 3; p++) {
          const z = front - (v - 0.5) * BAY - (2 - p) * 0.9;
          atlasCodes.push(`Z-${String(v).padStart(2, '0')}-${lv}-${p}`);
          atlasSpots.push({ x: x - 0.53, y: lv === 0 ? 1.83 : zb[lv - 1] - 0.06, z, ry: -Math.PI / 2, w: 0.2, h: 0.07 });
          if (lv === 0) loads.pallet(x, 0, z, 0, 'vries', Math.floor(rnd() * 4), rnd());
          else if (rnd() < 0.8) loads.pallet(x, zb[lv - 1], z, 0, 'vries', 5, 1, true);
        }
    const s = textBoard(1.1, 0.8, ['Z'], '#17346b', '#ffffff');
    s.position.set(x, 3.2, front + 0.06);
    scene.add(s);
  }
  // blokstapeling achterin (zone VB)
  outline(15, -24.5, 31.5, -18, YELLOW);
  mark(23, -17.4, 1.6, 0.7, YELLOW, 'VB', Math.PI);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) {
    if (rnd() < 0.25) continue;
    const x = 16.2 + j * 1.95;
    const z = -19.2 - i * 1.5;
    const top = loads.pallet(x, 0, z, 0, 'vries', 5, 1, true, 0);
    if (rnd() < 0.7) loads.pallet(x, top + 0.01, z, 0, 'vries', 4, 1, true, 0);
  }

  scene.add(uprights.build(UNIT_BOX, blue), beams.build(UNIT_BOX, orange), ties.build(UNIT_BOX, blue), plainLabels.build(UNIT_BOX, paint('#f2c81a', 0.6, 0), false));

  // labels uit de atlas
  {
    const { texture, rects } = labelAtlas(atlasCodes);
    const geos = atlasSpots.map((s, i) => {
      const g = new THREE.PlaneGeometry(s.w, s.h);
      const uv = g.attributes.uv;
      const [u0, v0, u1, v1] = rects[i];
      for (let j = 0; j < uv.count; j++) uv.setXY(j, uv.getX(j) ? u1 : u0, uv.getY(j) ? v1 : v0);
      return g.rotateY(s.ry).translate(s.x + Math.sin(s.ry) * 0.004, s.y, s.z + Math.cos(s.ry) * 0.004);
    });
    const m = new THREE.Mesh(mergeGeometries(geos), onTop(new THREE.MeshStandardMaterial({ map: texture, roughness: 0.6 })));
    m.receiveShadow = true;
    scene.add(m);
  }
  // artikelkaartjes rij C en D
  for (const c of cards) {
    const [name, nr] = c.text.split('|');
    const b = board(0.24, 0.09, 1000, (g, w, h) => {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#111';
      g.textBaseline = 'middle';
      g.font = `bold ${Math.round(h * 0.32)}px Arial`;
      g.fillText(name, w * 0.04, h * 0.32, w * 0.92);
      g.font = `${Math.round(h * 0.26)}px Arial`;
      g.fillText(`art. ${nr}`, w * 0.04, h * 0.72, w * 0.92);
    });
    b.position.set(c.x + Math.sin(c.ry) * 0.004, c.y, c.z);
    b.rotation.y = c.ry;
    scene.add(b);
  }

  // ---------- Expeditiekantoor met loket ----------
  {
    const { x0, x1, z0, z1 } = OFFICE;
    const low = STYLE.white;
    part(scene, UNIT_BOX, low, (x0 + x1) / 2, 0.5, z0).scale.set(x1 - x0, 1.0, 0.1);
    for (const x of [x0, x1]) part(scene, UNIT_BOX, low, x, 0.5, (z0 + z1) / 2).scale.set(0.1, 1.0, z1 - z0);
    part(scene, UNIT_BOX, STYLE.glass, (x0 + x1) / 2, 1.95, z0).scale.set(x1 - x0, 1.9, 0.02);
    part(scene, UNIT_BOX, STYLE.glass, x1, 1.95, (z0 + z1) / 2).scale.set(0.02, 1.9, z1 - z0);
    part(scene, UNIT_BOX, low, x0, 1.95, (z0 + z1) / 2).scale.set(0.1, 1.9, z1 - z0);
    for (let x = x0; x <= x1 + 0.01; x += 2) part(scene, UNIT_BOX, STYLE.dark, x, 1.95, z0).scale.set(0.06, 1.9, 0.06);
    part(scene, UNIT_BOX, STYLE.ceiling, (x0 + x1) / 2, 2.95, (z0 + z1) / 2).scale.set(x1 - x0 + 0.1, 0.1, z1 - z0 + 0.1);
    for (const [x, z] of [[3.2, 21.0], [6.2, 21.0]]) {
      part(scene, rb(1.6, 0.04, 0.8, 0.01), STYLE.wood, x, 0.74, z);
      for (const dx of [-0.75, 0.75]) part(scene, UNIT_BOX, STYLE.dark, x + dx, 0.37, z).scale.set(0.05, 0.72, 0.7);
      part(scene, rb(0.55, 0.35, 0.03, 0.01), STYLE.black, x, 1.0, z - 0.25);
      part(scene, rb(0.5, 0.45, 0.5, 0.05), STYLE.blue, x, 0.45, z + 0.7);
    }
    // planningscherm aan de linkerwand
    const ps = planningScreen(2.0, 1.125);
    ps.position.set(x0 + 0.06, 1.75, 22.2);
    ps.rotation.y = Math.PI / 2;
    scene.add(ps);
    part(scene, rb(2.08, 1.2, 0.04, 0.01), STYLE.black, x0 + 0.04, 1.75, 22.2).rotation.y = Math.PI / 2;
    // loket: balie binnen, bord en bel buiten
    part(scene, rb(1.4, 0.05, 0.5, 0.01), STYLE.wood, 2.6, 1.0, FRONT - 0.3);
    const loket = textBoard(1.6, 0.5, ['LOKET', 'CHAUFFEURS MELDEN HIER'], '#17346b', '#ffffff');
    loket.position.set(2.6, 2.45, FRONT + 0.13);
    scene.add(loket);
    part(scene, rb(0.08, 0.12, 0.04, 0.01), STYLE.dark, 3.45, 1.4, FRONT + 0.14);
    const light = new THREE.PointLight('#fff4e2', 6, 9, 2);
    light.position.set(5, 2.6, 22);
    scene.add(light);
    const pdoor = textBoard(0.6, 0.3, ['INGANG'], '#2b2e32', '#ffffff');
    pdoor.position.set(11, 2.4, FRONT + 0.13);
    scene.add(pdoor);
  }

  // ---------- Afmeldplekken: weegschaal en wikkelmachine ----------
  for (const x of [1.5, 4.2]) {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), leveller);
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(x, 0.004, 15.0);
    plate.receiveShadow = true;
    scene.add(plate);
    const w = createWrapper();
    w.position.set(x - 0.3, 0, 17.3);
    scene.add(w);
    part(scene, UNIT_BOX, STYLE.dark, x + 0.75, 0.75, 15.0).scale.set(0.06, 1.5, 0.06);
    const sc = screen(0.42, 0.26, x === 1.5 ? ['ROLCO 0412-07', 'RIT 05  STOP 3', 'GEWICHT 186 kg', 'VERWACHT 181 kg  OK', 'BAAN E5-2'] : ['WACHT OP SCAN'], { px: 1500 });
    const box = part(scene, rb(0.46, 0.3, 0.05, 0.01), STYLE.black, x + 0.75, 1.6, 15.0);
    box.rotation.y = Math.PI - 0.6;
    sc.position.z = 0.027;
    box.add(sc);
  }
  mark(2.85, 14.1, 2.6, 0.4, '#e9e9e2', 'AFMELDEN', Math.PI);

  // ---------- Acculaadruimte ----------
  {
    const lamp = glow('#2ecc55', 2.5);
    for (let i = 0; i < 16; i++) {
      const z = 1.6 + i * 0.72;
      const c = createCharger(lamp);
      c.position.set(-35.88, 0, z);
      c.rotation.y = Math.PI / 2;
      c.scale.setScalar(0.85);
      scene.add(c);
      const nb = textBoard(0.3, 0.2, [String(i + 1)], '#ffffff', '#111111');
      nb.position.set(-35.87, 2.0, z);
      nb.rotation.y = Math.PI / 2;
      scene.add(nb);
    }
    for (let i = 0; i < 6; i++) {
      const t = createOrderPicker();
      t.position.set(-34.4 + 0.0, 0, 1.6 + i * 1.44 + 0.36);
      t.rotation.y = Math.PI / 2;
      scene.add(t);
    }
    for (let i = 0; i < 2; i++) {
      const j = createElectricJack();
      j.group.position.set(-34.9, 0, 10.6 + i * 0.72 + 0.36);
      j.group.rotation.y = Math.PI / 2;
      scene.add(j.group);
    }
    const s = textBoard(2.0, 0.45, ['ACCULAADRUIMTE'], '#2b2e32', '#ffffff');
    s.position.set(-33, 3.0, 1.105);
    scene.add(s);
  }

  // ---------- Leeggoed ----------
  {
    const s = textBoard(2.6, 0.9, ['LEEGGOED', 'EMBALLAGE'], '#3a9a5c', '#ffffff');
    s.position.set(-35.86, 3.0, -6);
    s.rotation.y = Math.PI / 2;
    scene.add(s);
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 14; j++) {
        if (i === 3 && j > 8) continue;
        const r = createRolco();
        r.position.set(-35.2 + i * 0.85, 0, -24 + j * 0.84);
        scene.add(r);
      }
    for (let i = 0; i < 3; i++) for (let j = 0; j < 8; j++) crateStack(scene, -31.2 - i * 0.7, -10.5 + j * 0.5 - (i % 2) * 0.1, 6 + ((i + j) % 5), (i + j) % 3 ? STYLE.blue : STYLE.plastic).rotation.y = Math.PI / 2;
    outline(-35.8, -24.6, -30.4, -12.2, YELLOW);
  }

  // ---------- Expeditiebanen met rolcontainers ----------
  const rolcoLabel = (klant: string, rit: string, stop: number, id: string) =>
    board(0.22, 0.15, 1400, (g, w, h) => {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#111';
      g.textBaseline = 'middle';
      g.font = `bold ${Math.round(h * 0.16)}px Arial`;
      g.fillText(klant, w * 0.05, h * 0.14, w * 0.9);
      g.font = `bold ${Math.round(h * 0.3)}px Arial`;
      g.fillText(`STOP ${stop}`, w * 0.05, h * 0.42, w * 0.9);
      g.font = `${Math.round(h * 0.13)}px Arial`;
      g.fillText(`${rit}   ${id}`, w * 0.05, h * 0.64, w * 0.9);
      g.fillRect(w * 0.05, h * 0.74, w * 0.9, h * 0.005);
      for (let i = 0; i < 60; i++) if ((i * 7) % 3) g.fillRect(w * (0.06 + i * 0.0145), h * 0.77, w * 0.008, h * 0.18);
    });
  const KLANTEN = ['SUPERMARKT DE BRINK', 'SUPER VERSHOEK OOST', 'BUURTSUPER HET PLEIN', 'HOTEL DE WADDEN', 'SUPERMARKT MARKTSTRAAT', 'EETCAFE DE HAVEN', 'SUPERMARKT ZUIDERWAL', 'RESTAURANT LINDEHOF'];
  const fillLane = (dock: number, lane: number, count: number, rit: string, stops: number) => {
    const lx = dockX(dock) + (lane - 2) * 1.2;
    for (let i = 0; i < count; i++) {
      // hoogste stop vooraan bij de deur (laatste stop gaat als eerste de wagen in)
      const stop = Math.max(1, stops - Math.floor((i * stops) / 12));
      const z = 22.3 - 0.4 - i * 0.75;
      const r = createRolco({ fill: 0.6 + rnd() * 0.35, wrap: true, label: rolcoLabel(KLANTEN[(stop + dock) % KLANTEN.length], rit, stop, `0${dock}${lane}${i}-${10 + i}`), seed: dock * 100 + lane * 13 + i });
      r.position.set(lx, 0, z);
      r.rotation.y = Math.PI; // label naar de hal
      scene.add(r);
    }
  };
  fillLane(5, 1, 12, 'RIT 02', 8);
  fillLane(5, 2, 12, 'RIT 02', 5);
  fillLane(5, 3, 5, 'RIT 02', 2);
  fillLane(4, 1, 12, 'RIT 01', 9);
  fillLane(4, 2, 9, 'RIT 01', 5);
  fillLane(7, 1, 7, 'RIT 04', 10);
  fillLane(8, 1, 4, 'RIT 05', 8);
  fillLane(6, 1, 3, 'RIT 03', 2);

  // ---------- Vrachtwagens ----------
  const truckIn = createTruck('in');
  truckIn.group.visible = true;
  truckIn.setDoors(1);
  truckIn.group.position.set(dockX(2), GROUND, FRONT + 0.75);
  truckIn.group.rotation.y = Math.PI / 2;
  scene.add(truckIn.group);
  // lading in de wagen van de leverancier (lokaal: -x is de wagen in)
  {
    const l = new Loads();
    for (let i = 0; i < 5; i++) for (const s of [-0.45, 0.45]) l.pallet(-1.8 - i * 1.25, 0.45, s, 0, 'tray', 6, 1, true, 0);
    l.build(truckIn.group);
  }
  const truckOut = createTruck('out');
  truckOut.group.visible = true;
  truckOut.setDoors(1);
  truckOut.group.position.set(dockX(6), GROUND, FRONT + 0.75);
  truckOut.group.rotation.y = Math.PI / 2;
  scene.add(truckOut.group);
  {
    // tussenschot en temperatuurschermen in de laadruimte
    const F = 0.45;
    part(truckOut.group, UNIT_BOX, STYLE.white, -4.2, F + TRAILER.height / 2, 0).scale.set(0.06, TRAILER.height - 0.05, TRAILER.half * 2 - 0.1);
    for (const [x, t, c] of [[-0.6, '3 °C', 'KOEL'], [-4.4, '-21 °C', 'VRIES']] as const) {
      const d = screen(0.24, 0.13, [c, t], { bg: '#0b0f12', fg: '#5ff08a', px: 1400 });
      const housing = part(truckOut.group, rb(0.28, 0.17, 0.04, 0.01), STYLE.black, x, F + 2.2, -TRAILER.half + 0.03);
      d.position.z = 0.022;
      housing.add(d);
    }
    // vries voorin met hoes, daarna koel
    for (let i = 0; i < 4; i++) {
      const r = createRolco({ cover: true });
      r.position.set(-7.4 + (i % 2) * 0.0, F, -0.45 + (i % 2) * 0.9);
      r.position.x = -7.5 + Math.floor(i / 2) * 0.85;
      r.rotation.y = Math.PI / 2;
      truckOut.group.add(r);
    }
    for (let i = 0; i < 6; i++) {
      const r = createRolco({ fill: 0.8, wrap: true, seed: 900 + i });
      r.position.set(-3.6 + Math.floor(i / 2) * 0.82, F, -0.45 + (i % 2) * 0.9);
      r.rotation.y = Math.PI / 2;
      truckOut.group.add(r);
    }
  }
  const trailer = createParkedTrailer();
  trailer.position.set(30, GROUND, 52);
  trailer.rotation.y = 0.1;
  scene.add(trailer);
  const truck3 = createTruck('in');
  truck3.group.visible = true;
  truck3.group.position.set(16, GROUND, 44);
  truck3.group.rotation.y = Math.PI / 2 + 0.25;
  scene.add(truck3.group);
  // logo op de gevel (verlichte letters)
  {
    const logo = board(14, 2.4, 160, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      g.fillStyle = '#ffffff';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `bold ${Math.round(h * 0.55)}px Arial`;
      g.fillText('Noordkade Vers', w / 2, h * 0.4);
      g.font = `${Math.round(h * 0.2)}px Arial`;
      g.fillText('DISTRIBUTIECENTRUM DRACHTEN', w / 2, h * 0.82);
    });
    (logo.material as THREE.MeshStandardMaterial).transparent = true;
    (logo.material as THREE.MeshStandardMaterial).emissive = new THREE.Color('#ffffff');
    (logo.material as THREE.MeshStandardMaterial).emissiveMap = (logo.material as THREE.MeshStandardMaterial).map;
    (logo.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.9;
    logo.position.set(-14, 7.6, FRONT + 0.135);
    scene.add(logo);
    const band = part(scene, UNIT_BOX, paint('#2f7a4c', 0.7, 0), -14, 7.6, FRONT + 0.13);
    band.scale.set(15, 2.8, 0.01);
  }
  // terreinlampen
  for (const x of [-30, -10, 10, 30]) {
    part(scene, UNIT_BOX, STYLE.dark, x, GROUND + 4, 40).scale.set(0.15, 8, 0.15);
    part(scene, rb(0.7, 0.15, 0.35, 0.04), STYLE.dark, x, GROUND + 8, 39.7);
    const l = new THREE.PointLight('#ffe2b8', 120, 30, 2);
    l.position.set(x, GROUND + 7.7, 39.5);
    scene.add(l);
    const g = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.28), glow('#fff1d8', 3));
    g.rotation.x = Math.PI / 2;
    g.position.set(x, GROUND + 7.92, 39.7);
    scene.add(g);
  }

  // ---------- Acteurs: mensen en voertuigen per fragment ----------
  const person = (x: number, z: number, faceX: number, faceZ: number, only: string[], vest?: string, state: CharacterState = {}, y = 0) => {
    const c = createCharacter(new THREE.Group(), { vest });
    c.group.position.set(x, y, z);
    c.group.rotation.y = Math.atan2(faceX - x, faceZ - z);
    c.update(0, state);
    c.group.traverse((o) => ((o as THREE.Mesh).isMesh && ((o as THREE.Mesh).castShadow = true)));
    actor(c.group, only);
    return c;
  };
  const ORANGE = '#f0590f';
  const LIME = '#c7e01a';

  // F04/F05: lossen aan dock 2, temperatuur meten, label scannen
  {
    const x = dockX(2);
    const jack = createElectricJack();
    jack.setLift(1);
    jack.group.position.set(x, 0, 23.6);
    jack.group.rotation.y = Math.PI;
    const g = new THREE.Group();
    g.add(jack.group);
    const lj = new Loads();
    lj.pallet(x, 0.09, 22.85, Math.PI / 2, 'tray', 6, 1, true, 0);
    lj.build(g);
    actor(g, ['F04']);
    person(x, 24.6, x, 22, ['F04'], ORANGE);
    person(x + 1.5, 21.0, x + 0.8, 21.85, ['F04', 'F05'], LIME, { tool: 'scanner', scan: 1, look: { yaw: 0, pitch: -0.4 } });
  }
  // pallets in de ontvangstbuffer (altijd), een met het grote label voor de close-up
  const buffer: [number, string, number][] = [[1, 'A', 3], [1, 'B', 2], [2, 'A', 2], [2, 'B', 2], [3, 'A', 1]];
  for (const [dock, lane, n] of buffer)
    for (let i = 0; i < n; i++) {
      const x = dockX(dock) + (lane === 'A' ? -0.8 : 0.8);
      const z = 22.3 - 0.75 - i * 1.3;
      loads.pallet(x, 0, z, Math.PI / 2, i % 2 ? 'doos' : 'tray', 5, 1, true);
      const y = board(0.1, 0.07, 1500, (g, w, h) => {
        g.fillStyle = '#ffd21f';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#111';
        g.font = `bold ${Math.round(h * 0.3)}px Arial`;
        g.textBaseline = 'middle';
        g.fillText(`NK${400120 + dock * 10 + i}`, w * 0.06, h * 0.3, w * 0.9);
        for (let k = 0; k < 30; k++) if (k % 3) g.fillRect(w * (0.06 + k * 0.029), h * 0.55, w * 0.015, h * 0.35);
      });
      y.position.set(x + 0.415, 0.9, z);
      y.rotation.y = Math.PI / 2;
      scene.add(y);
    }
  {
    const x = dockX(2) + 0.8;
    const z = 22.3 - 0.75;
    const lbl = palletLabel('387123450004127766', '08712345678906', '03-12-2026', 'L2611A', 'VOLLE YOGHURT 1L  12x');
    lbl.position.set(x + 0.42, 0.95, z + 0.1);
    lbl.rotation.y = Math.PI / 2;
    scene.add(lbl);
  }
  // quarantaine: twee pallets, een met rood etiket
  loads.pallet(-35.15, 0, 22.55, Math.PI / 2, 'doos', 3, 0.5, true);
  loads.pallet(-34.25, 0, 22.55, Math.PI / 2, 'tray', 4, 1, true);
  {
    const red = textBoard(0.3, 0.12, ['GEBLOKKEERD'], '#c8231c', '#ffffff', { px: 1200 });
    red.position.set(-34.25, 0.8, 22.55 - 0.615);
    red.rotation.y = Math.PI;
    scene.add(red);
  }

  // F11: reachtruck in gang 3 zet een pallet op F-06-3-1
  {
    const r = row('F');
    const z = slotZ(r, 6, 1);
    const ax = aisleX(3);
    const t = createReachTruck({
      lift: BEAMS[2] + 0.25,
      reach: 0,
      screen: screen(0.26, 0.18, ['WEGZETTEN', 'NK400131', '-> F-06-3-1', 'SCAN LOCATIE'], { px: 1400 }),
      load: (forks) => {
        const l = new Loads();
        l.pallet(0, 0.06, 0.6, 0, 'doos', 4, 1, true);
        l.build(forks);
      },
    });
    t.position.set(ax + 0.2, 0, z);
    t.rotation.y = Math.PI / 2;
    actor(t, ['F11']);
    const c = person(0, 0, 0, 0, ['F11'], ORANGE, { seated: true, seatHipY: 1.2 });
    c.group.position.set(ax + 0.2 - 0.45, 0, z - 0.32);
    c.group.rotation.y = 0;
    c.update(0, { seated: true, seatHipY: 1.2 });
  }
  // F12: aanvullen D-03-0-1 in gang 2
  {
    const r = row('D');
    const z = slotZ(r, 3, 1);
    const ax = aisleX(2);
    const t = createReachTruck({
      lift: 0.35,
      reach: 1,
      screen: screen(0.26, 0.18, ['AANVULLEN D-03-0-1', 'VAN D-03-2-1', 'THT 21-11-2026', 'RESTDOZEN BOVENOP'], { px: 1400 }),
      load: (forks) => {
        const l = new Loads();
        l.pallet(0, 0.06, 0.6, 0, 'doos', 4, 1, false);
        l.build(forks);
      },
    });
    t.position.set(ax + 0.85, 0, z);
    t.rotation.y = Math.PI / 2;
    actor(t, ['F12']);
    const c = person(0, 0, 0, 0, ['F12'], ORANGE);
    c.group.position.set(ax + 0.85 - 0.45, 0, z - 0.32);
    c.group.rotation.y = 0;
    c.update(0, { seated: true, seatHipY: 1.2 });
  }
  // F15: vriesreachtruck rijdt baan V05 in
  {
    const t = createReachTruck({
      lift: 1.95,
      cabin: true,
      load: (forks) => {
        const l = new Loads();
        l.pallet(0, 0.06, 0.6, Math.PI / 2, 'vries', 5, 1, true, 1);
        l.build(forks);
      },
    });
    t.position.set(laneX(4), 0, 7.6);
    t.rotation.y = Math.PI;
    actor(t, ['F15']);
    const c = person(0, 0, 0, 0, ['F15'], ORANGE, { seated: true, seatHipY: 1.2 });
    c.group.position.set(laneX(4) - 0.32, 0, 7.6 + 0.45);
    c.group.rotation.y = Math.PI / 2;
    c.update(0, { seated: true, seatHipY: 1.2 });
  }
  // F16: kantoor
  person(2.5, 23.3, 1.06, 22.2, ['F16'], '#1e4f9c', { look: { yaw: 0, pitch: 0.1 } });
  // F17/F18/F19: orderpicker in gang 2 bij D-07
  {
    const ax = aisleX(2);
    const zD = slotZ(row('D'), 7, 2);
    const g = new THREE.Group();
    const term = screen(0.27, 0.19, ['GANG 2  D-07-0-2', 'CONTROLE 54', '6 COLLI -> ROLCO 1', 'NOG 23 REGELS'], { px: 1400 });
    const t = createOrderPicker(term);
    g.add(t);
    const label = (klant: string, stop: number) => rolcoLabel(klant, 'RIT 03', stop, `03${stop}1-11`);
    const r1 = createRolco({ fill: 0.35, label: label('SUPERMARKT DE BRINK', 4) });
    r1.position.set(0, 0.06, 0.55 + 0.45);
    r1.rotation.y = Math.PI;
    const r2 = createRolco({ fill: 0.2, label: label('HOTEL DE WADDEN', 5) });
    r2.position.set(0, 0.06, 1.9);
    r2.rotation.y = Math.PI;
    g.add(r1, r2);
    g.position.set(ax + 0.3, 0, zD + 1.6);
    g.rotation.y = Math.PI;
    actor(g, ['F17', 'F18']);
    const c = person(0, 0, 0, 0, ['F17'], LIME, { look: { yaw: -0.6, pitch: 0 } });
    c.group.position.set(ax + 0.3, 0.16, zD + 1.6 + 0.95);
    c.group.rotation.y = Math.PI;
    c.update(0, { look: { yaw: -0.6, pitch: 0 } });
    // F18: de picker staat bij de stelling en pakt dozen
    person(ax + 1.15, zD + 0.25, ax + 3, zD + 0.25, ['F18'], LIME, { carrying: true });
    // F19: dezelfde truck, maar met een THT-melding (los terminalbeeld)
    const g19 = new THREE.Group();
    const t19 = createOrderPicker(screen(0.27, 0.19, ['!THT < 5 DGN', '!NIET PICKEN', '!MELD TL', 'D-05-0-3  14 COLLI'], { px: 1400 }));
    g19.add(t19);
    g19.position.set(ax + 0.3, 0, slotZ(row('D'), 5, 3) + 1.4);
    g19.rotation.y = Math.PI;
    actor(g19, ['F19']);
    const box = new THREE.Group();
    part(box, rb(0.4, 0.26, 0.3, 0.02), new THREE.MeshStandardMaterial({ color: '#c49a6c', roughness: 0.85 }), 0, 0.13, 0);
    const stamp = board(0.2, 0.06, 2400, (g2, w, h) => {
      g2.fillStyle = '#c49a6c';
      g2.fillRect(0, 0, w, h);
      g2.fillStyle = '#1b1b1b';
      g2.font = `bold ${Math.round(h * 0.38)}px Courier New`;
      g2.textBaseline = 'middle';
      g2.fillText('THT 15-11-2026', w * 0.03, h * 0.3, w * 0.94);
      g2.fillText('L2609C  04:12', w * 0.03, h * 0.75, w * 0.94);
    });
    stamp.position.set(0, 0.15, 0.151);
    box.add(stamp);
    box.position.set(ax + 0.15, 1.13, slotZ(row('D'), 5, 3) + 1.4 + 0.3);
    box.rotation.y = 0.25;
    actor(box, ['F19']);
  }
  // F20: rolcontainers met thermohoes vooraan in de vriescel
  for (let i = 0; i < 6; i++) {
    const r = createRolco({ cover: true, label: rolcoLabel(KLANTEN[i], 'RIT 02', 8 - i, `V02${i}-1`) });
    r.position.set(16.0 + i * 0.95, 0, 11.3);
    r.rotation.y = Math.PI;
    scene.add(r);
  }
  {
    const half = createRolco({ fill: 0.9, kind: 'vries', seed: 77 });
    half.position.set(16.0 + 6 * 0.95, 0, 11.3);
    half.rotation.y = Math.PI;
    actor(half, ['F20']);
    const cover = part(new THREE.Group(), rb(ROLCO.w + 0.08, 0.5, ROLCO.d + 0.08, 0.06), STYLE.cover, 0, 0, 0);
    cover.position.set(16.0 + 6 * 0.95, 1.75, 11.3);
    actor(cover, ['F20']);
    person(16.0 + 6 * 0.95 + 0.2, 10.4, 16.0 + 6 * 0.95, 11.3, ['F20'], LIME, { leftHand: { point: new THREE.Vector3(16.0 + 6 * 0.95 - 0.1, 1.6, 10.85) }, rightHand: { point: new THREE.Vector3(16.0 + 6 * 0.95 + 0.25, 1.5, 10.85) } });
  }
  // F21: afmelden op de weegschaal
  {
    const r = createRolco({ fill: 0.85, label: rolcoLabel('SUPERMARKT DE BRINK', 'RIT 05', 3, '0412-07'), seed: 41 });
    r.position.set(1.5, 0.005, 15.0);
    r.rotation.y = Math.PI / 2 + 0.2;
    actor(r, ['F21']);
    person(2.3, 15.9, 1.6, 15.1, ['F21'], LIME, { tool: 'scanner', scan: 1 });
  }
  // F23: laden aan dock 6
  {
    const jack = createElectricJack();
    jack.setLift(1);
    const g = new THREE.Group();
    g.add(jack.group);
    const r = createRolco({ fill: 0.8, wrap: true, seed: 5, label: rolcoLabel('SUPERMARKT ZUIDERWAL', 'RIT 03', 6, '0361-14') });
    r.position.set(0, 0.09, 0.65);
    g.add(r);
    g.position.set(dockX(6), 0, 25.4);
    actor(g, ['F23']);
    person(dockX(6) + 0.15, 24.6, dockX(6), 26, ['F23'], '#e2601a', { tool: 'scanner', scan: 1, leftHand: { point: new THREE.Vector3(dockX(6) - 0.15, 1.05, 24.79) } });
  }
  // F24: leeggoed tellen
  person(-31.5, -6.5, -31.2, -8.5, ['F24'], ORANGE, { tool: 'scanner', look: { yaw: 0, pitch: -0.3 } });
  // F26: tellen in gang 3 bij rij F, met de scanner in beeld
  person(aisleX(3) + 0.6, slotZ(row('F'), 4, 2), aisleX(3) + 3, slotZ(row('F'), 4, 2), ['F26'], ORANGE, { tool: 'scanner', look: { yaw: 0, pitch: -0.5 } });
  const handheld = createHandheld(screen(0.065, 0.085, ['TELLING RIJ F', '14 VAN 36', 'F-04-0-2', 'AANTAL: _'], { px: 6000, title: 'TELLEN' }));
  // F27: rondleider in de dockzone
  person(-6.5, 15.2, -2, 13.2, ['F27'], '#1e4f9c', { look: { yaw: 0, pitch: 0 } });
  // F02: chauffeur bij het loket
  person(2.6, 25.9, 2.6, 25, ['F02', 'F01'], '#e2601a', {}, GROUND);

  loads.build(scene);
  for (const [mat, geos] of paintGeos) {
    const m = new THREE.Mesh(mergeGeometries(geos), mat);
    m.receiveShadow = true;
    m.renderOrder = -1;
    scene.add(m);
  }

  return { actors, handheld, pointLights };
}

export { checkDigit };
