import * as THREE from 'three';

/** Heftruck (elektrische contragewichttruck). Voorkant wijst naar +Z. */
export function createForklift() {
  const g = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: '#f0b414', roughness: 0.38, metalness: 0.25 });
  const black = new THREE.MeshStandardMaterial({ color: '#1b1c1e', roughness: 0.6, metalness: 0.3 });
  const steel = new THREE.MeshStandardMaterial({ color: '#3a3d42', roughness: 0.4, metalness: 0.8 });
  const rubber = new THREE.MeshStandardMaterial({ color: '#101010', roughness: 0.95 });
  const seat = new THREE.MeshStandardMaterial({ color: '#25272b', roughness: 0.9 });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  const b = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

  // Chassis en contragewicht
  add(b(1.1, 0.5, 1.9), yellow, 0, 0.5, -0.1);
  add(b(1.12, 0.75, 0.55), black, 0, 0.7, -1.0); // contragewicht
  add(b(1.0, 0.45, 0.8), yellow, 0, 0.95, -0.45); // motorkap
  add(b(0.5, 0.12, 0.5), seat, 0, 1.24, -0.45);
  add(b(0.5, 0.5, 0.1), seat, 0, 1.5, -0.7, -0.15);
  add(b(0.9, 0.6, 0.12), yellow, 0, 1.0, 0.55); // dashboard
  add(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 8), black, 0, 1.35, 0.42, -0.5);
  add(new THREE.TorusGeometry(0.16, 0.022, 8, 24), black, 0, 1.52, 0.33, Math.PI / 2 - 0.5);

  // Beschermkooi
  for (const x of [-0.5, 0.5]) {
    add(b(0.06, 1.3, 0.06), black, x, 1.6, 0.62, 0.12);
    add(b(0.06, 1.2, 0.06), black, x, 1.65, -0.95);
  }
  add(b(1.1, 0.05, 1.7), black, 0, 2.25, -0.15);
  for (const z of [-0.7, -0.35, 0, 0.35]) add(b(1.0, 0.03, 0.05), black, 0, 2.22, z);

  // Wielen
  const wheel = new THREE.CylinderGeometry(0.3, 0.3, 0.22, 24);
  const smallWheel = new THREE.CylinderGeometry(0.24, 0.24, 0.2, 24);
  const wheels: THREE.Mesh[] = [];
  for (const x of [-0.56, 0.56]) {
    wheels.push(add(wheel, rubber, x, 0.3, 0.55, 0, Math.PI / 2));
    wheels.push(add(smallWheel, rubber, x, 0.24, -0.85, 0, Math.PI / 2));
  }

  // Mast, vorkenbord en vorken
  for (const x of [-0.36, 0.36]) add(b(0.09, 2.5, 0.12), steel, x, 1.3, 0.98);
  add(b(0.82, 0.08, 0.1), steel, 0, 2.5, 0.98);
  add(b(0.82, 0.08, 0.1), steel, 0, 0.6, 0.98);
  add(b(0.95, 0.5, 0.06), black, 0, 0.42, 1.08);
  for (const y of [0.9, 1.15]) add(b(0.95, 0.03, 0.03), black, 0, y, 1.08); // lastrek
  for (const x of [-0.3, 0.3]) {
    add(b(0.11, 0.045, 1.1), steel, x, 0.11, 1.66);
    add(b(0.11, 0.5, 0.045), steel, x, 0.34, 1.13);
  }

  // Zwaailamp en koplampen
  const beacon = new THREE.MeshBasicMaterial();
  beacon.color.setRGB(3.5, 1.4, 0.1);
  add(new THREE.CylinderGeometry(0.05, 0.05, 0.09, 12), beacon, 0.4, 2.33, -0.8);
  const head = new THREE.MeshBasicMaterial();
  head.color.setRGB(3, 3, 2.7);
  for (const x of [-0.45, 0.45]) add(new THREE.SphereGeometry(0.045, 12, 8), head, x, 2.18, 0.72);

  return {
    group: g,
    /** Laat wielen draaien en de zwaailamp knipperen. */
    update(dt: number, speed: number, time: number) {
      for (const w of wheels) w.rotation.x += (speed * dt) / 0.3;
      const k = 0.6 + 0.4 * Math.sin(time * 9);
      beacon.color.setRGB(3.5 * k, 1.4 * k, 0.1);
    },
  };
}
