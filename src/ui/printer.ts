import * as THREE from 'three';
import { articleName } from '../sim/catalog';
import { location } from '../sim/layout';
import type { Item } from '../shared/contract';
import type { SimOrder } from '../sim/warehouse';
import { onTop } from './scene/style';

// Laserprinter op het bureau naast de pc: drukt de picklijst van een order af.
// B (als je erbij staat): afdrukken → het vel schuift eruit → B: vel pakken. Het vel houd je daarna linksboven
// in beeld; regels die gepickt zijn worden afgevinkt. B verder weg: het vel wegleggen.
// De picklijst is een afdruk: de locaties zijn de voorraad op het moment van afdrukken (zoals de WMS die meldt).
// De printer is van deze speler alleen; andere spelers zien en horen hem niet.
// De voorkant (papieruitvoer) wijst naar de -Z-kant.

/** Binnen deze afstand bedien je de printer met B. */
const NEAR = 2;
/** Opwarmen (s) en daarna het vel naar buiten (s). */
const WARM = 0.7;
const FEED = 2.2;
const PAPER = { w: 0.21, h: 0.297 };
const SHEET_PX = { w: 512, h: 724 };

type Line = { sku: string; name: string; qty: number; places: string[] };
type Sheet = { orderId: string; lines: Line[]; printedAt: string };

export interface PrinterSource {
  orders: () => SimOrder[];
  /** Id van de order die deze speler onderhanden heeft, anders null. */
  carriedOrder: () => string | null;
  stockList: () => Item[];
}

const css = `
.picklist { position: fixed; left: 16px; top: 16px; z-index: 15; width: min(290px, calc(100vw - 32px)); box-sizing: border-box;
  padding: 12px 14px 10px; background: #f7f5ef; color: #1d1f22; border-radius: 2px; transform: rotate(-0.8deg);
  box-shadow: 0 6px 22px rgba(0,0,0,.4); font: 12px/1.35 ui-monospace, Consolas, monospace; pointer-events: none; display: none; }
.picklist.on { display: block; }
.picklist h3 { margin: 0; font: bold 15px system-ui, sans-serif; letter-spacing: .08em; }
.picklist .meta { display: flex; justify-content: space-between; margin: 2px 0 8px; color: #5a5f66; }
.picklist .bars { height: 22px; margin-bottom: 8px; }
.picklist .ln { display: grid; grid-template-columns: 18px 1fr; gap: 0 6px; padding: 5px 0; border-top: 1px dashed #b9b4a8; }
.picklist .ln .box { font-size: 14px; line-height: 1.1; }
.picklist .ln b { font-size: 13px; }
.picklist .ln .loc { color: #5a5f66; }
.picklist .ln.done { color: #8b9097; }
.picklist .ln.done b { text-decoration: line-through; }
.picklist .foot { margin-top: 6px; padding-top: 5px; border-top: 1px solid #1d1f22; color: #5a5f66; font: 11px system-ui, sans-serif; }
`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Streepjescode-achtig patroon van een tekst (alleen voor de vorm, niet echt scanbaar). */
function bars(text: string): number[] {
  const widths: number[] = [2, 1, 1, 1];
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    widths.push(1 + (c % 3), 1 + ((c >> 2) % 2), 1 + ((c >> 3) % 3), 1 + ((c >> 1) % 2));
  }
  widths.push(2, 1, 1, 1);
  return widths;
}

function barsSvg(text: string) {
  let x = 0;
  const rects: string[] = [];
  bars(text).forEach((w, i) => {
    if (i % 2 === 0) rects.push(`<rect x="${x}" width="${w}" height="22"/>`);
    x += w;
  });
  return `<svg class="bars" viewBox="0 0 ${x} 22" preserveAspectRatio="none" width="100%">${rects.join('')}</svg>`;
}

function drawSheet(g: CanvasRenderingContext2D, s: Sheet) {
  const { w, h } = SHEET_PX;
  g.fillStyle = '#f7f6f1';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#16181b';
  g.textBaseline = 'alphabetic';
  g.font = 'bold 40px system-ui, sans-serif';
  g.fillText('PICKLIJST', 36, 70);
  g.font = 'bold 28px Consolas, monospace';
  g.fillText(s.orderId, 36, 112, w - 72);
  g.font = '20px system-ui, sans-serif';
  g.fillStyle = '#4a4f55';
  g.fillText(`Afgedrukt ${s.printedAt}`, 36, 142);
  // streepjescode van het ordernummer
  g.fillStyle = '#16181b';
  const widths = bars(s.orderId);
  const total = widths.reduce((a, b) => a + b, 0);
  const unit = (w - 72) / total;
  let x = 36;
  widths.forEach((bw, i) => {
    if (i % 2 === 0) g.fillRect(x, 160, bw * unit, 56);
    x += bw * unit;
  });
  let y = 262;
  g.fillRect(36, y - 26, w - 72, 3);
  for (const l of s.lines) {
    g.fillStyle = '#16181b';
    g.font = 'bold 26px Consolas, monospace';
    g.fillText(`${l.qty}× ${l.sku}`, 36, y + 14, w - 72);
    g.font = '21px system-ui, sans-serif';
    g.fillStyle = '#33373c';
    g.fillText(l.name || '—', 36, y + 44, w - 72);
    g.fillStyle = '#5a5f66';
    g.fillText(l.places.length ? l.places.join('  ') : 'geen voorraad in de stellingen', 36, y + 72, w - 72);
    g.strokeStyle = '#b9b4a8';
    g.setLineDash([6, 5]);
    g.beginPath();
    g.moveTo(36, y + 92);
    g.lineTo(w - 36, y + 92);
    g.stroke();
    g.setLineDash([]);
    y += 112;
    if (y > h - 60) break;
  }
  g.fillStyle = '#8b9097';
  g.font = '18px system-ui, sans-serif';
  g.fillText('WM-Sim · locaties volgens de WMS bij afdrukken', 36, h - 30, w - 72);
}

/** Kort printergeluid (opwarmen en het vel dat erdoor loopt), zachter als je verder weg staat. */
let audio: AudioContext | null = null;
function playPrintSound(volume: number) {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    if (ctx.state === 'suspended') void ctx.resume();
    const len = WARM + FEED + 0.2;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * len), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 900;
    band.Q.value = 0.9;
    const gain = ctx.createGain();
    const t0 = ctx.currentTime;
    const g = gain.gain;
    g.setValueAtTime(0, t0);
    g.linearRampToValueAtTime(0.05 * volume, t0 + 0.15); // opwarmen: zacht gezoem
    g.setValueAtTime(0.05 * volume, t0 + WARM);
    // vel loopt door: ritmisch geratel van de rollen
    for (let t = WARM; t < WARM + FEED; t += 0.09) {
      g.setValueAtTime(0.16 * volume, t0 + t);
      g.linearRampToValueAtTime(0.08 * volume, t0 + t + 0.07);
    }
    g.linearRampToValueAtTime(0, t0 + len);
    band.frequency.setValueAtTime(900, t0);
    band.frequency.linearRampToValueAtTime(1700, t0 + WARM);
    noise.connect(band).connect(gain).connect(ctx.destination);
    noise.start(t0);
    noise.stop(t0 + len);
  } catch {
    // geen geluid mogelijk: de printer werkt ook stil
  }
}

export function createPrinter(src: PrinterSource) {
  const group = new THREE.Group();
  const mat = (color: string, roughness = 0.55, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const add = (w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material, shadow = true) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y, z);
    m.castShadow = shadow;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  const shell = mat('#d9dbdc', 0.5);
  const grey = mat('#7c8186', 0.6);
  const dark = mat('#202326', 0.7);

  // Kast, deksel, papierlade onderin en de uitvoer met opvangbak aan de voorkant
  add(0.36, 0.16, 0.32, 0, 0.08, 0, shell);
  add(0.34, 0.012, 0.22, 0, 0.166, 0.035, grey);
  add(0.3, 0.05, 0.006, 0, 0.035, -0.161, grey);
  add(0.08, 0.008, 0.008, 0, 0.042, -0.166, dark);
  add(0.25, 0.014, 0.006, 0, 0.112, -0.161, dark); // sleuf waar het vel uitkomt
  add(0.24, 0.005, 0.19, 0, 0.1, -0.255, grey);
  // Bedieningspaneel rechtsvoor (vanaf de voorkant gezien) met display en lampje
  add(0.1, 0.014, 0.06, -0.11, 0.165, -0.12, dark);
  add(0.05, 0.003, 0.022, -0.1, 0.1735, -0.12, new THREE.MeshBasicMaterial({ color: '#4fa3c7' }), false);
  const ledOn = new THREE.MeshBasicMaterial({ color: '#4caf50' });
  const ledOff = new THREE.MeshBasicMaterial({ color: '#1b3a1d' });
  const led = add(0.01, 0.004, 0.01, -0.145, 0.1735, -0.12, ledOn, false);

  // Het vel: plat, bedrukte kant boven, bovenkant van de bladzijde naar de printer toe
  const canvas = document.createElement('canvas');
  canvas.width = SHEET_PX.w;
  canvas.height = SHEET_PX.h;
  const g = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const paper = new THREE.Mesh(
    new THREE.PlaneGeometry(PAPER.w, PAPER.h),
    onTop(new THREE.MeshStandardMaterial({ map: texture, roughness: 0.9, side: THREE.DoubleSide })),
  );
  paper.rotation.set(-Math.PI / 2, 0, Math.PI);
  paper.receiveShadow = true;
  paper.visible = false;
  group.add(paper);
  /** Waar het vel ligt: 0 = nog helemaal in de printer, 1 = helemaal uit, in de opvangbak. */
  const SLOT_Z = -0.16;
  function placePaper(out: number) {
    const z = SLOT_Z + PAPER.h / 2 - out * PAPER.h;
    paper.position.set(0, 0.106, z);
  }

  // --- Picklijst in beeld (het vel dat je hebt gepakt) ---
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const card = document.createElement('div');
  card.className = 'picklist';
  document.body.appendChild(card);

  let distance = Infinity;
  /** Wat er nu wordt afgedrukt, met de tijd (s) sinds de start. */
  let job: { sheet: Sheet; t: number } | null = null;
  /** Het vel in de opvangbak. */
  let inTray: Sheet | null = null;
  /** Het vel dat de speler bij zich heeft. */
  let held: Sheet | null = null;
  let cardHtml = '';

  /** De order om af te drukken: die je onderhanden hebt, anders de eerste open order. */
  function target(): SimOrder | undefined {
    const orders = src.orders();
    const carried = src.carriedOrder();
    return (carried ? orders.find((o) => o.id === carried) : undefined) ?? orders.find((o) => o.status === 'open');
  }

  function makeSheet(o: SimOrder): Sheet {
    const stock = src.stockList();
    const lines = o.lines.map((l) => {
      const places = stock
        .filter((s) => s.sku === l.sku && s.qty > 0 && !s.locationId.startsWith('DOCK'))
        .sort((a, b) => (location(a.locationId)?.level ?? 9) - (location(b.locationId)?.level ?? 9) || b.qty - a.qty)
        .slice(0, 3)
        .map((s) => `${s.locationId} (${s.qty})`);
      return { sku: l.sku, name: articleName(l.sku), qty: l.qty, places };
    });
    const printedAt = new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    return { orderId: o.id, lines, printedAt };
  }

  function print() {
    const o = target();
    if (!o || job) return;
    const sheet = makeSheet(o);
    drawSheet(g, sheet);
    texture.needsUpdate = true;
    inTray = null;
    job = { sheet, t: 0 };
    placePaper(0);
    paper.visible = true;
    playPrintSound(THREE.MathUtils.clamp(3 / Math.max(distance, 1), 0.3, 1));
  }

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.code !== 'KeyB' || e.repeat || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    if (distance <= NEAR) {
      if (job) return;
      if (inTray) {
        held = inTray;
        inTray = null;
        paper.visible = false;
      } else print();
    } else if (held) {
      held = null; // wegleggen
    }
  });

  function renderCard() {
    let html = '';
    if (held) {
      const o = src.orders().find((x) => x.id === held!.orderId);
      const rows = held.lines
        .map((l) => {
          const line = o?.lines.find((x) => x.sku === l.sku);
          const done = !!o && o.status !== 'open' && !!line && line.picked >= line.qty;
          return `<div class="ln${done ? ' done' : ''}"><span class="box">${done ? '☑' : '☐'}</span><span><b>${l.qty}× ${esc(l.sku)}</b> ${esc(l.name)}<br><span class="loc">${
            l.places.length ? esc(l.places.join(' · ')) : 'geen voorraad in de stellingen'
          }</span></span></div>`;
        })
        .join('');
      const state = !o ? 'order niet meer open' : o.status === 'picked' ? 'compleet gepickt' : o.status === 'picking' ? 'bezig met picken' : 'nog niet gestart';
      html = `<h3>PICKLIJST</h3><div class="meta"><span>${esc(held.orderId)}</span><span>${esc(held.printedAt)}</span></div>${barsSvg(held.orderId)}${rows}<div class="foot">${esc(state)} · <b>B</b> (weg van de printer): wegleggen</div>`;
    }
    if (html === cardHtml) return;
    cardHtml = html;
    card.innerHTML = html;
    card.classList.toggle('on', !!html);
  }

  const world = new THREE.Vector3();
  return {
    group,
    /** Tekst voor de speler die bij de printer staat, anders leeg. */
    get hint() {
      if (distance > NEAR) return '';
      if (job) return 'Printer drukt af…';
      if (inTray) return `<b>B</b>: picklijst ${esc(inTray.orderId)} pakken`;
      const o = target();
      return o ? `<b>B</b>: picklijst ${esc(o.id)} afdrukken` : 'Printer: geen open orders om af te drukken';
    },
    /** listener: waar de speler staat. */
    update(dt: number, listener: THREE.Vector3) {
      group.getWorldPosition(world);
      distance = Math.hypot(listener.x - world.x, listener.z - world.z);
      if (job) {
        job.t += dt;
        led.material = job.t < WARM + FEED && Math.floor(job.t * 4) % 2 === 1 ? ledOff : ledOn;
        placePaper(THREE.MathUtils.smoothstep(job.t, WARM, WARM + FEED));
        if (job.t >= WARM + FEED) {
          inTray = job.sheet;
          job = null;
          led.material = ledOn;
        }
      }
      // Een vel van een order die de deur uit is of niet meer bestaat, gooi je weg.
      if (held) {
        const o = src.orders().find((x) => x.id === held!.orderId);
        if (!o || o.status === 'staged' || o.status === 'loaded' || o.status === 'shipped') held = null;
      }
      renderCard();
    },
  };
}
