import * as THREE from 'three';

// De 6-7 in first person: je eigen twee handen voor je, handpalmen omhoog, die om de beurt op en neer wegen.
// Anderen (en jijzelf in third person) zien het figuur het gebaar maken, zie src/ui/scene/character.ts.

export function createEmoteHands(camera: THREE.Camera) {
  const root = new THREE.Group();
  root.visible = false;
  camera.add(root);
  // dezelfde handschoen en mouw als bij de scanner
  const glove = new THREE.MeshStandardMaterial({ color: '#4a4d52', roughness: 0.92 });
  const sleeve = new THREE.MeshStandardMaterial({ color: '#ee5a12', roughness: 0.85 });
  const band = new THREE.MeshStandardMaterial({ color: '#cfd3d6', roughness: 0.35, metalness: 0.6 });

  const hands = [-1, 1].map((side) => {
    const hand = new THREE.Group(); // vingers naar voren (-z), handpalm naar boven (+y), duim naar buiten
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.frustumCulled = false;
      hand.add(m);
      return m;
    };
    add(new THREE.SphereGeometry(1, 20, 14), glove, 0, 0, 0).scale.set(0.046, 0.017, 0.052); // handpalm
    const finger = new THREE.CapsuleGeometry(0.0105, 0.05, 6, 12).rotateX(Math.PI / 2);
    [-0.03, -0.01, 0.01, 0.03].forEach((x, i) => {
      const f = add(finger, glove, x, 0.006, -0.075 + Math.abs(i - 1.5) * 0.006);
      f.rotation.x = 0.28; // licht gekromd: de toppen komen iets omhoog
    });
    const thumb = add(new THREE.CapsuleGeometry(0.012, 0.04, 6, 12).rotateX(Math.PI / 2), glove, side * 0.052, 0.006, -0.018);
    thumb.rotation.y = -side * 0.75;
    // onderarm: van de pols schuin terug naar buiten beeld
    const arm = new THREE.Group();
    arm.add(new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.05, 0.46, 16), sleeve));
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.037, 0.037, 0.02, 16), band);
    cuff.position.y = 0.22;
    arm.add(cuff);
    arm.traverse((o) => (o.frustumCulled = false));
    arm.position.set(side * 0.035, -0.07, 0.27);
    arm.rotation.set(-1.28, 0, -side * 0.13);
    hand.add(arm);
    root.add(hand);
    return { hand, side };
  });

  let raise = 0;
  let time = 0;
  return {
    /** @param on de speler doet de 6-7 en kijkt door zijn eigen ogen */
    update(dt: number, on: boolean) {
      raise += ((on ? 1 : 0) - raise) * (1 - Math.exp(-dt * 12));
      root.visible = raise > 0.02;
      if (!root.visible) return;
      time += dt;
      for (const { hand, side } of hands) {
        const weigh = Math.sin(time * 10 + (side > 0 ? Math.PI : 0)); // links omhoog als rechts omlaag gaat
        hand.position.set(side * 0.17, -0.15 + 0.045 * weigh - (1 - raise) * 0.4, -0.42);
        hand.rotation.set(0.12 + 0.1 * weigh, -side * 0.12, side * 0.1);
      }
    },
  };
}
