import type * as THREE from 'three';
import type { CounterRobot } from '../sim/counter';
import type { Solid } from './scene/warehouse';
import { createDockCounter } from './scene/dockCounter';

// De telrobot bij de ontvangst in beeld. Leest alleen de sim (src/sim/counter.ts).

const LED = { free: '#3ddc84', busy: '#35a7ff' };

export function mountDockCounter(scene: THREE.Scene, counter: CounterRobot) {
  const mesh = createDockCounter();
  scene.add(mesh.group);
  let time = 0;
  const pose = { x: 0, z: 0, r: 0 };
  return {
    /** Waar de speler tegenaan loopt: het onderstel en de mast met de scannerkop. */
    solids(): Solid[] {
      const r = counter.robot;
      Object.assign(pose, { x: r.x, z: r.z, r: r.r });
      return [
        { pose, minX: -0.3, maxX: 0.3, minZ: -0.36, maxZ: 0.36, minY: 0, maxY: 0.36 },
        { pose, minX: -0.16, maxX: 0.16, minZ: -0.24, maxZ: -0.04, minY: 0.36, maxY: 1.54 },
      ];
    },
    update(dt: number) {
      time += dt;
      const r = counter.robot;
      mesh.group.position.set(r.x, 0, r.z);
      mesh.group.rotation.y = r.r;
      mesh.setLed(r.phase === 'idle' ? LED.free : LED.busy);
      mesh.setScan(r.phase === 'counting', 0.5 + 0.5 * Math.sin(time * 14));
    },
  };
}
