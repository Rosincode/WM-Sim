import * as THREE from 'three';
import { menu } from './menu';

// Geluid van alles wat rijdt in de hal: de heftruck, de pompwagen en de robots.
// Alles wordt ter plekke opgewekt (Web Audio), er zijn geen geluidsbestanden. De module leest alleen
// de stand van een bron (plek, richting, hefhoogte) en leidt daar zelf snelheid en hefbeweging uit af:
// daardoor klinkt een voertuig dat een andere speler bestuurt precies hetzelfde.
// - Heftruck (elektrisch): zoemende motor, banden op beton, hydrauliekpomp bij heffen, sissen bij zakken,
//   pieper bij achteruitrijden.
// - Pompwagen: ratelende harde wielen, pompslagen bij omhoog pompen, sissen en een bons bij laten zakken.
// - Robots: zachte aandrijving, servo van hefplateau/vorken/mast/arm, dubbele piep als iets in de weg staat.
// Verder weg klinkt alles zachter; links en rechts volgen de kijkrichting.

export type SoundKind = 'forklift' | 'jack' | 'robot';
export interface SoundSource {
  readonly x: number;
  readonly z: number;
  /** Rijrichting (draaiing om y); voorkant naar +Z. */
  readonly r: number;
  /** Stand (m) van alles wat heft of uitschuift; verandert die, dan hoor je de aandrijving ervan. */
  readonly lift: number;
  /** Robot die wacht omdat er iets in de weg staat. */
  readonly waiting?: boolean;
}

/** Bron voor een voertuig in de scène. */
export function objectSource(o: THREE.Object3D, lift: () => number): SoundSource {
  return {
    get x() { return o.position.x; },
    get z() { return o.position.z; },
    get r() { return o.rotation.y; },
    get lift() { return lift(); },
  };
}

type Motion = { speed: number; along: number; rate: number; waiting: boolean; dt: number };
type Driver = (m: Motion) => void;
type Voice = {
  kind: SoundKind;
  source: SoundSource;
  x: number;
  z: number;
  lift: number;
  speed: number;
  rate: number;
  out?: GainNode;
  pan?: StereoPannerNode;
  drive?: Driver;
  silent: boolean;
};

const VOLUME_KEY = 'wm-sim.sound.volume';
/** Binnen deze afstand (m) klinkt een bron op volle sterkte. */
const NEAR: Record<SoundKind, number> = { forklift: 5, jack: 3, robot: 3 };
const FAR = 60;

export function createSounds() {
  const voices: Voice[] = [];
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noise: AudioBuffer | null = null;

  let volume = 0.7;
  try {
    const saved = Number(localStorage.getItem(VOLUME_KEY) ?? NaN);
    if (saved >= 0 && saved <= 1) volume = saved;
  } catch {
    // geen localStorage: standaardvolume
  }

  // ---------- Menu: volume ----------
  const panel = document.createElement('div');
  panel.innerHTML = `<label style="display:block">Geluid van de heftruck, de pompwagen en de robots
    <input type="range" min="0" max="100" step="5" style="display:block;width:100%;margin-top:8px"></label>
    <div style="margin-top:8px;color:#9aa0a6">Helemaal naar links is uit. De radio, de toeter, de scanner en de printer hebben hun eigen volume.</div>`;
  const slider = panel.querySelector('input')!;
  slider.value = String(Math.round(volume * 100));
  slider.addEventListener('input', () => {
    volume = Number(slider.value) / 100;
    if (ctx && master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.05);
    try {
      localStorage.setItem(VOLUME_KEY, String(volume));
    } catch {
      // niet bewaard: geldt dan alleen voor deze sessie
    }
  });
  slider.addEventListener('change', () => slider.blur());
  menu.addSection('sound', 'Geluid', panel, 8);

  // De browser laat pas geluid toe na een klik of toets van de speler zelf.
  const unlock = () => {
    try {
      if (!ctx) {
        ctx = new AudioContext();
        master = ctx.createGain();
        master.gain.value = volume;
        master.connect(ctx.destination);
        noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const data = noise.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      if (ctx.state === 'suspended' && !document.hidden) void ctx.resume();
    } catch {
      ctx = null; // geen geluid beschikbaar: de game werkt ook stil
    }
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  // Een verborgen tabblad tekent niet meer en werkt het geluid dus ook niet bij: dan stil.
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) void ctx.suspend();
    else void ctx.resume();
  });

  // ---------- Bouwstenen ----------
  function build(v: Voice, ctx: AudioContext, master: GainNode, noise: AudioBuffer) {
    const pan = ctx.createStereoPanner();
    pan.connect(master);
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(pan);

    const gain = (dest: AudioNode | AudioParam, value = 0) => {
      const g = ctx.createGain();
      g.gain.value = value;
      g.connect(dest as AudioNode);
      return g;
    };
    const filter = (type: BiquadFilterType, freq: number, dest: AudioNode, q = 0.7) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      f.connect(dest);
      return f;
    };
    const osc = (type: OscillatorType, freq: number, dest: AudioNode | AudioParam) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.connect(dest as AudioNode);
      o.start();
      return o;
    };
    /** Doorlopende ruis. */
    const hiss = (dest: AudioNode) => {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      s.loop = true;
      s.connect(dest);
      s.start(0, Math.random() * 1.5);
    };
    const to = (p: AudioParam, value: number, tc = 0.05) => p.setTargetAtTime(value, ctx.currentTime, tc);
    /** Kort stukje ruis (tik, slag, sis). */
    const burst = (type: BiquadFilterType, freq: number, level: number, dur: number, delay = 0) => {
      const t = ctx.currentTime + delay;
      const g = gain(out);
      g.gain.setValueAtTime(level, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const s = ctx.createBufferSource();
      s.buffer = noise;
      s.connect(filter(type, freq, g, 1));
      s.start(t, Math.random() * 1.5, dur + 0.05);
      s.onended = () => g.disconnect();
    };
    /** Doffe bons: een lage toon die snel wegzakt. */
    const thud = (level: number, delay = 0) => {
      const t = ctx.currentTime + delay;
      const g = gain(out);
      g.gain.setValueAtTime(level, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(110, t);
      o.frequency.exponentialRampToValueAtTime(50, t + 0.14);
      o.connect(g);
      o.start(t);
      o.stop(t + 0.2);
      o.onended = () => g.disconnect();
    };

    const drivers: Record<SoundKind, () => Driver> = {
      forklift() {
        const motorGain = gain(out);
        const motorFilter = filter('lowpass', 400, motorGain);
        const motor = osc('sawtooth', 60, motorFilter);
        const whineGain = gain(out);
        const whine = osc('triangle', 420, whineGain);
        const rollGain = gain(out);
        hiss(filter('lowpass', 500, rollGain));
        const pumpGain = gain(out);
        osc('sawtooth', 150, filter('bandpass', 600, pumpGain, 1.2));
        const hissGain = gain(out);
        hiss(filter('highpass', 2200, hissGain));
        const beepGain = gain(out);
        osc('square', 1000, filter('lowpass', 2500, beepGain));
        let beep = 0;
        return (m) => {
          const n = Math.min(1, m.speed / 4);
          to(motor.frequency, 60 + 130 * n);
          to(motorFilter.frequency, 380 + 500 * n);
          to(motorGain.gain, 0.06 * Math.sqrt(n));
          to(whine.frequency, 420 + 1100 * n);
          to(whineGain.gain, 0.012 * n);
          to(rollGain.gain, 0.07 * n);
          // Heffen: de pomp draait. Zakken: alleen de olie die terugstroomt.
          to(pumpGain.gain, m.rate > 0.03 ? 0.05 : 0);
          to(hissGain.gain, m.rate > 0.03 ? 0.015 : m.rate < -0.03 ? 0.04 : 0);
          const reversing = m.along < -0.3;
          beep = reversing ? (beep + m.dt) % 0.8 : 0;
          to(beepGain.gain, reversing && beep < 0.4 ? 0.02 : 0, 0.008);
        };
      },
      jack() {
        // Harde wielen op beton: ruis die ratelt, sneller naarmate je harder loopt
        const rollGain = gain(out);
        const rattle = gain(rollGain, 0.6);
        hiss(filter('bandpass', 900, rattle, 0.7));
        const lfo = osc('square', 9, gain(rattle.gain, 0.4));
        let dir = 0;
        return (m) => {
          const n = Math.min(1, m.speed / 2.2);
          to(rollGain.gain, 0.09 * n);
          to(lfo.frequency, 8 + 10 * n);
          if (m.rate > 0.05 && dir !== 1) {
            dir = 1; // omhoog pompen: drie slagen met de dissel
            for (const d of [0, 0.17, 0.34]) {
              burst('highpass', 3500, 0.1, 0.02, d);
              burst('bandpass', 1400, 0.12, 0.09, d);
            }
          } else if (m.rate < -0.05 && dir !== -1) {
            dir = -1; // ventiel open: sissend zakken, en de last komt neer
            burst('highpass', 2500, 0.08, 0.4);
            thud(0.2, 0.28);
          } else if (Math.abs(m.rate) < 0.01) dir = 0;
        };
      },
      robot() {
        const base = 90 + Math.random() * 14; // elke robot net een andere toon
        const motorGain = gain(out);
        const motor = osc('triangle', base, filter('lowpass', 1200, motorGain));
        const servoGain = gain(out);
        const servo = osc('sawtooth', 480, filter('bandpass', 1400, servoGain, 2));
        const beepGain = gain(out);
        osc('sine', 1500, beepGain);
        let beep = 0;
        return (m) => {
          const n = Math.min(1, m.speed / 1.8);
          to(motor.frequency, base + 160 * n);
          to(motorGain.gain, 0.04 * Math.sqrt(n));
          const moving = Math.abs(m.rate) > 0.02;
          if (moving) to(servo.frequency, m.rate > 0 ? 520 : 430);
          to(servoGain.gain, moving ? 0.012 : 0);
          // Iets in de weg: om de drie seconden een dubbele piep
          beep = m.waiting ? (beep + m.dt) % 3 : 0;
          to(beepGain.gain, m.waiting && (beep < 0.08 || (beep > 0.16 && beep < 0.24)) ? 0.02 : 0, 0.008);
        };
      },
    };
    v.out = out;
    v.pan = pan;
    v.drive = drivers[v.kind]();
  }

  const right = new THREE.Vector3();
  return {
    /** Meldt iets aan dat geluid maakt. */
    add(kind: SoundKind, source: SoundSource) {
      voices.push({ kind, source, x: source.x, z: source.z, lift: source.lift, speed: 0, rate: 0, silent: true });
    },
    /** Elke frame. `ear` is waar je luistert (de camera, of in het overzicht het punt waar je naar kijkt). */
    update(dt: number, ear: THREE.Vector3, camera: THREE.Camera) {
      if (dt <= 0) return;
      const live = ctx && master && noise && ctx.state === 'running' && volume > 0;
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      const rl = Math.hypot(right.x, right.z) || 1;
      for (const v of voices) {
        const s = v.source;
        // Snelheid en hefbeweging uit het verschil met de vorige frame; een sprong (reset, teleport) telt niet
        const vx = (s.x - v.x) / dt;
        const vz = (s.z - v.z) / dt;
        const raw = Math.hypot(vx, vz);
        const jump = raw > 15;
        v.speed += ((jump ? 0 : raw) - v.speed) * Math.min(1, dt * 10);
        const rate = THREE.MathUtils.clamp((s.lift - v.lift) / dt, -3, 3);
        v.rate += (rate - v.rate) * Math.min(1, dt * 14);
        v.x = s.x;
        v.z = s.z;
        v.lift = s.lift;
        if (!live) continue;

        const dx = s.x - ear.x;
        const dz = s.z - ear.z;
        const d = Math.hypot(dx, dz);
        const level = d > FAR ? 0 : Math.pow(NEAR[v.kind] / Math.max(d, NEAR[v.kind]), 1.2);
        if (level === 0 && v.silent) continue;
        if (!v.drive) build(v, ctx!, master!, noise!);
        const t = ctx!.currentTime;
        v.out!.gain.setTargetAtTime(level, t, 0.08);
        v.silent = level === 0;
        if (v.silent) continue;
        v.pan!.pan.setTargetAtTime(d < 0.5 ? 0 : THREE.MathUtils.clamp((dx * right.x + dz * right.z) / (d * rl), -1, 1) * 0.8, t, 0.08);
        const along = jump ? 0 : vx * Math.sin(s.r) + vz * Math.cos(s.r);
        v.drive!({ speed: v.speed, along, rate: v.rate, waiting: !!s.waiting, dt });
      }
    },
  };
}
