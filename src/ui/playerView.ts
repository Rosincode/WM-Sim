import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** Camera-modi: overzicht (orbit), first person (dichtbij, standaard) en third person. */
export type ViewMode = 'overview' | 'first' | 'third';

interface Options {
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  controls: OrbitControls;
  player: THREE.Object3D;
  hud: HTMLElement;
  /** Loopbaar gebied (x/z-grenzen). */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Obstakels (stellingen e.d.) waar de speler niet doorheen loopt. */
  colliders?: { minX: number; maxX: number; minZ: number; maxZ: number }[];
  initialMode?: ViewMode;
  onModeChange?: (mode: ViewMode) => void;
}

const EYE_HEIGHT = 1.6;
const GRAVITY = 22;
const JUMP_SPEED = 7.5;
const MOUSE_SENS = 0.0022;
const MAX_PITCH = Math.PI / 2 - 0.05;
const PLAYER_RADIUS = 0.42;

export function createPlayerView({ camera, canvas, controls, player, hud, bounds, colliders = [], initialMode = 'overview', onModeChange }: Options) {
  let mode: ViewMode = 'overview';
  let closeMode: Exclude<ViewMode, 'overview'> = 'first'; // laatst gebruikte dichtbij-modus
  let pitch = 0;
  let velY = 0;
  let grounded = true;
  let moving = 0; // 0..1, voor de loopbeweging van wat je vasthoudt
  /** Voertuig waarin de speler zit (heftruck); de speler en camera volgen het dan. */
  let vehicle: { object: THREE.Object3D; seat: THREE.Vector3 } | null = null;
  let lookYaw = 0; // rondkijken vanaf de stoel
  const seatWorld = new THREE.Vector3();

  const keys = new Set<string>();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const camTarget = new THREE.Vector3();

  const processKeys = '<br><b>E</b>: scannen / actie · <b>L</b>: API-log · <b>I</b>: voorraad';
  const hudText: Record<ViewMode, string> = {
    overview:
      '<b>WM-Sim — Overzicht</b><br>Slepen: draaien · Scroll: zoom · Rechts slepen: schuiven<br><b>C</b>: dichtbij (first person)',
    first:
      '<b>WM-Sim — First person</b><br>Klik: muis vastzetten · Muis: rondkijken · Esc: muis los<br>W/S: lopen · A/D: zijwaarts · ←/→: draaien · Shift: rennen · Spatie: springen<br><b>1</b>: scanner (klik = scannen) · <b>2</b>: tablet (Q: tabblad · F: dichterbij)<br><b>R</b>: in de heftruck stappen (als je ernaast staat) · <b>V</b>: third person · <b>C</b>: overzicht',
    third:
      '<b>WM-Sim — Third person</b><br>W/S: lopen · A/D: draaien · Shift: rennen · Spatie: springen<br><b>V</b>: first person · <b>C</b>: overzicht',
  };

  const drivingText =
    '<b>WM-Sim — Heftruck</b><br>W/S: rijden · A/D: sturen · <b>↑/↓</b>: vorken heffen/zakken · Muis: rondkijken<br>Oppakken: vorken onder de pallet en heffen · Neerzetten: zakken<br><b>R</b>: uitstappen · <b>V</b>: first/third person · <b>C</b>: overzicht';
  const refreshHud = () => (hud.innerHTML = (vehicle && mode !== 'overview' ? drivingText : hudText[mode]) + processKeys);

  function setMode(m: ViewMode) {
    mode = m;
    if (m !== 'overview') closeMode = m;
    controls.enabled = m === 'overview';
    player.visible = m !== 'first'; // eigen lichaam niet in beeld
    if (m !== 'first' && document.pointerLockElement === canvas) document.exitPointerLock();
    if (m === 'overview') {
      camera.position.set(0, 32, 28);
      controls.target.set(0, 0, 0);
    } else if (m === 'first') {
      pitch = 0;
    }
    refreshHud();
    onModeChange?.(m);
  }
  setMode(initialMode);

  function isTyping(e: KeyboardEvent) {
    const t = e.target;
    return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
  }

  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return; // typen in formulier ≠ besturing
    if (e.code === 'Space') e.preventDefault(); // niet scrollen / knoppen activeren
    if (!e.repeat) {
      if (e.code === 'KeyC') setMode(mode === 'overview' ? closeMode : 'overview');
      if (e.code === 'KeyV' && mode !== 'overview') setMode(mode === 'first' ? 'third' : 'first');
      if (e.code === 'Space' && mode !== 'overview' && grounded && !vehicle) {
        velY = JUMP_SPEED;
        grounded = false;
      }
    }
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  // Muis vastzetten in first person; Esc laat los (browserstandaard).
  canvas.addEventListener('click', () => {
    if (mode === 'first' && document.pointerLockElement !== canvas) canvas.requestPointerLock();
  });
  document.addEventListener('mousemove', (e) => {
    if (mode !== 'first' || document.pointerLockElement !== canvas) return;
    if (vehicle) lookYaw = THREE.MathUtils.clamp(lookYaw - e.movementX * MOUSE_SENS, -2.5, 2.5);
    else player.rotation.y -= e.movementX * MOUSE_SENS;
    pitch = THREE.MathUtils.clamp(pitch - e.movementY * MOUSE_SENS, -MAX_PITCH, MAX_PITCH);
  });

  const down = (...codes: string[]) => codes.some((c) => keys.has(c));

  function update(dt: number) {
    if (vehicle) {
      // In de heftruck: speler en camera volgen het voertuig; rijden doet het voertuig zelf.
      const o = vehicle.object;
      o.updateMatrixWorld();
      o.localToWorld(seatWorld.copy(vehicle.seat));
      player.position.set(seatWorld.x, 0.5, seatWorld.z);
      player.rotation.y = o.rotation.y;
      moving = 0;
      if (mode === 'overview') {
        controls.update();
      } else if (mode === 'first') {
        camera.position.copy(seatWorld);
        camera.rotation.set(pitch, o.rotation.y + Math.PI + lookYaw, 0, 'YXZ');
      } else {
        forward.set(Math.sin(o.rotation.y), 0, Math.cos(o.rotation.y));
        camTarget.copy(o.position).addScaledVector(forward, -7.5).setY(4.5);
        camera.position.lerp(camTarget, 1 - Math.exp(-dt * 5));
        camera.lookAt(o.position.x, 1.6, o.position.z);
      }
      return;
    }

    if (mode === 'overview') {
      controls.update();
      moving = 0;
      return;
    }
    const startX = player.position.x;
    const startZ = player.position.z;

    const speed = down('ShiftLeft', 'ShiftRight') ? 9 : 5;
    const turn = mode === 'first' ? down('ArrowLeft') : down('KeyA', 'ArrowLeft');
    const turnR = mode === 'first' ? down('ArrowRight') : down('KeyD', 'ArrowRight');
    if (turn) player.rotation.y += 2.5 * dt;
    if (turnR) player.rotation.y -= 2.5 * dt;

    forward.set(Math.sin(player.rotation.y), 0, Math.cos(player.rotation.y));
    right.set(-forward.z, 0, forward.x);
    const move = (down('KeyW', 'ArrowUp') ? 1 : 0) - (down('KeyS', 'ArrowDown') ? 1 : 0);
    const strafe = mode === 'first' ? (down('KeyD') ? 1 : 0) - (down('KeyA') ? 1 : 0) : 0;
    const len = Math.hypot(move, strafe) || 1; // diagonaal niet sneller
    player.position.addScaledVector(forward, (move / len) * speed * dt);
    player.position.addScaledVector(right, (strafe / len) * speed * dt);
    player.position.x = THREE.MathUtils.clamp(player.position.x, bounds.minX, bounds.maxX);
    player.position.z = THREE.MathUtils.clamp(player.position.z, bounds.minZ, bounds.maxZ);

    // Niet door obstakels lopen: langs de kortste kant terugduwen
    for (const c of colliders) {
      const p = player.position;
      const overlapX = Math.min(p.x - (c.minX - PLAYER_RADIUS), c.maxX + PLAYER_RADIUS - p.x);
      const overlapZ = Math.min(p.z - (c.minZ - PLAYER_RADIUS), c.maxZ + PLAYER_RADIUS - p.z);
      if (overlapX <= 0 || overlapZ <= 0) continue;
      if (overlapX < overlapZ) p.x = p.x < (c.minX + c.maxX) / 2 ? c.minX - PLAYER_RADIUS : c.maxX + PLAYER_RADIUS;
      else p.z = p.z < (c.minZ + c.maxZ) / 2 ? c.minZ - PLAYER_RADIUS : c.maxZ + PLAYER_RADIUS;
    }
    const walked = Math.hypot(player.position.x - startX, player.position.z - startZ) / Math.max(dt, 1e-4);
    moving += (Math.min(1, walked / 5) - moving) * (1 - Math.exp(-dt * 10));

    // Springen: zwaartekracht tot de vloer
    if (!grounded) {
      velY -= GRAVITY * dt;
      player.position.y += velY * dt;
      if (player.position.y <= 0) {
        player.position.y = 0;
        velY = 0;
        grounded = true;
      }
    }

    if (mode === 'first') {
      camera.position.set(player.position.x, player.position.y + EYE_HEIGHT, player.position.z);
      camera.rotation.set(pitch, player.rotation.y + Math.PI, 0, 'YXZ'); // camera kijkt langs -Z
    } else {
      // Achter en boven de speler, soepel volgend
      camTarget.copy(player.position).addScaledVector(forward, -6).setY(3.5 + player.position.y);
      camera.position.lerp(camTarget, 1 - Math.exp(-dt * 6));
      camera.lookAt(player.position.x, player.position.y + 1.5, player.position.z);
    }
  }

  /** Stap in (voertuig) of uit (null); bij uitstappen zet de aanroeper de speler neer. */
  function setVehicle(v: { object: THREE.Object3D; seat: THREE.Vector3 } | null) {
    vehicle = v;
    lookYaw = 0;
    pitch = v ? -0.12 : 0;
    player.position.y = 0;
    velY = 0;
    grounded = true;
    refreshHud();
    onModeChange?.(mode);
  }

  return { update, setMode, setVehicle, get mode() { return mode; }, get moving() { return moving; } };
}
