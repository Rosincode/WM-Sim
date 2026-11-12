import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { readPhoto, type HeadLook } from './headPhoto';
import { EYES, HEAD, MOUTH_V, halfWidth, headFront, headSurface, headY } from './headShape';

// Magazijnmedewerker: gelede figuur op ware grootte (hesje, werkhandschoenen, veiligheidsschoenen) met procedurele
// loopanimatie. Voorkant wijst naar +Z, voeten op y = 0. Geen modelbestanden of skinning: de vorm zit in
// draaiprofielen (ledematen, romp) en een gevormd hoofd. Zonder foto draagt hij een helm; met een foto is het
// hoofd dat van de speler: gezicht, huidskleur en haar (of kaal) komen van de foto, zie headPhoto.ts.

const HIP_HEIGHT = 0.9;
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
  const shirt = mat('#243349');
  const trousers = mat('#2c313b', 0.9);
  const dark = mat('#17181a', 0.6);
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

  // Heupen: alles hangt hieraan, zodat het lichaam als geheel kan deinen en leunen.
  const rig = pivot(group, 0, HIP_HEIGHT, 0);
  const pelvis = lathe([[0.001, -0.17], [0.09, -0.16], [0.148, -0.1], [0.162, -0.02], [0.158, 0.05]], trousers, rig);
  pelvis.scale.set(1.05, 1, 0.55);

  // Romp: draaiprofiel van heup naar schouders, afgeplat tot een borstkas. Het hesje is de romp zelf en valt over de heupen.
  const SX = 1.08;
  const SZ = 0.64;
  const PROFILE: [number, number][] = [
    [0.001, -0.09], [0.176, -0.1], [0.172, -0.02], [0.16, 0.08], [0.158, 0.16], [0.172, 0.3], [0.19, 0.43], [0.186, 0.5], [0.15, 0.556], [0.075, 0.59], [0.001, 0.6],
  ];
  const radiusAt = (y: number) => {
    for (let i = 1; i < PROFILE.length; i++) {
      const [r0, y0] = PROFILE[i - 1];
      const [r1, y1] = PROFILE[i];
      if (y <= y1) return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
    }
    return 0;
  };
  const torso = pivot(rig);
  const shell = pivot(torso);
  shell.scale.set(SX, 1, SZ);
  lathe(PROFILE, vest, shell);
  // Reflecterende banden: één rond de taille, twee over de schouders
  lathe([[radiusAt(0) + 0.004, 0], [radiusAt(0.045) + 0.004, 0.045]], stripe, shell);
  for (const side of [1, -1]) {
    const x = side * 0.088;
    const onSurface = (y: number, dir: number) => {
      const r = radiusAt(y) + 0.004;
      return new THREE.Vector3(x, y, dir * SZ * r * Math.sqrt(Math.max(0, 1 - (x / (SX * r)) ** 2)));
    };
    const ys = [0.045, 0.15, 0.27, 0.38, 0.46, 0.52, 0.55];
    const path = new THREE.CatmullRomCurve3([
      ...ys.map((y) => onSurface(y, 1)),
      new THREE.Vector3(x, 0.574, 0),
      ...ys.reverse().map((y) => onSurface(y, -1)),
    ]);
    mesh(new THREE.TubeGeometry(path, 28, 0.015, 6), stripe, torso).scale.set(1, 1, 1);
  }
  // Kraag van het shirt en de nek
  mesh(new THREE.CylinderGeometry(0.06, 0.084, 0.045, 20), shirt, torso, 0, 0.578, 0.004);
  const neck = mesh(new THREE.CylinderGeometry(0.047, 0.055, 0.13, 18), skin, torso, 0, 0.63, 0.002);
  neck.rotation.x = 0.1;

  // Hoofd: een bol die tot hoofd is gevormd (headShape.ts). De richting van elk punt vanuit het midden blijft
  // bewaard, zodat de vorm opnieuw kan worden opgebouwd als er haar bij komt.
  const head = pivot(torso, 0, 0.62, 0);
  const skull = pivot(head, 0, HEAD.y, HEAD.z);
  const SEG_W = 80;
  const SEG_H = 56;
  const HAIR = 0.014; // dikte van het haar
  const headGeo = new THREE.SphereGeometry(1, SEG_W, SEG_H, -Math.PI / 2); // naad achterop
  const dirs = headGeo.attributes.position.array.slice();
  const pt = { x: 0, y: 0, z: 0 };
  function shapeHead(hairAt?: HeadLook['hairAt']) {
    const pos = headGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const dx = dirs[i * 3];
      const dy = dirs[i * 3 + 1];
      const dz = dirs[i * 3 + 2];
      headSurface(dx, dy, dz, pt);
      const h = hairAt ? HAIR * hairAt(dx, dy, dz) : 0;
      if (h > 0) {
        // haar ligt op het hoofd: naar buiten langs de normaal
        const nx = dx / HEAD.hx;
        const ny = dy / HEAD.hy;
        const nz = dz / (dz >= 0 ? HEAD.front : HEAD.back);
        const l = h / Math.hypot(nx, ny, nz);
        pt.x += nx * l;
        pt.y += ny * l;
        pt.z += nz * l;
      }
      pos.setXYZ(i, pt.x, pt.y, pt.z);
    }
    pos.needsUpdate = true;
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
    nor.needsUpdate = true;
    headGeo.computeBoundingSphere();
  }
  shapeHead();
  const skinColor = skin.color.clone();
  const headMat = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.65 });
  mesh(headGeo, headMat, skull);

  // Oren
  const ears = [1, -1].map((side) => {
    const ear = ball(1, skin, skull, side * halfWidth(-0.012) * 0.98, -0.012, -0.012);
    ear.scale.set(0.011, 0.031, 0.019);
    ear.rotation.set(0.12, side * 0.4, 0);
    return ear;
  });
  // Het gewone gezicht (zonder foto): ogen, wenkbrauwen en mond; de neus zit in de vorm van het hoofd.
  const features: THREE.Object3D[] = [];
  const eyeY = headY(EYES.v);
  for (const side of [1, -1]) {
    const e = headFront(side * 0.031, eyeY);
    const eye = ball(0.0095, dark, skull, e.x, e.y, e.z - 0.002);
    eye.scale.set(1, 0.85, 0.6);
    const b = headFront(side * 0.033, eyeY + 0.021);
    const brow = mesh(new THREE.CapsuleGeometry(0.0038, 0.022, 4, 8), dark, skull, b.x, b.y, b.z);
    brow.rotation.set(0, side * 0.35, Math.PI / 2 - side * 0.12);
    features.push(eye, brow);
  }
  const lips = headFront(0, headY(MOUTH_V));
  const mouth = mesh(new THREE.CapsuleGeometry(0.0035, 0.03, 4, 8), mat('#9a5c4c', 0.7), skull, lips.x, lips.y, lips.z);
  mouth.rotation.z = Math.PI / 2;
  features.push(mouth);
  // Lang haar valt achter de nek tot op de schouders
  const hairMat = mat('#2a2018', 0.8);
  const drape = mesh(new THREE.SphereGeometry(1, 20, 14), hairMat, skull, 0, -0.13, -0.078);
  drape.scale.set(0.086, 0.13, 0.046);
  drape.rotation.x = 0.28;
  drape.visible = false;
  // Helm (alleen zonder foto: met een foto is het eigen haar te zien)
  const helm = pivot(skull, 0, 0.048, -0.004);
  mesh(new THREE.SphereGeometry(0.106, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), helmet, helm).scale.set(0.86, 0.92, 1.08);
  mesh(new THREE.CylinderGeometry(0.108, 0.111, 0.01, 24), helmet, helm, 0, 0, 0.026).scale.set(0.87, 1, 1.2);

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
    const hip = pivot(rig, side * 0.094, -0.02, 0);
    // Werkbroek: bovenbeen, knie, kuit (iets naar achteren) en een zoom op de schoen
    limb([[0.084, 0], [0.088, -0.07], [0.085, -0.18], [0.075, -0.31], [0.068, -THIGH]], trousers, hip);
    const knee = pivot(hip, 0, -THIGH, 0);
    limb([[0.068, 0], [0.069, -0.09], [0.064, -0.2], [0.056, -0.32], [0.054, -0.385], [0.056, -0.392], [0.056, -0.405], [0.03, -SHIN]], trousers, knee, 0.96, 1.06);
    const foot = pivot(knee, 0, -SHIN, 0);
    // Veiligheidsschoen: hoge hiel en wreef, lage ronde neus, zool eronder
    mesh(shoeGeo, dark, foot);
    mesh(soleGeo, sole, foot);
    return { hip, knee, foot };
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
    const gait = THREE.MathUtils.smoothstep(abs, 0.15, 1.2) * (1 - seat); // 0 = staan, 1 = lopen
    const run = THREE.MathUtils.smoothstep(abs, 5.6, 8.5); // 0 = lopen, 1 = rennen
    // Pasfrequentie groeit minder hard dan de snelheid (langere passen), anders wordt het trippelen.
    phase += Math.sign(speed) * 0.8 * Math.pow(abs, 0.42) * Math.PI * 2 * dt * (abs > 0.05 ? 1 : 0);

    const legAmp = (0.5 + 0.35 * run) * gait;
    const kneeAmp = (0.95 + 0.55 * run) * gait;
    const armAmp = (0.5 + 0.45 * run) * gait * (1 - carry);
    const breathe = Math.sin(time * 1.6);

    legs.forEach((l, i) => {
      const ph = phase + i * Math.PI;
      const swing = Math.sin(ph); // + = been naar voren
      // Knie buigt terwijl het been naar voren zwaait, en blijft gestrekt tijdens het afzetten.
      const lift = Math.max(0, Math.cos(ph - 0.35));
      let hip = -legAmp * swing - 0.12 * run * gait;
      let knee = 0.04 + kneeAmp * lift * lift;
      // In de lucht: benen iets opgetrokken
      hip = THREE.MathUtils.lerp(hip, i ? -0.25 : -0.5, air);
      knee = THREE.MathUtils.lerp(knee, i ? 0.7 : 0.95, air);
      // Zittend: bovenbenen naar voren, onderbenen omlaag
      hip = THREE.MathUtils.lerp(hip, -1.42, seat);
      knee = THREE.MathUtils.lerp(knee, 1.3, seat);
      l.hip.rotation.z = (i ? -0.1 : 0.1) * seat; // zittend: knieën iets uit elkaar, om de stuurkolom
      l.hip.rotation.x = hip;
      l.knee.rotation.x = knee;
      l.foot.rotation.x = THREE.MathUtils.lerp(-(hip + knee) * 0.45, 0.1, seat); // zool ongeveer vlak
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

    arms.forEach((a, i) => {
      const swing = Math.sin(phase + i * Math.PI); // arm zwaait tegengesteld aan het been aan dezelfde kant
      let shoulder = armAmp * swing + 0.03 * breathe * (1 - gait);
      let elbow = -(0.18 + 0.25 * gait + 1.05 * run * gait) - 0.3 * armAmp * Math.max(0, -swing);
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
      a.shoulder.rotation.set(shoulder, 0, a.restZ);
      a.elbow.rotation.x = elbow;
    });

    // Romp: licht voorover bij tempo, schouders draaien tegen de heupen in, hoofd blijft recht vooruit
    const twist = Math.sin(phase) * gait;
    rig.rotation.y = 0.1 * twist;
    torso.rotation.y = -(0.1 + 0.16 * (1 - carry)) * twist;
    torso.rotation.x = (0.04 + 0.2 * run) * gait * Math.sign(speed || 1) + 0.1 * carry - 0.08 * seat;
    torso.rotation.z = -0.03 * twist;
    head.rotation.y = -(rig.rotation.y + torso.rotation.y) * 0.8 + lookYaw;
    head.rotation.x = -torso.rotation.x * 0.6 - lookPitch * 0.75;
    shell.scale.z = SZ + 0.012 * breathe;

    // Deinen: het laagst als beide voeten aan de grond staan, het hoogst boven het standbeen
    const stride = legAmp * Math.sin(phase);
    const bob = -(THIGH + SHIN) * (1 - Math.cos(stride)) * 0.6 + 0.03 * run * gait * Math.abs(Math.cos(phase));
    const standY = HIP_HEIGHT + bob;
    const seatY = (state.seatHipY ?? 0.5) - p.y;
    rig.position.y = THREE.MathUtils.lerp(standY, seatY, seat);
    rig.position.x = 0.018 * Math.cos(phase) * gait * (1 - run);

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
   * Foto van de speler op het hoofd zetten (null = het gewone gezicht met helm). Gezicht, huidskleur en haar komen
   * van de foto: het haar dat erop te zien is loopt door over het hele hoofd; zonder haar is het hoofd kaal.
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
    helm.visible = !look;
    if (look?.hair) hairMat.color.copy(look.hair);
    drape.visible = !!look?.long;
    shapeHead(look?.hairAt);
    // oren verdwijnen onder haar dat eroverheen valt
    ears.forEach((ear, i) => (ear.visible = !look || look.hairAt(i ? -0.99 : 0.99, -0.1, -0.1) < 0.5));
  }

  /** First person in de heftruck: het hoofd niet tekenen, de camera zit op die plek. */
  function setFirstPerson(on: boolean) {
    head.visible = neck.visible = !on;
  }

  update(0);
  return { group, update, setFirstPerson, setFace };
}
