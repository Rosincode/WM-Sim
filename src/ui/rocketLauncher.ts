import * as THREE from 'three';
import { menu } from './menu';
import { STYLE, onTop } from './scene/style';
import { canvasTexture } from './scene/textures';
import type { Solid } from './scene/warehouse';

// Raketwerper (3): schiet het magazijn kapot. De schade is alleen beeld: de sim, de voorraad en de WMS merken er
// niets van. Daardoor is herstellen (menu › Raketwerper) altijd veilig. In multiplayer gaat elke inslag (en het
// herstellen) naar alle spelers (src/ui/multiplayer.ts): iedereen ziet dezelfde schade, en de raket van een ander
// blaast jou op: je vliegt weg (de camera volgt je), en als je geland bent begin je weer op de startplek.
// Zo werkt de schade:
// - alles wat binnen de ontploffing valt verdwijnt van zijn plek: een losse mesh wordt verborgen, een exemplaar van een
//   InstancedMesh krijgt schaal nul, en van een heel grote mesh (de locatielabels samen, de vloerverf) alleen de
//   driehoeken die er helemaal binnen vallen. Wat er stond wordt onthouden, zodat herstellen alles terugzet;
// - wat verdwijnt vliegt als los onderdeel weg (dezelfde vorm en hetzelfde materiaal) en blijft als puin liggen;
// - in heel grote onderdelen (wanden, gevels, dak, spanten) slaat de inslag een gat: het materiaal tekent niets
//   meer binnen de ontploffing (zie holed). Alleen de vloer en het terrein zelf blijven heel, met een schroeiplek;
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
  onExplode?: (x: number, y: number, z: number, nuke: boolean) => void;
  /** De speler heeft het magazijn hersteld: dat geldt voor iedereen. */
  onRestore?: () => void;
  /** De binnenkant van de hal: puin dat binnen begint ketst tegen de wanden en het dak en blijft dus binnen. */
  walls?: { minX: number; maxX: number; minZ: number; maxZ: number; maxY: number };
  /** Het figuur van de speler zelf: de raket van een ander kan hem opblazen. */
  self?: THREE.Object3D;
  /** De speler wordt weggeblazen door de raket van `by`: de besturing ligt stil tot hij geland is (zie `flying`). */
  onLaunched?: (by: string) => void;
  /** De speler is geland: de aanroeper zet hem terug op de startplek. */
  onKilled?: (by: string) => void;
}

/** Straal van een ontploffing (m). */
const BLAST = 4.5;
/** Onderdelen met een grotere straal dan dit (m) vliegen niet weg: daar komt een gat in (wanden, gevels, dak, spanten). */
const MAX_SIZE = 7;
/** Zoveel inslagen kunnen tegelijk een gat in wanden en dak houden; daarboven groeien de oudste gaten dicht. */
const MAX_HOLES = 48;
const SPEED = 60;
const RANGE = 160;
const COOLDOWN = 0.7;
/** Kernbom (4): één raket met een veel grotere ontploffing (straal in m); daarna duurt het even voor de volgende klaar is. */
const NUKE = 32;
const NUKE_COOLDOWN = 20;
const NUKE_DEBRIS = 560;
/** Zoveel stukken puin van een kernbom vliegen brandend weg (en branden na waar ze neerkomen). */
const MAX_BURNING = 110;
const GRAVITY = 18;
/** Zoveel losse stukken puin liggen er hooguit; de oudste verdwijnen. */
const MAX_DEBRIS = 950;
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
type Puff = { mesh: THREE.Mesh; vel: THREE.Vector3; age: number; life: number; size: number; gravity: number; /** Hoe snel hij afremt (per s). */ drag: number };
/** Een los stuk dat wegvliegt, stuitert en blijft liggen. state: 0 = vliegt, 1 = gaat liggen, 2 = ligt. */
type Debris = { /** Seconden dat het stuk nog brandt. */ burn: number; flame: number; pivot: THREE.Group; /** Begon binnen de hal: blijft daar. */ indoor: boolean; vel: THREE.Vector3; axis: THREE.Vector3; spin: number; thin: THREE.Vector3; rest: number; state: 0 | 1 | 2; flat: THREE.Quaternion; settle: number };
type Rocket = { group: THREE.Group; dir: THREE.Vector3; left: number; smoke: number; nuke: boolean; /** Stopt het razen van de raket. */ hush: () => void };
type Piece = { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; matrix: THREE.Matrix4; size: number };
type Ring = { mesh: THREE.Mesh; age: number; r: number };
type Fire = { at: THREE.Vector3; left: number; size: number; flame: number; fume: number };
type Dead = { scale: THREE.Vector3; until: number; body?: Debris };

export function createRocketLauncher({ scene, camera, canvas, onChange, onRespawn, onExplode, onRestore, walls, self, onLaunched, onKilled }: Options) {
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

  // ---------- Gaten in grote onderdelen (wanden, gevels, dak) ----------
  // Zo'n onderdeel krijgt een eigen kopie van zijn materiaal die niets tekent binnen een inslag. De inslagen staan in
  // één lijst die alle kopieën delen; herstellen zet de eigen materialen terug.
  const holeZones = { value: Array.from({ length: MAX_HOLES }, () => new THREE.Vector4()) };
  const holeCount = { value: 0 };
  const holedMaterials = new Map<THREE.Material, THREE.Material>();
  /** De onderdelen met een gat erin, met hun eigen materiaal. */
  const holedMeshes = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  function holed(material: THREE.Material) {
    let copy = holedMaterials.get(material);
    if (copy) return copy;
    copy = material.clone();
    const before = material.onBeforeCompile;
    copy.onBeforeCompile = (shader, renderer) => {
      before?.call(copy, shader, renderer);
      shader.uniforms.blastZones = holeZones;
      shader.uniforms.blastCount = holeCount;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vBlastPos;')
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
          #ifdef USE_INSTANCING
            vBlastPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          #else
            vBlastPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          #endif`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vBlastPos;\nuniform vec4 blastZones[${MAX_HOLES}];\nuniform int blastCount;`)
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
          for (int i = 0; i < ${MAX_HOLES}; i++) {
            if (i >= blastCount) break;
            vec3 away = vBlastPos - blastZones[i].xyz;
            if (away.y > 0.0) away.y *= ${ABOVE.toFixed(2)}; // dezelfde regel als reach(): erboven stort het ook in
            // een rafelige rand
            float edge = blastZones[i].w * (0.88 + 0.12 * sin(vBlastPos.x * 2.3 + vBlastPos.y * 3.1) * sin(vBlastPos.z * 2.9 + vBlastPos.y * 1.7));
            if (dot(away, away) < edge * edge) discard;
          }`,
        );
    };
    copy.customProgramCacheKey = () => `blast-holes:${material.customProgramCacheKey()}`;
    holedMaterials.set(material, copy);
    return copy;
  }
  /** Geeft een groot onderdeel het materiaal met gaten. De vloer en het terrein (plat, op de grond) blijven heel. */
  function pierce(mesh: THREE.Mesh) {
    if (holedMeshes.has(mesh)) return;
    box.setFromObject(mesh);
    if (box.max.y < 1 && box.max.y - box.min.y < 0.5) return;
    holedMeshes.set(mesh, mesh.material);
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(holed) : holed(mesh.material);
  }
  function refreshHoles() {
    const list = zones.slice(-MAX_HOLES);
    list.forEach((z, i) => holeZones.value[i].set(z.p.x, z.p.y, z.p.z, z.r));
    holeCount.value = list.length;
  }
  /** Ligt dit punt in een gat (een eerdere inslag)? */
  const inHole = (q: THREE.Vector3) => zones.slice(-MAX_HOLES).some((z) => reach(z.p, q.x, q.y, q.z) <= z.r * 0.88);

  /** Zet hit(): het onderdeel raakt de ontploffing maar is te groot om weg te vliegen (er komt een gat in). */
  let tooBig = false;
  /** Valt een onderdeel (geometrie met wereldmatrix `world`) binnen de ontploffing? Het midden komt in `center`. */
  function hit(geo: THREE.BufferGeometry, p: THREE.Vector3, r: number) {
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    if (!geo.boundingBox) geo.computeBoundingBox();
    const radius = geo.boundingSphere!.radius * world.getMaxScaleOnAxis();
    center.copy(geo.boundingSphere!.center).applyMatrix4(world);
    tooBig = false;
    if (center.distanceTo(p) > r / ABOVE + radius) return 0;
    if (radius > MAX_SIZE) {
      tooBig = true;
      return 0;
    }
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
    let big = false;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, own);
      if (isGone(own)) continue;
      world.multiplyMatrices(mesh.matrixWorld, own);
      const size = hit(mesh.geometry, p, r);
      if (tooBig) big = true;
      if (!size) continue;
      rec.saved.set(i, own.clone());
      mesh.setMatrixAt(i, GONE);
      changed = true;
      if (flies) pieces.push({ geometry: mesh.geometry, material: mesh.material, matrix: world.clone(), size });
    }
    if (changed) mesh.instanceMatrix.needsUpdate = true;
    rec.version = mesh.instanceMatrix.version;
    if (big) pierce(mesh); // spanten, leidingen: te lang om weg te vliegen
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
    // In een heel grote mesh komt een gat (wand, gevel, dak); kleine vlakken die er helemaal binnen vallen gaan er
    // in hun geheel uit (een locatielabel, een stukje vloerverf).
    if (tooBig) pierce(mesh);
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
    const force = r > BLAST ? 2 : 1; // een kernbom slingert alles veel verder weg
    vel.normalize().multiplyScalar(((rnd(5, 9) + 9 * Math.max(0, 1 - d / r)) * force) / (1 + size * 0.35));
    vel.y += (rnd(2, 6) * force) / (1 + size * 0.2);
    const indoor = !!walls && at.x > walls.minX && at.x < walls.maxX && at.z > walls.minZ && at.z < walls.maxZ && at.y < walls.maxY;
    const piece: Debris = { burn: 0, flame: 0, pivot, indoor, vel, axis: scatter(1), spin: rnd(2, 9) / (1 + size), thin: AXES[i].clone().applyQuaternion(dQuat), rest: Math.max(half.getComponent(i), 0.01), state: 0, flat: new THREE.Quaternion(), settle: 0 };
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
    const thrown = launch(mesh, piece.matrix, center, dSize, p, r);
    // een kernbom zet de boel in de fik: een deel van het puin vliegt brandend weg
    if (r > BLAST && Math.random() < 0.34 && debris.reduce((n, d) => n + (d.burn > 0 ? 1 : 0), 0) < MAX_BURNING) thrown.burn = rnd(6, 16);
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
    refreshHoles();
    for (const [mesh, material] of holedMeshes) mesh.material = material;
    holedMeshes.clear();
    for (const [unit, entry] of [...dead]) respawn(unit, entry, true);
    for (const d of [...debris]) if (d !== flight?.body) removeDebris(d); // wie zelf nog vliegt, vliegt door
    for (const s of scorches) fx.remove(s);
    scorches.length = 0;
    fires.length = 0;
    for (const q of puffs) fx.remove(q.mesh); // ook de rook is weg
    puffs.length = 0;
    shots = 0;
    passCache = new WeakMap();
    refreshPanel();
  }

  // ---------- Waar je doorheen loopt: wat weg is houdt je niet meer tegen ----------
  // - wat is weggeblazen (stelling, pallet, meubel, boom) is er voor de speler niet meer: passable();
  // - een wand, gevel of ander groot onderdeel blijft staan met een gat erin: sta je in dat gat, dan houdt het je
  //   niet tegen, en de rand van de hal ook niet (free());
  // - een robot, voertuig of mens die kapot is, is er niet tot hij terugkomt: alive().
  let passCache = new WeakMap<Solid[], { n: number; out: Solid[]; big: Solid[] }>();
  const isBig = (s: Solid) => s.maxX - s.minX > MAX_SIZE || s.maxZ - s.minZ > MAX_SIZE;
  /** Een punt in het eigen assenstelsel van een blok (dat kan gedraaid staan, zoals de heftruck). Resultaat in `local`. */
  function toSolid(s: Solid, x: number, z: number) {
    if (!s.pose) return local.set(x, 0, z);
    const dx = x - s.pose.x;
    const dz = z - s.pose.z;
    const c = Math.cos(s.pose.r);
    const n = Math.sin(s.pose.r);
    return local.set(dx * c - dz * n, 0, dx * n + dz * c);
  }
  /** Raakt dit blok de inslag? */
  function touches(z: Zone, s: Solid, scale = 1) {
    toSolid(s, z.p.x, z.p.z);
    const nx = THREE.MathUtils.clamp(local.x, s.minX, s.maxX) - local.x;
    const nz = THREE.MathUtils.clamp(local.z, s.minZ, s.maxZ) - local.z;
    const ny = THREE.MathUtils.clamp(z.p.y, s.minY, s.maxY) - z.p.y;
    return Math.hypot(nx, ny * (ny > 0 ? ABOVE : 1), nz) <= z.r * scale;
  }
  /** De gaten waar de speler nu in staat. */
  function standingIn() {
    const me = self?.position;
    return me ? zones.filter((z) => reach(z.p, me.x, THREE.MathUtils.clamp(z.p.y, me.y, me.y + 1.8), me.z) <= z.r * 0.88) : [];
  }
  /** De blokken waar de speler tegenaan loopt, zonder wat er is weggeblazen (en zonder de wand waar hij in het gat staat). */
  function passable(list: Solid[]) {
    if (!zones.length) return list;
    let c = passCache.get(list);
    if (!c || c.n !== zones.length) {
      const out = list.filter((s) => isBig(s) || !zones.some((z) => touches(z, s)));
      c = { n: zones.length, out, big: out.filter((s) => isBig(s) && zones.some((z) => touches(z, s, 0.88))) };
      passCache.set(list, c);
    }
    if (!c.big.length) return c.out;
    const here = standingIn();
    return here.length ? c.out.filter((s) => !(isBig(s) && here.some((z) => touches(z, s, 0.88)))) : c.out;
  }
  /** Dezelfde blokken zonder die van een robot, voertuig of mens die nu kapot is. */
  function alive(list: Solid[]) {
    if (!dead.size || !list.length) return list;
    const spots = [...dead.keys()].map((unit) => unit.getWorldPosition(new THREE.Vector3()));
    return list.filter(
      (s) =>
        !spots.some((q) => {
          if (s.pose) return Math.hypot(q.x - s.pose.x, q.z - s.pose.z) < 0.8; // een voertuig: al zijn blokken horen bij die ene plek
          toSolid(s, q.x, q.z);
          return local.x > s.minX - 0.9 && local.x < s.maxX + 0.9 && local.z > s.minZ - 0.9 && local.z < s.maxZ + 0.9;
        }),
    );
  }
  /** Staat dit punt in een gat op de grond? Daar mag de speler door de rand van de hal heen (door de wand naar buiten). */
  const free = (x: number, z: number) => zones.some((q) => q.p.y < q.r && Math.hypot(x - q.p.x, z - q.p.z) <= q.r * 0.85);

  // ---------- Rook, vuur en vonken ----------
  /** @param gravity valt (vonken) of stijgt op eigen snelheid (0) */
  function puff(material: THREE.Material, at: THREE.Vector3, vel: THREE.Vector3, size: number, life: number, gravity = 0, drag = gravity ? 0.6 : 2.2) {
    const mesh = new THREE.Mesh(BALL, material);
    mesh.position.copy(at);
    mesh.scale.setScalar(0.001);
    mesh.userData.noAO = true; // geen omgevingsschaduw van rook en vuur (zie main.ts)
    fx.add(mesh);
    puffs.push({ mesh, vel, age: 0, life, size, gravity, drag });
  }
  /** Een brandje dat een tijd nasmeult: vlammen en een rookpluim. */
  function burn(at: THREE.Vector3, seconds: number, size: number) {
    fires.push({ at, left: seconds, size, flame: 0, fume: 0 });
    if (fires.length > 70) fires.shift();
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
  function scorch(p: THREE.Vector3, r: number) {
    const mark = new THREE.Mesh(scorchGeo, scorchMat);
    mark.position.set(p.x, 0.005, p.z);
    mark.rotation.y = rnd(0, 6);
    mark.scale.setScalar(r * rnd(1.6, 2.1));
    mark.receiveShadow = true;
    fx.add(mark);
    scorches.push(mark);
  }
  /**
   * Een inslag. Zonder `from` is het een eigen raket; die gaat ook naar de andere spelers.
   * @param from by = naam van de speler die schoot, spare = zijn figuur (zijn eigen raket doet hem niets);
   *             quiet = schade van eerder (voor wie later binnenkomt): alleen het gat, zonder knal en puin.
   * @param nuke een kernbom: een veel grotere ontploffing, die ook de schutter zelf niet spaart.
   * @param safe de speler zelf blijft staan (de drukgolf van de bom uit de lucht: hij kijkt toe hoe alles wegvliegt).
   */
  function explode(p: THREE.Vector3, from?: { by?: string; spare?: THREE.Object3D; quiet?: boolean }, nuke = false, safe = false) {
    const r = nuke ? NUKE : BLAST;
    const key = `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`;
    if (seen.has(key)) return;
    seen.add(key);
    shots++;
    zones.push({ p: p.clone(), r });
    refreshHoles();
    if (from?.quiet) {
      destroy(p, r, 'units');
      if (p.y < 2.2) scorch(p, r);
      passCache = new WeakMap();
      refreshPanel();
      return;
    }
    if (!from) onExplode?.(+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), nuke);
    if ((from || nuke) && self && !flight && !safe) {
      // de raket van een ander (of je eigen kernbom): sta je erin, dan vlieg je weg
      const me = self.position;
      if (reach(p, me.x, THREE.MathUtils.clamp(p.y, me.y, me.y + 1.8), me.z) <= r * 0.8) killed(from?.by ?? 'je eigen kernbom', p, r);
    }
    const pieces = destroy(p, r, nuke ? undefined : from?.spare);
    const budget = nuke ? NUKE_DEBRIS : DEBRIS_PER_BLAST;
    // Puin: de grote stukken (staanders, liggers, pallets) allemaal, van de rest (dozen) een greep
    pieces.sort((a, b) => b.size - a.size);
    const big = pieces.findIndex((piece) => piece.size < 0.55);
    const keep = pieces.splice(0, Math.min(big < 0 ? pieces.length : big, Math.round(budget * 0.55)));
    while (keep.length < budget && pieces.length) keep.push(pieces.splice(Math.floor(Math.random() * pieces.length), 1)[0]);
    for (const piece of keep) throwPiece(piece, p, r);
    // te veel puin: de oudste stukken die al liggen gaan weg (een lichaam blijft tot de mens terug is)
    const bodies = new Set([...dead.values()].map((d) => d.body));
    bodies.add(flight?.body);
    for (let i = 0; debris.length > MAX_DEBRIS && i < debris.length; ) {
      if (bodies.has(debris[i])) i++;
      else removeDebris(debris[i]);
    }

    // Vuurbal: witheet hart, oranje bol, uitwaaierende vlammen, vonken, en een zwarte rookwolk die blijft hangen
    const still = new THREE.Vector3();
    const k = Math.sqrt(r / BLAST); // een kernbom: alles groter, verder en langer
    puff(hot, p, still.clone(), r * 0.5, 0.26 * k * k);
    puff(fire, p, still.clone(), r * 0.95, 0.5 * k * k);
    for (let i = 0; i < 16; i++) puff(fire, p, scatter(rnd(5, 14) * k * k), rnd(0.5, 1.3) * k * k, rnd(0.3, 0.65) * k);
    for (let i = 0; i < 34; i++) {
      const vel = scatter(rnd(7, 20) * k);
      vel.y = Math.abs(vel.y) + rnd(1, 5);
      puff(ember, p, vel, rnd(0.04, 0.1), rnd(0.7, 1.5), 14);
    }
    for (let i = 0; i < 18; i++) {
      const vel = scatter(rnd(1.5, 5));
      vel.y = Math.abs(vel.y) * 0.8 + rnd(0.8, 2.4);
      puff(i % 3 ? soot : smoke, p, vel.multiplyScalar(k * k), rnd(1.3, 3) * k, rnd(2.5, 5.5) * k);
    }
    if (nuke) mushroom(p, r);
    // Drukgolf over de vloer
    const ring = new THREE.Mesh(RING, onTop(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), 4));
    (ring.material as THREE.MeshBasicMaterial).color.setRGB(2.4, 1.8, 1.2);
    ring.position.set(p.x, Math.max(0.03, Math.min(p.y, 0.5)), p.z);
    ring.userData.noAO = true;
    fx.add(ring);
    rings.push({ mesh: ring, age: 0, r });
    // Wat er lag blijft nabranden
    const ground = p.y < 2.5 ? 0.1 : p.y;
    burn(new THREE.Vector3(p.x, ground, p.z), rnd(6, 9), 1.2);
    for (let i = 0; i < 3; i++) burn(new THREE.Vector3(p.x + rnd(-3, 3), 0.1, p.z + rnd(-3, 3)), rnd(4, 10), rnd(0.5, 0.9));
    if (nuke) for (let i = 0; i < 30; i++) burn(new THREE.Vector3(p.x + rnd(-0.85, 0.85) * r, 0.1, p.z + rnd(-0.85, 0.85) * r), rnd(10, 26), rnd(0.9, 2.2));

    if (p.y < 2.2 || nuke) scorch(p, r);
    const d = camera.getWorldPosition(center).distanceTo(p);
    shake = Math.max(shake, nuke ? 2 : THREE.MathUtils.clamp(1.5 - d / 35, 0, 1));
    if (nuke) {
      // de lichtflits: even is alles wit
      flash.style.transition = 'none';
      flash.style.opacity = '1';
      void flash.offsetWidth;
      flash.style.transition = 'opacity 3.5s ease-out 0.25s';
      flash.style.opacity = '0';
    }
    boomSound(p, nuke);
    refreshPanel();
  }

  /** De paddenstoelwolk van een kernbom: een stam van rook en vuur die opstijgt, met een hoed die uitwaaiert. */
  function mushroom(p: THREE.Vector3, r: number) {
    for (let i = 0; i < 28; i++) {
      const at = new THREE.Vector3(p.x + rnd(-2.5, 2.5), rnd(0.5, r * 0.5), p.z + rnd(-2.5, 2.5));
      puff(i % 4 ? soot : fire, at, new THREE.Vector3(rnd(-0.6, 0.6), rnd(5, 9), rnd(-0.6, 0.6)), rnd(3.5, 6), i % 4 ? rnd(7, 11) : rnd(2.5, 4), 0, 0.22);
    }
    for (let i = 0; i < 34; i++) {
      const a = rnd(0, Math.PI * 2);
      const out = rnd(0, 5);
      const at = new THREE.Vector3(p.x + Math.cos(a) * out, r * 0.55 + rnd(0, 5), p.z + Math.sin(a) * out);
      const vel = new THREE.Vector3(Math.cos(a) * rnd(1.5, 4.5), rnd(3, 5.5), Math.sin(a) * rnd(1.5, 4.5));
      puff(i % 5 ? (i % 2 ? soot : smoke) : fire, at, vel, rnd(6, 10), i % 5 ? rnd(9, 13) : rnd(3, 5), 0, 0.2);
    }
  }
  const flash = document.createElement('div');
  flash.style.cssText = 'position:fixed;inset:0;z-index:56;pointer-events:none;opacity:0;background:#fffdf0';
  document.body.appendChild(flash);

  // ---------- Opgeblazen: even een rood scherm, en terug naar de startplek ----------
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:55;display:flex;align-items:center;justify-content:center;pointer-events:none;opacity:0;background:radial-gradient(circle,rgba(150,20,10,.35),rgba(90,0,0,.8));color:#fff;font:700 34px system-ui,sans-serif;text-shadow:0 2px 8px #000;text-align:center';
  document.body.appendChild(overlay);
  /** De speler zelf vliegt weg: zijn lichaam als puin, de camera volgt het tot het ligt. */
  let flight: { body: Debris; by: string; time: number; down: number } | null = null;
  const chase = new THREE.Vector3();
  function killed(by: string, p: THREE.Vector3, r: number) {
    if (!self) return;
    overlay.textContent = `Opgeblazen door ${by}`;
    overlay.style.transition = 'none';
    overlay.style.opacity = '0.75';
    void overlay.offsetWidth; // de overgang hieronder begint pas na dit beeld
    overlay.style.transition = 'opacity 1.6s ease-out';
    overlay.style.opacity = '0';
    onLaunched?.(by); // eerst: uit de heftruck of van de stoel, dan staat het figuur op zijn eigen plek
    self.updateWorldMatrix(true, true);
    const body = self.clone(true);
    body.visible = true; // in first person is het eigen figuur verborgen
    body.traverse((o) => {
      if ((o as THREE.Sprite).isSprite) o.visible = false; // tekstwolkje
    });
    center.setFromMatrixPosition(self.matrixWorld);
    center.y += 0.9;
    const piece = launch(body, self.matrixWorld, center, dSize.set(0.28, 0.9, 0.16), p, r);
    piece.vel.y += 6; // hoog genoeg om jezelf te zien gaan
    piece.spin = Math.max(piece.spin, 4);
    flight = { body: piece, by, time: 0, down: 0 };
    self.visible = false;
    camera.getWorldPosition(chase);
  }
  /** Tijdens de vlucht: de camera hangt schuin achter je lichaam en kijkt ernaar. */
  function fly(dt: number) {
    if (!flight) return;
    const at = flight.body.pivot.position;
    flight.time += dt;
    if (flight.body.state !== 0) flight.down += dt;
    const v = flight.body.vel;
    const h = Math.hypot(v.x, v.z) || 1;
    step.set(at.x - (v.x / h) * 5.5, Math.max(1.2, at.y + 2.2), at.z - (v.z / h) * 5.5);
    if (flight.body.indoor && walls) step.set(THREE.MathUtils.clamp(step.x, walls.minX, walls.maxX), Math.min(step.y, walls.maxY), THREE.MathUtils.clamp(step.z, walls.minZ, walls.maxZ)); // de camera blijft ook binnen
    if (flight.body.state === 0) chase.lerp(step, 1 - Math.exp(-dt * 4));
    camera.position.copy(chase);
    camera.lookAt(at);
    if (flight.down < 1.3 && flight.time < 9) return; // even blijven liggen, dan terug
    const by = flight.by;
    removeDebris(flight.body);
    flight = null;
    onKilled?.(by);
  }

  // ---------- Geluid: ter plekke opgewekt (Web Audio), net als de rest van de game ----------
  // - afvuren: een doffe plof uit de buis en het sissen van de motor;
  // - onderweg: de raket raast, steeds zachter naarmate hij verder weg is;
  // - inslag: een scherpe knal, een lage dreun die uitrolt, de galm van de hal en puin dat neerklettert.
  // Verder weg klinkt een inslag zachter en later (het geluid doet er even over), links of rechts volgt de kijkrichting.
  // Het volume volgt de schuif bij menu › Geluid.
  let audio: AudioContext | null = null;
  let master: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  function ready() {
    try {
      if (!audio) {
        audio = new AudioContext();
        const squash = audio.createDynamicsCompressor(); // meerdere knallen tegelijk: niet kraken
        squash.threshold.value = -6; // pas vlak voor het maximum ingrijpen: het mag echt hard
        squash.ratio.value = 6;
        master = audio.createGain();
        master.connect(squash).connect(audio.destination);
        // galm van de hal: een paar echo's die steeds doffer worden
        const echo = audio.createDelay(0.5);
        echo.delayTime.value = 0.13;
        const back = audio.createGain();
        back.gain.value = 0.36;
        const dull = audio.createBiquadFilter();
        dull.type = 'lowpass';
        dull.frequency.value = 1300;
        master.connect(echo).connect(dull).connect(back).connect(echo);
        back.connect(squash);
        noise = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
        const data = noise.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      if (audio.state === 'suspended') void audio.resume();
      let volume = 0.7;
      try {
        const saved = Number(localStorage.getItem('wm-sim.sound.volume') ?? NaN);
        if (saved >= 0 && saved <= 1) volume = saved;
      } catch {
        // geen localStorage: standaardvolume
      }
      master!.gain.value = volume * 4; // de raketwerper is veruit het hardste geluid in de hal
      return audio.state === 'running';
    } catch {
      return false; // geen geluid beschikbaar: stil doorgaan
    }
  }
  // De browser laat pas geluid toe na een klik of toets van de speler zelf: daarna hoor je ook de inslagen van anderen.
  window.addEventListener('pointerdown', ready);
  window.addEventListener('keydown', ready);

  /** Ruis door een filter, met een verloop in toon en sterkte. Geeft de sterkteregelaar terug. */
  function hiss(type: BiquadFilterType, from: number, to: number, level: number, at: number, seconds: number, pan = 0, q = 0.8) {
    const src = audio!.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const filter = audio!.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, at);
    filter.frequency.exponentialRampToValueAtTime(to, at + seconds);
    const gain = audio!.createGain();
    gain.gain.setValueAtTime(level, at);
    gain.gain.exponentialRampToValueAtTime(0.0008, at + seconds);
    const side = audio!.createStereoPanner();
    side.pan.value = pan;
    src.connect(filter).connect(gain).connect(side).connect(master!);
    src.start(at, Math.random() * 1.5);
    src.stop(at + seconds + 0.05);
    return gain;
  }
  /** Een toon die zakt (de dreun). */
  function thud(wave: OscillatorType, from: number, to: number, level: number, at: number, seconds: number, pan = 0) {
    const osc = audio!.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(from, at);
    osc.frequency.exponentialRampToValueAtTime(to, at + seconds);
    const gain = audio!.createGain();
    gain.gain.setValueAtTime(level, at);
    gain.gain.exponentialRampToValueAtTime(0.0008, at + seconds);
    const side = audio!.createStereoPanner();
    side.pan.value = pan;
    osc.connect(gain).connect(side).connect(master!);
    osc.start(at);
    osc.stop(at + seconds + 0.05);
  }

  /** Afvuren: plof uit de buis, dan het sissen van de motor. */
  function launchSound() {
    if (!ready()) return;
    const t = audio!.currentTime;
    thud('sine', 190, 45, 0.9, t, 0.22);
    hiss('lowpass', 2600, 300, 0.7, t, 0.16);
    hiss('bandpass', 2400, 500, 0.55, t + 0.03, 0.7, 0, 1.4);
  }
  /** De raket onderweg: raast tot hij inslaat, zachter naarmate hij verder weg is. Geeft terug hoe je hem stopt. */
  function flightSound(seconds: number) {
    if (!ready()) return () => {};
    const t = audio!.currentTime;
    const len = Math.max(0.15, seconds);
    const gain = hiss('bandpass', 900, 520, 0.5, t, len + 0.3, 0, 2.2);
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.06, t + len);
    return () => {
      const now = audio!.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(0, now, 0.02);
    };
  }
  /** De inslag op punt `p`: hoe verder weg, hoe zachter, doffer en later. */
  function boomSound(p: THREE.Vector3, nuke = false) {
    if (!ready()) return;
    camera.getWorldPosition(camPos);
    const d = camPos.distanceTo(p);
    const level = nuke ? 1 : THREE.MathUtils.clamp(1.2 / (1 + d / 22), 0.08, 1); // een kernbom hoor je overal
    step.setFromMatrixColumn(camera.matrixWorld, 0); // rechts van de camera
    const pan = d < 1 ? 0 : THREE.MathUtils.clamp(((p.x - camPos.x) * step.x + (p.z - camPos.z) * step.z) / d, -1, 1) * 0.75;
    const t = audio!.currentTime + Math.min(d / 340, 0.6);
    const far = THREE.MathUtils.clamp(d / 60, 0, 1); // ver weg hoor je vooral de lage dreun
    hiss('highpass', 1800, 900, 1.1 * level * (1 - 0.8 * far), t, 0.09, pan); // de knal
    hiss('lowpass', 2600 - 1700 * far, 55, 1.2 * level, t, 1.9, pan); // de dreun die uitrolt
    thud('sine', 110, 24, 1.3 * level, t, 1.0, pan);
    thud('triangle', 62, 30, 0.6 * level, t + 0.02, 0.6, pan);
    if (nuke) {
      // de kernbom: een dreun die seconden doorrolt, met een tweede golf erachteraan
      hiss('lowpass', 1400, 28, 2, t, 7, pan);
      thud('sine', 75, 16, 2.2, t, 4.5, pan);
      thud('sawtooth', 48, 20, 0.7, t + 0.1, 3, pan);
      hiss('lowpass', 500, 30, 1.2, t + 1.4, 6, -pan);
    }
    // puin dat neerklettert
    for (let i = 0; i < (nuke ? 30 : 9); i++) {
      const at = t + 0.35 + Math.random() * (nuke ? 5 : 1.5);
      hiss('bandpass', 1200 + Math.random() * 2600, 500 + Math.random() * 600, 0.16 * level * (1 - 0.6 * far), at, 0.05 + Math.random() * 0.09, THREE.MathUtils.clamp(pan + (Math.random() - 0.5) * 0.6, -1, 1), 3);
    }
  }

  // ---------- Kernbom uit de lucht (de knop in de kantine): ver weg valt een bom ----------
  // Je ziet hem vallen, dan de flits en de paddenstoelwolk in de verte, en een paar tellen later is de drukgolf bij
  // de hal: dan ontploft alles om je heen. Wat ver weg staat tekent zonder nevel (fog: false), anders zie je het niet.
  const FALL = 4.5; // zo lang valt de bom (s)
  const SHOCK = 3.4; // zo lang doet de drukgolf erover van de inslag naar de hal (s)
  const WAVE = 16; // zoveel ontploffingen om je heen als hij aankomt; de eerste twee zijn zo groot als een kernbom
  const far = (r: number, g: number, b: number, opacity = 1) => {
    const m = new THREE.MeshBasicMaterial({ fog: false, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
    m.color.setRGB(r, g, b);
    return m;
  };
  const farHot = far(16, 12, 6);
  const farFire = far(7, 2.6, 0.5);
  const farSoot = far(0.05, 0.05, 0.055, 0.8);
  const farDust = far(0.75, 0.72, 0.66, 0.5);
  const WALL_GEO = new THREE.CylinderGeometry(1, 1, 1, 96, 1, true);
  type Strike = { t: number; at: THREE.Vector3; own: boolean; bomb: THREE.Group; trail: number; hit: boolean; arrived: boolean; wave: number; next: number; ring?: THREE.Mesh; wall?: THREE.Mesh; reach: number };
  let strike: Strike | null = null;

  /** Laat ver weg een kernbom vallen op (x, z). own: deze speler drukte op de knop; bij hem slaat de drukgolf in. */
  function airstrike(x: number, z: number, own: boolean) {
    if (strike) return false;
    const bomb = new THREE.Group(); // neus naar +Z
    const dark = far(0.06, 0.065, 0.07);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.1, 4.2, 8, 16).rotateX(Math.PI / 2), dark);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(1.12, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), far(0.9, 0.72, 0.05));
    nose.position.z = 2.1;
    bomb.add(body, nose);
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.2, 1.6), dark);
      fin.position.set(Math.sin((i * Math.PI) / 2) * 1.3, Math.cos((i * Math.PI) / 2) * 1.3, -2.6);
      fin.rotation.z = (-i * Math.PI) / 2;
      bomb.add(fin);
    }
    bomb.scale.setScalar(1.6); // van 250 m nog te zien
    bomb.traverse((o) => (o.userData.noAO = true));
    fx.add(bomb);
    camera.getWorldPosition(camPos);
    strike = { t: 0, at: new THREE.Vector3(x, 0, z), own, bomb, trail: 0, hit: false, arrived: false, wave: 0, next: 0, reach: Math.hypot(x - camPos.x, z - camPos.z) };
    return true;
  }

  function strikeStep(dt: number) {
    const s = strike;
    if (!s) return;
    s.t += dt;
    if (!s.hit) {
      // de bom valt, steeds sneller, met een rookspoor
      const k = Math.min(1, s.t / FALL);
      const from = step.set(s.at.x - 55, 240, s.at.z + 20);
      s.bomb.position.set(from.x + (s.at.x - from.x) * k, 240 * (1 - k * k), from.z + (s.at.z - from.z) * k);
      s.bomb.quaternion.setFromUnitVectors(FORWARD, local.set(55, -480 * k - 20, -20).normalize());
      for (s.trail += dt * 14; s.trail >= 1; s.trail--) puff(farDust, s.bomb.position.clone(), new THREE.Vector3(), rnd(2.5, 4), rnd(2, 3.5), 0, 0.5);
      if (s.t < FALL) return;
      s.hit = true;
      fx.remove(s.bomb);
      // De flits: een witte bol die opzwelt, en even is je hele beeld wit
      const still = () => new THREE.Vector3();
      puff(farHot, new THREE.Vector3(s.at.x, 12, s.at.z), still(), 110, 2.2);
      puff(farFire, new THREE.Vector3(s.at.x, 18, s.at.z), still(), 150, 4.5);
      flash.style.transition = 'none';
      flash.style.opacity = '0.92';
      void flash.offsetWidth;
      flash.style.transition = 'opacity 4s ease-out 0.3s';
      flash.style.opacity = '0';
      // De paddenstoelwolk: een stam die opstijgt en een hoed die uitrolt
      for (let i = 0; i < 20; i++) {
        const at = new THREE.Vector3(s.at.x + rnd(-9, 9), rnd(5, 75), s.at.z + rnd(-9, 9));
        puff(i % 4 ? farSoot : farFire, at, new THREE.Vector3(rnd(-1, 1), rnd(11, 18), rnd(-1, 1)), rnd(22, 32), i % 4 ? rnd(13, 17) : rnd(4, 7), 0, 0.1);
      }
      for (let i = 0; i < 30; i++) {
        const a = rnd(0, Math.PI * 2);
        const out = rnd(0, 22);
        const at = new THREE.Vector3(s.at.x + Math.cos(a) * out, rnd(92, 112), s.at.z + Math.sin(a) * out);
        const vel = new THREE.Vector3(Math.cos(a) * rnd(5, 12), rnd(5, 9), Math.sin(a) * rnd(5, 12));
        puff(i % 5 ? farSoot : farFire, at, vel, rnd(38, 58), i % 5 ? rnd(14, 18) : rnd(5, 8), 0, 0.12);
      }
      // De drukgolf: een ring over de grond en een muur van stof die op je af komt
      s.ring = new THREE.Mesh(RING, far(3, 2.6, 2, 0.7));
      (s.ring.material as THREE.Material).blending = THREE.AdditiveBlending;
      s.ring.position.set(s.at.x, 0.4, s.at.z);
      s.wall = new THREE.Mesh(WALL_GEO, farDust.clone());
      (s.wall.material as THREE.Material).side = THREE.DoubleSide;
      s.wall.position.set(s.at.x, 9, s.at.z);
      for (const m of [s.ring, s.wall]) {
        m.userData.noAO = true;
        m.frustumCulled = false;
        fx.add(m);
      }
    }
    const after = s.t - FALL;
    const radius = Math.max(1, (s.reach + 6) * (after / SHOCK)); // precies op tijd bij de kijker
    s.ring!.scale.setScalar(radius);
    s.wall!.scale.set(radius, 18, radius);
    (s.wall!.material as THREE.Material).opacity = 0.5 * Math.max(0, 1 - (after - SHOCK) / 1.2);
    (s.ring!.material as THREE.Material).opacity = 0.7 * Math.max(0, 1 - (after - SHOCK) / 1.2);
    if (after < SHOCK) return;
    if (!s.arrived) {
      // Hij is er: de klap, en alles schudt
      s.arrived = true;
      shake = 2;
      camera.getWorldPosition(camPos);
      boomSound(camPos.clone().addScaledVector(local.copy(s.at).sub(camPos).normalize(), 12), true);
    }
    // Wie op de knop drukte: om hem heen ontploft alles (die inslagen gaan gewoon naar alle spelers)
    if (s.own && s.wave < WAVE && after >= SHOCK + s.next) {
      const me = self?.position ?? camPos;
      const a = rnd(0, Math.PI * 2);
      const out = rnd(5, 26);
      const toBomb = new THREE.Vector3().copy(s.at).sub(me).setY(0).normalize();
      // Eerst de klap zelf, zo groot als een kernbom: aan de kant van de bom (de gevel en alles om je heen vliegt
      // de hal in), en meteen daarna dieper in de hal. Jij blijft staan. Daarna overal losse ontploffingen.
      if (s.wave === 0) explode(new THREE.Vector3(me.x + toBomb.x * 7, 1.5, me.z + toBomb.z * 7), undefined, true, true);
      else if (s.wave === 1) explode(new THREE.Vector3(me.x - toBomb.x * 34 + rnd(-8, 8), 1.5, me.z - toBomb.z * 34), undefined, true, true);
      else explode(new THREE.Vector3(me.x + Math.cos(a) * out, rnd(0.3, 2.5), me.z + Math.sin(a) * out));
      s.wave++;
      s.next += s.wave <= 2 ? 0.55 : rnd(0.1, 0.28);
    }
    if (after < SHOCK + 4) return;
    fx.remove(s.ring!, s.wall!);
    (s.ring!.material as THREE.Material).dispose();
    (s.wall!.material as THREE.Material).dispose();
    strike = null;
  }

  // ---------- Vuren ----------
  const raycaster = new THREE.Raycaster();
  const camPos = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const FORWARD = new THREE.Vector3(0, 0, 1);

  /** Waarschuwingsgeel: de kop van de kernbom. */
  const nukeMat = new THREE.MeshStandardMaterial({ color: '#f0c20a', roughness: 0.6, metalness: 0.05 });
  let nukeLoaded = false;
  /** Vanaf dit tijdstip (clock) is de volgende kernbom klaar. */
  let nukeReadyAt = 0;
  function loadNuke(on: boolean) {
    if (on && clock < nukeReadyAt) return;
    nukeLoaded = on;
    if (on && !equipped) setEquipped(true);
    refreshPanel();
  }

  function buildRocket(nuke: boolean) {
    const g = new THREE.Group(); // voorkant naar +Z
    if (nuke) g.scale.setScalar(1.8);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.42, 16).rotateX(Math.PI / 2), STYLE.dark);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.046, 0.14, 16).rotateX(Math.PI / 2), nuke ? nukeMat : STYLE.paint);
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
    const nuke = nukeLoaded;
    if (nuke) {
      nukeLoaded = false;
      nukeReadyAt = clock + NUKE_COOLDOWN;
      refreshPanel();
    }
    cooldown = nuke ? 1.5 : COOLDOWN;
    kick = nuke ? 1.8 : 1;
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
      if (skip || (holedMeshes.has(h.object as THREE.Mesh) && inHole(h.point))) continue; // door een gat schiet je heen
      target.copy(h.point).addScaledVector(camDir, -0.05);
      break;
    }
    const group = buildRocket(nuke);
    rig.updateWorldMatrix(true, false);
    group.position.copy(rig.localToWorld(new THREE.Vector3(0, 0, -0.62)));
    const dir = target.clone().sub(group.position);
    const left = dir.length();
    dir.normalize();
    group.quaternion.setFromUnitVectors(FORWARD, dir);
    fx.add(group);
    rockets.push({ group, dir, left, smoke: 0, nuke, hush: flightSound(left / SPEED) });
    for (let i = 0; i < 6; i++) puff(smoke, camPos.clone().addScaledVector(camDir, -0.6), scatter(1.2).addScaledVector(camDir, -3), rnd(0.25, 0.5), rnd(0.5, 1));
    launchSound();
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
    else if (e.code === 'Digit4' || e.code === 'Numpad4') loadNuke(!nukeLoaded);
    else if (equipped && (e.code === 'Digit1' || e.code === 'Numpad1')) setEquipped(false, 'scanner');
    else if (equipped && (e.code === 'Digit2' || e.code === 'Numpad2')) setEquipped(false, 'tablet');
  });
  function setEquipped(on: boolean, tool: 'scanner' | 'tablet' | null = null) {
    if (on === equipped) return;
    equipped = on;
    if (!on) nukeLoaded = false;
    refreshPanel();
    onChange(tool);
  }

  // ---------- Menu: pakken en herstellen ----------
  const panel = document.createElement('div');
  panel.innerHTML = `<div><b>3</b>: raketwerper pakken of wegleggen (te voet, in first person) · <b>Klik</b>: vuren · <b>4</b>: kernbom laden (één schot, daarna ${NUKE_COOLDOWN} s wachten) · <b>1</b>/<b>2</b>: terug naar scanner of tablet</div>
    <div style="margin-top:6px;color:#9aa0a6">Alles kan kapot: stellingen, voorraad, robots, karren, vrachtwagens en mensen, en in wanden, gevels en dak sla je gaten (ook van buitenaf). Robots, voertuigen en mensen komen na een paar tellen vanzelf terug. Iedereen in de kamer ziet dezelfde schade, en de raket van een ander blaast jou op (je begint dan weer op de startplek). Herstellen geldt ook voor iedereen. Een kernbom vaagt een groot deel van de hal weg en spaart ook jezelf niet. De schade is alleen beeld: de voorraad en de WMS merken er niets van.</div>
    <div class="state" style="margin-top:10px"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="restore" style="padding:8px 14px;border:0;border-radius:6px;background:#2e7d4f;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer">Magazijn herstellen</button>
      <button class="equip" style="padding:8px 14px;border:0;border-radius:6px;background:#3a4047;color:#fff;font:14px system-ui,sans-serif;cursor:pointer"></button>
      <button class="nuke" style="padding:8px 14px;border:0;border-radius:6px;background:#8a6d00;color:#fff;font:14px system-ui,sans-serif;cursor:pointer"></button>
    </div>`;
  const stateEl = panel.querySelector<HTMLDivElement>('.state')!;
  const restoreBtn = panel.querySelector<HTMLButtonElement>('.restore')!;
  const equipBtn = panel.querySelector<HTMLButtonElement>('.equip')!;
  const nukeBtn = panel.querySelector<HTMLButtonElement>('.nuke')!;
  nukeBtn.addEventListener('click', () => {
    loadNuke(!nukeLoaded);
    nukeBtn.blur();
  });
  function refreshPanel() {
    stateEl.textContent = shots ? `${shots} ${shots === 1 ? 'inslag' : 'inslagen'}: het magazijn is beschadigd.` : 'Het magazijn is heel.';
    restoreBtn.disabled = !shots;
    restoreBtn.style.opacity = shots ? '1' : '0.45';
    restoreBtn.style.cursor = shots ? 'pointer' : 'default';
    equipBtn.textContent = equipped ? 'Raketwerper wegleggen' : 'Raketwerper pakken';
    nukeBtn.textContent = nukeLoaded ? 'Kernbom eruit halen' : 'Kernbom laden';
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
    crosshair.style.borderColor = nukeLoaded ? '#ffd21f' : 'rgba(255,255,255,.8)';
    tip.visible = cooldown < COOLDOWN * 0.45; // herladen: de volgende raket schuift erin
    tip.material = nukeLoaded ? nukeMat : STYLE.paint;
    tip.scale.setScalar(nukeLoaded ? 1.35 : 1);
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
      r.hush();
      fx.remove(r.group);
      rockets.splice(i, 1);
      explode(r.group.position, undefined, r.nuke);
    }

    for (let i = fires.length - 1; i >= 0; i--) {
      const f = fires[i];
      f.left -= dt;
      if (f.left <= 0) {
        fires.splice(i, 1);
        continue;
      }
      const fade = Math.min(1, f.left / 2); // dooft langzaam uit
      const thin = Math.min(1, 22 / fires.length); // staat alles in brand, dan per brandje wat minder vlammen
      for (f.flame += dt * 13 * thin; f.flame >= 1; f.flame--)
        puff(Math.random() < 0.25 ? hot : fire, step.set(f.at.x + rnd(-0.4, 0.4) * f.size, f.at.y, f.at.z + rnd(-0.4, 0.4) * f.size).clone(), new THREE.Vector3(rnd(-0.3, 0.3), rnd(1.6, 3.2) * f.size, rnd(-0.3, 0.3)), rnd(0.22, 0.5) * f.size * fade, rnd(0.35, 0.6));
      for (f.fume += dt * 3.5 * thin; f.fume >= 1; f.fume--)
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
      p.vel.multiplyScalar(Math.exp(-dt * p.drag));
      p.mesh.scale.setScalar(p.size * (t < 0.25 ? t / 0.25 : 1 - (t - 0.25) / 0.75) + 0.001); // snel opzwellen, langzaam oplossen
    }

    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.age += dt;
      const t = r.age / (0.45 * Math.sqrt(r.r / BLAST));
      if (t >= 1) {
        fx.remove(r.mesh);
        (r.mesh.material as THREE.Material).dispose();
        rings.splice(i, 1);
        continue;
      }
      r.mesh.scale.setScalar(0.5 + r.r * 2.6 * (1 - (1 - t) ** 2));
      (r.mesh.material as THREE.Material).opacity = 0.8 * (1 - t);
    }

    for (const d of debris) {
      if (d.burn > 0) {
        d.burn -= dt;
        for (d.flame += dt * 4.5; d.flame >= 1; d.flame--)
          puff(Math.random() < 0.2 ? hot : Math.random() < 0.15 ? soot : fire, d.pivot.position.clone(), new THREE.Vector3(rnd(-0.3, 0.3), rnd(1, 2.4), rnd(-0.3, 0.3)), rnd(0.25, 0.6), rnd(0.3, 0.55));
      }
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
      if (d.indoor && walls) {
        // tegen een wand of het dak: terugketsen
        const q = pivot.position;
        if (q.x < walls.minX || q.x > walls.maxX) {
          q.x = THREE.MathUtils.clamp(q.x, walls.minX, walls.maxX);
          d.vel.x *= -0.4;
        }
        if (q.z < walls.minZ || q.z > walls.maxZ) {
          q.z = THREE.MathUtils.clamp(q.z, walls.minZ, walls.maxZ);
          d.vel.z *= -0.4;
        }
        if (q.y > walls.maxY && d.vel.y > 0) {
          q.y = walls.maxY;
          d.vel.y *= -0.3;
        }
      }
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

    strikeStep(dt);
    fly(dt);
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
    /** Vliegt de speler zelf weg (opgeblazen)? Dan ligt de besturing stil en stuurt de werper de camera. */
    get flying() {
      return !!flight;
    },
    /** Is er iets kapot? */
    get damaged() {
      return shots > 0;
    },
    /** Voor testen: hoeveel er ligt en wat er kapot is. */
    get stats() {
      return { debris: debris.length, dead: dead.size, puffs: puffs.length, fires: fires.length };
    },
    /** De blokken waar de speler tegenaan loopt, zonder wat er is weggeblazen. */
    passable,
    /** Blokken van robots, voertuigen en mensen, zonder wie nu kapot is. */
    alive,
    /** Staat dit punt in een gat? Daar houdt de rand van de hal de speler niet tegen. */
    free,
    /** Zet alles terug zoals het was. remote: een andere speler deed dat (niet nog eens rondsturen). */
    restore,
    /** De inslag van de raket van een andere speler (by = zijn naam, spare = zijn figuur: dat blijft heel). */
    remoteBlast: (x: number, y: number, z: number, by: string, spare?: THREE.Object3D, nuke = false) => explode(new THREE.Vector3(x, y, z), { by, spare }, nuke),
    /** Alle inslagen tot nu toe, voor een speler die later binnenkomt. */
    zones: () => zones.map((z) => [+z.p.x.toFixed(2), +z.p.y.toFixed(2), +z.p.z.toFixed(2), z.r > BLAST ? 1 : 0]), // het vierde getal: 1 = kernbom
    /** Schade van voor je binnenkwam overnemen: alleen de gaten, zonder knal. */
    applyZones(list: number[][]) {
      for (const [x, y, z, n] of list) explode(new THREE.Vector3(x, y, z), { quiet: true }, n === 1);
    },
    /** Vuurt (voor testen: zonder vastgezette muis). */
    shoot,
    /** Voor testen: een inslag op deze plek. */
    blastAt: (x: number, y: number, z: number, nuke = false) => explode(new THREE.Vector3(x, y, z), undefined, nuke),
    /** Kernbom laden of weer uit de werper halen (zoals toets 4); voor de trailer (src/ui/trailer.ts). */
    loadNuke,
    /** Laat ver weg een kernbom vallen (de knop in de kantine). Geeft false als er al een onderweg is. */
    airstrike,
    /** Is er een kernbom uit de lucht onderweg (of rolt de drukgolf nog)? */
    get striking() {
      return !!strike;
    },
    /** Zit er een kernbom in de werper? */
    get nukeLoaded() {
      return nukeLoaded;
    },
    /** Seconden tot de volgende kernbom klaar is (0 = klaar). */
    get nukeWait() {
      return Math.max(0, Math.ceil(nukeReadyAt - clock));
    },
  };
}
