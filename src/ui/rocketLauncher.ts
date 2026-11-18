import * as THREE from 'three';
import { menu } from './menu';
import { STYLE, onTop } from './scene/style';
import { canvasTexture } from './scene/textures';
import type { Solid } from './scene/warehouse';

// Raketwerper (3): schiet het magazijn kapot. De schade is alleen beeld: de sim, de voorraad en de WMS merken er
// niets van. Daardoor is herstellen (menu › Raketwerper) altijd veilig. In multiplayer gaat elke inslag (en het
// herstellen) naar alle spelers (src/ui/multiplayer.ts): iedereen ziet dezelfde schade, en de raket van een ander
// blaast jou op: je begint dan weer op de startplek.
// Zo werkt de schade:
// - alles wat binnen de ontploffing valt verdwijnt van zijn plek: een losse mesh wordt verborgen, een exemplaar van een
//   InstancedMesh krijgt schaal nul, en van een heel grote mesh (de locatielabels samen, de vloerverf) alleen de
//   driehoeken die er helemaal binnen vallen. Wat er stond wordt onthouden, zodat herstellen alles terugzet;
// - wat verdwijnt vliegt als los onderdeel weg (dezelfde vorm en hetzelfde materiaal) en blijft als puin liggen;
// - heel grote onderdelen (vloer, wanden, dak, spanten) blijven staan;
// - mensen, robots en voertuigen (userData.blastUnit) gaan in hun geheel: een mens wordt weggeblazen, een machine
//   valt uit elkaar. De sim rijdt gewoon door; na een paar tellen staan ze er weer, waar de sim ze dan heeft;
// - tekent de eigenaar zijn exemplaren opnieuw (de voorraad in de stellingen), dan wordt de schade er weer overheen gelegd.

interface Options {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /** De werper is gepakt of weggelegd. tool = wat de speler in plaats daarvan pakte (toets 1 of 2), anders null. */
  onChange: (tool: 'scanner' | 'tablet' | null) => void;
  /** Iets wat kapot was (robot, voertuig, mens) is er weer: de aanroeper mag het op een andere plek neerzetten. */
  onRespawn?: (unit: THREE.Object3D) => void;
  /** Een eigen raket is ingeslagen: de andere spelers moeten dezelfde inslag zien. */
  onExplode?: (x: number, y: number, z: number) => void;
  /** De speler heeft het magazijn hersteld: dat geldt voor iedereen. */
  onRestore?: () => void;
  /** Waar de speler zelf staat (voeten): de raket van een ander kan hem opblazen. */
  self?: () => THREE.Vector3;
  /** De speler is opgeblazen door de raket van `by`: de aanroeper zet hem terug op de startplek. */
  onKilled?: (by: string) => void;
}

/** Straal van een ontploffing (m). */
const BLAST = 4.5;
/** Onderdelen met een grotere straal dan dit (m) blijven staan: vloer, wanden, dak, spanten. */
const MAX_SIZE = 7;
const SPEED = 60;
const RANGE = 160;
const COOLDOWN = 0.7;
const GRAVITY = 18;
/** Zoveel losse stukken puin liggen er hooguit; de oudste verdwijnen. */
const MAX_DEBRIS = 600;
const DEBRIS_PER_BLAST = 190;
const PARTS_PER_MACHINE = 45;
/** Na zoveel seconden is een mens, robot of voertuig er weer. */
const RESPAWN = 7;
/** Een mens is er sneller weer: een opgeblazen speler loopt intussen al rond vanaf de startplek. */
const PERSON_RESPAWN = 3;
/** Wat bóven de inslag hangt telt zijn hoogte maar half mee: van een geraakte stelling stort ook de rest erboven in. */
const ABOVE = 0.5;
/** Afstand van de inslag tot een punt, met die regel. */
const reach = (p: THREE.Vector3, x: number, y: number, z: number) => Math.hypot(x - p.x, (y - p.y) * (y > p.y ? ABOVE : 1), z - p.z);

type Zone = { p: THREE.Vector3; r: number };
type Puff = { mesh: THREE.Mesh; vel: THREE.Vector3; age: number; life: number; size: number; gravity: number };
/** Een los stuk dat wegvliegt, stuitert en blijft liggen. state: 0 = vliegt, 1 = gaat liggen, 2 = ligt. */
type Debris = { pivot: THREE.Group; vel: THREE.Vector3; axis: THREE.Vector3; spin: number; thin: THREE.Vector3; rest: number; state: 0 | 1 | 2; flat: THREE.Quaternion; settle: number };
type Rocket = { group: THREE.Group; dir: THREE.Vector3; left: number; smoke: number };
type Piece = { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; matrix: THREE.Matrix4; size: number };
type Ring = { mesh: THREE.Mesh; age: number };
type Fire = { at: THREE.Vector3; left: number; size: number; flame: number; fume: number };
type Dead = { scale: THREE.Vector3; until: number; body?: Debris };

export function createRocketLauncher({ scene, camera, canvas, onChange, onRespawn, onExplode, onRestore, self, onKilled }: Options) {
  /** Alles wat de werper zelf in de scène zet (raketten, rook, puin, schroeiplekken): dat schiet je niet kapot. */
  const fx = new THREE.Group();
  fx.userData.noBlast = true;
  scene.add(fx);

  const glow = (r: number, g: number, b: number) => {
    const m = new THREE.MeshBasicMaterial();
    m.color.setRGB(r, g, b); // feller dan wit: gloeit op in de nabewerking
    return m;
  };
  const fire = glow(7, 2.6, 0.5);
  const hot = glow(14, 10, 5);
  const ember = glow(9, 4.5, 0.9);
  const smoke = new THREE.MeshStandardMaterial({ color: '#4c4f53', roughness: 1, transparent: true, opacity: 0.5, depthWrite: false });
  const soot = new THREE.MeshStandardMaterial({ color: '#1d1e20', roughness: 1, transparent: true, opacity: 0.62, depthWrite: false });
  const BALL = new THREE.IcosahedronGeometry(1, 3);
  const RING = new THREE.RingGeometry(0.8, 1, 56).rotateX(-Math.PI / 2);

  // ---------- De werper in je handen (first person) ----------
  const rig = new THREE.Group();
  rig.visible = false;
  camera.add(rig);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.046, 0.13, 20).rotateX(-Math.PI / 2), STYLE.paint);
  {
    const part = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.frustumCulled = false;
      rig.add(m);
      return m;
    };
    const along = (top: number, bottom: number, len: number) => new THREE.CylinderGeometry(top, bottom, len, 24).rotateX(Math.PI / 2); // as langs z, `top` achter
    part(along(0.055, 0.055, 0.9), STYLE.dark, 0, 0, -0.1);
    part(along(0.066, 0.066, 0.06), STYLE.black, 0, 0, -0.55);
    part(along(0.066, 0.066, 0.04), STYLE.black, 0, 0, -0.05);
    part(along(0.085, 0.055, 0.14), STYLE.black, 0, 0, 0.4);
    part(new THREE.BoxGeometry(0.034, 0.11, 0.045), STYLE.black, 0, -0.1, -0.2).rotation.x = 0.2;
    part(new THREE.BoxGeometry(0.034, 0.09, 0.04), STYLE.black, 0, -0.095, -0.4);
    part(new THREE.BoxGeometry(0.012, 0.05, 0.012), STYLE.steel, 0, 0.078, -0.5);
    part(new THREE.BoxGeometry(0.03, 0.045, 0.03), STYLE.steel, 0, 0.076, -0.12);
    tip.position.set(0, 0, -0.6);
    tip.frustumCulled = false;
    rig.add(tip);
    // handschoen en mouw: dezelfde als bij de scanner
    const glove = new THREE.MeshStandardMaterial({ color: '#4a4d52', roughness: 0.92 });
    const sleeve = new THREE.MeshStandardMaterial({ color: '#ee5a12', roughness: 0.85 });
    part(new THREE.SphereGeometry(1, 20, 14), glove, 0.004, -0.11, -0.19).scale.set(0.04, 0.055, 0.045);
    const arm = part(new THREE.CylinderGeometry(0.036, 0.05, 0.42, 16), sleeve, 0.04, -0.27, -0.02);
    arm.rotation.set(-0.85, 0, -0.18);
  }

  const crosshair = document.createElement('div');
  crosshair.style.cssText =
    'position:fixed;left:50%;top:50%;width:22px;height:22px;margin:-12px 0 0 -12px;border:2px solid rgba(255,255,255,.8);border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.5);pointer-events:none;display:none';
  crosshair.innerHTML = '<div style="position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;border-radius:50%;background:#ff5a36"></div>';
  document.body.appendChild(crosshair);

  // ---------- Toestand ----------
  let equipped = false;
  let allowed = false; // te voet in first person, met je handen vrij
  let raise = 0;
  let cooldown = 0;
  let kick = 0;
  let shake = 0;
  let clock = 0;
  const rockets: Rocket[] = [];
  const puffs: Puff[] = [];
  const debris: Debris[] = [];
  const rings: Ring[] = [];
  const fires: Fire[] = [];
  const scorches: THREE.Mesh[] = [];

  // ---------- Schade ----------
  const zones: Zone[] = [];
  /** Per InstancedMesh: de exemplaren die weg zijn (hun eigen matrix), en de versie van de matrices na onze laatste ingreep. */
  const instanced = new Map<THREE.InstancedMesh, { saved: Map<number, THREE.Matrix4>; version: number }>();
  const hidden: THREE.Mesh[] = [];
  /** Per geometrie de weggehaalde driehoeken: [plek in de index, tweede hoek, derde hoek, ...]. */
  const cuts = new Map<THREE.BufferGeometry, number[]>();
  /** Mensen, robots en voertuigen die kapot zijn: tot ze terugkomen zijn ze onzichtbaar klein gemaakt. */
  const dead = new Map<THREE.Object3D, Dead>();
  let shots = 0;

  const GONE = new THREE.Matrix4().makeScale(0, 0, 0).setPosition(0, -500, 0);
  const isGone = (m: THREE.Matrix4) => m.elements[0] === 0 && m.elements[5] === 0 && m.elements[10] === 0 && m.elements[13] === -500;
  const own = new THREE.Matrix4();
  const world = new THREE.Matrix4();
  const inv = new THREE.Matrix4();
  const center = new THREE.Vector3();
  const near = new THREE.Vector3();
  const local = new THREE.Vector3();
  const box = new THREE.Box3();

  /** Valt een onderdeel (geometrie met wereldmatrix `world`) binnen de ontploffing? Het midden komt in `center`. */
  function hit(geo: THREE.BufferGeometry, p: THREE.Vector3, r: number) {
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    if (!geo.boundingBox) geo.computeBoundingBox();
    const radius = geo.boundingSphere!.radius * world.getMaxScaleOnAxis();
    center.copy(geo.boundingSphere!.center).applyMatrix4(world);
    if (radius > MAX_SIZE || center.distanceTo(p) > r / ABOVE + radius) return 0;
    // precies: het dichtstbijzijnde punt van de doos om het onderdeel
    local.copy(p).applyMatrix4(inv.copy(world).invert());
    geo.boundingBox!.clampPoint(local, near).applyMatrix4(world);
    return reach(p, near.x, near.y, near.z) <= r ? Math.max(radius, 0.01) : 0;
  }
  /** Vliegt dit als puin weg? Folie en glas niet: die zijn er gewoon niet meer. */
  const solidLook = (m: THREE.Material | THREE.Material[]) => {
    const one = Array.isArray(m) ? m[0] : m;
    return !(one.transparent && one.opacity < 0.6);
  };

  function blastInstances(mesh: THREE.InstancedMesh, p: THREE.Vector3, r: number, pieces?: Piece[]) {
    let rec = instanced.get(mesh);
    if (!rec) instanced.set(mesh, (rec = { saved: new Map(), version: mesh.instanceMatrix.version }));
    const flies = pieces && solidLook(mesh.material);
    let changed = false;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, own);
      if (isGone(own)) continue;
      world.multiplyMatrices(mesh.matrixWorld, own);
      const size = hit(mesh.geometry, p, r);
      if (!size) continue;
      rec.saved.set(i, own.clone());
      mesh.setMatrixAt(i, GONE);
      changed = true;
      if (flies) pieces.push({ geometry: mesh.geometry, material: mesh.material, matrix: world.clone(), size });
    }
    if (changed) mesh.instanceMatrix.needsUpdate = true;
    rec.version = mesh.instanceMatrix.version;
  }

  function blastMesh(mesh: THREE.Mesh, p: THREE.Vector3, r: number, pieces: Piece[]) {
    const geo = mesh.geometry;
    if (!geo.attributes.position) return;
    world.copy(mesh.matrixWorld);
    const size = hit(geo, p, r);
    if (size) {
      mesh.visible = false;
      hidden.push(mesh);
      if (solidLook(mesh.material)) pieces.push({ geometry: geo, material: mesh.material, matrix: world.clone(), size });
      return;
    }
    // Een heel grote mesh blijft staan; alleen kleine vlakken die er helemaal binnen vallen gaan eruit
    // (een locatielabel, een stukje vloerverf).
    const index = geo.index;
    const radius = geo.boundingSphere!.radius * world.getMaxScaleOnAxis();
    if (!index || index.count > 600_000 || radius <= MAX_SIZE || center.distanceTo(p) > r / ABOVE + radius) return;
    const pos = geo.attributes.position;
    const inside = (v: number) => {
      local.fromBufferAttribute(pos, v).applyMatrix4(world);
      return reach(p, local.x, local.y, local.z) <= r;
    };
    const list = cuts.get(geo) ?? [];
    const before = list.length;
    for (let t = 0; t + 2 < index.count; t += 3) {
      const a = index.getX(t);
      const b = index.getX(t + 1);
      const c = index.getX(t + 2);
      if (a === b || !inside(a) || !inside(b) || !inside(c)) continue;
      list.push(t, b, c);
      index.setX(t + 1, a); // drie keer dezelfde hoek: de driehoek wordt niet meer getekend
      index.setX(t + 2, a);
    }
    if (list.length === before) return;
    cuts.set(geo, list);
    index.needsUpdate = true;
  }

  // ---------- Puin: losse stukken die wegvliegen, stuiteren en blijven liggen ----------
  const UP = new THREE.Vector3(0, 1, 0);
  const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  const dPos = new THREE.Vector3();
  const dQuat = new THREE.Quaternion();
  const dScale = new THREE.Vector3();
  const dSize = new THREE.Vector3();
  const qStep = new THREE.Quaternion();
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  const scatter = (speed: number) => new THREE.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize().multiplyScalar(speed);

  /**
   * Zet een voorwerp (met wereldmatrix `matrix`) als puin in de lucht, weggeslagen vanaf de inslag `p`.
   * @param half halve maten langs zijn eigen assen: op de dunste kant komt het te liggen.
   */
  function launch(object: THREE.Object3D, matrix: THREE.Matrix4, at: THREE.Vector3, half: THREE.Vector3, p: THREE.Vector3, r: number) {
    const pivot = new THREE.Group(); // draait om het midden van het stuk
    pivot.position.copy(at);
    object.matrixAutoUpdate = false;
    object.matrix.copy(matrix).premultiply(own.makeTranslation(-at.x, -at.y, -at.z));
    pivot.add(object);
    fx.add(pivot);
    matrix.decompose(dPos, dQuat, dScale);
    const i = half.x <= half.y && half.x <= half.z ? 0 : half.y <= half.z ? 1 : 2;
    const size = Math.max(half.x, half.y, half.z);
    const d = reach(p, at.x, at.y, at.z);
    const vel = at.clone().sub(p);
    vel.y = Math.abs(vel.y) * 0.5 + 0.4;
    // dichter bij de inslag en lichter = harder weg
    vel.normalize().multiplyScalar((rnd(5, 9) + 9 * Math.max(0, 1 - d / r)) / (1 + size * 0.35));
    vel.y += rnd(2, 6) / (1 + size * 0.2);
    const piece: Debris = { pivot, vel, axis: scatter(1), spin: rnd(2, 9) / (1 + size), thin: AXES[i].clone().applyQuaternion(dQuat), rest: Math.max(half.getComponent(i), 0.01), state: 0, flat: new THREE.Quaternion(), settle: 0 };
    debris.push(piece);
    return piece;
  }
  function removeDebris(d: Debris) {
    fx.remove(d.pivot);
    const i = debris.indexOf(d);
    if (i >= 0) debris.splice(i, 1);
  }
  /** Eén onderdeel (geometrie, materiaal, wereldmatrix) als los stuk puin. */
  function throwPiece(piece: Piece, p: THREE.Vector3, r: number) {
    const geo = piece.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const mesh = new THREE.Mesh(geo, piece.material);
    mesh.castShadow = mesh.receiveShadow = true;
    piece.matrix.decompose(dPos, dQuat, dScale);
    geo.boundingBox!.getSize(dSize).multiply(dScale).multiplyScalar(0.5);
    dSize.set(Math.abs(dSize.x), Math.abs(dSize.y), Math.abs(dSize.z));
    geo.boundingBox!.getCenter(center).applyMatrix4(piece.matrix);
    launch(mesh, piece.matrix, center, dSize, p, r);
  }

  // ---------- Mensen, robots en voertuigen ----------
  function blastUnit(unit: THREE.Object3D, kind: unknown, p: THREE.Vector3, r: number) {
    if (dead.has(unit)) return;
    box.setFromObject(unit);
    if (box.isEmpty()) return;
    box.clampPoint(p, near);
    if (reach(p, near.x, near.y, near.z) > r) return;
    const entry: Dead = { scale: unit.scale.clone(), until: clock + (kind === 'person' ? PERSON_RESPAWN : RESPAWN) };
    if (kind === 'person') {
      // Een mens vliegt in zijn geheel weg en blijft liggen tot hij terugkomt
      const body = unit.clone(true);
      body.traverse((o) => {
        if ((o as THREE.Sprite).isSprite) o.visible = false; // naamlabel
      });
      body.userData.blastUnit = undefined;
      center.setFromMatrixPosition(unit.matrixWorld);
      center.y += 0.9;
      entry.body = launch(body, unit.matrixWorld, center, dSize.set(0.28, 0.9, 0.16), p, r);
      entry.body.vel.y += 3;
    } else {
      // Een machine valt uit elkaar: elk onderdeel vliegt los weg
      const parts: Piece[] = [];
      const collect = (o: THREE.Object3D) => {
        if (!o.visible) return;
        const mesh = o as THREE.InstancedMesh;
        if (mesh.isMesh && !mesh.isInstancedMesh && mesh.geometry.attributes.position && solidLook(mesh.material)) {
          if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
          parts.push({ geometry: mesh.geometry, material: mesh.material, matrix: mesh.matrixWorld.clone(), size: mesh.geometry.boundingSphere!.radius * mesh.matrixWorld.getMaxScaleOnAxis() });
        }
        for (const child of o.children) collect(child);
      };
      collect(unit);
      parts.sort((a, b) => b.size - a.size); // de grote onderdelen eerst: daar herken je het wrak aan
      for (const part of parts.slice(0, PARTS_PER_MACHINE)) throwPiece(part, p, r);
      box.getCenter(center);
      for (let i = 0; i < 6; i++) puff(fire, center, scatter(rnd(2, 6)), rnd(0.3, 0.7), rnd(0.25, 0.5));
      burn(center.clone().setY(Math.max(0.1, box.min.y + 0.1)), rnd(4, 7), 0.8);
    }
    dead.set(unit, entry);
    unit.scale.setScalar(1e-4); // de eigenaar blijft het gewoon verplaatsen; je ziet het alleen niet
  }
  function respawn(unit: THREE.Object3D, entry: Dead, quiet = false) {
    dead.delete(unit);
    unit.scale.copy(entry.scale);
    if (entry.body) removeDebris(entry.body);
    onRespawn?.(unit);
    if (quiet || !unit.visible) return;
    unit.updateWorldMatrix(true, false);
    center.setFromMatrixPosition(unit.matrixWorld);
    for (let i = 0; i < 7; i++) {
      const vel = scatter(1.6);
      vel.y = Math.abs(vel.y) * 0.5;
      puff(smoke, center.clone().setY(center.y + rnd(0.2, 1.2)), vel, rnd(0.4, 0.8), rnd(0.5, 0.9));
    }
  }

  /** @param spare dit blijft heel (de schutter zelf), of 'units': mensen, robots en voertuigen blijven allemaal heel */
  function destroy(p: THREE.Vector3, r: number, spare?: THREE.Object3D | 'units') {
    const pieces: Piece[] = [];
    const walk = (o: THREE.Object3D) => {
      if (!o.visible || o.userData.noBlast || o === camera) return;
      if (o.userData.blastUnit) return spare === 'units' || o === spare ? undefined : blastUnit(o, o.userData.blastUnit, p, r);
      const mesh = o as THREE.InstancedMesh;
      if (mesh.isInstancedMesh) blastInstances(mesh, p, r, pieces);
      else if (mesh.isMesh) blastMesh(mesh, p, r, pieces);
      if (o.visible) for (const child of o.children) walk(child);
    };
    walk(scene);
    return pieces;
  }

  /** Heeft de eigenaar zijn exemplaren opnieuw getekend (voorraad, lege pallets), dan gaat de schade er weer overheen. */
  function keepDestroyed() {
    for (const [mesh, rec] of instanced) {
      if (mesh.instanceMatrix.version === rec.version) continue;
      for (const i of [...rec.saved.keys()]) {
        if (i >= mesh.instanceMatrix.count) continue;
        mesh.getMatrixAt(i, own);
        if (!isGone(own)) rec.saved.delete(i); // opnieuw getekend: wat we bewaarden klopt niet meer
      }
      for (const z of zones) blastInstances(mesh, z.p, z.r);
    }
  }

  /** @param remote een andere speler herstelde: niet nog eens rondsturen */
  function restore(remote = false) {
    if (!remote && shots) onRestore?.();
    seen.clear();
    for (const [mesh, rec] of instanced) {
      for (const [i, m] of rec.saved) {
        if (i >= mesh.instanceMatrix.count) continue;
        mesh.getMatrixAt(i, own);
        if (isGone(own)) mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
    instanced.clear();
    for (const m of hidden) m.visible = true;
    hidden.length = 0;
    for (const [geo, list] of cuts) {
      const index = geo.index!;
      for (let k = 0; k < list.length; k += 3) {
        index.setX(list[k] + 1, list[k + 1]);
        index.setX(list[k] + 2, list[k + 2]);
      }
      index.needsUpdate = true;
    }
    cuts.clear();
    zones.length = 0;
    for (const [unit, entry] of [...dead]) respawn(unit, entry, true);
    for (const d of debris) fx.remove(d.pivot);
    debris.length = 0;
    for (const s of scorches) fx.remove(s);
    scorches.length = 0;
    fires.length = 0;
    shots = 0;
    passFrom = null;
    refreshPanel();
  }

  // ---------- Waar je doorheen loopt: wat weg is houdt je niet meer tegen ----------
  let passFrom: Solid[] | null = null;
  let passZones = 0;
  let passOut: Solid[] = [];
  function passable(list: Solid[]) {
    if (!zones.length) return list;
    if (list === passFrom && passZones === zones.length) return passOut;
    passFrom = list;
    passZones = zones.length;
    passOut = list.filter((s) => {
      if (s.pose || s.maxX - s.minX > MAX_SIZE || s.maxZ - s.minZ > MAX_SIZE) return true;
      return !zones.some(
        (z) => reach(z.p, THREE.MathUtils.clamp(z.p.x, s.minX, s.maxX), THREE.MathUtils.clamp(z.p.y, s.minY, s.maxY), THREE.MathUtils.clamp(z.p.z, s.minZ, s.maxZ)) <= z.r,
      );
    });
    return passOut;
  }

  // ---------- Rook, vuur en vonken ----------
  /** @param gravity valt (vonken) of stijgt op eigen snelheid (0) */
  function puff(material: THREE.Material, at: THREE.Vector3, vel: THREE.Vector3, size: number, life: number, gravity = 0) {
    const mesh = new THREE.Mesh(BALL, material);
    mesh.position.copy(at);
    mesh.scale.setScalar(0.001);
    mesh.userData.noAO = true; // geen omgevingsschaduw van rook en vuur (zie main.ts)
    fx.add(mesh);
    puffs.push({ mesh, vel, age: 0, life, size, gravity });
  }
  /** Een brandje dat een tijd nasmeult: vlammen en een rookpluim. */
  function burn(at: THREE.Vector3, seconds: number, size: number) {
    fires.push({ at, left: seconds, size, flame: 0, fume: 0 });
    if (fires.length > 14) fires.shift();
  }

  const scorchMat = onTop(
    new THREE.MeshStandardMaterial({
      map: canvasTexture(256, 256, (g, w, h) => {
        const blot = (x: number, y: number, r: number, alpha: number) => {
          const grad = g.createRadialGradient(x, y, 0, x, y, r);
          grad.addColorStop(0, `rgba(14,13,12,${alpha})`);
          grad.addColorStop(1, 'rgba(14,13,12,0)');
          g.fillStyle = grad;
          g.fillRect(0, 0, w, h);
        };
        blot(w / 2, h / 2, w / 2, 0.9);
        for (let i = 0; i < 26; i++) {
          const a = (i / 26) * Math.PI * 2;
          const d = w * (0.18 + ((i * 7) % 5) * 0.04);
          blot(w / 2 + Math.cos(a) * d, h / 2 + Math.sin(a) * d, w * 0.14, 0.55);
        }
      }),
      transparent: true,
      depthWrite: false,
      roughness: 1,
    }),
    3, // boven de vloerverf (+1) en de baanvlakken (+2)
  );
  const scorchGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

  /** Inslagen die al verwerkt zijn (op 10 cm): dezelfde inslag komt soms twee keer binnen. */
  const seen = new Set<string>();
  function scorch(p: THREE.Vector3) {
    const mark = new THREE.Mesh(scorchGeo, scorchMat);
    mark.position.set(p.x, 0.005, p.z);
    mark.rotation.y = rnd(0, 6);
    mark.scale.setScalar(BLAST * rnd(1.6, 2.1));
    mark.receiveShadow = true;
    fx.add(mark);
    scorches.push(mark);
  }
  /**
   * Een inslag. Zonder `from` is het een eigen raket; die gaat ook naar de andere spelers.
   * @param from by = naam van de speler die schoot, spare = zijn figuur (zijn eigen raket doet hem niets);
   *             quiet = schade van eerder (voor wie later binnenkomt): alleen het gat, zonder knal en puin.
   */
  function explode(p: THREE.Vector3, from?: { by?: string; spare?: THREE.Object3D; quiet?: boolean }) {
    const key = `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`;
    if (seen.has(key)) return;
    seen.add(key);
    shots++;
    zones.push({ p: p.clone(), r: BLAST });
    if (from?.quiet) {
      destroy(p, BLAST, 'units');
      if (p.y < 2.2) scorch(p);
      passFrom = null;
      refreshPanel();
      return;
    }
    if (!from) onExplode?.(+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2));
    else if (self && onKilled) {
      // de raket van een ander: sta je erin, dan ben je er geweest
      const me = self();
      if (reach(p, me.x, THREE.MathUtils.clamp(p.y, me.y, me.y + 1.8), me.z) <= BLAST * 0.8) killed(from.by ?? 'iemand');
    }
    const pieces = destroy(p, BLAST, from?.spare);
    // Puin: de grote stukken (staanders, liggers, pallets) allemaal, van de rest (dozen) een greep
    pieces.sort((a, b) => b.size - a.size);
    const big = pieces.findIndex((piece) => piece.size < 0.55);
    const keep = pieces.splice(0, Math.min(big < 0 ? pieces.length : big, Math.round(DEBRIS_PER_BLAST * 0.55)));
    while (keep.length < DEBRIS_PER_BLAST && pieces.length) keep.push(pieces.splice(Math.floor(Math.random() * pieces.length), 1)[0]);
    for (const piece of keep) throwPiece(piece, p, BLAST);
    // te veel puin: de oudste stukken die al liggen gaan weg (een lichaam blijft tot de mens terug is)
    const bodies = new Set([...dead.values()].map((d) => d.body));
    for (let i = 0; debris.length > MAX_DEBRIS && i < debris.length; ) {
      if (bodies.has(debris[i])) i++;
      else removeDebris(debris[i]);
    }

    // Vuurbal: witheet hart, oranje bol, uitwaaierende vlammen, vonken, en een zwarte rookwolk die blijft hangen
    const still = new THREE.Vector3();
    puff(hot, p, still.clone(), BLAST * 0.5, 0.26);
    puff(fire, p, still.clone(), BLAST * 0.95, 0.5);
    for (let i = 0; i < 16; i++) puff(fire, p, scatter(rnd(5, 14)), rnd(0.5, 1.3), rnd(0.3, 0.65));
    for (let i = 0; i < 34; i++) {
      const vel = scatter(rnd(7, 20));
      vel.y = Math.abs(vel.y) + rnd(1, 5);
      puff(ember, p, vel, rnd(0.04, 0.1), rnd(0.7, 1.5), 14);
    }
    for (let i = 0; i < 18; i++) {
      const vel = scatter(rnd(1.5, 5));
      vel.y = Math.abs(vel.y) * 0.8 + rnd(0.8, 2.4);
      puff(i % 3 ? soot : smoke, p, vel, rnd(1.3, 3), rnd(2.5, 5.5));
    }
    // Drukgolf over de vloer
    const ring = new THREE.Mesh(RING, onTop(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), 4));
    (ring.material as THREE.MeshBasicMaterial).color.setRGB(2.4, 1.8, 1.2);
    ring.position.set(p.x, Math.max(0.03, Math.min(p.y, 0.5)), p.z);
    ring.userData.noAO = true;
    fx.add(ring);
    rings.push({ mesh: ring, age: 0 });
    // Wat er lag blijft nabranden
    const ground = p.y < 2.5 ? 0.1 : p.y;
    burn(new THREE.Vector3(p.x, ground, p.z), rnd(6, 9), 1.2);
    for (let i = 0; i < 3; i++) burn(new THREE.Vector3(p.x + rnd(-3, 3), 0.1, p.z + rnd(-3, 3)), rnd(4, 10), rnd(0.5, 0.9));

    if (p.y < 2.2) scorch(p);
    const d = camera.getWorldPosition(center).distanceTo(p);
    shake = Math.max(shake, THREE.MathUtils.clamp(1.5 - d / 35, 0, 1));
    sound('boom', THREE.MathUtils.clamp(1.15 - d / 90, 0.15, 1));
    refreshPanel();
  }

  // ---------- Opgeblazen: even een rood scherm, en terug naar de startplek ----------
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:55;display:flex;align-items:center;justify-content:center;pointer-events:none;opacity:0;background:radial-gradient(circle,rgba(150,20,10,.35),rgba(90,0,0,.8));color:#fff;font:700 34px system-ui,sans-serif;text-shadow:0 2px 8px #000;text-align:center';
  document.body.appendChild(overlay);
  function killed(by: string) {
    overlay.textContent = `Opgeblazen door ${by}`;
    overlay.style.transition = 'none';
    overlay.style.opacity = '1';
    void overlay.offsetWidth; // de overgang hieronder begint pas na dit beeld
    overlay.style.transition = 'opacity 2.2s ease-in 0.6s';
    overlay.style.opacity = '0';
    onKilled?.(by);
  }

  // ---------- Geluid: ter plekke opgewekt, net als de rest van de game ----------
  let audio: AudioContext | null = null;
  let noise: AudioBuffer | null = null;
  function sound(kind: 'launch' | 'boom', level = 1) {
    try {
      audio ??= new AudioContext();
      if (audio.state === 'suspended') void audio.resume();
      if (!noise) {
        noise = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
        const data = noise.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      const t = audio.currentTime;
      const src = audio.createBufferSource();
      src.buffer = noise;
      const filter = audio.createBiquadFilter();
      const gain = audio.createGain();
      src.connect(filter).connect(gain).connect(audio.destination);
      if (kind === 'launch') {
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(1400, t);
        filter.frequency.exponentialRampToValueAtTime(260, t + 0.5);
        gain.gain.setValueAtTime(0.22, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
        src.start(t);
        src.stop(t + 0.6);
      } else {
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1100, t);
        filter.frequency.exponentialRampToValueAtTime(70, t + 1.2);
        gain.gain.setValueAtTime(0.55 * level, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
        src.start(t);
        src.stop(t + 1.6);
        const thump = audio.createOscillator();
        const thumpGain = audio.createGain();
        thump.frequency.setValueAtTime(95, t);
        thump.frequency.exponentialRampToValueAtTime(28, t + 0.5);
        thumpGain.gain.setValueAtTime(0.5 * level, t);
        thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
        thump.connect(thumpGain).connect(audio.destination);
        thump.start(t);
        thump.stop(t + 0.65);
      }
    } catch {
      // geen geluid beschikbaar: stil doorgaan
    }
  }

  // ---------- Vuren ----------
  const raycaster = new THREE.Raycaster();
  const camPos = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const FORWARD = new THREE.Vector3(0, 0, 1);

  function buildRocket() {
    const g = new THREE.Group(); // voorkant naar +Z
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.42, 16).rotateX(Math.PI / 2), STYLE.dark);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.046, 0.14, 16).rotateX(Math.PI / 2), STYLE.paint);
    nose.position.z = 0.28;
    g.add(body, nose);
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.09, 0.1), STYLE.steel);
      fin.position.set(Math.sin((i * Math.PI) / 2) * 0.07, Math.cos((i * Math.PI) / 2) * 0.07, -0.17);
      fin.rotation.z = (-i * Math.PI) / 2;
      g.add(fin);
    }
    const flame = new THREE.Mesh(BALL, hot);
    flame.scale.set(0.06, 0.06, 0.24);
    flame.position.z = -0.36;
    flame.userData.noAO = true;
    g.add(flame);
    g.traverse((o) => (o.castShadow = o !== flame));
    return g;
  }

  function shoot() {
    if (cooldown > 0) return;
    cooldown = COOLDOWN;
    kick = 1;
    camera.getWorldPosition(camPos);
    camera.getWorldDirection(camDir);
    // Waar de raket inslaat: het eerste wat je in het vizier hebt
    raycaster.set(camPos, camDir);
    raycaster.far = RANGE;
    raycaster.camera = camera; // verplicht zodra er sprites (naam- en taaklabels) in de scène staan
    const target = camPos.clone().addScaledVector(camDir, RANGE);
    for (const h of raycaster.intersectObject(scene, true)) {
      if ((h.object as THREE.Sprite).isSprite) continue;
      let o: THREE.Object3D | null = h.object;
      let skip = false;
      for (; o; o = o.parent) if (!o.visible || o === camera || o === fx || o.userData.noBlast) skip = true; // eigen handen en lichaam, verborgen dingen, eigen rook en puin
      if (skip) continue;
      target.copy(h.point).addScaledVector(camDir, -0.05);
      break;
    }
    const group = buildRocket();
    rig.updateWorldMatrix(true, false);
    group.position.copy(rig.localToWorld(new THREE.Vector3(0, 0, -0.62)));
    const dir = target.clone().sub(group.position);
    const left = dir.length();
    dir.normalize();
    group.quaternion.setFromUnitVectors(FORWARD, dir);
    fx.add(group);
    rockets.push({ group, dir, left, smoke: 0 });
    for (let i = 0; i < 6; i++) puff(smoke, camPos.clone().addScaledVector(camDir, -0.6), scatter(1.2).addScaledVector(camDir, -3), rnd(0.25, 0.5), rnd(0.5, 1));
    sound('launch');
  }

  const active = () => equipped && allowed;
  canvas.addEventListener('mousedown', (e) => {
    // alleen met de muis vastgezet: de klik waarmee je de muis vastzet vuurt nog niet
    if (e.button === 0 && active() && document.pointerLockElement === canvas) shoot();
  });
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.repeat || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    if (e.code === 'Digit3' || e.code === 'Numpad3') setEquipped(!equipped);
    else if (equipped && (e.code === 'Digit1' || e.code === 'Numpad1')) setEquipped(false, 'scanner');
    else if (equipped && (e.code === 'Digit2' || e.code === 'Numpad2')) setEquipped(false, 'tablet');
  });
  function setEquipped(on: boolean, tool: 'scanner' | 'tablet' | null = null) {
    if (on === equipped) return;
    equipped = on;
    refreshPanel();
    onChange(tool);
  }

  // ---------- Menu: pakken en herstellen ----------
  const panel = document.createElement('div');
  panel.innerHTML = `<div><b>3</b>: raketwerper pakken of wegleggen (te voet, in first person) · <b>Klik</b>: vuren · <b>1</b>/<b>2</b>: terug naar scanner of tablet</div>
    <div style="margin-top:6px;color:#9aa0a6">Alles kan kapot: stellingen, voorraad, robots, karren, vrachtwagens en mensen. Robots, voertuigen en mensen komen na een paar tellen vanzelf terug. Iedereen in de kamer ziet dezelfde schade, en de raket van een ander blaast jou op (je begint dan weer op de startplek). Herstellen geldt ook voor iedereen. De schade is alleen beeld: de voorraad en de WMS merken er niets van.</div>
    <div class="state" style="margin-top:10px"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="restore" style="padding:8px 14px;border:0;border-radius:6px;background:#2e7d4f;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer">Magazijn herstellen</button>
      <button class="equip" style="padding:8px 14px;border:0;border-radius:6px;background:#3a4047;color:#fff;font:14px system-ui,sans-serif;cursor:pointer"></button>
    </div>`;
  const stateEl = panel.querySelector<HTMLDivElement>('.state')!;
  const restoreBtn = panel.querySelector<HTMLButtonElement>('.restore')!;
  const equipBtn = panel.querySelector<HTMLButtonElement>('.equip')!;
  function refreshPanel() {
    stateEl.textContent = shots ? `${shots} ${shots === 1 ? 'inslag' : 'inslagen'}: het magazijn is beschadigd.` : 'Het magazijn is heel.';
    restoreBtn.disabled = !shots;
    restoreBtn.style.opacity = shots ? '1' : '0.45';
    restoreBtn.style.cursor = shots ? 'pointer' : 'default';
    equipBtn.textContent = equipped ? 'Raketwerper wegleggen' : 'Raketwerper pakken';
  }
  restoreBtn.addEventListener('click', () => {
    restore(); // geldt voor iedereen in de kamer
    restoreBtn.blur();
  });
  equipBtn.addEventListener('click', () => {
    setEquipped(!equipped);
    equipBtn.blur();
  });
  refreshPanel();
  menu.addSection('rocket', 'Raketwerper', panel, 9);

  const step = new THREE.Vector3();
  function update(dt: number) {
    clock += dt;
    const k = 1 - Math.exp(-dt * 12);
    raise += ((active() ? 1 : 0) - raise) * k;
    cooldown = Math.max(0, cooldown - dt);
    kick = Math.max(0, kick - dt * 5);
    rig.visible = raise > 0.02;
    crosshair.style.display = active() ? 'block' : 'none';
    tip.visible = cooldown < COOLDOWN * 0.45; // herladen: de volgende raket schuift erin
    rig.position.set(0.2, -0.17 - (1 - raise) * 0.5 + kick * 0.012, -0.34 + kick * 0.07);
    rig.rotation.set(kick * 0.09, 0.02, 0);

    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      const d = Math.min(r.left, SPEED * dt);
      r.group.position.addScaledVector(r.dir, d);
      r.left -= d;
      r.smoke += d;
      if (r.smoke > 0.8) {
        r.smoke = 0;
        puff(smoke, r.group.position.clone().addScaledVector(r.dir, -0.4), scatter(0.4), rnd(0.2, 0.36), rnd(0.6, 1.1));
        puff(fire, r.group.position.clone().addScaledVector(r.dir, -0.5), scatter(0.3), rnd(0.1, 0.16), 0.18);
      }
      if (r.left > 1e-4) continue;
      fx.remove(r.group);
      rockets.splice(i, 1);
      explode(r.group.position);
    }

    for (let i = fires.length - 1; i >= 0; i--) {
      const f = fires[i];
      f.left -= dt;
      if (f.left <= 0) {
        fires.splice(i, 1);
        continue;
      }
      const fade = Math.min(1, f.left / 2); // dooft langzaam uit
      for (f.flame += dt * 13; f.flame >= 1; f.flame--)
        puff(Math.random() < 0.25 ? hot : fire, step.set(f.at.x + rnd(-0.4, 0.4) * f.size, f.at.y, f.at.z + rnd(-0.4, 0.4) * f.size).clone(), new THREE.Vector3(rnd(-0.3, 0.3), rnd(1.6, 3.2) * f.size, rnd(-0.3, 0.3)), rnd(0.22, 0.5) * f.size * fade, rnd(0.35, 0.6));
      for (f.fume += dt * 3.5; f.fume >= 1; f.fume--)
        puff(soot, step.set(f.at.x, f.at.y + f.size, f.at.z).clone(), new THREE.Vector3(rnd(-0.4, 0.4), rnd(1.6, 2.6), rnd(-0.4, 0.4)), rnd(0.5, 1.1) * f.size, rnd(2, 3.5));
    }

    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i];
      p.age += dt;
      const t = p.age / p.life;
      if (t >= 1 || (p.gravity && p.mesh.position.y < 0)) {
        fx.remove(p.mesh);
        puffs.splice(i, 1);
        continue;
      }
      p.vel.y -= p.gravity * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(Math.exp(-dt * (p.gravity ? 0.6 : 2.2)));
      p.mesh.scale.setScalar(p.size * (t < 0.25 ? t / 0.25 : 1 - (t - 0.25) / 0.75) + 0.001); // snel opzwellen, langzaam oplossen
    }

    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.age += dt;
      const t = r.age / 0.45;
      if (t >= 1) {
        fx.remove(r.mesh);
        (r.mesh.material as THREE.Material).dispose();
        rings.splice(i, 1);
        continue;
      }
      r.mesh.scale.setScalar(0.5 + BLAST * 2.6 * (1 - (1 - t) ** 2));
      (r.mesh.material as THREE.Material).opacity = 0.8 * (1 - t);
    }

    for (const d of debris) {
      if (d.state === 2) continue;
      const pivot = d.pivot;
      if (d.state === 1) {
        // gaat liggen: op zijn dunste kant, plat op de vloer
        d.settle += dt;
        pivot.quaternion.slerp(d.flat, 1 - Math.exp(-dt * 16));
        pivot.position.y += (d.rest - pivot.position.y) * (1 - Math.exp(-dt * 16));
        if (d.settle > 0.45) {
          pivot.quaternion.copy(d.flat);
          pivot.position.y = d.rest;
          d.state = 2;
        }
        continue;
      }
      d.vel.y -= GRAVITY * dt;
      pivot.position.addScaledVector(d.vel, dt);
      pivot.quaternion.premultiply(qStep.setFromAxisAngle(d.axis, d.spin * dt));
      if (pivot.position.y > d.rest || d.vel.y > 0) continue;
      pivot.position.y = d.rest;
      if (Math.abs(d.vel.y) < 2.4) {
        d.state = 1;
        local.copy(d.thin).applyQuaternion(pivot.quaternion);
        d.flat.setFromUnitVectors(local, local.y >= 0 ? UP : step.set(0, -1, 0)).multiply(pivot.quaternion);
      } else {
        d.vel.y *= -0.32;
        d.vel.x *= 0.6;
        d.vel.z *= 0.6;
        d.spin *= 0.6;
      }
    }

    for (const [unit, entry] of dead) if (clock >= entry.until) respawn(unit, entry);
    if (zones.length) keepDestroyed();

    // De klap voel je: de camera schudt even (alleen te voet in first person; daar wordt hij elk beeld opnieuw gezet)
    shake = Math.max(0, shake - dt * 2.2);
    if (shake > 0 && allowed) camera.position.add(step.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).multiplyScalar(0.08 * shake * shake));
  }

  return {
    update,
    /** Heeft de speler de werper nu in handen (gepakt, en te voet in first person)? */
    get active() {
      return active();
    },
    get equipped() {
      return equipped;
    },
    setEquipped: (on: boolean) => setEquipped(on),
    /** Kan de speler hem nu vasthouden: te voet, in first person, met de handen vrij? */
    setAllowed(on: boolean) {
      allowed = on;
    },
    /** Is er iets kapot? */
    get damaged() {
      return shots > 0;
    },
    /** Voor testen: hoeveel er ligt en wat er kapot is. */
    get stats() {
      return { debris: debris.length, dead: dead.size, puffs: puffs.length, fires: fires.length };
    },
    /** De blokken waar de speler tegenaan loopt, zonder wat er is weggeschoten. */
    passable,
    /** Zet alles terug zoals het was. remote: een andere speler deed dat (niet nog eens rondsturen). */
    restore,
    /** De inslag van de raket van een andere speler (by = zijn naam, spare = zijn figuur: dat blijft heel). */
    remoteBlast: (x: number, y: number, z: number, by: string, spare?: THREE.Object3D) => explode(new THREE.Vector3(x, y, z), { by, spare }),
    /** Alle inslagen tot nu toe, voor een speler die later binnenkomt. */
    zones: () => zones.map((z) => [+z.p.x.toFixed(2), +z.p.y.toFixed(2), +z.p.z.toFixed(2)]),
    /** Schade van voor je binnenkwam overnemen: alleen de gaten, zonder knal. */
    applyZones(list: number[][]) {
      for (const [x, y, z] of list) explode(new THREE.Vector3(x, y, z), { quiet: true });
    },
    /** Vuurt (voor testen: zonder vastgezette muis). */
    shoot,
    /** Voor testen: een inslag op deze plek. */
    blastAt: (x: number, y: number, z: number) => explode(new THREE.Vector3(x, y, z)),
  };
}
