import * as THREE from 'three';
import { EYES, HEAD, NOSE_V, OLD_PHOTO, PHOTO, halfWidth, headSurface, headY } from './headShape';

// Van een foto (recht van voren) naar het uiterlijk van het hoofd. De foto dekt alleen het gezicht; de rest van
// het hoofd (zijkanten, achterhoofd, onder de kin) krijgt één egale kleur: de huidskleur van de persoon, gemeten
// op de wangen en de neus. Haar wordt niet nagemaakt: de figuur draagt altijd een helm (zie character.ts).

/**
 * Opbouw van het fotobestand: links de foto (w × h), rechts een strook (strip) waarin bij het maken van de foto
 * een haarmasker wordt gezet (strip × maskH, met rond flagY een wit blok als het erbij zit). Het masker wordt niet
 * meer gebruikt; de strook blijft, zodat bestaande foto's blijven passen.
 */
export const FORMAT = { w: 384, h: 512, strip: 96, maskH: 128, flagY: 192 };

const { w: W, h: H } = FORMAT;
const TW = 1024;
const TH = 512;
/** De foto wordt niet tot op de rand van het hoofd gebruikt: daar rekt hij uit en kan de achtergrond staan. */
const INSET = 0.9;

export interface HeadLook {
  /** Kleur van het hele hoofd, uitgevouwen zoals de bol van het hoofd (lengte × breedte, naad achter). */
  texture: THREE.CanvasTexture;
  skin: THREE.Color;
}

const clamp = THREE.MathUtils.clamp;
const smoothstep = THREE.MathUtils.smoothstep;
const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
/** Plek op de foto (beeldpunten) van een punt op het hoofd (meters). */
const toCol = (x: number) => Math.round((0.5 + x / PHOTO.w) * W);
const toRow = (y: number) => Math.round((PHOTO.top + (HEAD.hy - y) / PHOTO.h) * H);

export function readPhoto(image: HTMLImageElement | HTMLCanvasElement): HeadLook | null {
  const iw = (image as HTMLImageElement).naturalWidth || image.width;
  const ih = (image as HTMLImageElement).naturalHeight || image.height;
  const old = iw / ih < 0.8; // van vóór de ruimere uitsnede: alleen het hoofd, geen strook
  let px: Uint8ClampedArray;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    if (old) {
      // in de nieuwe uitsnede zetten
      const dw = (W * OLD_PHOTO.w) / PHOTO.w;
      const dh = (H * OLD_PHOTO.h) / PHOTO.h;
      ctx.drawImage(image, 0, 0, iw, ih, (W - dw) / 2, H * PHOTO.top - dh * OLD_PHOTO.top, dw, dh);
    } else ctx.drawImage(image, 0, 0, (iw * W) / (W + FORMAT.strip), ih, 0, 0, W, H);
    px = ctx.getImageData(0, 0, W, H).data;
  } catch {
    return null; // foto niet te lezen: de figuur houdt het gewone hoofd
  }

  /** Gemiddelde kleur van een stuk van de foto (in meters op het hoofd); in de tweede ronde zonder de uitschieters. */
  const average = (x0: number, x1: number, yTop: number, yBottom: number) => {
    let mean: number[] | null = null;
    for (let pass = 0; pass < 2; pass++) {
      const sum = [0, 0, 0];
      let n = 0;
      for (let r = toRow(yTop); r <= toRow(yBottom); r += 2) {
        for (let c = toCol(x0); c <= toCol(x1); c += 2) {
          const i = (r * W + c) * 4;
          if (mean && Math.hypot(px[i] - mean[0], px[i + 1] - mean[1], px[i + 2] - mean[2]) > 60) continue;
          for (let ch = 0; ch < 3; ch++) sum[ch] += px[i + ch];
          n++;
        }
      }
      if (!n) break;
      mean = sum.map((v) => v / n);
    }
    return mean;
  };

  // Huidskleur: wangen en neus, tussen de ogen en de mond.
  const noseY = headY(NOSE_V);
  const skinRGB = average(-0.03, 0.03, headY(EYES.v) - 0.014, noseY - 0.004) ?? [214, 160, 124];
  const skinL = luma(skinRGB[0], skinRGB[1], skinRGB[2]);

  // Onder de neus staan op de foto de neusgaten en de schaduw van de neus. Op het hoofd heeft de neus zelf al
  // vorm en schaduw, en van opzij wordt dat een donkere vlek: daar de foto lichter maken, naar de huidskleur toe.
  // Niet bij een snor: die is zelf donker en moet blijven.
  const lip = average(-0.015, 0.015, noseY - 0.012, noseY - 0.022);
  if (!lip || luma(lip[0], lip[1], lip[2]) > 0.7 * skinL) {
    const floor = 0.8 * skinL;
    for (let r = toRow(noseY + 0.008); r <= toRow(noseY - 0.02); r++) {
      const y = HEAD.hy - ((r + 0.5) / H - PHOTO.top) * PHOTO.h;
      for (let c = toCol(-0.024); c <= toCol(0.024); c++) {
        const x = ((c + 0.5) / W - 0.5) * PHOTO.w;
        const i = (r * W + c) * 4;
        const near = Math.exp(-((x / 0.013) ** 2) - ((y - noseY + 0.006) / 0.008) ** 2);
        const t = Math.min(1, 1.5 * near) * smoothstep(floor - luma(px[i], px[i + 1], px[i + 2]), 0, 25);
        for (let ch = 0; ch < 3; ch++) px[i + ch] += (0.85 * skinRGB[ch] - px[i + ch]) * t;
      }
    }
  }

  /** Kleurkanaal van de foto op plek (u, v), vloeiend tussen de beeldpunten. */
  const sample = (ch: number, u: number, v: number) => {
    const fx = clamp(u * W - 0.5, 0, W - 1.001);
    const fy = clamp(v * H - 0.5, 0, H - 1.001);
    const x0 = fx | 0;
    const y0 = fy | 0;
    const ax = fx - x0;
    const ay = fy - y0;
    const i = (y0 * W + x0) * 4 + ch;
    return (px[i] * (1 - ax) + px[i + 4] * ax) * (1 - ay) + (px[i + W * 4] * (1 - ax) + px[i + W * 4 + 4] * ax) * ay;
  };

  // Kleur van het hele hoofd: de foto op het gezicht, naar opzij, naar boven en onder de kin overlopend in de
  // egale huidskleur. Bovenop (onder de helm) en achterop staat dus geen foto.
  const canvas = document.createElement('canvas');
  canvas.width = TW;
  canvas.height = TH;
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(TW, TH);
  const pt = { x: 0, y: 0, z: 0 };
  for (let j = 0; j < TH; j++) {
    const theta = ((j + 0.5) / TH) * Math.PI;
    const dy = Math.cos(theta);
    for (let i = 0; i < TW; i++) {
      const phi = -Math.PI / 2 + ((i + 0.5) / TW) * Math.PI * 2;
      const dx = -Math.cos(phi) * Math.sin(theta);
      const dz = Math.sin(phi) * Math.sin(theta);
      headSurface(dx, dy, dz, pt);
      // hoe zwaar de foto telt: 1 op het gezicht, 0 opzij, bovenop, onder de kin en achterop
      const w = smoothstep(dz, 0.05, 0.45) * (1 - smoothstep(dy, 0.75, 0.95)) * (1 - smoothstep(-pt.y, HEAD.hy - 0.02, HEAD.hy - 0.006));
      const o = (j * TW + i) * 4;
      const reach = INSET * halfWidth(pt.y);
      const u = 0.5 + clamp(pt.x, -reach, reach) / PHOTO.w;
      const v = clamp(PHOTO.top + (HEAD.hy - pt.y) / PHOTO.h, 0.01, PHOTO.chin - 0.004);
      for (let ch = 0; ch < 3; ch++) out.data[o + ch] = w > 0 ? skinRGB[ch] + (sample(ch, u, v) - skinRGB[ch]) * w : skinRGB[ch];
      out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  return { texture, skin: new THREE.Color().setRGB(skinRGB[0] / 255, skinRGB[1] / 255, skinRGB[2] / 255, THREE.SRGBColorSpace) };
}
