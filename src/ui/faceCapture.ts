import { FORMAT } from './scene/headPhoto';
import { FACE_POINTS, photoUV } from './scene/headShape';

// Van camerabeeld naar de foto voor op de figuur. Een model voor gezichtsherkenning (MediaPipe, draait in de
// browser: er gaat geen beeld naar buiten) zoekt ogen, neus, mond, kin en de rand van het gezicht. Daarmee wordt
// het beeld zo bijgetrokken dat die punten precies op hun plek op het hoofd van de figuur vallen, hoe je ook voor
// de camera zit. Een tweede model wijst aan waar haar zit; dat masker gaat mee in de foto (strook rechts), zodat
// elke speler hetzelfde haar ziet. De modellen worden pas opgehaald als iemand een foto gaat maken; lukt dat niet
// (geen internet), dan wordt de foto gewoon uit het midden van het beeld gesneden en bepaalt de hoofdvorm in het
// fotovenster hoe hij past.

const VERSION = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODELS = 'https://storage.googleapis.com/mediapipe-models';

/** Breedte van een gemiddeld gezicht (tussen de randen ter hoogte van de oren) gedeeld door de afstand ogen-kin. */
const AVERAGE_WIDTH = (2 * FACE_POINTS.side[0]) / (FACE_POINTS.eye[1] - FACE_POINTS.chin[1]);

interface Point {
  x: number;
  y: number;
}
interface Models {
  landmarker: { detect(image: CanvasImageSource): { faceLandmarks?: Point[][] } };
  segmenter: {
    segment(image: CanvasImageSource): { categoryMask?: { width: number; height: number; getAsUint8Array(): Uint8Array; close(): void } };
  };
}

let loading: Promise<Models | null> | null = null;
/** Modellen ophalen (één keer); null als dat niet lukt. */
export function loadFaceModels() {
  return (loading ??= (async (): Promise<Models | null> => {
    try {
      const vision = await import(/* @vite-ignore */ `${CDN}/vision_bundle.mjs`);
      const files = await vision.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      const [landmarker, segmenter] = await Promise.all([
        vision.FaceLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: `${MODELS}/face_landmarker/face_landmarker/float16/1/face_landmarker.task` },
          runningMode: 'IMAGE',
          numFaces: 1,
        }),
        vision.ImageSegmenter.createFromOptions(files, {
          baseOptions: { modelAssetPath: `${MODELS}/image_segmenter/hair_segmenter/float32/latest/hair_segmenter.tflite` },
          runningMode: 'IMAGE',
          outputCategoryMask: true,
          outputConfidenceMasks: false,
        }),
      ]);
      return { landmarker, segmenter };
    } catch {
      return null;
    }
  })());
}

/** De punten van het gezicht die we gebruiken, in beeldpunten van het bronbeeld; links in beeld eerst. */
interface Face {
  eyes: [Point, Point];
  nose: Point;
  mouth: Point;
  chin: Point;
  forehead: Point;
  sides: [Point, Point];
  jaws: [Point, Point];
}

function findFace(models: Models | null, image: HTMLCanvasElement | HTMLVideoElement, w: number, h: number): Face | null {
  let lm: Point[] | undefined;
  try {
    lm = models?.landmarker.detect(image).faceLandmarks?.[0];
  } catch {
    return null;
  }
  if (!lm || lm.length < 455) return null;
  const at = (...ids: number[]): Point => ({
    x: (ids.reduce((s, i) => s + lm[i].x, 0) / ids.length) * w,
    y: (ids.reduce((s, i) => s + lm[i].y, 0) / ids.length) * h,
  });
  const pair = (a: Point, b: Point): [Point, Point] => (a.x < b.x ? [a, b] : [b, a]);
  return {
    eyes: pair(at(33, 133), at(362, 263)),
    nose: at(1),
    mouth: at(13, 14),
    chin: at(152),
    forehead: at(10),
    sides: pair(at(234), at(454)),
    jaws: pair(at(172), at(397)),
  };
}

export interface FaceCheck {
  /** Is er een gezicht gevonden? */
  found: boolean;
  /** Kijkt het recht in de camera (niet gedraaid of gekanteld)? */
  straight: boolean;
  /** Hoogte van het gezicht (ogen tot kin) als deel van de beeldhoogte. */
  size: number;
  /** Staat het hele hoofd, met ruimte voor haar, in beeld? */
  inFrame: boolean;
}

/** Hoe staat het gezicht voor de camera? Voor aanwijzingen terwijl de camera loopt. Null zolang de modellen er niet zijn. */
export function checkFace(models: Models | null, video: HTMLVideoElement): FaceCheck | null {
  if (!models) return null;
  const w = video.videoWidth;
  const h = video.videoHeight;
  const f = w && h ? findFace(models, video, w, h) : null;
  if (!f) return { found: false, straight: false, size: 0, inFrame: false };
  const [a, b] = f.eyes;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const span = Math.hypot(b.x - a.x, b.y - a.y);
  const down = f.chin.y - mid.y;
  const yaw = Math.abs(f.nose.x - mid.x) / span;
  const roll = Math.abs(Math.atan2(b.y - a.y, b.x - a.x));
  return {
    found: true,
    straight: yaw < 0.14 && roll < 0.16,
    size: down / h,
    inFrame: mid.y - down * 1.5 > 0 && f.chin.y + down * 0.3 < h && mid.x - down > 0 && mid.x + down < w,
  };
}

/**
 * Vloeiende vervorming (thin plate spline) die een aantal punten precies op hun doel legt: voor elk punt in de foto
 * geeft hij de plek in het bronbeeld.
 */
function warp(from: Point[], to: Point[]) {
  const n = from.length;
  const U = (r2: number) => (r2 < 1e-12 ? 0 : 0.5 * r2 * Math.log(r2));
  const size = n + 3;
  const m: number[][] = Array.from({ length: size }, () => new Array<number>(size + 2).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) m[i][j] = U((from[i].x - from[j].x) ** 2 + (from[i].y - from[j].y) ** 2);
    m[i][i] += 40; // iets toegeven: liever vloeiend dan tot op de pixel
    m[i][n] = m[n][i] = 1;
    m[i][n + 1] = m[n + 1][i] = from[i].x;
    m[i][n + 2] = m[n + 2][i] = from[i].y;
    m[i][size] = to[i].x;
    m[i][size + 1] = to[i].y;
  }
  // Gauss-eliminatie met pivotering
  for (let c = 0; c < size; c++) {
    let best = c;
    for (let r = c + 1; r < size; r++) if (Math.abs(m[r][c]) > Math.abs(m[best][c])) best = r;
    [m[c], m[best]] = [m[best], m[c]];
    for (let r = 0; r < size; r++) {
      if (r === c) continue;
      const k = m[r][c] / m[c][c];
      for (let j = c; j < size + 2; j++) m[r][j] -= k * m[c][j];
    }
  }
  const wx = m.map((row, i) => row[size] / row[i]);
  const wy = m.map((row, i) => row[size + 1] / row[i]);
  return (x: number, y: number, out: Point) => {
    let sx = wx[n] + wx[n + 1] * x + wx[n + 2] * y;
    let sy = wy[n] + wy[n + 1] * x + wy[n + 2] * y;
    for (let i = 0; i < n; i++) {
      const u = U((x - from[i].x) ** 2 + (y - from[i].y) ** 2);
      sx += wx[i] * u;
      sy += wy[i] * u;
    }
    out.x = sx;
    out.y = sy;
  };
}

export interface Shot {
  /** De foto (JPEG als data-URL), of null als hij te groot uitviel. */
  data: string | null;
  /** Is het gezicht herkend en de foto daarop bijgetrokken? */
  aligned: boolean;
}

/**
 * Foto voor op de figuur maken van een beeld (camera of afbeelding) van `sw` × `sh` beeldpunten. `maxLength` is de
 * grootste toegestane lengte van het resultaat.
 */
export async function makeFace(source: CanvasImageSource, sw: number, sh: number, maxLength: number): Promise<Shot> {
  const { w: W, h: H, strip: SW, maskH: SH } = FORMAT;
  const models = await loadFaceModels();

  // Bronbeeld (hooguit 1280 breed) als beeldpunten
  const scale = Math.min(1, 1280 / sw);
  const iw = Math.round(sw * scale);
  const ih = Math.round(sh * scale);
  const src = document.createElement('canvas');
  src.width = iw;
  src.height = ih;
  const sctx = src.getContext('2d', { willReadFrequently: true })!;
  sctx.drawImage(source, 0, 0, iw, ih);
  const sp = sctx.getImageData(0, 0, iw, ih).data;

  // Van elk punt in de foto naar het bronbeeld: bijgetrokken op het gezicht, of anders het midden van het beeld.
  const face = findFace(models, src, iw, ih);
  let toSource: (x: number, y: number, out: Point) => void;
  if (face) {
    // Breedte van het gezicht t.o.v. de afstand ogen-kin: een smal of breed gezicht blijft voor de helft zo.
    const mid = { x: (face.eyes[0].x + face.eyes[1].x) / 2, y: (face.eyes[0].y + face.eyes[1].y) / 2 };
    const wide = Math.hypot(face.sides[1].x - face.sides[0].x, face.sides[1].y - face.sides[0].y) / Math.hypot(face.chin.x - mid.x, face.chin.y - mid.y);
    const own = 1 + 0.5 * (Math.max(0.88, Math.min(1.12, wide / AVERAGE_WIDTH)) - 1);
    const px = ([x, y]: number[], side = 1): Point => {
      const { u, v } = photoUV(side * x * own, y);
      return { x: u * W, y: v * H };
    };
    const P = FACE_POINTS;
    toSource = warp(
      [px(P.eye, -1), px(P.eye), px(P.nose), px(P.mouth), px(P.chin), px(P.forehead), px(P.side, -1), px(P.side), px(P.jaw, -1), px(P.jaw)],
      [...face.eyes, face.nose, face.mouth, face.chin, face.forehead, ...face.sides, ...face.jaws],
    );
  } else {
    const crop = Math.min(iw / W, ih / H);
    toSource = (x, y, out) => {
      out.x = (iw - W * crop) / 2 + x * crop;
      out.y = (ih - H * crop) / 2 + y * crop;
    };
  }
  const canvas = document.createElement('canvas');
  canvas.width = W + SW;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const photo = ctx.createImageData(W, H);
  const p = { x: 0, y: 0 };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      toSource(x + 0.5, y + 0.5, p);
      const fx = Math.max(0, Math.min(iw - 1.001, p.x - 0.5));
      const fy = Math.max(0, Math.min(ih - 1.001, p.y - 0.5));
      const x0 = fx | 0;
      const y0 = fy | 0;
      const ax = fx - x0;
      const ay = fy - y0;
      const i = (y0 * iw + x0) * 4;
      const o = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = sp[i + ch] * (1 - ax) + sp[i + 4 + ch] * ax;
        const bottom = sp[i + iw * 4 + ch] * (1 - ax) + sp[i + iw * 4 + 4 + ch] * ax;
        photo.data[o + ch] = top * (1 - ay) + bottom * ay;
      }
      photo.data[o + 3] = 255;
    }
  }

  // Belichting gelijktrekken op de huid (wangen en neus), zodat een donkere kamer geen donker hoofd geeft.
  const region = [photoUV(-0.03, FACE_POINTS.eye[1] - 0.014), photoUV(0.03, FACE_POINTS.nose[1] - 0.004)];
  let sum = 0;
  let count = 0;
  for (let y = Math.round(region[0].v * H); y < region[1].v * H; y++) {
    for (let x = Math.round(region[0].u * W); x < region[1].u * W; x++) {
      const o = (y * W + x) * 4;
      sum += 0.299 * photo.data[o] + 0.587 * photo.data[o + 1] + 0.114 * photo.data[o + 2];
      count++;
    }
  }
  const gain = Math.max(0.85, Math.min(1.6, 150 / Math.max(1, sum / count)));
  const curve = Uint8ClampedArray.from({ length: 256 }, (_, v) => 255 * (1 - (1 - v / 255) ** gain)); // lichter zonder uit te bijten
  for (let i = 0; i < photo.data.length; i += 4) for (let ch = 0; ch < 3; ch++) photo.data[i + ch] = curve[photo.data[i + ch]];
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W + SW, H);
  ctx.putImageData(photo, 0, 0);

  // Haarmasker in de strook rechts, met een wit blok eronder als teken dat het masker erbij zit.
  try {
    const cut = document.createElement('canvas');
    cut.width = W;
    cut.height = H;
    cut.getContext('2d')!.putImageData(photo, 0, 0);
    const result = models?.segmenter.segment(cut).categoryMask;
    if (result) {
      const cats = result.getAsUint8Array();
      const { width: mw, height: mh } = result;
      const strip = ctx.createImageData(SW, SH);
      for (let y = 0; y < SH; y++) {
        for (let x = 0; x < SW; x++) {
          let hair = 0;
          let n = 0;
          for (let my = Math.floor((y * mh) / SH); my < ((y + 1) * mh) / SH; my++) {
            for (let mx = Math.floor((x * mw) / SW); mx < ((x + 1) * mw) / SW; mx++, n++) if (cats[my * mw + mx] === 1) hair++;
          }
          const o = (y * SW + x) * 4;
          strip.data[o] = strip.data[o + 1] = strip.data[o + 2] = (255 * hair) / Math.max(1, n);
          strip.data[o + 3] = 255;
        }
      }
      result.close();
      ctx.putImageData(strip, W, 0);
      ctx.fillStyle = '#fff';
      ctx.fillRect(W + 16, FORMAT.flagY - 24, SW - 32, 48);
    }
  } catch {
    // geen masker: het haar wordt dan op kleur herkend
  }

  for (const quality of [0.84, 0.76, 0.66, 0.55]) {
    const data = canvas.toDataURL('image/jpeg', quality);
    if (data.length <= maxLength) return { data, aligned: !!face };
  }
  return { data: null, aligned: !!face };
}

