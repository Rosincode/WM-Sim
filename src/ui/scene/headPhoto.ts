import * as THREE from 'three';
import { HEAD, PHOTO, halfWidth, headY } from './headShape';

// Van een foto (recht van voren) naar het uiterlijk van het hele hoofd. De foto zelf dekt alleen de voorkant;
// hier wordt uitgezocht wat huid is en wat haar, en dat wordt rond het hoofd doorgetrokken: het haar dat op de
// foto te zien is loopt door over de kruin, de zijkanten en het achterhoofd. Is er geen haar te zien, dan is
// het hoofd kaal; staat er alleen haar opzij (kale kruin), dan loopt er een krans rond het achterhoofd.

const PW = 120;
const PH = 160;
const TW = 256;
const TH = 256;
/** Tot waar het haar in de nek reikt bij kort haar (v op de foto, ter hoogte van de oorlel). */
const NAPE_V = PHOTO.top + (HEAD.hy + 0.05) / PHOTO.h;
/** Tot waar het haar opzij reikt bij kort haar: de bovenkant van het oor. */
const EAR_V = PHOTO.top + (HEAD.hy - 0.012) / PHOTO.h;
const LOBE_V = PHOTO.top + (HEAD.hy + 0.03) / PHOTO.h;
/** De foto wordt niet tot op de rand van het hoofd gebruikt: daar rekt hij uit en kan de achtergrond staan. */
const INSET = 0.9;

export interface HeadLook {
  /** Kleur van het hele hoofd, uitgevouwen zoals de bol van het hoofd (lengte × breedte, naad achter). */
  texture: THREE.CanvasTexture;
  skin: THREE.Color;
  /** Haarkleur, of null als het hoofd kaal is. */
  hair: THREE.Color | null;
  /** Lang haar: valt tot voorbij de kaak. */
  long: boolean;
  /** Hoeveel haar (0..1) er zit op het punt van het hoofd in richting (dx, dy, dz). */
  hairAt(dx: number, dy: number, dz: number): number;
}

const clamp = THREE.MathUtils.clamp;
const smoothstep = THREE.MathUtils.smoothstep;
const median = (list: number[]) => [...list].sort((a, b) => a - b)[list.length >> 1];

export function readPhoto(image: HTMLImageElement | HTMLCanvasElement): HeadLook | null {
  let px: Uint8ClampedArray;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = PW;
    canvas.height = PH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0, PW, PH);
    px = ctx.getImageData(0, 0, PW, PH).data;
  } catch {
    return null; // foto niet te lezen: de figuur houdt het gewone hoofd
  }

  /** Gemiddelde kleur van de punten die `use` aanwijst; in de tweede ronde zonder de uitschieters. */
  const average = (use: (c: number, r: number) => boolean) => {
    let mean: [number, number, number] | null = null;
    let count = 0;
    for (let pass = 0; pass < 2; pass++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let row = 0; row < PH; row++) {
        for (let col = 0; col < PW; col++) {
          if (!use(col, row)) continue;
          const i = (row * PW + col) * 4;
          if (mean && Math.hypot(px[i] - mean[0], px[i + 1] - mean[1], px[i + 2] - mean[2]) > 60) continue;
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
          n++;
        }
      }
      if (!n) break;
      mean = [r / n, g / n, b / n];
      count = n;
    }
    return mean && { rgb: mean, count };
  };

  // Huidskleur: wangen en neus, tussen de ogen en de mond.
  const skinRGB = average((c, r) => c >= PW * 0.36 && c < PW * 0.64 && r >= PH * 0.54 && r < PH * 0.68)!.rgb;
  const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = (r: number, g: number, b: number) => -0.169 * r - 0.331 * g + 0.5 * b;
  const cr = (r: number, g: number, b: number) => 0.5 * r - 0.419 * g - 0.081 * b;
  const sY = luma(...skinRGB);
  const sCb = cb(...skinRGB);
  const sCr = cr(...skinRGB);
  const darker = Math.max(30, sY * 0.33); // schaduw op de huid is nog geen haar
  /** Is dit punt géén huid (haar)? Duidelijk donkerder, veel lichter, of een andere tint dan de huid. */
  const notSkin = (c: number, r: number) => {
    const i = (r * PW + c) * 4;
    const dY = luma(px[i], px[i + 1], px[i + 2]) - sY;
    const dC = Math.hypot(cb(px[i], px[i + 1], px[i + 2]) - sCb, cr(px[i], px[i + 1], px[i + 2]) - sCr);
    return Math.max((-dY - darker) / 15, (dY - 70) / 20, (dC - 11) / 8) > 0.5;
  };

  // Per kolom van de kruin omlaag: het haar is het aaneengesloten stuk niet-huid vanaf de bovenkant van het hoofd.
  // Midden op het gezicht stopt dat uiterlijk bij de wenkbrauwen; opzij mag het doorlopen (bakkebaarden, lang haar).
  const mask = new Float32Array(PW * PH);
  const runs: { du: number; side: number; top: number; end: number }[] = [];
  for (let c = 0; c < PW; c++) {
    const u = (c + 0.5) / PW;
    const du = Math.abs(u - 0.5);
    const x = du * PHOTO.w;
    if (x > HEAD.hx * 0.97) continue;
    let start = Math.ceil(PH * (PHOTO.top + 0.005));
    while (start < PH && halfWidth(headY((start + 0.5) / PH)) < x) start++;
    start++;
    const limit = Math.floor(PH * (du < 0.2 ? 0.43 : du < 0.27 ? 0.47 : 1));
    let end = start;
    for (let r = start, gap = 0; r < limit; r++) {
      if (notSkin(c, r)) {
        end = r + 1;
        gap = 0;
      } else if (++gap > 2) break;
    }
    if (end - start < 3) end = start;
    runs.push({ du, side: u < 0.5 ? 0 : 1, top: start / PH, end: end / PH });
    for (let r = 0; r < end && end > start; r++) mask[r * PW + c] = 1;
  }

  const outer = (c: number) => Math.abs((c + 0.5) / PW - 0.5);
  const inside = (c: number, r: number, part = INSET) => r > PH * 0.065 && outer(c) * PHOTO.w < part * halfWidth(headY((r + 0.5) / PH));
  const far = (c: number, r: number, rgb: number[], limit: number) => {
    const i = (r * PW + c) * 4;
    return Math.hypot(px[i] - rgb[0], px[i + 1] - rgb[1], px[i + 2] - rgb[2]) > limit;
  };
  // Haar bovenop: de haargrens ligt in het midden duidelijk onder de kruin.
  const crown = median(runs.filter((r) => r.du < 0.2).map((r) => r.end)) >= 0.13;
  // Haar opzij: de kolommen net binnen de rand van het hoofd.
  const band = runs.filter((r) => r.du >= 0.31 && r.du <= 0.37);
  const inBand = (c: number, r: number) => outer(c) >= 0.31 && outer(c) <= 0.37 && r < PH * 0.6 && mask[r * PW + c] > 0 && inside(c, r, 1);
  let hairAvg = crown ? average((c, r) => mask[r * PW + c] > 0 && outer(c) < 0.27 && inside(c, r)) : average(inBand);
  if (!crown && hairAvg) {
    // Kale kruin: wat opzij niet-huid is, is haar - tenzij het de achtergrond is die langs het hoofd te zien is.
    const background = average((c, r) => r < 14 && (c < 8 || c >= PW - 8));
    if (background && Math.hypot(...hairAvg.rgb.map((v, i) => v - background.rgb[i])) < 35) hairAvg = null;
  }
  const hairRGB = hairAvg && hairAvg.count >= 15 ? hairAvg.rgb : null;
  // Opzij loopt het haar door zolang het de haarkleur houdt: daaronder is het kleding of achtergrond.
  runs.forEach((run, n) => {
    if (run.du < 0.27 || !hairRGB) return;
    const c = Math.round((run.side ? 0.5 + run.du : 0.5 - run.du) * PW - 0.5);
    let end = Math.round(run.top * PH);
    for (let r = end, off = 0; r < run.end * PH; r++) {
      if (!far(c, r, hairRGB, 75)) {
        end = r + 1;
        off = 0;
      } else if (++off > 3) break;
    }
    for (let r = end; r < PH; r++) mask[r * PW + c] = 0;
    if (end <= run.top * PH + 2) for (let r = 0; r < PH; r++) mask[r * PW + c] = 0;
    runs[n].end = Math.max(run.top, end / PH);
  });
  const sides = [0, 1]
    .map((side) => {
      const cols = band.filter((r) => r.side === side);
      const hairy = cols.filter((r) => r.end - r.top >= 0.05);
      return hairy.length * 3 >= cols.length && hairy.length ? { top: median(hairy.map((r) => r.top)), end: median(hairy.map((r) => r.end)) } : null;
    })
    .filter((s) => !!s);
  const hasHair = !!hairRGB && (crown || sides.length > 0);
  if (!hasHair) mask.fill(0);
  // kale kruin: wat er midden bovenop niet-huid leek (glans, schaduw) is geen haar
  else if (!crown) for (let c = 0; c < PW; c++) if (outer(c) < 0.27) for (let r = 0; r < PH; r++) mask[r * PW + c] = 0;
  // Buiten de foto (zijkanten, achterhoofd): haar vanaf de kruin (of, bij een kale kruin, vanaf waar het opzij begint)
  // tot boven de oren, en achterop tot in de nek; bij langer haar tot waar het op de foto opzij reikt.
  const ruleTop = crown ? -1 : Math.min(...sides.map((s) => s.top));
  const sideEnd = sides.length ? Math.max(...sides.map((s) => s.end)) : EAR_V;
  const backEnd = Math.max(NAPE_V, sideEnd);
  const frontEnd = Math.min(sideEnd, LOBE_V);
  const long = hasHair && crown && sides.length === 2 && sides[0].end + sides[1].end >= 1.6;

  // Zachte overgang tussen haar en huid
  const tmp = new Float32Array(PW * PH);
  for (let pass = 0; pass < 4; pass++) {
    const down = pass % 2 === 1; // om en om: opzij, omlaag
    const src = down ? tmp : mask;
    const dst = down ? mask : tmp;
    const step = down ? PW : 1;
    const n = down ? PH : PW;
    for (let i = 0; i < PW * PH; i++) {
      const k = down ? (i / PW) | 0 : i % PW; // plek langs de richting waarin vervaagd wordt
      let sum = 0;
      for (let d = -2; d <= 2; d++) sum += src[i + (clamp(k + d, 0, n - 1) - k) * step];
      dst[i] = sum / 5;
    }
  }

  /** Waarde op de foto (kleurkanaal of haarmasker), vloeiend tussen de punten. */
  const sample = (data: ArrayLike<number>, stride: number, offset: number, u: number, v: number) => {
    const fx = clamp(u * PW - 0.5, 0, PW - 1.001);
    const fy = clamp(v * PH - 0.5, 0, PH - 1.001);
    const x0 = fx | 0;
    const y0 = fy | 0;
    const ax = fx - x0;
    const ay = fy - y0;
    const at = (x: number, y: number) => data[(y * PW + x) * stride + offset];
    return (at(x0, y0) * (1 - ax) + at(x0 + 1, y0) * ax) * (1 - ay) + (at(x0, y0 + 1) * (1 - ax) + at(x0 + 1, y0 + 1) * ax) * ay;
  };

  /**
   * Een punt op het hoofd: waar het op de foto ligt (u, v), hoe zwaar de foto daar telt (w: 1 op het gezicht,
   * 0 opzij en achterop) en of er buiten de foto haar zit.
   */
  const at = { u: 0, v: 0, w: 0, rule: 0 };
  const locate = (dx: number, dy: number, dz: number) => {
    const y = HEAD.hy * dy;
    const reach = INSET * halfWidth(y);
    const x = clamp(HEAD.hx * dx * (1 - 0.3 * Math.max(0, -dy) ** 2), -reach, reach);
    const v = PHOTO.top + (HEAD.hy - y) / PHOTO.h;
    at.u = 0.5 + x / PHOTO.w;
    at.v = clamp(v, PHOTO.top + 0.015, PHOTO.chin - 0.005);
    at.w = smoothstep(dz, -0.05, 0.4);
    const end = frontEnd + (backEnd - frontEnd) * smoothstep(-dz, 0, 0.45); // vóór het oor niet lager dan de oorlel
    at.rule = hasHair ? smoothstep(v, ruleTop - 0.03, ruleTop + 0.03) * (1 - smoothstep(v, end - 0.025, end + 0.025)) : 0;
    return at;
  };
  const hairAt = (dx: number, dy: number, dz: number) => {
    const p = locate(dx, dy, dz);
    return p.rule + (sample(mask, 1, 0, p.u, p.v) - p.rule) * p.w;
  };

  // Kleur van het hele hoofd: de foto op de voorkant, naar achteren overlopend in effen haar of huid.
  const canvas = document.createElement('canvas');
  canvas.width = TW;
  canvas.height = TH;
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(TW, TH);
  for (let j = 0; j < TH; j++) {
    const theta = ((j + 0.5) / TH) * Math.PI;
    const dy = Math.cos(theta);
    for (let i = 0; i < TW; i++) {
      const phi = -Math.PI / 2 + ((i + 0.5) / TW) * Math.PI * 2;
      const p = locate(-Math.cos(phi) * Math.sin(theta), dy, Math.sin(phi) * Math.sin(theta));
      const o = (j * TW + i) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const flat = skinRGB[ch] + ((hairRGB?.[ch] ?? 0) - skinRGB[ch]) * p.rule;
        out.data[o + ch] = flat + (sample(px, 4, ch, p.u, p.v) - flat) * p.w;
      }
      out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  const color = (rgb: number[]) => new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
  return { texture, skin: color(skinRGB), hair: hairRGB && color(hairRGB), long, hairAt };
}
