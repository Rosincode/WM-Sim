import * as THREE from 'three';
import { onTop } from './scene/style';

// Radio in het magazijn: speelt de live stream van een echte zender (internetradio).
// M (als je erbij staat): uit → PiratenRadio.nl → 100% NL → uit. + en -: harder en zachter. Verder weg klinkt hij zachter.
// De radio is van iedereen: de zender en het volume die één speler kiest, gelden voor alle spelers (zie src/ui/multiplayer.ts).
// De voorkant (luidspreker en display) wijst naar de -Z-kant.

const STATIONS = [
  { name: 'PiratenRadio.nl', url: 'https://stream.piratenradio.nl/listen/piratenradio/prradio', color: '#ffb300' },
  { name: '100% NL', url: 'https://stream.100p.nl/100pctnl.mp3', color: '#ff6a2b' },
];
/** Binnen deze afstand bedien je de radio met M. */
const NEAR = 2.5;
/** Volumeknop: stand 0 (stil) t/m 10 (voluit). Het volume loopt kwadratisch op, zodat de lage standen echt zacht zijn. */
const MAX_LEVEL = 10;
const DEFAULT_LEVEL = 8;

export function createRadio() {
  const group = new THREE.Group();
  const mat = (color: string, roughness = 0.6, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const add = (geo: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    group.add(m);
    return m;
  };
  const body = mat('#7a2f24', 0.45);
  const dark = mat('#17181a', 0.8);
  const chrome = mat('#c9ced3', 0.3, 0.9);

  // Kast, luidspreker, knoppen, handvat en antenne
  add(new THREE.BoxGeometry(0.34, 0.19, 0.1), body, 0, 0.095, 0);
  add(new THREE.CylinderGeometry(0.07, 0.07, 0.012, 24), dark, 0.08, 0.09, -0.05).rotation.x = Math.PI / 2;
  for (const x of [-0.12, -0.05]) add(new THREE.CylinderGeometry(0.016, 0.016, 0.02, 16), chrome, x, 0.05, -0.055).rotation.x = Math.PI / 2;
  add(new THREE.BoxGeometry(0.24, 0.012, 0.012), chrome, 0, 0.225, 0);
  for (const x of [-0.12, 0.12]) add(new THREE.BoxGeometry(0.012, 0.04, 0.012), chrome, x, 0.205, 0);
  const antenna = add(new THREE.CylinderGeometry(0.003, 0.003, 0.36, 6), chrome, -0.2, 0.33, 0.03);
  antenna.rotation.z = 0.35;

  // Display met de naam van de zender
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const display = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.056), onTop(new THREE.MeshBasicMaterial({ map: texture })));
  display.position.set(-0.085, 0.125, -0.051);
  display.rotation.y = Math.PI;
  group.add(display);

  let station = -1; // -1 = uit
  let level = DEFAULT_LEVEL;
  let failed = false;
  let distance = Infinity;

  function draw() {
    const s = STATIONS[station];
    ctx.fillStyle = s ? '#1d1206' : '#0b0d10';
    ctx.fillRect(0, 0, 256, 96);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = s ? s.color : '#3a4048';
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.fillText(s ? s.name : 'UIT', 128, s ? 36 : 48, 236);
    if (s) {
      ctx.font = '20px system-ui, sans-serif';
      ctx.fillText(failed ? 'geen verbinding' : '● LIVE', 128, 62, 236);
      // Volumebalk: een blokje per stand
      for (let i = 0; i < MAX_LEVEL; i++) {
        ctx.globalAlpha = i < level ? 1 : 0.22;
        ctx.fillRect(33 + i * 19.4, 80, 15, 8);
      }
      ctx.globalAlpha = 1;
    }
    texture.needsUpdate = true;
  }
  draw();

  // Een gewoon audio-element: de stream is altijd live, er wordt niets gebufferd als de radio uit staat.
  const audio = new Audio();
  audio.preload = 'none';
  audio.addEventListener('error', () => {
    if (station < 0 || !audio.error) return;
    failed = true;
    draw();
  });

  /** De browser hield het geluid tegen (nog geen klik of toets van deze speler): bij de eerstvolgende opnieuw proberen. */
  let blocked = false;
  /** Tot dit tijdstip ziet iedereen, ook ver weg, een melding dat de radio is geschakeld. */
  let noticeUntil = 0;
  function play() {
    const i = station;
    blocked = false;
    audio.play().catch((err: unknown) => {
      if (station !== i || (err instanceof DOMException && err.name === 'AbortError')) return; // intussen doorgeschakeld
      if (err instanceof DOMException && err.name === 'NotAllowedError') blocked = true;
      else failed = true;
      draw();
    });
  }

  function tune(i: number) {
    if (i === station) return;
    station = i;
    failed = false;
    blocked = false;
    noticeUntil = performance.now() + 5000;
    if (i < 0) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } else {
      audio.src = STATIONS[i].url;
      play();
    }
    draw();
  }

  function setLevel(l: number) {
    const next = THREE.MathUtils.clamp(Math.round(l), 0, MAX_LEVEL);
    if (next === level) return false;
    level = next;
    draw();
    return true;
  }

  const changeListeners: (() => void)[] = [];
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    if (distance > NEAR || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyM' && !e.repeat) {
      tune(station + 1 < STATIONS.length ? station + 1 : -1);
      changeListeners.forEach((l) => l());
      return;
    }
    // + en - (ook op het numerieke deel): harder en zachter, alleen als hij aan staat
    const step = e.key === '+' || e.key === '=' ? 1 : e.key === '-' || e.key === '_' ? -1 : 0;
    if (step && station >= 0 && setLevel(level + step)) changeListeners.forEach((l) => l());
  });
  // Een andere speler zette de radio aan voordat deze speler iets had aangeraakt: nu mag het geluid wel.
  const retry = () => {
    if (blocked && station >= 0) play();
  };
  window.addEventListener('pointerdown', retry);
  window.addEventListener('keydown', retry);

  const world = new THREE.Vector3();
  return {
    group,
    /** De gekozen zender (index), -1 = uit. De radio is van iedereen: multiplayer deelt deze stand. */
    get station() {
      return station;
    },
    /** Een andere speler schakelde de radio: overnemen. */
    setStation(i: number) {
      tune(Number.isInteger(i) && i >= 0 && i < STATIONS.length ? i : -1);
    },
    /** De stand van de volumeknop (0 t/m 10); geldt net als de zender voor alle spelers. */
    get volume() {
      return level;
    },
    /** Een andere speler draaide aan de volumeknop: overnemen. */
    setVolume(l: number) {
      if (Number.isFinite(l)) setLevel(l);
    },
    /** Deze speler schakelde zelf de radio (met M) of zette hem harder of zachter (+ en -). */
    onChange(l: () => void) {
      changeListeners.push(l);
    },
    /** Tekst voor de speler die bij de radio staat, anders leeg. */
    get hint() {
      const s = STATIONS[station];
      if (distance > NEAR) {
        // Niet bij de radio: alleen kort melden dat iemand hem schakelde, of dat de browser het geluid nog tegenhoudt
        if (s && blocked) return `Radio staat aan (${s.name}): klik of druk op een toets om hem te horen`;
        if (performance.now() > noticeUntil) return '';
        return s ? `Radio aan: <b>${s.name}</b>` : 'Radio uit';
      }
      const next = STATIONS[station + 1];
      if (!s) return `<b>M</b>: radio aanzetten (${STATIONS[0].name})`;
      return `Radio: <b>${s.name}</b>${failed ? ' (geen verbinding)' : ''} · <b>M</b>: ${next ? next.name : 'uitzetten'} · <b>+</b>/<b>-</b>: volume ${level}/${MAX_LEVEL}`;
    },
    /** listener: waar de speler staat; hoe verder weg, hoe zachter de radio. */
    update(listener: THREE.Vector3) {
      group.getWorldPosition(world);
      distance = Math.hypot(listener.x - world.x, listener.z - world.z);
      if (station >= 0) audio.volume = (level / MAX_LEVEL) ** 2 * THREE.MathUtils.clamp(6 / Math.max(distance, 1), 0.35, 1); // in de hele hal goed te horen
    },
  };
}
