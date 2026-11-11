import { EYES, HEAD, headOutline, photoUV } from './scene/headShape';

// Foto van je eigen hoofd voor op je figuur. De foto wordt met de webcam gemaakt in een hoofdvorm (het silhouet van het hoofd van de figuur),
// sterk verkleind en alleen in deze browser bewaard (localStorage). Net als je naam gaat hij via de
// publieke broker naar de andere spelers in de kamer: iedereen in de kamer kan hem dus zien.

const FACE_KEY = 'wm-sim.face';
const W = 120;
const H = 160;
const PREFIX = 'data:image/jpeg;base64,';
/** Ruim boven wat een foto van 120×160 oplevert; alles wat groter is weigeren we (ook van andere spelers). */
const MAX_LENGTH = 24_000;

/** Is dit een foto zoals wij die maken? De broker is publiek: controleer wat binnenkomt. */
export function validFace(v: unknown): v is string {
  return typeof v === 'string' && v.length <= MAX_LENGTH && v.startsWith(PREFIX) && /^[A-Za-z0-9+/=]+$/.test(v.slice(PREFIX.length));
}

export function loadFace(): string | null {
  try {
    const v = localStorage.getItem(FACE_KEY);
    return validFace(v) ? v : null;
  } catch {
    return null; // geen opslag beschikbaar
  }
}

export function saveFace(face: string | null) {
  try {
    if (face) localStorage.setItem(FACE_KEY, face);
    else localStorage.removeItem(FACE_KEY);
  } catch {
    // geen opslag beschikbaar: de foto geldt dan alleen voor deze sessie
  }
}

/** Korte vingerafdruk van een foto, zodat spelers kunnen zien of ze de juiste versie al hebben. */
export function faceVersion(face: string | null) {
  if (!face) return '';
  let h = 5381;
  for (let i = 0; i < face.length; i++) h = ((h * 33) ^ face.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function decodeFace(face: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('foto kan niet worden gelezen'));
    img.src = face;
  });
}

/** Onderdeel voor in een venster: de camera met een hoofdvorm eroverheen, en knoppen om een foto te maken of te wissen. */
export function createFacePicker(initial: string | null) {
  let face = initial;
  let stream: MediaStream | null = null;

  const el = document.createElement('div');
  el.style.cssText = 'display:flex;gap:14px;align-items:center';

  // De hoofdvorm: het beeld van de camera met daaroverheen het silhouet van het hoofd van de figuur.
  // Wat binnen de vorm valt komt op het hoofd; de rondjes en de kin bepalen dat het gezicht goed past.
  const VW = 300;
  const VH = 400;
  const frame = document.createElement('div');
  frame.style.cssText = 'position:relative;flex:none;width:150px;height:200px;border-radius:12px;overflow:hidden;background:#12161a';
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1)'; // gespiegeld, zoals in een spiegel
  const photo = document.createElement('img');
  photo.alt = 'Jouw foto';
  photo.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover';
  const empty = document.createElement('div');
  empty.textContent = '🙂';
  empty.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:64px;opacity:.35';
  const outline = `${headOutline().map(([u, v], i) => `${i ? 'L' : 'M'}${(u * VW).toFixed(1)} ${(v * VH).toFixed(1)}`).join('')}Z`;
  const eyes = [-1, 1]
    .map((d) => `<ellipse cx="${(0.5 + d * EYES.du) * VW}" cy="${EYES.v * VH}" rx="13" ry="8"/>`)
    .join('');
  const brimV = photoUV(0, 0.13).v; // onderrand van de helm
  const chinY = photoUV(0, HEAD.y - HEAD.r * HEAD.sy + 0.012).v * VH; // net boven de onderkant van het hoofd
  const guide = document.createElement('div');
  guide.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  guide.innerHTML = `<svg viewBox="0 0 ${VW} ${VH}" width="100%" height="100%" style="display:block">
    <path d="M0 0H${VW}V${VH}H0Z${outline}" fill="rgba(18,22,26,.78)" fill-rule="evenodd"/>
    <path class="line" d="${outline}" fill="none" stroke="#fff" stroke-width="3"/>
    <g class="marks" fill="none" stroke="#ffd54f" stroke-width="2.5">
      ${eyes}
      <path d="M${VW * 0.2} ${brimV * VH}H${VW * 0.8}" stroke-dasharray="7 6" opacity=".8"/>
      <path d="M${VW * 0.5 - 22} ${chinY}Q${VW * 0.5} ${chinY + 9} ${VW * 0.5 + 22} ${chinY}"/>
    </g>
  </svg>`;
  const line = guide.querySelector<SVGPathElement>('.line')!;
  const marks = guide.querySelector<SVGGElement>('.marks')!;
  frame.append(empty, photo, video, guide);

  const side = document.createElement('div');
  side.style.cssText = 'display:flex;flex-direction:column;gap:8px;align-items:flex-start;min-width:0';
  const status = document.createElement('div');
  status.style.cssText = 'color:#b9c0c7;line-height:1.4;font-size:13px';
  const button = (text: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.style.cssText = 'padding:7px 12px;border-radius:8px;border:0;font:inherit;cursor:pointer;color:#fff;background:#3a424a';
    return b;
  };
  const shoot = button('');
  const remove = button('Foto verwijderen');
  side.append(status, shoot, remove);
  el.append(frame, side);

  function stop() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  }

  function sync(message?: string) {
    const live = !!stream;
    video.style.display = live ? '' : 'none';
    photo.style.display = !live && face ? '' : 'none';
    if (face) photo.src = face;
    empty.style.display = live || face ? 'none' : '';
    marks.style.display = live ? '' : 'none';
    line.setAttribute('stroke', live ? '#fff' : '#47505a');
    shoot.textContent = live ? '📸 Foto maken' : face ? 'Nieuwe foto maken' : 'Foto maken met camera';
    shoot.style.background = live ? '#1e88e5' : '#3a424a';
    remove.style.display = face && !live ? '' : 'none';
    status.textContent =
      message ?? (live ? 'Vul de vorm met je gezicht: ogen op de gele rondjes, kin op het boogje. Boven de stippellijn komt je helm.' : face ? 'Deze foto staat op het hoofd van je figuur.' : 'Optioneel: zet je eigen gezicht op je figuur.');
  }

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) return sync('Deze browser geeft geen toegang tot de camera.');
    sync('Camera starten…');
    shoot.disabled = true;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      if (!el.isConnected) return s.getTracks().forEach((t) => t.stop()); // venster is intussen gesloten
      stream = s;
      video.srcObject = s;
      await video.play();
      sync();
    } catch {
      stop();
      sync('Geen toegang tot de camera. Sta de camera toe in je browser en probeer het opnieuw.');
    } finally {
      shoot.disabled = false;
    }
  }

  function capture() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    // Hetzelfde stuk van het beeld als in het venster te zien is (object-fit: cover), niet gespiegeld:
    // zo zien anderen je zoals je bent.
    const crop = Math.min(vw / W, vh / H);
    const cw = W * crop;
    const ch = H * crop;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.getContext('2d')!.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, W, H);
    const data = canvas.toDataURL('image/jpeg', 0.72);
    stop();
    if (validFace(data)) face = data;
    sync(validFace(data) ? undefined : 'De foto is niet gelukt; probeer het opnieuw.');
  }

  shoot.addEventListener('click', () => (stream ? capture() : void start()));
  remove.addEventListener('click', () => {
    face = null;
    sync();
  });
  sync();

  return {
    el,
    /** De gekozen foto, of null voor geen foto. */
    get value() {
      return face;
    },
    /** Camera uitzetten; altijd aanroepen als het venster sluit. */
    stop,
  };
}
