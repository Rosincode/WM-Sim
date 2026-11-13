import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { readPhoto, type HeadLook } from './headPhoto';
import { EYES, HEAD, MOUTH_V, halfWidth, headFront, headSurface, headY } from './headShape';

// Magazijnmedewerker: gelede figuur op ware grootte (hesje, werkhandschoenen, veiligheidsschoenen) met procedurele
// loopanimatie. Voorkant wijst naar +Z, voeten op y = 0. Geen modelbestanden of skinning: de vorm zit in
// draaiprofielen (ledematen, romp) en een gevormd hoofd. Iedereen draagt een veiligheidshelm; met een foto komen
// het gezicht en de huidskleur van de speler, zie headPhoto.ts.

const HIP_HEIGHT = 0.916; // heupen (draaipunt van de figuur) boven de grond als hij rechtop staat
const HIP_DROP = 0.02; // de heupgewrichten zitten iets onder dat draaipunt
const ANKLE = 0.06; // enkel boven de zool
const HEEL = 0.06; // hiel achter de enkel
const TOE = 0.15; // punt vóór de enkel waarover de voet afrolt
const THIGH = 0.43;
const SHIN = 0.41;
const UPPER_ARM = 0.29;
const FOREARM = 0.26;

export interface CharacterState {
  /** Zit in de heftruck. */
  seated?: boolean;
  /** Hoogte van de heupen (wereld) als de figuur zit. */
  seatHipY?: number;
  /** Draagt iets voor zich uit. */
  carrying?: boolean;
  /** Waar de linker-/rechterhand naartoe reikt (bijv. het stuur); zonder doel volgt de arm de gewone houding. */
  leftHand?: HandTarget;
  rightHand?: HandTarget;
  /** Kijkrichting van het hoofd t.o.v. het lichaam (rad): yaw + = naar links, pitch + = omhoog. */
  look?: { yaw: number; pitch: number };
  /** Wat de figuur zichtbaar vasthoudt: scanner in de rechterhand of tablet voor de borst. */
  tool?: 'scanner' | 'tablet';
  /** 0..1: is aan het scannen (arm richt, laser aan). */
  scan?: number;
  /**
   * Eigen loopsnelheid (m/s, negatief = achteruit). Zonder deze waarde volgt de snelheid uit de verplaatsing;
   * geef hem mee als de figuur ook door iets anders beweegt (opgetild of meegenomen door de heftruck).
   */
  walk?: number;
  /** Is de figuur los van de grond (springen, vallen)? Zonder deze waarde: zodra hij boven de vloer is. */
  airborne?: boolean;
}

export interface HandTarget {
  /** Wereldpositie: het punt waar de handpalm op ligt, of — zonder `normal` — de pols. */
  point: THREE.Vector3;
  /** Normaal van het oppervlak (wereld): de hand ligt er plat op. */
  normal?: THREE.Vector3;
  /** Hand niet tekenen: die zit al aan wat de speler vasthoudt (scanner/tablet in first person). */
  hideHand?: boolean;
}

export function createCharacter(group: THREE.Group = new THREE.Group(), colors: { /** Kleur van het hesje (andere spelers krijgen een eigen kleur). */ vest?: string } = {}) {
  const mat = (color: string, roughness = 0.85, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const vest = mat(colors.vest ?? '#f0590f', 0.8);
  const stripe = new THREE.MeshStandardMaterial({ color: '#e4e7e2', roughness: 0.3, metalness: 0.35, side: THREE.DoubleSide });
  const dark = mat('#17181a', 0.6);
  const shirt = mat('#243349');
  const trousers = mat('#2c313b', 0.9);
  const sole = mat('#0e0e0f', 0.9);
  const glove = mat('#4a4d52', 0.9);
  const skin = mat('#d6a07c', 0.65);
  const helmet = mat('#f2c200', 0.35);

  const mesh = (geo: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(x, y, z);
    o.castShadow = true;
    parent.add(o);
    return o;
  };
  const pivot = (parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };
  const ball = (r: number, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) =>
    mesh(new THREE.SphereGeometry(r, 14, 10), m, parent, x, y, z);
  const lathe = (pts: [number, number][], m: THREE.Material, parent: THREE.Object3D) =>
    mesh(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 24), m, parent);

  /**
   * Vorm uit doorsnedes boven elkaar: per hoogte y een halve breedte (w), de diepte naar voren (f) en naar achteren
   * (b) en hoe hoekig de doorsnede is (n: 2 = ellips, hoger = vierkanter). Tussen de doorsnedes loopt de vorm vloeiend
   * door. Geeft de geometrie en `at`: de doorsnede op een willekeurige hoogte.
   */
  type Ring = { y: number; w: number; f: number; b: number; n?: number };
  function loft(rings: Ring[], grow = 0, from = rings[0].y, to = rings[rings.length - 1].y, closed = true) {
    const key = (k: keyof Ring, i: number) => rings[THREE.MathUtils.clamp(i, 0, rings.length - 1)][k] ?? 2.2;
    const at = (y: number) => {
      let i = 0;
      while (i < rings.length - 2 && y > rings[i + 1].y) i++;
      const t = THREE.MathUtils.clamp((y - rings[i].y) / (rings[i + 1].y - rings[i].y), 0, 1);
      // Catmull-Rom tussen de doorsnedes
      const mix = (k: keyof Ring) => {
        const [p0, p1, p2, p3] = [key(k, i - 1), key(k, i), key(k, i + 1), key(k, i + 2)];
        return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
      };
      return { w: mix('w') + grow, f: mix('f') + grow, b: mix('b') + grow, n: mix('n') };
    };
    const SEG = 64;
    const rows = Math.max(2, Math.round((to - from) / 0.008));
    const pos: number[] = [];
    const index: number[] = [];
    for (let j = 0; j <= rows; j++) {
      const y = from + ((to - from) * j) / rows;
      const r = at(y);
      for (let i = 0; i < SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        pos.push(r.w * Math.sign(c) * Math.abs(c) ** (2 / r.n), y, (sn >= 0 ? r.f : r.b) * Math.sign(sn) * Math.abs(sn) ** (2 / r.n));
        if (j < rows) {
          const p = j * SEG + i;
          const q = j * SEG + ((i + 1) % SEG);
          index.push(p, p + SEG, q, q, p + SEG, q + SEG);
        }
      }
    }
    if (closed) {
      for (const [j, y] of [[0, from], [rows, to]] as const) {
        const centre = pos.length / 3;
        pos.push(0, y, 0);
        for (let i = 0; i < SEG; i++) {
          const p = j * SEG + i;
          const q = j * SEG + ((i + 1) % SEG);
          if (j) index.push(p, centre, q);
          else index.push(q, centre, p);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    return { geo, at };
  }

  // Heupen: alles hangt hieraan, zodat het lichaam als geheel kan deinen en leunen.
  const rig = pivot(group, 0, HIP_HEIGHT, 0);
  mesh(
    loft([
      { y: -0.185, w: 0.04, f: 0.04, b: 0.04 },
      { y: -0.15, w: 0.125, f: 0.085, b: 0.092 },
      { y: -0.09, w: 0.168, f: 0.1, b: 0.112 },
      { y: -0.03, w: 0.168, f: 0.102, b: 0.112 },
      { y: 0.05, w: 0.16, f: 0.098, b: 0.1 },
    ]).geo,
    trousers,
    rig,
  );

  // Romp: het hesje is de romp zelf en valt over de heupen. Taille, borstkas, schouders die aflopen naar de nek.
  const VEST: Ring[] = [
    { y: -0.055, w: 0.186, f: 0.116, b: 0.12 },
    { y: 0.0, w: 0.183, f: 0.114, b: 0.117 },
    { y: 0.1, w: 0.172, f: 0.108, b: 0.102 },
    { y: 0.22, w: 0.174, f: 0.112, b: 0.1, n: 2.3 },
    { y: 0.34, w: 0.188, f: 0.122, b: 0.106, n: 2.5 },
    { y: 0.43, w: 0.197, f: 0.123, b: 0.11, n: 2.5 },
    { y: 0.49, w: 0.198, f: 0.11, b: 0.106, n: 2.4 },
    { y: 0.535, w: 0.168, f: 0.088, b: 0.094 },
    { y: 0.565, w: 0.112, f: 0.068, b: 0.078 },
    { y: 0.592, w: 0.064, f: 0.056, b: 0.06 },
  ];
  const torso = pivot(rig);
  const shell = pivot(torso);
  const body = loft(VEST);
  mesh(body.geo, vest, shell);
  /** Punt op het hesje (iets erboven) op hoogte y, x opzij; voor- of achterkant. */
  const onVest = (x: number, y: number, front: boolean, lift = 0.003) => {
    const r = body.at(y);
    const k = Math.max(0, 1 - Math.abs(x / (r.w + lift)) ** r.n) ** (1 / r.n);
    return new THREE.Vector3(x, y, front ? (r.f + lift) * k : -(r.b + lift) * k);
  };
  /** Band die over het hesje loopt van `y0` omhoog; met `over`: over de schouder en langs de rug weer omlaag. */
  function band(x: number, width: number, y0: number, y1: number, over: boolean, m: THREE.Material) {
    const pos: number[] = [];
    const index: number[] = [];
    const edges = [x - width / 2, x + width / 2];
    // elke rand loopt tot waar het hesje daar ophoudt (de schouder)
    const tops = edges.map((e) => {
      if (!over) return y1;
      let lo = y0;
      let hi = y1;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (body.at(mid).w + 0.003 > Math.abs(e) * 1.001) lo = mid;
        else hi = mid;
      }
      return lo;
    });
    const N = 30;
    const steps = over ? 2 * N : N;
    for (let i = 0; i <= steps; i++) {
      const front = i <= N;
      const t = (front ? i : steps - i) / N;
      edges.forEach((e, k) => {
        const p = onVest(e, y0 + (tops[k] - y0) * (1 - (1 - t) ** 1.6), front); // dichter op elkaar bij de schouder
        pos.push(p.x, p.y + 0.002 * t, p.z);
      });
      if (i < steps) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    return mesh(geo, m, shell);
  }
  // Reflecterende banden: één rond de taille, twee over de schouders; rits midden voor.
  mesh(loft(VEST, 0.003, 0, 0.045, false).geo, stripe, shell);
  for (const side of [1, -1]) band(side * 0.086, 0.036, 0.045, 0.59, true, stripe);
  band(0, 0.009, -0.053, 0.575, false, dark);
  // Kraag van het shirt en de nek
  mesh(new THREE.CylinderGeometry(0.058, 0.072, 0.03, 20), shirt, torso, 0, 0.59, 0.002);
  const neck = lathe([[0.062, -0.075], [0.054, -0.035], [0.049, 0.01], [0.049, 0.065]], skin, torso);
  neck.position.set(0, 0.63, 0.002);
  neck.rotation.x = 0.1;
  neck.scale.z = 1.08;

  // Hoofd: een bol die tot hoofd is gevormd (headShape.ts).
  const head = pivot(torso, 0, 0.62, 0);
  const skull = pivot(head, 0, HEAD.y, HEAD.z);
  const SEG_W = 112;
  const SEG_H = 80;
  const headGeo = new THREE.SphereGeometry(1, SEG_W, SEG_H, -Math.PI / 2); // naad achterop
  {
    const pos = headGeo.attributes.position;
    const pt = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < pos.count; i++) {
      headSurface(pos.getX(i), pos.getY(i), pos.getZ(i), pt);
      pos.setXYZ(i, pt.x, pt.y, pt.z);
    }
    headGeo.computeVertexNormals();
    // Naad en polen: punten op dezelfde plek krijgen dezelfde normaal, anders is er een vouw te zien.
    const nor = headGeo.attributes.normal;
    const n = new THREE.Vector3();
    for (let iy = 0; iy <= SEG_H; iy++) {
      const first = iy * (SEG_W + 1);
      const same = iy === 0 || iy === SEG_H ? Array.from({ length: SEG_W + 1 }, (_, ix) => first + ix) : [first, first + SEG_W];
      n.set(0, 0, 0);
      for (const i of same) n.set(n.x + nor.getX(i), n.y + nor.getY(i), n.z + nor.getZ(i));
      n.normalize();
      for (const i of same) nor.setXYZ(i, n.x, n.y, n.z);
    }
    headGeo.computeBoundingSphere();
  }
  const skinColor = skin.color.clone();
  const headMat = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.65 });
  mesh(headGeo, headMat, skull);

  // Oren
  [1, -1].forEach((side) => {
    const ear = ball(1, skin, skull, side * halfWidth(-0.012) * 0.98, -0.012, -0.012);
    ear.scale.set(0.011, 0.031, 0.019);
    ear.rotation.set(0.12, side * 0.4, 0);
  });
  // Het gewone gezicht (zonder foto): ogen, wenkbrauwen en mond; de neus zit in de vorm van het hoofd.
  const features: THREE.Object3D[] = [];
  const white = mat('#f1efe9', 0.5);
  const eyeY = headY(EYES.v);
  for (const side of [1, -1]) {
    const e = headFront(side * 0.031, eyeY);
    const eye = ball(0.0115, white, skull, e.x, e.y, e.z - 0.004);
    eye.scale.set(1.15, 0.72, 0.6);
    features.push(eye, ball(0.005, dark, skull, e.x, e.y, e.z + 0.0018));
    const b = headFront(side * 0.033, eyeY + 0.021);
    const brow = mesh(new THREE.CapsuleGeometry(0.0038, 0.022, 4, 8), dark, skull, b.x, b.y, b.z);
    brow.rotation.set(0, side * 0.35, Math.PI / 2 - side * 0.12);
    features.push(brow);
  }
  const lips = headFront(0, headY(MOUTH_V));
  const mouth = mesh(new THREE.CapsuleGeometry(0.0035, 0.03, 4, 8), mat('#9a5c4c', 0.7), skull, lips.x, lips.y, lips.z);
  mouth.rotation.z = Math.PI / 2;
  features.push(mouth);
  // Veiligheidshelm, op elk hoofd: een volle schaal met een opstaande rand rondom, een klep voor, een kam over
  // het midden met een lagere ribbel aan weerszijden, en binnenin de draagband die achter onder de rand uitkomt.
  const helm = pivot(skull, 0, 0.05, -0.004);
  const HELM = { w: 0.089, d: 0.107, h: 0.09 }; // halve breedte, halve diepte en hoogte van de schaal
  const dome: [number, number][] = [[0.95, 0.001], [1.02, -0.003], [1.045, 0.002], [1.035, 0.008], [1, 0.013]];
  for (let k = 1; k <= 14; k++) {
    const a = (k / 14) * (Math.PI / 2);
    dome.push([Math.max(0.001, Math.cos(a) ** 0.72), 0.013 + (HELM.h - 0.013) * Math.sin(a)]);
  }
  const domeGeo = new THREE.LatheGeometry(dome.map(([r, y]) => new THREE.Vector2(r, y)), 40);
  const helmetShell = helmet.clone();
  helmetShell.side = THREE.DoubleSide; // van onderen kijk je in de schaal
  mesh(domeGeo, helmetShell, helm).scale.set(HELM.w, 1, HELM.d);
  // kam en ribbels: dezelfde schaal, smal en net iets hoger, zodat ze er een paar millimeter bovenuit komen
  const ridgeGeo = new THREE.LatheGeometry(dome.slice(4).map(([r, y]) => new THREE.Vector2(r, y)), 40);
  mesh(ridgeGeo, helmet, helm).scale.set(0.012, 1.045, HELM.d * 1.012);
  for (const side of [1, -1]) {
    const rib = mesh(ridgeGeo, helmet, helm, side * 0.03, -0.004, 0);
    rib.scale.set(0.008, 1, HELM.d * 0.93);
    rib.rotation.z = -side * 0.3;
  }
  // klep: een platte, ronde lip die schuin naar voren afloopt
  const peak = mesh(new THREE.SphereGeometry(1, 24, 10), helmet, helm, 0, 0.001, HELM.d * 0.86);
  peak.scale.set(HELM.w * 0.8, 0.0045, 0.045);
  peak.rotation.x = 0.22;
  // draagband met stelknop in de nek
  const strap = mesh(new THREE.CylinderGeometry(1, 1, 0.016, 32, 1, true), dark, helm, 0, -0.012, -0.004);
  strap.scale.set(0.077, 1, 0.093);
  mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.008, 16), dark, helm, 0, -0.012, -0.099).rotation.x = Math.PI / 2;

  /** Ledemaat dat vanaf het draaipunt naar beneden hangt: draaiprofiel [straal, y] met een ronde bovenkant. */
  const limb = (pts: [number, number][], m: THREE.Material, parent: THREE.Object3D, sx = 1, sz = 1) => {
    ball(pts[0][0], m, parent).scale.set(sx, 1, sz);
    const o = lathe([...pts].reverse(), m, parent); // van onder naar boven: buitenkant naar buiten
    o.scale.set(sx, 1, sz);
    return o;
  };

  const palmGeo = new RoundedBoxGeometry(0.03, 0.09, 0.084, 3, 0.013);
  function arm(side: number) {
    const shoulder = pivot(torso, side * 0.203, 0.495, 0);
    shoulder.rotation.z = side * 0.04;
    // Mouw tot de elleboog: schouderkop, bovenarm en een zoom
    limb([[0.057, 0], [0.056, -0.07], [0.05, -0.18], [0.047, -0.262], [0.049, -0.27], [0.049, -0.286], [0.03, -0.29]], shirt, shoulder, 1, 1.05);
    const elbow = pivot(shoulder, 0, -UPPER_ARM, 0);
    limb([[0.041, 0], [0.043, -0.05], [0.039, -0.12], [0.031, -0.2], [0.028, -FOREARM]], skin, elbow, 0.92, 1);
    // Hand in een werkhandschoen aan een pols, zodat hij plat op het stuur kan liggen. Vingers wijzen langs -y,
    // de handpalm naar het lichaam; elke vinger heeft twee kootjes en is licht gekromd.
    const wrist = pivot(elbow, 0, -FOREARM, 0);
    mesh(new THREE.CylinderGeometry(0.031, 0.035, 0.03, 14), glove, wrist, 0, -0.006, 0).scale.set(0.8, 1, 1); // manchet
    mesh(palmGeo, glove, wrist, 0, -0.05, 0.002);
    [0.031, 0.0105, -0.01, -0.03].forEach((z, i) => {
      const len = [0.92, 1, 0.94, 0.76][i];
      const knuckle = pivot(wrist, 0, -0.088, z);
      knuckle.rotation.z = -side * 0.14;
      mesh(new THREE.CapsuleGeometry(0.0094, 0.022 * len, 4, 8), glove, knuckle, 0, -0.016 * len, 0);
      const tip = pivot(knuckle, 0, -0.032 * len, 0);
      tip.rotation.z = -side * 0.32;
      mesh(new THREE.CapsuleGeometry(0.0088, 0.018 * len, 4, 8), glove, tip, 0, -0.013 * len, 0);
    });
    const thumb = pivot(wrist, -side * 0.006, -0.03, 0.04);
    thumb.rotation.x = -0.6;
    mesh(new THREE.CapsuleGeometry(0.0115, 0.022, 4, 8), glove, thumb, 0, -0.014, 0);
    const thumbTip = pivot(thumb, 0, -0.03, 0);
    thumbTip.rotation.set(0.25, 0, -side * 0.25);
    mesh(new THREE.CapsuleGeometry(0.0098, 0.018, 4, 8), glove, thumbTip, 0, -0.012, 0);
    return { side, shoulder, elbow, wrist, restZ: shoulder.rotation.z, reach: 0 };
  }

  // Arm naar een doel laten reiken (tweebots-IK in de ruimte van de romp); w = 0..1 mengt met de gewone houding.
  const PALM = 0.016; // halve dikte van de handpalm
  const wristW = new THREE.Vector3();
  const fingers = new THREE.Vector3();
  const toTarget = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const pole = new THREE.Vector3();
  const perp = new THREE.Vector3();
  const upper = new THREE.Vector3();
  const lower = new THREE.Vector3();
  const bx = new THREE.Vector3();
  const by = new THREE.Vector3();
  const bz = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const qIK = new THREE.Quaternion();
  const qArm = new THREE.Quaternion();
  const qHand = new THREE.Quaternion();

  function reachFor(a: ReturnType<typeof arm>, target: HandTarget, w: number) {
    torso.updateWorldMatrix(true, false);
    const n = target.normal;
    wristW.copy(target.point);
    if (n) {
      // vingers wijzen van de schouder af, plat over het oppervlak; de pols ligt een handpalm terug
      a.shoulder.getWorldPosition(fingers);
      fingers.subVectors(target.point, fingers);
      fingers.addScaledVector(n, -fingers.dot(n)).normalize();
      wristW.addScaledVector(n, PALM).addScaledVector(fingers, -0.05);
    }
    toTarget.copy(wristW);
    torso.worldToLocal(toTarget).sub(a.shoulder.position);
    const d = THREE.MathUtils.clamp(toTarget.length(), 0.08, UPPER_ARM + FOREARM - 0.004);
    dir.copy(toTarget).normalize();
    // elleboog wijst omlaag en naar buiten
    pole.set(a.side * 0.6, -1, -0.25);
    perp.copy(pole).addScaledVector(dir, -pole.dot(dir)).normalize();
    const cosA = THREE.MathUtils.clamp((UPPER_ARM ** 2 + d * d - FOREARM ** 2) / (2 * UPPER_ARM * d), -1, 1);
    upper.copy(dir).multiplyScalar(cosA).addScaledVector(perp, Math.sqrt(1 - cosA * cosA));
    lower.copy(dir).multiplyScalar(d).addScaledVector(upper, -UPPER_ARM).normalize();
    // schouder: -y langs de bovenarm, z in het vlak van de buiging (de elleboog scharniert om x)
    by.copy(upper).negate();
    bz.copy(lower).addScaledVector(upper, -lower.dot(upper)).normalize();
    bx.crossVectors(by, bz);
    qIK.setFromRotationMatrix(basis.makeBasis(bx, by, bz));
    a.shoulder.quaternion.slerp(qIK, w);
    a.elbow.rotation.x = THREE.MathUtils.lerp(a.elbow.rotation.x, -Math.acos(THREE.MathUtils.clamp(upper.dot(lower), -1, 1)), w);
    if (!n) {
      a.wrist.quaternion.identity();
      return;
    }
    // pols: handpalm tegen het oppervlak
    bx.copy(n).multiplyScalar(a.side);
    by.copy(fingers).negate();
    bz.crossVectors(bx, by);
    qHand.setFromRotationMatrix(basis.makeBasis(bx, by, bz));
    torso.getWorldQuaternion(qArm).multiply(a.shoulder.quaternion).multiply(a.elbow.quaternion);
    qHand.premultiply(qArm.invert());
    a.wrist.quaternion.identity().slerp(qHand, w);
  }

  /**
   * Vorm van een schoen (in het draaipunt van de enkel): een bol met een korte hiel en een lange neus. `top` geeft
   * de hoogte boven `y` per plek langs de voet (-1 hiel .. 1 neus), `under` de dikte eronder.
   */
  function shoe(width: number, top: (dz: number) => number, y: number, under: number) {
    const geo = new THREE.SphereGeometry(1, 20, 14);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const dy = pos.getY(i);
      const dz = pos.getZ(i);
      // stompe hiel en neus in plaats van een punt, en breder bij de bal van de voet
      const blunt = Math.cbrt(1 - Math.abs(dz) ** 3) / Math.max(1e-4, Math.sqrt(1 - dz * dz));
      const wide = width * blunt * (1 + 0.1 * THREE.MathUtils.smoothstep(dz, -0.6, 0.5));
      pos.setXYZ(i, pos.getX(i) * wide, y + dy * blunt * (dy > 0 ? top(dz) : under), 0.012 + dz * (dz < 0 ? 0.072 : 0.162));
    }
    geo.computeVertexNormals();
    return geo;
  }

  function leg(side: number) {
    const hip = pivot(rig, side * 0.094, -HIP_DROP, 0);
    // Werkbroek: bovenbeen, knie, kuit (iets naar achteren) en een zoom op de schoen
    limb([[0.084, 0], [0.088, -0.07], [0.085, -0.18], [0.075, -0.31], [0.068, -THIGH]], trousers, hip);
    const knee = pivot(hip, 0, -THIGH, 0);
    limb([[0.068, 0], [0.069, -0.09], [0.064, -0.2], [0.056, -0.32], [0.054, -0.385], [0.056, -0.392], [0.056, -0.405], [0.03, -SHIN]], trousers, knee, 0.96, 1.06);
    const foot = pivot(knee, 0, -SHIN, 0);
    // Veiligheidsschoen: hoge hiel en wreef, lage ronde neus, zool eronder
    mesh(shoeGeo, dark, foot);
    mesh(soleGeo, sole, foot);
    return { side, hip, knee, foot };
  }

  const shoeGeo = shoe(0.045, (dz) => 0.078 - 0.03 * THREE.MathUtils.smoothstep(dz, -0.1, 0.6), -0.042, 0.004);
  const soleGeo = shoe(0.049, () => 0.012, -0.048, 0.012);
  const arms = [arm(1), arm(-1)];
  const legs = [leg(1), leg(-1)];
  head.rotation.order = 'YXZ';

  // Wat de figuur vasthoudt, zoals anderen het zien: scanner in de rechterhand, tablet voor de borst.
  const device = mat('#25272b', 0.55);
  const accent = mat('#f2b705', 0.5);
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  // Met de onderarm naar voren wijst in de pols -y vooruit en +z omhoog.
  const scanner = pivot(arms[1].wrist, 0.012, -0.075, 0.05);
  mesh(box(0.07, 0.17, 0.034), device, scanner);
  mesh(box(0.074, 0.014, 0.038), accent, scanner, 0, -0.08, 0);
  mesh(box(0.074, 0.012, 0.038), accent, scanner, 0, 0.08, 0);
  mesh(box(0.056, 0.08, 0.002), new THREE.MeshBasicMaterial({ color: '#2a6fd0' }), scanner, 0, -0.02, 0.018).castShadow = false;
  const laser = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  laser.color.setRGB(5, 0.25, 0.2);
  const beam = mesh(box(0.005, 6, 0.005), laser, scanner, 0, -3.09, 0);
  beam.castShadow = false;
  const tablet = pivot(torso, 0, 0.24, 0.36);
  tablet.rotation.x = -0.6; // scherm schuin naar het gezicht
  mesh(box(0.272, 0.012, 0.182), device, tablet);
  mesh(box(0.24, 0.002, 0.15), new THREE.MeshBasicMaterial({ color: '#dfe7f1' }), tablet, 0, 0.007, 0).castShadow = false;
  mesh(box(0.24, 0.0022, 0.016), new THREE.MeshBasicMaterial({ color: '#17346b' }), tablet, 0, 0.0072, -0.067).castShadow = false;
  const tabletHands: HandTarget[] = [{ point: new THREE.Vector3() }, { point: new THREE.Vector3() }];
  scanner.visible = tablet.visible = false;
  let holdScanner = 0;
  let holdTablet = 0;

  const prev = new THREE.Vector3();
  let hasPrev = false;
  let speed = 0; // gladgestreken loopsnelheid (m/s), negatief = achteruit
  let phase = 0; // loopcyclus
  let time = 0;
  let seat = 0; // 0..1 overgang naar zithouding
  let carry = 0;
  let air = 0;
  let hipY = HIP_HEIGHT - HIP_DROP; // hoogte van de heupgewrichten
  let land = 0; // 1 vlak na het neerkomen: door de knieën
  let lean = 0; // voorover bij optrekken, achterover bij afremmen
  let roll = 0; // de bocht in hangen
  let prevYaw = 0;
  let prevSpeed = 0;
  let wasAir = false;

  /**
   * Waar de enkel is op een plek in de pas (ph 0..1; 0 = de voet komt neer): z vóór de heup, y boven de grond, en
   * hoe de voet gekanteld is (pitch, + = hiel omhoog). Tijdens het staan (ph < duty) blijft de voet op zijn plek op
   * de grond terwijl het lichaam er `stride` meter overheen gaat: hij komt neer op de hiel, ligt vlak en rolt af
   * over de tenen. Daarna zwaait hij naar voren, `lift` hoog.
   */
  type Foot = { z: number; y: number; pitch: number; stance: boolean };
  const feet: Foot[] = [0, 1].map(() => ({ z: 0, y: ANKLE, pitch: 0, stance: true }));
  const from: Foot = { z: 0, y: 0, pitch: 0, stance: true };
  const to: Foot = { z: 0, y: 0, pitch: 0, stance: true };
  function planted(s: number, stride: number, strike: number, out: Foot) {
    const heel = Math.min(0.36 * stride, 0.34) - HEEL - stride * s; // de hiel als de voet vlak zou staan
    const k = Math.min(1, stride / 0.75);
    const pitch = s < 0.18 ? -strike * k * (1 - s / 0.18) : s > 0.45 ? 0.95 * k * ((s - 0.45) / 0.55) ** 2 : 0;
    const c = Math.cos(pitch);
    const sn = Math.sin(Math.abs(pitch));
    out.z = pitch <= 0 ? heel + HEEL * c - ANKLE * sn : heel + HEEL + TOE - TOE * c + ANKLE * sn;
    out.y = (pitch <= 0 ? HEEL : TOE) * sn + ANKLE * c;
    out.pitch = pitch;
    out.stance = true;
  }
  function footAt(ph: number, duty: number, stride: number, strike: number, lift: number, out: Foot) {
    if (ph < duty) return planted(ph / duty, stride, strike, out);
    const u = (ph - duty) / (1 - duty);
    planted(1, stride, strike, from);
    planted(0, stride, strike, to);
    const e = u * u * (3 - 2 * u);
    out.z = from.z + (to.z - from.z) * e;
    out.y = from.y + (to.y - from.y) * e + lift * Math.sin(Math.PI * u ** 0.8);
    out.pitch = from.pitch + (to.pitch - from.pitch) * THREE.MathUtils.smoothstep(u, 0.1, 0.85);
    out.stance = false;
  }
  const LEG_MAX = THIGH + SHIN - 0.004; // nooit helemaal gestrekt

  const ease = (cur: number, target: number, dt: number, rate: number) => cur + (target - cur) * (1 - Math.exp(-dt * rate));

  /** Aanroepen na het verplaatsen van de speler; de snelheid volgt uit de verplaatsing. */
  function update(dt: number, state: CharacterState = {}) {
    time += dt;
    const p = group.position;
    let raw = 0;
    if (state.walk !== undefined) {
      raw = state.seated ? 0 : THREE.MathUtils.clamp(state.walk, -10, 10);
    } else if (hasPrev && dt > 0 && !state.seated) {
      const dx = p.x - prev.x;
      const dz = p.z - prev.z;
      const along = dx * Math.sin(group.rotation.y) + dz * Math.cos(group.rotation.y);
      raw = Math.min(Math.hypot(dx, dz) / dt, 10) * (along < -1e-5 ? -1 : 1); // min: teleporteren telt niet als sprint
    }
    prev.copy(p);
    hasPrev = true;

    speed = ease(speed, raw, dt, 10);
    seat = ease(seat, state.seated ? 1 : 0, dt, 8);
    carry = ease(carry, state.carrying && !state.seated ? 1 : 0, dt, 8);
    air = ease(air, !state.seated && (state.airborne ?? p.y > 0.02) ? 1 : 0, dt, 14);

    const abs = Math.abs(speed);
    const gait = THREE.MathUtils.smoothstep(abs, 0.1, 0.7) * (1 - seat); // 0 = staan, 1 = in beweging
    const run = THREE.MathUtils.smoothstep(abs, 2, 4.2); // 0 = lopen, 1 = rennen (met zweeffase)
    const sprint = THREE.MathUtils.smoothstep(abs, 5.5, 9);
    // Pasfrequentie (hele passen per seconde), welk deel van de pas een voet aan de grond staat, en hoe ver het
    // lichaam in die tijd over de voet heen gaat: zo staan de voeten stil op de grond in plaats van te glijden.
    const freq = THREE.MathUtils.lerp(0.8 * Math.pow(abs, 0.42), 1.5 + 0.19 * (abs - 5), run);
    const duty = THREE.MathUtils.lerp(0.62, Math.max(0.2, 0.29 - 0.0175 * (abs - 5)), run);
    const stride = Math.min((abs * duty) / Math.max(freq, 0.1), 1.05) * (1 - seat);
    phase += Math.sign(speed) * freq * dt * (abs > 0.05 ? 1 : 0);
    phase -= Math.floor(phase);
    const turn = Math.PI * 2 * phase;
    const breathe = Math.sin(time * 1.6);
    const idle = 1 - gait;

    // Optrekken, afremmen, bochten en neerkomen
    const yaw = group.rotation.y;
    const yawRate = dt > 0 ? Math.atan2(Math.sin(yaw - prevYaw), Math.cos(yaw - prevYaw)) / dt : 0;
    const accel = dt > 0 ? (speed - prevSpeed) / dt : 0;
    prevYaw = yaw;
    prevSpeed = speed;
    lean = ease(lean, THREE.MathUtils.clamp(accel * 0.012, -0.1, 0.12), dt, 8);
    roll = ease(roll, THREE.MathUtils.clamp(-yawRate * abs * 0.012, -0.14, 0.14), dt, 6);
    const flying = air > 0.5;
    if (wasAir && !flying) land = 1;
    wasAir = flying;
    land = ease(land, 0, dt, 7);

    // Voeten: waar ze horen te staan
    const strike = THREE.MathUtils.lerp(0.28, 0.06, run);
    const lift = THREE.MathUtils.lerp(0.05 + 0.04 * gait, 0.3 + 0.16 * sprint, run) * gait;
    feet.forEach((f, i) => footAt((phase + i * 0.5) % 1, duty, stride, strike, lift, f));
    // Heupen: lopend zo hoog als het been dat staat toelaat (het hoogst boven de voet, het laagst met beide voeten
    // aan de grond); rennend veren ze in op de landing en komen ze los in de zweeffase.
    let high = HIP_HEIGHT - HIP_DROP - 0.012 * gait;
    for (const f of feet) if (f.stance) high = Math.min(high, f.y + Math.sqrt(Math.max(0.3, LEG_MAX * LEG_MAX - f.z * f.z)));
    const bounce = HIP_HEIGHT - HIP_DROP - 0.07 - 0.035 * Math.cos(2 * turn - Math.PI * 2 * duty);
    const standHip = THREE.MathUtils.lerp(high, bounce, run * gait) - 0.1 * land * (1 - air) + 0.004 * breathe * idle;
    hipY = ease(hipY, standHip, dt, 30);
    const seatY = (state.seatHipY ?? 0.5) - p.y;
    rig.position.y = THREE.MathUtils.lerp(hipY + HIP_DROP, seatY, seat);

    legs.forEach((l, i) => {
      // Tweebots-IK van heup naar enkel, de knie naar voren
      const f = feet[i];
      const ty = f.y - hipY;
      const d = THREE.MathUtils.clamp(Math.hypot(f.z, ty), 0.3, LEG_MAX);
      const reach = Math.atan2(f.z, -ty) + Math.acos(THREE.MathUtils.clamp((THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d), -1, 1));
      let hip = -reach;
      let knee = Math.PI - Math.acos(THREE.MathUtils.clamp((THIGH * THIGH + SHIN * SHIN - d * d) / (2 * THIGH * SHIN), -1, 1));
      let foot = f.pitch - hip - knee;
      // In de lucht: benen iets opgetrokken, tenen omlaag
      hip = THREE.MathUtils.lerp(hip, i ? -0.25 : -0.55, air);
      knee = THREE.MathUtils.lerp(knee, i ? 0.75 : 1.0, air);
      foot = THREE.MathUtils.lerp(foot, 0.35, air);
      // Zittend: bovenbenen naar voren, onderbenen omlaag
      hip = THREE.MathUtils.lerp(hip, -1.42, seat);
      knee = THREE.MathUtils.lerp(knee, 1.3, seat);
      // lopend de voeten dichter bij elkaar dan de heupen; zittend de knieën iets uit elkaar, om de stuurkolom
      l.hip.rotation.z = l.side * (0.1 * seat - 0.035 * gait * (1 - seat));
      l.hip.rotation.x = hip;
      l.knee.rotation.x = knee;
      l.foot.rotation.x = THREE.MathUtils.lerp(foot, 0.1, seat);
    });

    // Scanner/tablet in de hand (niet terwijl je iets draagt)
    const tool = state.carrying ? undefined : state.tool;
    const scan = state.scan ?? 0;
    const lookPitch = THREE.MathUtils.clamp(state.look?.pitch ?? 0, -1.1, 1.1);
    const lookYaw = THREE.MathUtils.clamp(state.look?.yaw ?? 0, -1.3, 1.3);
    holdScanner = ease(holdScanner, tool === 'scanner' ? 1 : 0, dt, 10);
    holdTablet = ease(holdTablet, tool === 'tablet' ? 1 : 0, dt, 10);
    scanner.visible = holdScanner > 0.05;
    tablet.visible = holdTablet > 0.05;
    beam.visible = scan > 0 && holdScanner > 0.5;
    laser.opacity = Math.min(1, scan * 3);
    tablet.position.x = -0.2 * seat; // rijdend: in de rechterhand, naast het stuur

    // Armen zwaaien tegen het been aan dezelfde kant in: lopend losjes en bijna gestrekt, rennend gebogen en krachtig.
    const swingAmp = THREE.MathUtils.lerp(0.42 * Math.min(1, stride / 0.8), 0.7 + 0.25 * sprint, run) * gait * (1 - carry);
    arms.forEach((a, i) => {
      const legForward = Math.cos(turn + i * Math.PI - 0.25); // + = het been aan deze kant is voor
      const forward = Math.max(0, -legForward); // de arm is dan juist achter
      let shoulder = swingAmp * (legForward + 0.15 * run) + 0.03 * breathe * idle;
      let elbow = -THREE.MathUtils.lerp(0.16 + 0.1 * gait + 0.35 * swingAmp * forward, 1.35 + 0.35 * forward, run * gait * (1 - carry));
      shoulder = THREE.MathUtils.lerp(shoulder, -0.95, carry); // dragen: armen voor zich uit
      elbow = THREE.MathUtils.lerp(elbow, -0.55, carry);
      shoulder = THREE.MathUtils.lerp(shoulder, i ? -0.2 : -1.2, air * (1 - carry));
      shoulder = THREE.MathUtils.lerp(shoulder, -0.85, seat); // handen aan het stuur
      elbow = THREE.MathUtils.lerp(elbow, -0.75, seat);
      if (i) {
        // scanner: onderarm naar voren, richt mee met de blik; bij scannen strekt de arm
        shoulder = THREE.MathUtils.lerp(shoulder, -0.45 - lookPitch * 0.8 - 0.3 * scan, holdScanner);
        elbow = THREE.MathUtils.lerp(elbow, -1.15 + 0.4 * scan, holdScanner);
      }
      a.shoulder.rotation.set(shoulder, 0, a.restZ + a.side * 0.1 * run * gait * (1 - carry) * (1 - seat));
      a.elbow.rotation.x = elbow;
    });

    // Bekken en romp: het bekken draait mee met het voorste been en zakt aan de kant van het zwaaiende been, de
    // schouders draaien ertegenin; voorover bij tempo en bij optrekken, de bocht in hangen. Het hoofd blijft recht.
    const lead = Math.cos(turn) * gait; // + = linkerbeen (i = 0) voor
    const support = Math.cos(turn - Math.PI * duty) * gait; // + = het gewicht op het linkerbeen
    const sway = Math.sin(time * 0.55) * idle * (1 - seat); // stilstaand: gewicht rustig van been naar been
    rig.rotation.y = -(0.07 + 0.05 * run) * lead;
    rig.rotation.z = (0.035 - 0.015 * run) * support + 0.012 * sway;
    rig.position.x = (0.022 - 0.012 * run) * support + 0.008 * sway;
    torso.rotation.y = (0.07 + 0.05 * run + (0.1 + 0.08 * run) * (1 - carry)) * lead;
    torso.rotation.x = (0.03 + 0.11 * run + 0.07 * sprint) * gait * Math.sign(speed || 1) + lean * (1 - seat) + 0.1 * carry - 0.08 * seat + 0.12 * land * (1 - air);
    torso.rotation.z = -0.7 * rig.rotation.z + roll * (1 - seat);
    head.rotation.y = -(rig.rotation.y + torso.rotation.y) * 0.85 + lookYaw;
    head.rotation.x = -torso.rotation.x * 0.6 - lookPitch * 0.75;
    head.rotation.z = -0.5 * (rig.rotation.z + torso.rotation.z);
    shell.scale.z = 1 + 0.018 * breathe;

    // Handen met een doel (stuur, scanner/tablet): pas nu, want de romp staat in zijn eindstand
    arms.forEach((a, i) => {
      let target = i ? state.rightHand : state.leftHand;
      if (!target && tool === 'tablet' && tablet.visible && (i || !state.seated)) {
        // handen aan de zijkanten van de tablet (rijdend alleen rechts)
        tablet.updateWorldMatrix(true, false);
        target = tabletHands[i];
        tablet.localToWorld(target.point.set(i ? -0.15 : 0.15, -0.02, -0.04));
      }
      a.reach = target ? ease(a.reach, 1, dt, 10) : 0;
      a.wrist.visible = !target?.hideHand;
      if (target) reachFor(a, target, a.reach);
      else a.wrist.quaternion.identity();
    });
  }

  /**
   * Foto van de speler op het hoofd zetten (null = het gewone gezicht). Het gezicht en de huidskleur komen van de
   * foto; de rest van het hoofd krijgt die huidskleur. De helm blijft op.
   */
  let look: HeadLook | null = null;
  function setFace(image: HTMLImageElement | HTMLCanvasElement | null) {
    look?.texture.dispose();
    look = image ? readPhoto(image) : null;
    headMat.map = look?.texture ?? null;
    headMat.color.set(look ? '#ffffff' : skinColor);
    headMat.needsUpdate = true;
    skin.color.copy(look?.skin ?? skinColor);
    for (const f of features) f.visible = !look;
  }

  /** First person in de heftruck: het hoofd niet tekenen, de camera zit op die plek. */
  function setFirstPerson(on: boolean) {
    head.visible = neck.visible = !on;
  }

  update(0);
  return {
    group,
    update,
    setFirstPerson,
    setFace,
    /** De rechterpols: hang hier iets aan dat de figuur in zijn hand houdt (met de onderarm naar voren is +z omhoog en +x naar binnen). */
    rightHand: arms[1].wrist as THREE.Object3D,
  };
}
