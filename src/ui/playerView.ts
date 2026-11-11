import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Solid } from './scene/warehouse';

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
  /** Bronnen van blokken (stellingen, pallets, heftruck) waar de speler tegenaan loopt, op staat of onderdoor loopt. */
  solids?: (() => Solid[])[];
  initialMode?: ViewMode;
  onModeChange?: (mode: ViewMode) => void;
}

/** Voertuig waarin de speler zit: `seat` is de plek van de speler, `eye` die van de camera in first person (lokaal). */
type Vehicle = { object: THREE.Object3D; seat: THREE.Vector3; eye?: THREE.Vector3 };

const EYE_HEIGHT = 1.6;
const SEAT_PITCH = -0.3; // zittend kijk je iets omlaag: stuur en handen onder in beeld
const GRAVITY = 22;
const JUMP_SPEED = 7.5;
const MOUSE_SENS = 0.0022;
const MAX_PITCH = Math.PI / 2 - 0.05;
const PLAYER_RADIUS = 0.42;
const PLAYER_HEIGHT = 1.8;
const STEP = 0.35; // zo hoog stap je zonder springen ergens op (pallet, vorken)
const FOOT = 0.2; // zo ver mogen je voeten over een rand steken

export function createPlayerView({ camera, canvas, controls, player, hud, bounds, solids = [], initialMode = 'overview', onModeChange }: Options) {
  let mode: ViewMode = 'overview';
  let closeMode: Exclude<ViewMode, 'overview'> = 'first'; // laatst gebruikte dichtbij-modus
  let pitch = 0;
  let velY = 0;
  let grounded = true;
  let moving = 0; // 0..1, voor de loopbeweging van wat je vasthoudt
  /** Voertuig waarin de speler zit (heftruck); de speler en camera volgen het dan. */
  let vehicle: Vehicle | null = null;
  let lookYaw = 0; // rondkijken vanaf de stoel
  const seatWorld = new THREE.Vector3();
  /** Waar de speler op staat als dat kan bewegen (heftruck): plek in het assenstelsel daarvan. */
  let ride: { pose: NonNullable<Solid['pose']>; x: number; z: number; r: number; lift: boolean } | null = null;
  let lx = 0;
  let lz = 0;
  /** Zet een punt om naar het assenstelsel van een blok (resultaat in lx, lz). */
  function toLocal(s: Solid, x: number, z: number) {
    if (!s.pose) {
      lx = x;
      lz = z;
      return;
    }
    const dx = x - s.pose.x;
    const dz = z - s.pose.z;
    const c = Math.cos(s.pose.r);
    const n = Math.sin(s.pose.r);
    lx = dx * c - dz * n;
    lz = dx * n + dz * c;
  }
  const inside = (s: Solid, margin: number) => lx > s.minX - margin && lx < s.maxX + margin && lz > s.minZ - margin && lz < s.maxZ + margin;

  const keys = new Set<string>();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const camTarget = new THREE.Vector3();

  const processKeys = '<br><b>E</b>: scannen / actie (bij de pc: WMS-app) · <b>L</b>: API-log · <b>I</b>: voorraad · <b>K</b>: WMS-API';
  const hudText: Record<ViewMode, string> = {
    overview:
      '<b>WM-Sim — Overzicht</b><br>Slepen: draaien · Scroll: zoom · Rechts slepen: schuiven<br><b>C</b>: dichtbij (first person)',
    first:
      '<b>WM-Sim — First person</b><br>Klik: muis vastzetten · Muis: rondkijken · Esc: muis los<br>W/S: lopen · A/D: zijwaarts · ←/→: draaien · Shift: rennen · Spatie: springen<br><b>1</b>: scanner (klik op een label = scannen naar de WMS) · <b>2</b>: tablet met WMS (F: dichtbij en bedienen)<br><b>R</b>: in de heftruck stappen (als je ernaast staat) · op de vorken staan: een ander tilt je op · <b>V</b>: third person · <b>C</b>: overzicht',
    third:
      '<b>WM-Sim — Third person</b><br>W/S: lopen · A/D: draaien · Shift: rennen · Spatie: springen<br><b>V</b>: first person · <b>C</b>: overzicht',
  };

  const drivingText =
    '<b>WM-Sim — Heftruck</b><br>W/S: rijden · A/D: sturen · <b>↑/↓</b>: vorken heffen/zakken · Muis: rondkijken<br><b>1</b>: scanner · <b>2</b>: tablet (F: dichtbij) in je rechterhand<br>Oppakken: vorken onder de pallet en heffen · Neerzetten: zakken<br><b>R</b>: uitstappen · <b>V</b>: first/third person · <b>C</b>: overzicht';
  const refreshHud = () => (hud.innerHTML = (vehicle && mode !== 'overview' ? drivingText : hudText[mode]) + processKeys);

  function setMode(m: ViewMode) {
    mode = m;
    if (m !== 'overview') closeMode = m;
    controls.enabled = m === 'overview';
    player.visible = m !== 'first' || !!vehicle; // lopend geen eigen lichaam in beeld; in de heftruck zie je het onder je
    if (m !== 'first' && document.pointerLockElement === canvas) document.exitPointerLock();
    if (m === 'overview') {
      camera.position.set(-48, 58, 82); // schuin van voren: dockgevel en voorgevel in beeld
      controls.target.set(-6, 0, 2);
    } else if (m === 'first') {
      pitch = vehicle ? SEAT_PITCH : 0;
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
      ride = null;
      if (mode === 'overview') {
        controls.update();
      } else if (mode === 'first') {
        o.localToWorld(camera.position.copy(vehicle.eye ?? vehicle.seat));
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
    const p = player.position;
    // Eerst de blokken ophalen: dat werkt ook de stand van de heftruck bij, nodig voor het meebewegen hieronder.
    const all = solids.map((source) => source());
    const rode = ride;
    // Sta je op iets dat beweegt (de vorken van de heftruck), dan ga je mee
    if (ride) {
      const { pose } = ride;
      const c = Math.cos(pose.r);
      const n = Math.sin(pose.r);
      p.x = pose.x + ride.x * c + ride.z * n;
      p.z = pose.z - ride.x * n + ride.z * c;
      player.rotation.y += pose.r - ride.r;
    }
    const startX = p.x;
    const startZ = p.z;

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

    // Hoogte: zwaartekracht, je hoofd stoten, en de ondergrond (vloer, pallet, vorken, stellingniveau)
    const prevFeet = p.y;
    let feet = prevFeet;
    if (!grounded) {
      velY -= GRAVITY * dt;
      feet += velY * dt;
    }
    let ground = 0;
    let on: Solid | null = null;
    for (const list of all)
      for (const s of list) {
        toLocal(s, p.x, p.z);
        if (velY > 0 && s.minY >= prevFeet + PLAYER_HEIGHT - 0.05 && s.minY < feet + PLAYER_HEIGHT && inside(s, PLAYER_RADIUS)) {
          feet = s.minY - PLAYER_HEIGHT;
          velY = 0;
        }
        // Stond je al op de vorken, dan blijf je erop, hoe snel ze ook stijgen (ook bij een haperend beeld).
        const lifted = !!rode?.lift && !!s.lift && s.pose === rode.pose;
        if (s.maxY > ground && (s.maxY <= prevFeet + STEP || lifted) && inside(s, FOOT)) {
          ground = s.maxY;
          on = s;
        }
      }
    if (grounded) {
      if (ground >= feet - STEP) {
        feet = ground; // op- of afstapje, of de ondergrond beweegt (vorken)
      } else {
        velY = 0; // van een rand af: vallen
        grounded = false;
      }
    } else if (feet <= ground) {
      feet = ground;
      if (velY <= 0) {
        velY = 0;
        grounded = true;
      }
    }
    p.y = feet;

    // Niet door obstakels lopen: langs de kortste kant terugduwen. Alleen wat op jouw hoogte zit telt.
    for (const list of all)
      for (const s of list) {
        if (s.maxY <= feet + STEP || s.minY >= feet + PLAYER_HEIGHT - 0.02) continue;
        toLocal(s, p.x, p.z);
        const overlapX = Math.min(lx - (s.minX - PLAYER_RADIUS), s.maxX + PLAYER_RADIUS - lx);
        const overlapZ = Math.min(lz - (s.minZ - PLAYER_RADIUS), s.maxZ + PLAYER_RADIUS - lz);
        if (overlapX <= 0 || overlapZ <= 0) continue;
        if (overlapX < overlapZ) lx = lx < (s.minX + s.maxX) / 2 ? s.minX - PLAYER_RADIUS : s.maxX + PLAYER_RADIUS;
        else lz = lz < (s.minZ + s.maxZ) / 2 ? s.minZ - PLAYER_RADIUS : s.maxZ + PLAYER_RADIUS;
        if (s.pose) {
          const c = Math.cos(s.pose.r);
          const n = Math.sin(s.pose.r);
          p.x = s.pose.x + lx * c + lz * n;
          p.z = s.pose.z - lx * n + lz * c;
        } else {
          p.x = lx;
          p.z = lz;
        }
      }
    const walked = Math.hypot(p.x - startX, p.z - startZ) / Math.max(dt, 1e-4);
    moving += (Math.min(1, walked / 5) - moving) * (1 - Math.exp(-dt * 10));

    // Onthouden waar je op staat, zodat je in het volgende beeld meebeweegt
    const stoodOn = on as Solid | null;
    if (grounded && stoodOn?.pose) {
      toLocal(stoodOn, p.x, p.z);
      ride = { pose: stoodOn.pose, x: lx, z: lz, r: stoodOn.pose.r, lift: !!stoodOn.lift };
    } else {
      ride = null;
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
  function setVehicle(v: Vehicle | null) {
    vehicle = v;
    lookYaw = 0;
    pitch = v ? SEAT_PITCH : 0;
    player.visible = mode !== 'first' || !!v;
    player.position.y = 0;
    velY = 0;
    grounded = true;
    ride = null;
    refreshHud();
    onModeChange?.(mode);
  }

  return {
    update,
    setMode,
    setVehicle,
    get mode() { return mode; },
    get moving() { return moving; },
    /** Het bewegende voorwerp waar de speler op staat (heftruck), met zijn plek daarop; anders null. */
    get standingOn() { return ride; },
    /** Kijkrichting: omhoog/omlaag, en vanaf de stoel van een voertuig ook opzij. */
    get look() { return { yaw: lookYaw, pitch }; },
  };
}
