import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BASE_MODEL, MODEL, MODEL_DRAFT_KEY, MODEL_IS_DRAFT, modelError, type WarehouseModel } from '../sim/layout';
import { menu } from './menu';

// Bewerkmodus voor de indeling van de hal. Je kijkt van boven en sleept grepen over de vloer; elke greep
// wijzigt een waarde in het model (src/sim/warehouse.json). De nieuwe indeling staat als lijntekening over
// de bestaande hal. De hal zelf wordt bij het laden uit het model opgebouwd, dus 'Toepassen' bewaart het
// concept in localStorage en laadt de pagina opnieuw. 'Opslaan als warehouse.json' schrijft het bestand:
// dat (ingecheckt) maakt de indeling definitief voor iedereen.

const EDIT_FLAG = 'wm-sim.edit'; // sessionStorage: bewerkmodus weer openen na het herladen

const css = `
.editor { position: fixed; left: 16px; top: 16px; z-index: 70; display: none; flex-direction: column; gap: 8px;
  width: min(360px, calc(100vw - 32px)); max-height: calc(100vh - 32px); box-sizing: border-box; padding: 12px 14px;
  border-radius: 10px; background: rgba(12,14,17,.9); color: #fff; font: 13px system-ui, sans-serif; line-height: 1.5;
  box-shadow: 0 10px 34px rgba(0,0,0,.45); }
.editor.open { display: flex; }
.editor h3 { margin: 0; font-size: 15px; }
.editor textarea { flex: 1; min-height: 220px; height: 46vh; resize: vertical; box-sizing: border-box; width: 100%;
  border: 1px solid #3a4047; border-radius: 6px; background: #0b0d10; color: #d7e3ee; font: 12px ui-monospace, Consolas, monospace; }
.editor .row { display: flex; flex-wrap: wrap; gap: 6px; }
.editor button, .editor-open { padding: 6px 10px; border: 0; border-radius: 5px; background: #3a4047; color: #fff; font: inherit; cursor: pointer; }
.editor button.main { background: #3b6ea5; }
.editor button:disabled { opacity: .45; cursor: default; }
.editor .status { min-height: 1.5em; color: #9fd3a8; }
.editor .status.err { color: #ff8a80; }
.editor .o { color: #ffa040; } .editor .w { color: #7fdfff; }
.editor-tip { position: fixed; z-index: 71; display: none; padding: 3px 8px; border-radius: 5px; pointer-events: none;
  background: rgba(0,0,0,.8); color: #fff; font: 12px system-ui, sans-serif; white-space: nowrap; }
.editor-badge { position: fixed; left: 16px; bottom: 16px; z-index: 59; padding: 5px 10px; border: 0; border-radius: 6px;
  background: rgba(226,96,26,.9); color: #fff; font: 600 12px system-ui, sans-serif; cursor: pointer; }
`;

type Handle = { label: string; x: number; z: number; structure: boolean; set(x: number, z: number): void };

const snap = (v: number, step: number) => +(Math.round(v / step) * step).toFixed(2);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** De grepen van een model: waar ze liggen en welke waarde ze bij het slepen wijzigen. */
function handlesOf(m: WarehouseModel): Handle[] {
  const { hall, racks, docks, furniture } = m;
  const wallX = -hall.width / 2;
  const list: Handle[] = [];
  /** Gebouw, stellingen en docks: op halve meters. */
  const structure = (label: string, x: number, z: number, set: (x: number, z: number) => void) =>
    list.push({ label, x, z, structure: true, set: (px, pz) => set(snap(px, 0.5), snap(pz, 0.5)) });
  /** Losse onderdelen: op 10 cm. */
  const object = (label: string, p: { x: number; z: number }) =>
    list.push({ label, x: p.x, z: p.z, structure: false, set: (px, pz) => ((p.x = snap(px, 0.1)), (p.z = snap(pz, 0.1))) });

  structure('Oostwand: breedte van de hal', hall.width / 2, 0, (x) => (hall.width = Math.max(10, 2 * x)));
  structure('Westwand (docks): breedte van de hal', wallX, 0, (x) => (hall.width = Math.max(10, -2 * x)));
  structure('Zuidwand: diepte van de hal', 0, hall.depth / 2, (_, z) => (hall.depth = Math.max(10, 2 * z)));
  structure('Noordwand: diepte van de hal', 0, -hall.depth / 2, (_, z) => (hall.depth = Math.max(10, -2 * z)));

  structure('Stellingen verplaatsen', racks.firstSectionX, racks.firstRowZ, (x, z) => {
    racks.firstSectionX = x;
    racks.firstRowZ = z;
  });
  structure(
    'Stellingen: aantal secties en rijen',
    racks.firstSectionX + (racks.sections - 0.5) * racks.sectionPitch,
    racks.firstRowZ + (racks.rows - 0.5) * racks.rowPitch,
    (x, z) => {
      racks.sections = clamp(Math.round((x - racks.firstSectionX) / racks.sectionPitch + 0.5), 1, 40);
      racks.rows = clamp(Math.round((z - racks.firstRowZ) / racks.rowPitch + 0.5), 1, 40);
    },
  );

  structure('Docks verplaatsen', wallX, docks.firstZ, (_, z) => (docks.firstZ = z));
  structure('Docks: aantal', wallX, docks.firstZ + (docks.count - 0.5) * docks.pitch, (_, z) => {
    docks.count = clamp(Math.round((z - docks.firstZ) / docks.pitch + 0.5), 1, 40);
  });
  list.push({
    label: 'Banen: afstand tot de dockwand',
    x: wallX + docks.lanes.distanceFromWall,
    z: docks.firstZ - docks.lanes.offsetFromDoor,
    structure: true,
    set: (x) => (docks.lanes.distanceFromWall = Math.max(1, snap(x - wallX, 0.1))),
  });

  object('Bureau met pc, radio en printer', m.desk);
  object('Rolcontainers', m.rollContainers);
  object('Heftruck (startplek)', m.equipment.forklift);
  object('Pompwagen (startplek)', m.equipment.palletJack);
  object('Speler (startplek)', m.playerStart);
  object('Paktafel', furniture.packingTable);
  furniture.palletStacks.forEach((s, i) => object(`Palletstapel ${i + 1}`, s));
  furniture.fireExtinguishers.forEach((e, i) => object(`Brandblusser ${i + 1}`, e));
  list.push({
    label: 'Nooduitgang (zuidwand)',
    x: furniture.exitDoor.x,
    z: hall.depth / 2,
    structure: false,
    set: (x) => (furniture.exitDoor.x = snap(x, 0.1)),
  });
  return list;
}

/** Lijntekening van een model: per lijnstuk twee punten (x, z). */
function outlineOf(m: WarehouseModel): number[] {
  const { hall, racks, docks, furniture } = m;
  const pts: number[] = [];
  /** Rechthoek met midden (cx, cz), eventueel gedraaid (graden, om de verticale as). */
  const rect = (cx: number, cz: number, w: number, d: number, rotation = 0) => {
    const r = (rotation * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const corner = (lx: number, lz: number) => [cx + lx * c + lz * s, cz - lx * s + lz * c];
    const corners = [corner(-w / 2, -d / 2), corner(w / 2, -d / 2), corner(w / 2, d / 2), corner(-w / 2, d / 2)];
    corners.forEach((p, i) => pts.push(...p, ...corners[(i + 1) % 4]));
  };
  /** Voorwerp met een kijkrichting: rechthoek met een streepje naar voren. */
  const posed = (p: { x: number; z: number; rotation: number }, w: number, d: number) => {
    rect(p.x, p.z, w, d, p.rotation);
    const r = (p.rotation * Math.PI) / 180;
    pts.push(p.x, p.z, p.x + Math.sin(r) * (d / 2 + 0.8), p.z + Math.cos(r) * (d / 2 + 0.8));
  };

  rect(0, 0, hall.width, hall.depth);
  const rackLen = racks.sections * racks.sectionPitch;
  const rackMid = racks.firstSectionX + ((racks.sections - 1) * racks.sectionPitch) / 2;
  for (let r = 0; r < racks.rows; r++) {
    const z = racks.firstRowZ + r * racks.rowPitch;
    rect(rackMid, z, rackLen, 1.1);
    for (let s = 1; s < racks.sections; s++) {
      const x = racks.firstSectionX + (s - 0.5) * racks.sectionPitch;
      pts.push(x, z - 0.55, x, z + 0.55);
    }
  }
  const wallX = -hall.width / 2;
  const laneLen = docks.lanes.slots * docks.lanes.slotPitch + 0.3;
  for (let i = 0; i < docks.count; i++) {
    const z = docks.firstZ + i * docks.pitch;
    rect(wallX, z, 0.5, 3);
    for (const side of [-1, 1]) rect(wallX + docks.lanes.distanceFromWall, z + side * docks.lanes.offsetFromDoor, laneLen, 1.5);
  }
  // Kantoor en kantine (noordhoek bij de docks) en de parkeerplaats (zuidhoek)
  const rooms = m.rooms;
  rect(wallX + rooms.officeWidth / 2, -hall.depth / 2 + rooms.depth / 2, rooms.officeWidth, rooms.depth);
  rect(wallX + rooms.officeWidth + rooms.canteenWidth / 2, -hall.depth / 2 + rooms.depth / 2, rooms.canteenWidth, rooms.depth);
  rect(wallX + m.parking.width / 2, hall.depth / 2 - m.parking.depth / 2, m.parking.width, m.parking.depth);
  rect(m.desk.x, m.desk.z, 1.5, 0.75);
  rect(m.rollContainers.x, m.rollContainers.z, 2.8, 0.8);
  posed(m.equipment.forklift, 1.2, 2.6);
  posed(m.equipment.palletJack, 0.7, 1.6);
  posed(m.playerStart, 0.6, 0.6);
  rect(furniture.packingTable.x, furniture.packingTable.z, 2.2, 0.9);
  for (const s of furniture.palletStacks) rect(s.x, s.z, 1.2, 1.0);
  for (const e of furniture.fireExtinguishers) rect(e.x, e.z, 0.4, 0.4);
  rect(furniture.exitDoor.x, hall.depth / 2, 1.0, 0.4);
  return pts;
}

interface Options {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  controls: OrbitControls;
  /** Zet de game in overzicht-modus (camera van boven, dak weg). */
  toOverview: () => void;
}

export function createEditor({ scene, camera, canvas, controls, toOverview }: Options) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  let draft: WarehouseModel = structuredClone(MODEL);
  let handles: Handle[] = [];
  let active = false;
  let dragging = -1;
  let hovered = -1;

  // ---------- Paneel ----------
  const panel = document.createElement('div');
  panel.className = 'editor';
  panel.innerHTML = `
    <h3>Indeling bewerken</h3>
    <div>Sleep de grepen over de vloer: <b class="o">oranje</b> = wanden, stellingen en docks, <b class="w">blauw</b> = losse onderdelen.
    De lijnen tonen de nieuwe indeling. Aantallen, tussenafstanden, hoogtes en draaiing (graden) pas je hieronder aan.</div>
    <textarea spellcheck="false"></textarea>
    <div class="status"></div>
    <div class="row">
      <button class="main" data-do="apply" title="Bewaart het concept in deze browser en bouwt de hal opnieuw op">Toepassen (herladen)</button>
      <button data-do="save" title="Kies src/sim/warehouse.json om het model te overschrijven">Opslaan als warehouse.json</button>
      <button data-do="reset" title="Terug naar de indeling uit warehouse.json">Origineel herstellen</button>
      <button data-do="close">Sluiten</button>
    </div>`;
  const text = panel.querySelector('textarea')!;
  const status = panel.querySelector<HTMLDivElement>('.status')!;
  const applyButton = panel.querySelector<HTMLButtonElement>('[data-do=apply]')!;
  const tip = document.createElement('div');
  tip.className = 'editor-tip';
  document.body.append(panel, tip);

  function say(message: string, error = false) {
    status.textContent = message;
    status.classList.toggle('err', error);
  }
  const serialize = (m: WarehouseModel) => JSON.stringify(m, null, 2);
  const changed = () => serialize(draft) !== serialize(MODEL);

  // ---------- Tekening en grepen in de scène ----------
  const overlay = new THREE.Group();
  overlay.visible = false;
  scene.add(overlay);
  const lines = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: '#00e5ff', depthTest: false, transparent: true }),
  );
  lines.renderOrder = 20;
  lines.frustumCulled = false;
  overlay.add(lines);
  const knobGeo = new THREE.CylinderGeometry(0.7, 0.7, 0.12, 24);
  const knobMat = (color: string) => new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
  const mats = { structure: knobMat('#ff8c1a'), object: knobMat('#4fc3f7'), hot: knobMat('#ffffff') };
  const knobs: THREE.Mesh[] = [];

  function redraw() {
    handles = handlesOf(draft);
    const flat = outlineOf(draft);
    const positions = new Float32Array((flat.length / 2) * 3);
    for (let i = 0; i < flat.length / 2; i++) positions.set([flat[i * 2], 0.15, flat[i * 2 + 1]], i * 3);
    lines.geometry.dispose();
    lines.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3));
    while (knobs.length < handles.length) {
      const k = new THREE.Mesh(knobGeo, mats.object);
      k.renderOrder = 21;
      knobs.push(k);
      overlay.add(k);
    }
    while (knobs.length > handles.length) overlay.remove(knobs.pop()!);
    handles.forEach((h, i) => {
      knobs[i].position.set(h.x, 0.3, h.z);
      knobs[i].material = i === dragging || i === hovered ? mats.hot : h.structure ? mats.structure : mats.object;
    });
    applyButton.disabled = !changed();
  }

  /** Neemt een (gesleept of getypt) model over als het klopt. */
  function setDraft(next: WarehouseModel, fromText = false) {
    const error = modelError(next);
    if (error) return say(error, true);
    draft = next;
    if (!fromText) text.value = serialize(draft);
    say(changed() ? 'Gewijzigd: nog niet toegepast.' : MODEL_IS_DRAFT ? 'Concept: staat alleen in deze browser.' : '');
    redraw();
  }

  text.addEventListener('input', () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.value);
    } catch (err) {
      return say(`Geen geldige JSON: ${err instanceof Error ? err.message : err}`, true);
    }
    const error = modelError(parsed);
    if (error) return say(error, true);
    setDraft(parsed as WarehouseModel, true);
  });

  // ---------- Slepen ----------
  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  function aim(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(pointer, camera);
  }
  const knobAt = (e: PointerEvent) => {
    aim(e);
    const first = ray.intersectObjects(knobs, false)[0];
    return first ? knobs.indexOf(first.object as THREE.Mesh) : -1;
  };

  // In de capture-fase op window: zo ziet OrbitControls de klik op een greep niet en draait de camera niet mee.
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!active || e.button !== 0 || e.target !== canvas) return;
      const i = knobAt(e);
      if (i < 0) return;
      e.stopPropagation();
      e.preventDefault();
      dragging = i;
      redraw();
    },
    { capture: true },
  );
  window.addEventListener('pointermove', (e) => {
    if (!active) return;
    if (dragging >= 0) {
      aim(e);
      if (!ray.ray.intersectPlane(floor, hit)) return;
      const next = structuredClone(draft);
      handlesOf(next)[dragging]?.set(hit.x, hit.z);
      setDraft(next);
    } else {
      const i = e.target === canvas ? knobAt(e) : -1;
      if (i !== hovered) {
        hovered = i;
        redraw();
      }
    }
    const shown = dragging >= 0 ? dragging : hovered;
    canvas.style.cursor = shown >= 0 ? 'grab' : '';
    tip.style.display = shown >= 0 ? 'block' : 'none';
    if (shown >= 0) {
      const h = handles[shown];
      tip.textContent = `${h.label} · x ${h.x.toFixed(1)}, z ${h.z.toFixed(1)}`;
      tip.style.left = `${e.clientX + 14}px`;
      tip.style.top = `${e.clientY + 14}px`;
    }
  });
  window.addEventListener('pointerup', () => {
    if (dragging < 0) return;
    dragging = -1;
    redraw();
  });

  // ---------- Bewaren ----------
  function reload() {
    sessionStorage.setItem(EDIT_FLAG, '1');
    location.reload();
  }
  function apply() {
    if (modelError(draft)) return;
    try {
      if (serialize(draft) === serialize(BASE_MODEL)) localStorage.removeItem(MODEL_DRAFT_KEY);
      else localStorage.setItem(MODEL_DRAFT_KEY, JSON.stringify(draft));
    } catch {
      return say('Het concept kan niet worden bewaard (localStorage is niet beschikbaar).', true);
    }
    reload();
  }
  function reset() {
    if (MODEL_IS_DRAFT) {
      localStorage.removeItem(MODEL_DRAFT_KEY);
      return reload();
    }
    setDraft(structuredClone(BASE_MODEL));
  }
  async function save() {
    const content = serialize(draft) + '\n';
    type Picker = (o: object) => Promise<{ createWritable(): Promise<{ write(s: string): Promise<void>; close(): Promise<void> }> }>;
    const picker = (window as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;
    if (picker) {
      try {
        const file = await picker({ suggestedName: 'warehouse.json', types: [{ description: 'Magazijnmodel', accept: { 'application/json': ['.json'] } }] });
        const out = await file.createWritable();
        await out.write(content);
        await out.close();
        return say('Opgeslagen. Staat het in src/sim/warehouse.json, dan is dit na inchecken de indeling voor iedereen.');
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // anders: gewoon downloaden
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    a.download = 'warehouse.json';
    a.click();
    URL.revokeObjectURL(a.href);
    say('Gedownload: zet het bestand in src/sim/ over warehouse.json heen.');
  }

  // ---------- Openen en sluiten ----------
  function open() {
    if (active) return;
    toOverview(); // kan de bewerkmodus sluiten (wissel van modus), daarom vóór active = true
    active = true;
    sessionStorage.setItem(EDIT_FLAG, '1');
    menu.close();
    const size = Math.max(draft.hall.width, draft.hall.depth);
    // Recht van boven, noorden boven en de docks links; iets naar rechts geschoven zodat het paneel de dockwand niet afdekt
    camera.position.set(-size * 0.2, size * 1.25, 0.5);
    controls.target.set(-size * 0.2, 0, 0);
    panel.classList.add('open');
    overlay.visible = true;
    badge.style.display = 'none';
    setDraft(draft);
  }
  function close() {
    if (!active) return;
    active = false;
    dragging = hovered = -1;
    sessionStorage.removeItem(EDIT_FLAG);
    panel.classList.remove('open');
    overlay.visible = false;
    tip.style.display = 'none';
    canvas.style.cursor = '';
    badge.style.display = MODEL_IS_DRAFT ? '' : 'none';
  }
  panel.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-do]')?.dataset.do;
    if (action === 'apply') apply();
    else if (action === 'save') void save();
    else if (action === 'reset') reset();
    else if (action === 'close') close();
  });

  // Zolang de hal uit een concept is opgebouwd: zichtbaar maken dat hij afwijkt van die van anderen.
  const badge = document.createElement('button');
  badge.className = 'editor-badge';
  badge.textContent = 'Concept-indeling (alleen in deze browser) · bewerken';
  badge.style.display = MODEL_IS_DRAFT ? '' : 'none';
  badge.addEventListener('click', open);
  document.body.appendChild(badge);

  // Ingang in het menu
  const section = document.createElement('div');
  section.innerHTML = `
    <p style="margin:0 0 8px">De indeling van de hal (gebouw, stellingen, docks, bureau, middelen) komt uit het model
    <code>src/sim/warehouse.json</code>. In de bewerkmodus kijk je van boven en versleep je de onderdelen.</p>
    <button class="editor-open">Indeling bewerken</button>`;
  section.querySelector('button')!.addEventListener('click', open);
  menu.addSection('layout', 'Indeling', section, 90);

  return {
    open,
    close,
    get active() { return active; },
    /** Stond de bewerkmodus open voordat de pagina werd herladen? */
    get resume() { return sessionStorage.getItem(EDIT_FLAG) === '1'; },
  };
}
