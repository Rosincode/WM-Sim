import * as THREE from 'three';

// Magazijnmedewerker: lichte, gelede figuur (hesje, helm) met procedurele loopanimatie.
// Voorkant wijst naar +Z, voeten op y = 0. Geen modelbestanden of skinning: ~25 eenvoudige meshes.

const HIP_HEIGHT = 0.92;
const THIGH = 0.45;
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
}

export function createCharacter(group: THREE.Group = new THREE.Group()) {
  const mat = (color: string, roughness = 0.85) => new THREE.MeshStandardMaterial({ color, roughness });
  const vest = mat('#ee5a12');
  const stripe = mat('#d9dcd6', 0.35);
  const shirt = mat('#27364d');
  const trousers = mat('#2b2f38');
  const shoe = mat('#17181a', 0.6);
  const skin = mat('#d9a47f', 0.7);
  const helmet = mat('#f2c200', 0.4);

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
  /** Ledemaat die vanaf het draaipunt naar beneden hangt. */
  const limb = (r: number, len: number, m: THREE.Material, parent: THREE.Object3D) =>
    mesh(new THREE.CapsuleGeometry(r, len - r, 4, 10), m, parent, 0, -len / 2, 0);

  // Heupen: alles hangt hieraan, zodat het lichaam als geheel kan deinen en leunen.
  const rig = pivot(group, 0, HIP_HEIGHT, 0);
  const pelvis = mesh(new THREE.CapsuleGeometry(0.115, 0.12, 4, 10), trousers, rig, 0, -0.02, 0);
  pelvis.rotation.z = Math.PI / 2;
  pelvis.scale.z = 0.9;

  // Romp met hesje en reflecterende banden
  const torso = pivot(rig);
  const chest = mesh(new THREE.CapsuleGeometry(0.17, 0.3, 6, 14), vest, torso, 0, 0.3, 0);
  chest.scale.set(1.15, 1, 0.72);
  for (const y of [0.2, 0.36]) {
    const band = mesh(new THREE.CylinderGeometry(1, 1, 0.04, 18, 1, true), stripe, torso, 0, y, 0);
    band.scale.set(0.199, 1, 0.126);
  }
  mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 10), skin, torso, 0, 0.64, 0);

  const head = pivot(torso, 0, 0.68, 0);
  const skull = mesh(new THREE.SphereGeometry(0.105, 16, 12), skin, head, 0, 0.09, 0.005);
  skull.scale.set(0.92, 1.15, 1);
  mesh(new THREE.SphereGeometry(0.122, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), helmet, head, 0, 0.115, 0);
  const brim = mesh(new THREE.CylinderGeometry(0.125, 0.125, 0.014, 16), helmet, head, 0, 0.12, 0.035);
  brim.scale.z = 1.15;

  function arm(side: number) {
    const shoulder = pivot(torso, side * 0.235, 0.5, 0);
    shoulder.rotation.z = side * 0.07;
    mesh(new THREE.SphereGeometry(0.062, 10, 8), shirt, shoulder);
    limb(0.048, UPPER_ARM, shirt, shoulder);
    const elbow = pivot(shoulder, 0, -UPPER_ARM, 0);
    limb(0.041, FOREARM, shirt, elbow);
    mesh(new THREE.SphereGeometry(0.046, 10, 8), skin, elbow, 0, -FOREARM - 0.02, 0).scale.set(0.8, 1.1, 1);
    return { shoulder, elbow };
  }

  function leg(side: number) {
    const hip = pivot(rig, side * 0.092, 0, 0);
    limb(0.078, THIGH, trousers, hip);
    const knee = pivot(hip, 0, -THIGH, 0);
    limb(0.06, SHIN, trousers, knee);
    const foot = pivot(knee, 0, -SHIN, 0);
    mesh(new THREE.BoxGeometry(0.1, 0.075, 0.26), shoe, foot, 0, -0.022, 0.055);
    return { hip, knee, foot };
  }

  const arms = [arm(1), arm(-1)];
  const legs = [leg(1), leg(-1)];

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
    if (hasPrev && dt > 0 && !state.seated) {
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
    air = ease(air, !state.seated && p.y > 0.02 ? 1 : 0, dt, 14);

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
      l.hip.rotation.x = hip;
      l.knee.rotation.x = knee;
      l.foot.rotation.x = THREE.MathUtils.lerp(-(hip + knee) * 0.45, 0.1, seat); // zool ongeveer vlak
    });

    arms.forEach((a, i) => {
      const swing = Math.sin(phase + i * Math.PI); // arm zwaait tegengesteld aan het been aan dezelfde kant
      let shoulder = armAmp * swing + 0.03 * breathe * (1 - gait);
      let elbow = -(0.18 + 0.25 * gait + 1.05 * run * gait) - 0.3 * armAmp * Math.max(0, -swing);
      shoulder = THREE.MathUtils.lerp(shoulder, -0.95, carry); // dragen: armen voor zich uit
      elbow = THREE.MathUtils.lerp(elbow, -0.55, carry);
      shoulder = THREE.MathUtils.lerp(shoulder, i ? -0.2 : -1.2, air * (1 - carry));
      shoulder = THREE.MathUtils.lerp(shoulder, -0.85, seat); // handen aan het stuur
      elbow = THREE.MathUtils.lerp(elbow, -0.75, seat);
      a.shoulder.rotation.x = shoulder;
      a.elbow.rotation.x = elbow;
    });

    // Romp: licht voorover bij tempo, schouders draaien tegen de heupen in, hoofd blijft recht vooruit
    const twist = Math.sin(phase) * gait;
    rig.rotation.y = 0.1 * twist;
    torso.rotation.y = -(0.1 + 0.16 * (1 - carry)) * twist;
    torso.rotation.x = (0.04 + 0.2 * run) * gait * Math.sign(speed || 1) + 0.1 * carry - 0.08 * seat;
    torso.rotation.z = -0.03 * twist;
    head.rotation.y = -(rig.rotation.y + torso.rotation.y) * 0.8;
    head.rotation.x = -torso.rotation.x * 0.6;
    chest.scale.z = 0.72 + 0.012 * breathe;

    // Deinen: het laagst als beide voeten aan de grond staan, het hoogst boven het standbeen
    const stride = legAmp * Math.sin(phase);
    const bob = -(THIGH + SHIN) * (1 - Math.cos(stride)) * 0.6 + 0.03 * run * gait * Math.abs(Math.cos(phase));
    const standY = HIP_HEIGHT + bob;
    const seatY = (state.seatHipY ?? 0.5) - p.y;
    rig.position.y = THREE.MathUtils.lerp(standY, seatY, seat);
    rig.position.x = 0.018 * Math.cos(phase) * gait * (1 - run);
  }

  update(0);
  return { group, update };
}
