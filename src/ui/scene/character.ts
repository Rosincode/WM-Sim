import * as THREE from 'three';
import { CENTER_V, HEAD, NOSE_V, headOutline, headY, photoUV, taper } from './headShape';

// Magazijnmedewerker: lichte, gelede figuur (hesje, helm) met procedurele loopanimatie.
// Voorkant wijst naar +Z, voeten op y = 0. Geen modelbestanden of skinning: enkele tientallen eenvoudige meshes.

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

/**
 * Overgang voor de foto op het hoofd: dekkend op het gezicht, naar de omtrek van het hoofd toe doorzichtig,
 * zodat de foto aan de zijkanten zacht overloopt in de huid. Gedeeld door alle figuren.
 */
let fade: THREE.CanvasTexture | null = null;
function faceFade() {
  if (fade) return fade;
  const W = 96;
  const H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const outline = headOutline();
  const STEPS = 14;
  for (let i = 0; i <= STEPS; i++) {
    const k = i / STEPS;
    const sx = 0.95 - 0.25 * k; // opzij eerder doorzichtig (daar rekt de foto uit) dan bij de kin
    const sy = 0.99 - 0.12 * k;
    const grey = Math.round(255 * k);
    ctx.fillStyle = `rgb(${grey},${grey},${grey})`;
    ctx.beginPath();
    for (const [u, v] of outline) ctx.lineTo((0.5 + (u - 0.5) * sx) * W, (CENTER_V + (v - CENTER_V) * sy) * H);
    ctx.fill();
  }
  return (fade = new THREE.CanvasTexture(canvas));
}

/** Bol omvormen tot hoofd: smaller naar de kin. Met `nose`: ook een lichte welving op de plek van de neus. */
function shapeHead(geo: THREE.BufferGeometry, r: number, nose = false) {
  const pos = geo.attributes.position;
  const noseY = headY(NOSE_V);
  for (let i = 0; i < pos.count; i++) {
    const f = taper(pos.getY(i) / r);
    const x = pos.getX(i) * f;
    let z = pos.getZ(i) * f;
    if (nose && z > 0) z += 0.013 * Math.exp(-((x * HEAD.sx / 0.018) ** 2) - ((HEAD.y + pos.getY(i) * HEAD.sy - noseY) / 0.03) ** 2);
    pos.setX(i, x);
    pos.setZ(i, z);
  }
  geo.computeVertexNormals();
  return geo;
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
  const hair = mat('#3b2a1f', 0.9);
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
  /** Taps toelopend ledemaat dat vanaf het draaipunt naar beneden hangt, met een ronde bovenkant. */
  const limb = (rTop: number, rBottom: number, len: number, m: THREE.Material, parent: THREE.Object3D) => {
    ball(rTop, m, parent);
    return mesh(new THREE.CylinderGeometry(rTop, rBottom, len, 14), m, parent, 0, -len / 2, 0);
  };
  const lathe = (pts: [number, number][], m: THREE.Material, parent: THREE.Object3D) =>
    mesh(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 24), m, parent);

  // Heupen: alles hangt hieraan, zodat het lichaam als geheel kan deinen en leunen.
  const rig = pivot(group, 0, HIP_HEIGHT, 0);
  const pelvis = lathe([[0.001, -0.17], [0.09, -0.16], [0.148, -0.1], [0.162, -0.02], [0.158, 0.05]], trousers, rig);
  pelvis.scale.set(1.05, 1, 0.55);

  // Romp: draaiprofiel van heup naar schouders, afgeplat tot een borstkas. Het hesje is de romp zelf en valt over de heupen.
  const SX = 1.15;
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
  mesh(new THREE.CylinderGeometry(0.062, 0.085, 0.045, 16), shirt, torso, 0, 0.578, 0.004);
  const neck = mesh(new THREE.CylinderGeometry(0.048, 0.054, 0.1, 14), skin, torso, 0, 0.62, 0);

  // Hoofd met gezicht, haar en helm
  const head = pivot(torso, 0, 0.62, 0);
  mesh(shapeHead(new THREE.SphereGeometry(HEAD.r, 24, 18), HEAD.r), skin, head, 0, HEAD.y, 0).scale.set(HEAD.sx, HEAD.sy, HEAD.sz);
  const features = [ball(0.013, skin, head, 0, 0.083, 0.098)]; // neus
  features[0].scale.set(0.8, 1.3, 1);
  for (const side of [1, -1]) {
    ball(0.022, skin, head, side * 0.09, 0.088, -0.004).scale.set(0.5, 1.2, 0.9); // oor
    features.push(ball(0.0105, dark, head, side * 0.036, 0.108, 0.088)); // oog
  }
  // Eigen foto als gezicht: een schil over de voorkant van het hoofd, in dezelfde vorm als het hoofd. De foto
  // staat er recht van voren op, zó dat de hoofdvorm uit het fotovenster precies op de omtrek van het hoofd valt:
  // ogen, neus en kin komen op hun plek. De bovenkant (haar, voorhoofd) valt onder de helm.
  const FACE_R = HEAD.r + 0.0015;
  const faceGeo = shapeHead(new THREE.SphereGeometry(FACE_R, 32, 28, Math.PI / 2 - 1.45, 2.9, 0.12 * Math.PI, 0.88 * Math.PI), FACE_R, true);
  {
    const pos = faceGeo.attributes.position;
    const uv = faceGeo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const { u, v } = photoUV(pos.getX(i) * HEAD.sx, HEAD.y + pos.getY(i) * HEAD.sy);
      uv.setXY(i, u, 1 - v);
    }
  }
  const faceMat = new THREE.MeshStandardMaterial({
    roughness: 0.7, transparent: true, depthWrite: false, alphaMap: faceFade(), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const face = new THREE.Mesh(faceGeo, faceMat);
  face.position.set(0, HEAD.y, 0);
  face.scale.set(HEAD.sx, HEAD.sy, HEAD.sz);
  face.visible = false;
  head.add(face);
  const skinColor = skin.color.clone();
  const hairCap = mesh(new THREE.SphereGeometry(0.104, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.6), hair, head, 0, 0.102, -0.01);
  hairCap.scale.set(0.93, 1.1, 1);
  hairCap.rotation.x = -0.55;
  const dome = mesh(new THREE.SphereGeometry(0.118, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), helmet, head, 0, 0.128, 0);
  dome.scale.set(1, 0.95, 1.1);
  const brim = mesh(new THREE.CylinderGeometry(0.12, 0.124, 0.012, 20), helmet, head, 0, 0.13, 0.03);
  brim.scale.z = 1.22;

  function arm(side: number) {
    const shoulder = pivot(torso, side * 0.218, 0.495, 0);
    shoulder.rotation.z = side * 0.04;
    limb(0.056, 0.047, UPPER_ARM, shirt, shoulder); // mouw tot de elleboog
    const elbow = pivot(shoulder, 0, -UPPER_ARM, 0);
    limb(0.044, 0.033, FOREARM, skin, elbow);
    // Hand aan een pols, zodat hij plat op het stuur kan liggen. Vingers wijzen langs -y, de handpalm naar het lichaam.
    const wrist = pivot(elbow, 0, -FOREARM, 0);
    ball(0.045, glove, wrist, 0, -0.045, 0.002).scale.set(0.36, 1, 0.9);
    const finger = new THREE.CapsuleGeometry(0.0095, 0.046, 4, 8);
    for (const z of [0.031, 0.012, -0.007, -0.026]) mesh(finger, glove, wrist, 0, -0.105, z);
    const thumb = mesh(new THREE.CapsuleGeometry(0.011, 0.034, 4, 8), glove, wrist, -side * 0.006, -0.05, 0.046);
    thumb.rotation.x = -0.55;
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

  function leg(side: number) {
    const hip = pivot(rig, side * 0.094, -0.02, 0);
    limb(0.088, 0.073, THIGH, trousers, hip);
    const knee = pivot(hip, 0, -THIGH, 0);
    limb(0.073, 0.058, SHIN, trousers, knee);
    const foot = pivot(knee, 0, -SHIN, 0);
    // Veiligheidsschoen: ronde neus, zool eronder
    const upper = mesh(new THREE.CapsuleGeometry(0.055, 0.125, 4, 10), dark, foot, 0, -0.008, 0.05);
    upper.rotation.x = Math.PI / 2;
    upper.scale.z = 0.8; // lokale z staat na het kantelen verticaal
    mesh(new THREE.BoxGeometry(0.1, 0.02, 0.225), sole, foot, 0, -0.05, 0.05);
    return { hip, knee, foot };
  }

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

  /** Foto van de speler op het hoofd zetten (null = het gewone gezicht). De huid kleurt mee met de foto. */
  function setFace(image: HTMLImageElement | HTMLCanvasElement | null) {
    faceMat.map?.dispose();
    faceMat.map = null;
    face.visible = !!image;
    for (const f of features) f.visible = !image;
    skin.color.copy(skinColor);
    if (!image) return;
    const texture = new THREE.Texture(image);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    faceMat.map = texture;
    faceMat.needsUpdate = true;
    // Huidskleur: gemiddelde van wangen, neus en mond op de foto
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 16;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(image, 0, 0, 16, 16);
      const px = ctx.getImageData(5, 8, 6, 4).data;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < px.length; i += 4) {
        r += px[i];
        g += px[i + 1];
        b += px[i + 2];
      }
      const n = (px.length / 4) * 255;
      skin.color.setRGB(r / n, g / n, b / n, THREE.SRGBColorSpace);
    } catch {
      // kleur niet te bepalen: de gewone huidskleur blijft
    }
  }

  /** First person in de heftruck: het hoofd niet tekenen, de camera zit op die plek. */
  function setFirstPerson(on: boolean) {
    head.visible = neck.visible = !on;
  }

  update(0);
  return { group, update, setFirstPerson, setFace };
}
