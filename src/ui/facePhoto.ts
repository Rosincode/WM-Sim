import * as THREE from 'three';
import { checkFace, loadFaceModels, makeFace } from './faceCapture';
import { createCharacter } from './scene/character';
import { FORMAT } from './scene/headPhoto';
import { EYES, HEAD, headOutline, photoUV } from './scene/headShape';

// Foto van je eigen hoofd voor op je figuur. De foto wordt met de webcam gemaakt: gezichtsherkenning (in de
// browser, zie faceCapture.ts) trekt hem recht en op maat, zodat je gezicht precies op het hoofd van de figuur
// past en je haar wordt overgenomen. Hij wordt alleen in deze browser bewaard (localStorage). Net als je naam
// gaat hij via de publieke broker naar de andere spelers in de kamer: iedereen in de kamer kan hem dus zien.

const FACE_KEY = 'wm-sim.face';
const PREFIX = 'data:image/jpeg;base64,';
/** Ruim boven wat een foto oplevert; alles wat groter is weigeren we (ook van andere spelers). */
const MAX_LENGTH = 90_000;

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

/** Draaiend voorbeeld van het hoofd van de figuur met een foto erop. */
function createPreview() {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:150px;height:180px;border-radius:10px;background:#2b3238;display:none';
  let renderer: THREE.WebGLRenderer | null = null;
  let character: ReturnType<typeof createCharacter> | null = null;
  let frame = 0;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(22, 150 / 180, 0.1, 10);

  function show(image: HTMLImageElement | null) {
    canvas.style.display = image ? '' : 'none';
    if (!image) return;
    try {
      if (!renderer) {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
        renderer.setSize(150, 180, false);
        scene.add(new THREE.HemisphereLight('#ffffff', '#8a8f96', 1.7));
        const sun = new THREE.DirectionalLight('#ffffff', 2);
        sun.position.set(2, 4, 5);
        scene.add(sun);
        character = createCharacter();
        scene.add(character.group);
        const y = 0.916 + 0.62 + HEAD.y; // midden van het hoofd
        camera.position.set(0, y + 0.03, 1.15);
        camera.lookAt(0, y - 0.01, 0);
        const start = performance.now();
        const tick = () => {
          frame = requestAnimationFrame(tick);
          if (!canvas.isConnected || canvas.style.display === 'none') return;
          character!.group.rotation.y = 1.25 * Math.sin((performance.now() - start) / 1700);
          renderer!.render(scene, camera);
        };
        tick();
      }
      character!.setFace(image);
    } catch {
      canvas.style.display = 'none'; // geen 3D beschikbaar: dan geen voorbeeld
    }
  }

  function dispose() {
    cancelAnimationFrame(frame);
    character?.setFace(null);
    renderer?.dispose();
    renderer = null;
  }

  return { canvas, show, dispose };
}

/** Onderdeel voor in een venster: de camera met een hoofdvorm eroverheen, en knoppen om een foto te maken of te wissen. */
export function createFacePicker(initial: string | null) {
  let face = initial;
  let stream: MediaStream | null = null;
  let models: Awaited<ReturnType<typeof loadFaceModels>> = null;
  let loadingModels = false;
  let busy = false;
  let hint = '';
  let good = false;
  let watch: ReturnType<typeof setInterval> | undefined;

  const el = document.createElement('div');
  el.style.cssText = 'display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start';

  // Het beeld van de camera (staand, 3:4) met daaroverheen de omtrek van het hoofd van de figuur, met ruimte
  // eromheen voor je haar. Met gezichtsherkenning is de omtrek alleen een richtlijn; zonder bepalen de rondjes
  // en het boogje hoe de foto op het hoofd past.
  const VW = 300;
  const VH = 400;
  const frame = document.createElement('div');
  frame.style.cssText = 'position:relative;flex:none;width:270px;height:360px;border-radius:12px;overflow:hidden;background:#12161a';
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1)'; // gespiegeld, zoals in een spiegel
  const photo = document.createElement('canvas');
  photo.width = FORMAT.w;
  photo.height = FORMAT.h;
  photo.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  const empty = document.createElement('div');
  empty.textContent = '🙂';
  empty.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:96px;opacity:.35';
  const outline = `${headOutline().map(([u, v], i) => `${i ? 'L' : 'M'}${(u * VW).toFixed(1)} ${(v * VH).toFixed(1)}`).join('')}Z`;
  const eyes = [-1, 1].map((d) => `<ellipse cx="${(0.5 + d * EYES.du) * VW}" cy="${EYES.v * VH}" rx="11" ry="7"/>`).join('');
  const chinY = photoUV(0, 0.01 - HEAD.hy).v * VH; // net boven de onderkant van het hoofd
  const guide = document.createElement('div');
  guide.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  guide.innerHTML = `<svg viewBox="0 0 ${VW} ${VH}" width="100%" height="100%" style="display:block">
    <path d="M0 0H${VW}V${VH}H0Z${outline}" fill="rgba(18,22,26,.35)" fill-rule="evenodd"/>
    <path class="line" d="${outline}" fill="none" stroke="#fff" stroke-width="2.5" stroke-dasharray="9 7"/>
    <g class="marks" fill="none" stroke="#ffd54f" stroke-width="2.5">
      ${eyes}
      <path d="M${VW * 0.5 - 22} ${chinY}Q${VW * 0.5} ${chinY + 9} ${VW * 0.5 + 22} ${chinY}"/>
    </g>
  </svg>`;
  const line = guide.querySelector<SVGPathElement>('.line')!;
  const marks = guide.querySelector<SVGGElement>('.marks')!;
  frame.append(empty, photo, video, guide);

  const side = document.createElement('div');
  side.style.cssText = 'display:flex;flex-direction:column;gap:10px;align-items:flex-start;min-width:150px;flex:1';
  const status = document.createElement('div');
  status.style.cssText = 'color:#b9c0c7;line-height:1.45;font-size:13px';
  const button = (text: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.style.cssText = 'padding:8px 13px;border-radius:8px;border:0;font:inherit;cursor:pointer;color:#fff;background:#3a424a';
    return b;
  };
  const shoot = button('');
  const remove = button('Foto verwijderen');
  const preview = createPreview();
  side.append(status, shoot, remove, preview.canvas);
  el.append(frame, side);

  function stopCamera() {
    clearInterval(watch);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  }

  /** De gekozen foto in het venster en op het voorbeeldhoofd zetten. */
  function showPhoto() {
    const shown = face;
    if (!shown) return preview.show(null);
    decodeFace(shown).then(
      (img) => {
        if (shown !== face) return;
        const old = img.naturalWidth / img.naturalHeight < 0.8; // oude foto: alleen het hoofd, zonder strook
        const ctx = photo.getContext('2d')!;
        ctx.fillStyle = '#12161a';
        ctx.fillRect(0, 0, photo.width, photo.height);
        if (old) ctx.drawImage(img, photo.width * 0.14, photo.height * 0.14, photo.width * 0.72, photo.height * 0.72);
        else ctx.drawImage(img, 0, 0, (img.naturalWidth * FORMAT.w) / (FORMAT.w + FORMAT.strip), img.naturalHeight, 0, 0, photo.width, photo.height);
        preview.show(img);
      },
      () => preview.show(null),
    );
  }

  function sync(message?: string) {
    const live = !!stream;
    video.style.display = live ? '' : 'none';
    photo.style.display = !live && face ? '' : 'none';
    empty.style.display = live || face ? 'none' : 'flex';
    guide.style.display = live ? '' : 'none';
    marks.style.display = live && !models && !loadingModels ? '' : 'none';
    line.setAttribute('stroke', good ? '#66d17a' : '#fff');
    shoot.textContent = busy ? 'Bezig…' : live ? '📸 Foto maken' : face ? 'Nieuwe foto maken' : 'Foto maken met camera';
    shoot.style.background = live && !busy ? (good ? '#2e9e4f' : '#1e88e5') : '#3a424a';
    shoot.disabled = busy;
    remove.style.display = face && !live ? '' : 'none';
    if (live) preview.show(null);
    status.textContent =
      message ??
      (live
        ? loadingModels
          ? 'Gezichtsherkenning laden… Je kunt alvast gaan zitten: recht voor de camera, met licht op je gezicht.'
          : models
            ? hint
            : 'Vul de vorm met je hoofd: ogen op de gele rondjes, kin op het boogje. Je haar mag buiten de vorm vallen.'
        : face
          ? 'Deze foto staat op het hoofd van je figuur. Hiernaast zie je hoe dat eruitziet.'
          : 'Optioneel: zet je eigen gezicht en haar op je figuur.');
  }

  /** Aanwijzingen terwijl de camera loopt. */
  function look() {
    if (!stream || busy || !models) return;
    const check = checkFace(models, video);
    good = false;
    if (!check?.found) hint = 'Geen gezicht gevonden. Ga recht voor de camera zitten, met licht op je gezicht.';
    else if (!check.inFrame) hint = 'Je hele hoofd moet in beeld zijn, ook je haar. Ga iets verder van de camera af of meer naar het midden.';
    else if (check.size < 0.13) hint = 'Kom wat dichterbij: dan wordt de foto scherper.';
    else if (!check.straight) hint = 'Kijk recht in de camera en houd je hoofd rechtop.';
    else {
      good = true;
      hint = 'Goed zo. Kijk in de camera en maak de foto: hij wordt vanzelf recht en op maat gezet.';
    }
    sync();
  }

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) return sync('Deze browser geeft geen toegang tot de camera.');
    busy = true;
    sync('Camera starten…');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (!el.isConnected) return s.getTracks().forEach((t) => t.stop()); // venster is intussen gesloten
      stream = s;
      video.srcObject = s;
      await video.play();
      hint = 'Ga recht voor de camera zitten.';
      good = false;
      if (!models) {
        loadingModels = true;
        void loadFaceModels().then((m) => {
          models = m;
          loadingModels = false;
          sync();
        });
      }
      watch = setInterval(look, 300);
    } catch {
      stopCamera();
      busy = false;
      return sync('Geen toegang tot de camera. Sta de camera toe in je browser en probeer het opnieuw.');
    }
    busy = false;
    sync();
  }

  async function capture() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || busy) return;
    busy = true;
    sync('Foto verwerken…');
    // Niet gespiegeld: zo zien anderen je zoals je bent. Zonder gezichtsherkenning het midden van het beeld, zoals in het venster.
    const shot = await makeFace(video, vw, vh, MAX_LENGTH).catch(() => null);
    busy = false;
    if (!el.isConnected) return;
    stopCamera();
    good = false;
    if (shot?.data && validFace(shot.data)) {
      face = shot.data;
      showPhoto();
      sync(shot.aligned ? undefined : 'Je gezicht is niet herkend; de foto is uit het midden van het beeld genomen. Past hij niet goed, maak dan een nieuwe.');
    } else sync('De foto is niet gelukt; probeer het opnieuw.');
  }

  shoot.addEventListener('click', () => void (stream ? capture() : start()));
  remove.addEventListener('click', () => {
    face = null;
    showPhoto();
    sync();
  });
  showPhoto();
  sync();

  return {
    el,
    /** De gekozen foto, of null voor geen foto. */
    get value() {
      return face;
    },
    /** Camera uitzetten en het voorbeeld opruimen; altijd aanroepen als het venster sluit. */
    stop() {
      stopCamera();
      preview.dispose();
    },
  };
}
