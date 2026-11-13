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
  /** Loopbaar gebied (x/z-grenzen): de hal. */
  bounds: Zone;
  /** Gebieden buiten de hal waar de speler ook mag lopen (deuropeningen en de kamers erachter). */
  walkable?: Zone[];
  /** Bronnen van blokken (stellingen, pallets, heftruck) waar de speler tegenaan loopt, op staat of onderdoor loopt. */
  solids?: (() => Solid[])[];
  /**
   * Wat de speler voor zich uit heeft (een pallet die hij draagt, de pompwagen): cirkels op `ahead` m voor hem.
   * Ook die botsen, zodat hij er nergens mee doorheen loopt. underPallets = schuift onder een pallet (vorken).
   */
  probes?: () => Probe[];
  /** De blokken waar die cirkels tegen botsen (standaard dezelfde als `solids`). */
  probeSolids?: (() => Solid[])[];
  initialMode?: ViewMode;
  onModeChange?: (mode: ViewMode) => void;
}

type Zone = { minX: number; maxX: number; minZ: number; maxZ: number };
export type Probe = { ahead: number; radius: number; underPallets?: boolean };

/**
 * Voertuig (of stoel) waarin de speler zit: `seat` is de plek van de speler, `eye` die van de camera in first person (lokaal).
 * Voor een stoel: `hud` = eigen uitleg van de besturing, `pitch` = kijkhoek bij het gaan zitten, `chase` = volgcamera in
 * third person (afstand erachter, hoogte, en de hoogte waar hij naar kijkt).
 */
type Vehicle = { object: THREE.Object3D; seat: THREE.Vector3; eye?: THREE.Vector3; hud?: string; pitch?: number; chase?: { back: number; up: number; lookY: number } };

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

export function createPlayerView({ camera, canvas, controls, player, hud, bounds, walkable = [], solids = [], probes, probeSolids, initialMode = 'overview', onModeChange }: Options) {
  const zones = [bounds, ...walkable];
  let mode: ViewMode = 'overview';
  let closeMode: Exclude<ViewMode, 'overview'> = 'first'; // laatst gebruikte dichtbij-modus
  let pitch = 0;
  let velY = 0;
  let grounded = true;
  let moving = 0; // 0..1, voor de loopbeweging van wat je vasthoudt
  let walk = 0; // eigen loopsnelheid (m/s, negatief = achteruit), zonder het meebewegen met de heftruck
  /** Voertuig waarin de speler zit (heftruck); de speler en camera volgen het dan. */
  let vehicle: Vehicle | null = null;
  let lookYaw = 0; // rondkijken vanaf de stoel
  /** Eigen lichaam ook lopend in first person tekenen (met de pompwagen: je ziet je handen op de greep). */
  let body = false;
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

  const processKeys =
    '<br><b>E</b>: scannen / actie (bij de pc: WMS-app) · <b>Enter</b> of <b>T</b>: chatten<br><b>Tab</b>: dit menu ·<b>L</b>: API-log · <b>I</b>: voorraad · <b>K</b>: WMS-API';
  const hudText: Record<ViewMode, string> = {
    overview:
      '<b>WM-Sim — Overzicht</b><br>Slepen: draaien · Scroll: zoom · Rechts slepen: schuiven<br><b>C</b>: dichtbij (first person)',
    first:
      '<b>WM-Sim — First person</b><br>Klik: muis vastzetten · Muis: rondkijken · Esc: muis los<br>W/S: lopen · A/D: zijwaarts · ←/→: draaien · Shift: rennen · Spatie: springen<br><b>1</b>: scanner (klik op een label = scannen naar de WMS) · <b>2</b>: tablet met WMS (F: dichtbij en bedienen)<br><b>R</b>: in de heftruck stappen of de pompwagen pakken (als je ernaast staat) · op de vorken staan: een ander tilt je op · <b>M</b>: radio (op het bureau bij de pc; <b>+</b>/<b>-</b>: harder en zachter) · <b>B</b>: picklijst afdrukken en pakken (printer naast de pc) · <b>V</b>: third person · <b>C</b>: overzicht',
    third:
      '<b>WM-Sim — Third person</b><br>W/S: lopen · A/D: draaien · Shift: rennen · Spatie: springen<br><b>V</b>: first person · <b>C</b>: overzicht',
  };

  const drivingText =
    '<b>WM-Sim — Heftruck</b><br>W/S: rijden · A/D: sturen · <b>↑/↓</b>: vorken heffen/zakken · <b>H</b>: toeteren · Muis: rondkijken<br><b>1</b>: scanner · <b>2</b>: tablet (F: dichtbij) in je rechterhand<br>Oppakken: vorken onder de pallet en heffen · Neerzetten: zakken<br><b>R</b>: uitstappen · <b>V</b>: first/third person · <b>C</b>: overzicht';
  const refreshHud = () => (hud.innerHTML = (vehicle && mode !== 'overview' ? (vehicle.hud ?? drivingText) : hudText[mode]) + processKeys);

  function setMode(m: ViewMode) {
    mode = m;
    if (m !== 'overview') closeMode = m;
    controls.enabled = m === 'overview';
    player.visible = m !== 'first' || !!vehicle || body; // lopend geen eigen lichaam in beeld; in de heftruck zie je het onder je
    if (m !== 'first' && document.pointerLockElement === canvas) document.exitPointerLock();
    if (m === 'overview') {
      camera.position.set(-48, 58, 82); // schuin van voren: dockgevel en voorgevel in beeld
      controls.target.set(-6, 0, 2);
    } else if (m === 'first') {
      pitch = vehicle ? (vehicle.pitch ?? SEAT_PITCH) : 0;
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
      walk = 0;
      ride = null;
      if (mode === 'overview') {
        controls.update();
      } else if (mode === 'first') {
        o.localToWorld(camera.position.copy(vehicle.eye ?? vehicle.seat));
        camera.rotation.set(pitch, o.rotation.y + Math.PI + lookYaw, 0, 'YXZ');
      } else {
        forward.set(Math.sin(o.rotation.y), 0, Math.cos(o.rotation.y));
        const chase = vehicle.chase ?? { back: 7.5, up: 4.5, lookY: 1.6 };
        camTarget.copy(o.position).addScaledVector(forward, -chase.back).setY(chase.up);
        camera.position.lerp(camTarget, 1 - Math.exp(-dt * 5));
        camera.lookAt(o.position.x, chase.lookY, o.position.z);
      }
      return;
    }

    if (mode === 'overview') {
      controls.update();
      moving = 0;
      walk = 0;
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
    // Binnen het loopbare gebied blijven: de hal, of een gebied erbuiten (aanbouw). Loop je overal uit, dan houdt
    // het gebied waar je vandaan kwam je tegen.
    const within = (z: Zone, x: number, zz: number) => x >= z.minX && x <= z.maxX && zz >= z.minZ && zz <= z.maxZ;
    if (!zones.some((z) => within(z, p.x, p.z))) {
      const home = zones.find((z) => within(z, startX, startZ)) ?? bounds;
      p.x = THREE.MathUtils.clamp(p.x, home.minX, home.maxX);
      p.z = THREE.MathUtils.clamp(p.z, home.minZ, home.maxZ);
    }

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
    // Wat je voor je uit hebt (een pallet, de pompwagen) loopt ook nergens doorheen: het duwt jou terug
    const ahead = probes?.() ?? [];
    if (ahead.length) {
      const lists = probeSolids ? probeSolids.map((source) => source()) : all;
      for (const probe of ahead)
        for (const list of lists)
          for (const s of list) {
            if (s.maxY <= feet + STEP || s.minY >= feet + PLAYER_HEIGHT - 0.02 || (probe.underPallets && s.pallet)) continue;
            const cx = p.x + forward.x * probe.ahead;
            const cz = p.z + forward.z * probe.ahead;
            toLocal(s, cx, cz);
            const overlapX = Math.min(lx - (s.minX - probe.radius), s.maxX + probe.radius - lx);
            const overlapZ = Math.min(lz - (s.minZ - probe.radius), s.maxZ + probe.radius - lz);
            if (overlapX <= 0 || overlapZ <= 0) continue;
            const fromX = lx;
            const fromZ = lz;
            if (overlapX < overlapZ) lx = lx < (s.minX + s.maxX) / 2 ? s.minX - probe.radius : s.maxX + probe.radius;
            else lz = lz < (s.minZ + s.maxZ) / 2 ? s.minZ - probe.radius : s.maxZ + probe.radius;
            const mx = lx - fromX;
            const mz = lz - fromZ;
            const c = s.pose ? Math.cos(s.pose.r) : 1;
            const n = s.pose ? Math.sin(s.pose.r) : 0;
            p.x += mx * c + mz * n;
            p.z += -mx * n + mz * c;
          }
    }
    const walked = Math.hypot(p.x - startX, p.z - startZ) / Math.max(dt, 1e-4);
    walk = (p.x - startX) * forward.x + (p.z - startZ) * forward.z < -1e-5 ? -walked : walked;
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
      if (body) camera.position.addScaledVector(forward, 0.1).y += 0.06; // net voor en boven de romp, zodat je er niet in kijkt
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
    pitch = v ? (v.pitch ?? SEAT_PITCH) : 0;
    player.visible = mode !== 'first' || !!v || body;
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
    /** Eigen lichaam (zonder hoofd) ook lopend in first person tonen, of niet. */
    setBody(on: boolean) {
      body = on;
      player.visible = mode !== 'first' || !!vehicle || body;
      onModeChange?.(mode);
    },
    get mode() { return mode; },
    get moving() { return moving; },
    /** Eigen loopsnelheid (m/s, negatief = achteruit): staat de speler stil op rijdende of stijgende vorken, dan is dit nul. */
    get walk() { return walk; },
    /** Los van de grond (springen of vallen)? Op de vorken of in een stelling staan telt als grond. */
    get airborne() { return !grounded && !vehicle; },
    /** Het bewegende voorwerp waar de speler op staat (heftruck), met zijn plek daarop; anders null. */
    get standingOn() { return ride; },
    /** Kijkrichting: omhoog/omlaag, en vanaf de stoel van een voertuig ook opzij. */
    get look() { return { yaw: lookYaw, pitch }; },
  };
}
