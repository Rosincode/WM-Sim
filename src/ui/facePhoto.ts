// Foto van je eigen hoofd voor op je figuur. De foto wordt met de webcam gemaakt in een ovale hoofdvorm,
// sterk verkleind en alleen in deze browser bewaard (localStorage). Net als je naam gaat hij via de
// publieke broker naar de andere spelers in de kamer: iedereen in de kamer kan hem dus zien.

const FACE_KEY = 'wm-sim.face';
const W = 96;
const H = 128;
const PREFIX = 'data:image/jpeg;base64,';
/** Ruim boven wat een foto van 96×128 oplevert; alles wat groter is weigeren we (ook van andere spelers). */
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

/** Onderdeel voor in een venster: ovale hoofdvorm met de camera erin, en knoppen om een foto te maken of te wissen. */
export function createFacePicker(initial: string | null) {
  let face = initial;
  let stream: MediaStream | null = null;

  const el = document.createElement('div');
  el.style.cssText = 'display:flex;gap:14px;align-items:center';

  // De hoofdvorm: een staand ovaal waarin je je gezicht past
  const oval = document.createElement('div');
  oval.style.cssText =
    'position:relative;flex:none;width:120px;height:160px;border-radius:50%;overflow:hidden;background:#12161a;border:2px dashed #47505a;display:flex;align-items:center;justify-content:center';
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1)'; // gespiegeld, zoals in een spiegel
  const photo = document.createElement('img');
  photo.alt = 'Jouw foto';
  photo.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover';
  const empty = document.createElement('div');
  empty.textContent = '🙂';
  empty.style.cssText = 'font-size:56px;opacity:.35';
  oval.append(empty, photo, video);

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
  el.append(oval, side);

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
    oval.style.borderStyle = live || face ? 'solid' : 'dashed';
    oval.style.borderColor = live ? '#1e88e5' : '#47505a';
    shoot.textContent = live ? '📸 Foto maken' : face ? 'Nieuwe foto maken' : 'Foto maken met camera';
    shoot.style.background = live ? '#1e88e5' : '#3a424a';
    remove.style.display = face && !live ? '' : 'none';
    status.textContent =
      message ?? (live ? 'Houd je hoofd in het ovaal en maak de foto.' : face ? 'Deze foto staat op het hoofd van je figuur.' : 'Optioneel: zet je eigen gezicht op je figuur.');
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
    // Hetzelfde stuk van het beeld als in het ovaal te zien is (object-fit: cover), niet gespiegeld:
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
