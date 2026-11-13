import type * as THREE from 'three';
import type { CounterRobot } from '../sim/counter';
import { createDockCounter } from './scene/dockCounter';

// De telrobot bij de ontvangst in beeld. Leest alleen de sim (src/sim/counter.ts).

const LED = { free: '#3ddc84', busy: '#35a7ff' };

export function mountDockCounter(scene: THREE.Scene, counter: CounterRobot) {
  const mesh = createDockCounter();
  scene.add(mesh.group);
  let time = 0;
  return {
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
