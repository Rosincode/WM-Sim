import * as THREE from 'three';
import { EYES, HEAD, NOSE_V, OLD_PHOTO, PHOTO, halfWidth, headSurface, headY } from './headShape';

// Van een foto (recht van voren) naar het uiterlijk van het hele hoofd. De foto zelf dekt alleen de voorkant;
// hier wordt uitgezocht waar haar zit en hoe dik het is, en dat wordt rond het hoofd doorgetrokken: het haar dat
// op de foto te zien is loopt door over de kruin, de zijkanten en het achterhoofd, met het volume dat het op de
// foto heeft. Is er geen haar te zien, dan is het hoofd kaal; staat er alleen haar opzij (kale kruin), dan loopt
// er een krans rond het achterhoofd.
//
// Wat de foto niet laat zien wordt aangevuld met wat er aan de rand van de foto wél staat: de structuur van de
// bovenkant van het hoofd (haar, of de kale huid) loopt door over de kruin en het achterhoofd, de huid van de
// zijkant van het gezicht loopt achter de oren langs, en de kin (met of zonder baard) loopt door tot de nek.
//
// Waar het haar zit staat in het masker dat bij het maken van de foto is meegegeven (zie faceCapture.ts). Foto's
// zonder masker (oude foto's, of gemaakt zonder gezichtsherkenning) worden op kleur bekeken: alles boven en naast
// het gezicht dat geen huidskleur heeft telt als haar.

/**
 * Opbouw van het fotobestand: links de foto (w × h), rechts een strook met bovenin het haarmasker (strip × maskH,
 * wit = haar) en rond flagY een wit blok als het masker erbij zit.
 */
export const FORMAT = { w: 384, h: 512, strip: 96, maskH: 128, flagY: 192 };

const { w: W, h: H } = FORMAT;
const MW = FORMAT.strip;
const MH = FORMAT.maskH;
const TW = 1024;
const TH = 512;
/** De foto wordt niet tot op de rand van het hoofd gebruikt: daar rekt hij uit en kan de achtergrond staan. */
const INSET = 0.9;
// Hoogtes op het hoofd: bovenkant van het oor, oorlel, haargrens in de nek.
const EAR_Y = 0.012;
const LOBE_Y = -0.03;
const NAPE_Y = -0.05;
const MIN_HAIR = 0.004;

export interface HeadLook {
  /** Kleur van het hele hoofd, uitgevouwen zoals de bol van het hoofd (lengte × breedte, naad achter). */
  texture: THREE.CanvasTexture;
  skin: THREE.Color;
  /** Haarkleur, of null als het hoofd kaal is. */
  hair: THREE.Color | null;
  /** Haar dat tot onder de oren valt: halve breedte, tot welke hoogte het reikt (t.o.v. het midden van het hoofd) en de dikte achter de nek (m), anders null. */
  drape: { halfWidth: number; bottom: number; depth: number } | null;
  /** Dikte van het haar (m) op het punt van het hoofd in richting (dx, dy, dz); 0 = huid. */
  hairAt(dx: number, dy: number, dz: number): number;
}

const clamp = THREE.MathUtils.clamp;
const smoothstep = THREE.MathUtils.smoothstep;
const median = (list: number[]) => [...list].sort((a, b) => a - b)[list.length >> 1];
const colX = (c: number) => ((c + 0.5) / MW - 0.5) * PHOTO.w;
const rowY = (r: number) => headY((r + 0.5) / MH);
const row = (y: number) => clamp(Math.round((PHOTO.top + (HEAD.hy - y) / PHOTO.h) * MH - 0.5), 0, MH - 1);
const col = (x: number) => clamp(Math.round((0.5 + x / PHOTO.w) * MW - 0.5), 0, MW - 1);

export function readPhoto(image: HTMLImageElement | HTMLCanvasElement): HeadLook | null {
  const iw = (image as HTMLImageElement).naturalWidth || image.width;
  const ih = (image as HTMLImageElement).naturalHeight || image.height;
  const old = iw / ih < 0.8; // van vóór de ruimere uitsnede: alleen het hoofd, geen strook
  let px: Uint8ClampedArray; // de foto
  let small: Uint8ClampedArray; // de foto, verkleind tot de maat van het masker
  let strip: Uint8ClampedArray; // de strook met het masker
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
    } else ctx.drawImage(image, 0, 0, (iw * W) / (W + MW), ih, 0, 0, W, H);
    px = ctx.getImageData(0, 0, W, H).data;
    const tiny = document.createElement('canvas');
    tiny.width = MW;
    tiny.height = MH + 1;
    const tctx = tiny.getContext('2d', { willReadFrequently: true })!;
    tctx.drawImage(canvas, 0, 0, MW, MH);
    small = tctx.getImageData(0, 0, MW, MH).data;
    tctx.clearRect(0, 0, MW, MH + 1);
    if (!old) {
      const k = ih / H;
      tctx.drawImage(image, (iw * W) / (W + MW), 0, (iw * MW) / (W + MW), MH * k, 0, 0, MW, MH);
      tctx.drawImage(image, iw - (iw * MW) / (W + MW) / 2 - 1, FORMAT.flagY * k - 1, 2, 2, 0, MH, MW, 1); // het witte blok
    }
    strip = tctx.getImageData(0, 0, MW, MH + 1).data;
  } catch {
    return null; // foto niet te lezen: de figuur houdt het gewone hoofd
  }
  const hasMask = strip[MH * MW * 4] > 128;

  /** Gemiddelde kleur (verkleinde foto) van de punten die `use` aanwijst; in de tweede ronde zonder de uitschieters. */
  const average = (use: (c: number, r: number) => boolean) => {
    let mean: [number, number, number] | null = null;
    let count = 0;
    for (let pass = 0; pass < 2; pass++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = 0; y < MH; y++) {
        for (let x = 0; x < MW; x++) {
          if (!use(x, y)) continue;
          const i = (y * MW + x) * 4;
          if (mean && Math.hypot(small[i] - mean[0], small[i + 1] - mean[1], small[i + 2] - mean[2]) > 60) continue;
          r += small[i];
          g += small[i + 1];
          b += small[i + 2];
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
  const skinRGB: number[] = average((c, r) => Math.abs(colX(c)) < 0.03 && rowY(r) < headY(EYES.v) - 0.014 && rowY(r) > headY(NOSE_V) - 0.004)?.rgb ?? [214, 160, 124];

  const mask = new Float32Array(MW * MH);
  let hairRGB: number[] | null = null;
  if (hasMask) {
    for (let i = 0; i < MW * MH; i++) mask[i] = smoothstep(strip[i * 4] / 255, 0.3, 0.7);
    const avg = average((c, r) => mask[r * MW + c] > 0.8);
    hairRGB = avg && avg.count >= 40 ? avg.rgb : null;
    if (!hairRGB) mask.fill(0);
  } else hairRGB = byColour();

  /** Zonder masker: haar herkennen aan de kleur. Vult `mask` (alleen binnen de omtrek van het hoofd) en geeft de haarkleur. */
  function byColour(): number[] | null {
    const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = (r: number, g: number, b: number) => -0.169 * r - 0.331 * g + 0.5 * b;
    const cr = (r: number, g: number, b: number) => 0.5 * r - 0.419 * g - 0.081 * b;
    const [sr, sg, sb] = skinRGB;
    const darker = Math.max(30, luma(sr, sg, sb) * 0.33); // schaduw op de huid is nog geen haar
    /** Is dit punt géén huid? Duidelijk donkerder, veel lichter, of een andere tint dan de huid. */
    const notSkin = (c: number, r: number) => {
      const i = (r * MW + c) * 4;
      const dY = luma(small[i], small[i + 1], small[i + 2]) - luma(sr, sg, sb);
      const dC = Math.hypot(cb(small[i], small[i + 1], small[i + 2]) - cb(sr, sg, sb), cr(small[i], small[i + 1], small[i + 2]) - cr(sr, sg, sb));
      return Math.max((-dY - darker) / 15, (dY - 70) / 20, (dC - 11) / 8) > 0.5;
    };
    const far = (c: number, r: number, rgb: number[], limit: number) => {
      const i = (r * MW + c) * 4;
      return Math.hypot(small[i] - rgb[0], small[i + 1] - rgb[1], small[i + 2] - rgb[2]) > limit;
    };
    // Per kolom van de kruin omlaag: het haar is het aaneengesloten stuk niet-huid vanaf de bovenkant van het hoofd.
    // Midden op het gezicht stopt dat uiterlijk bij de wenkbrauwen; opzij mag het doorlopen (bakkebaarden, lang haar).
    const runs: { c: number; x: number; top: number; end: number }[] = [];
    for (let c = 0; c < MW; c++) {
      const x = Math.abs(colX(c));
      if (x > HEAD.hx * 0.97) continue;
      let start = row(HEAD.hy - 0.002);
      while (start < MH && halfWidth(rowY(start)) < x) start++;
      start++;
      const limit = x < 0.041 ? row(0.016) : x < 0.055 ? row(0.005) : row(-HEAD.hy);
      let end = start;
      for (let r = start, gap = 0; r < limit; r++) {
        if (notSkin(c, r)) {
          end = r + 1;
          gap = 0;
        } else if (++gap > 1) break;
      }
      if (end - start < 2) end = start;
      runs.push({ c, x, top: start, end });
      for (let r = start; r < end; r++) mask[r * MW + c] = 1;
    }
    const inside = (c: number, r: number) => Math.abs(colX(c)) < halfWidth(rowY(r));
    // Haar bovenop: de haargrens ligt in het midden duidelijk onder de kruin.
    const crown = median(runs.filter((r) => r.x < 0.041).map((r) => rowY(r.end))) <= HEAD.hy - 0.019;
    const band = (c: number) => Math.abs(colX(c)) >= 0.0635 && Math.abs(colX(c)) <= 0.076;
    let avg = crown
      ? average((c, r) => mask[r * MW + c] > 0 && Math.abs(colX(c)) < 0.055 && inside(c, r))
      : average((c, r) => band(c) && rowY(r) > -0.03 && mask[r * MW + c] > 0 && inside(c, r));
    if (!crown && avg) {
      // Kale kruin: wat opzij niet-huid is, is haar - tenzij het de achtergrond is die langs het hoofd te zien is.
      const bg = average((c, r) => rowY(r) > HEAD.hy && rowY(r) < HEAD.hy + 0.012 && Math.abs(colX(c)) > 0.06 && Math.abs(colX(c)) < 0.09);
      const found = avg.rgb;
      if (bg && Math.hypot(found[0] - bg.rgb[0], found[1] - bg.rgb[1], found[2] - bg.rgb[2]) < 35) avg = null;
    }
    const rgb = avg && avg.count >= 8 ? avg.rgb : null;
    if (!rgb) {
      mask.fill(0);
      return null;
    }
    for (const run of runs) {
      if (run.x < 0.055) {
        // kale kruin: wat er midden bovenop niet-huid leek (glans, schaduw) is geen haar
        if (!crown) for (let r = 0; r < MH; r++) mask[r * MW + run.c] = 0;
        continue;
      }
      // Opzij loopt het haar door zolang het de haarkleur houdt: daaronder is het kleding of achtergrond.
      let end = run.top;
      for (let r = run.top, off = 0; r < run.end; r++) {
        if (!far(run.c, r, rgb, 75)) {
          end = r + 1;
          off = 0;
        } else if (++off > 2) break;
      }
      for (let r = end > run.top + 1 ? end : 0; r < MH; r++) mask[r * MW + run.c] = 0;
    }
    return rgb;
  }

  /** Masker op een plek in meters. */
  const maskAt = (x: number, y: number) => mask[row(y) * MW + col(x)];
  const hasHair = !!hairRGB;
  // Haar bovenop, en hoe ver het boven de schedel uitkomt.
  let crownSum = 0;
  let crownN = 0;
  for (let r = row(HEAD.hy - 0.006); r <= row(HEAD.hy - 0.03); r++) for (let c = col(-0.035); c <= col(0.035); c++, crownN++) crownSum += mask[r * MW + c];
  const crown = hasHair && crownSum / crownN > 0.5;
  const tops: number[] = [];
  for (let c = col(-0.03); c <= col(0.03); c++) {
    let r = 0;
    while (r < MH - 1 && mask[r * MW + c] < 0.5) r++;
    tops.push(rowY(r));
  }
  const topThick = !crown ? 0 : hasMask ? clamp(median(tops) - HEAD.hy, MIN_HAIR, 0.07) : 0.014;
  // Per hoogte: zit er haar aan de rand van het hoofd, en hoe ver steekt het opzij uit?
  const sidePresence = new Float32Array(MH);
  const sideThick = new Float32Array(MH);
  for (let r = row(HEAD.hy); r <= row(-HEAD.hy); r++) {
    const y = rowY(r);
    const hw = halfWidth(y);
    for (const side of [-1, 1]) {
      const present = Math.max(maskAt(side * hw * INSET, y), hasMask ? maskAt(side * (hw + 0.008), y) : 0);
      let c = col(side * hw);
      while (c > 0 && c < MW - 1 && mask[r * MW + c + side] > 0.5) c += side;
      sidePresence[r] += present / 2;
      sideThick[r] += (present > 0.5 ? (hasMask ? clamp(Math.abs(colX(c)) - hw, MIN_HAIR, 0.045) : 0.014) : 0) / 2;
    }
  }
  for (let pass = 0; pass < 5; pass++) {
    const copy = sideThick.slice();
    for (let r = 2; r < MH - 2; r++) sideThick[r] = (copy[r - 2] + copy[r - 1] + copy[r] + copy[r + 1] + copy[r + 2]) / 5;
  }
  // Van waar tot waar zit er opzij haar (van boven af, aaneengesloten)?
  let sideTop = NaN;
  let sideEnd = NaN;
  for (let r = row(HEAD.hy - 0.01), off = 0; r <= row(-HEAD.hy) && off < 3; r++) {
    if (sidePresence[r] >= 0.5) {
      if (Number.isNaN(sideTop)) sideTop = rowY(r);
      sideEnd = rowY(r);
      off = 0;
    } else if (!Number.isNaN(sideTop)) off++;
  }
  const sides = hasHair && sideTop - sideEnd > 0.035; // een krans loopt van de slaap tot onder het oor: een los vlekje (schaduw, glans) is geen haar
  if (hasHair && !crown && !sides) mask.fill(0);
  // kale kruin: wat er midden bovenop voor haar is aangezien (glans, schaduw) is geen haar
  else if (hasHair && !crown) for (let r = 0; r < MH; r++) for (let c = col(-0.055); c <= col(0.055); c++) mask[r * MW + c] = 0;
  const anyHair = hasHair && (crown || sides);
  // Buiten de foto (zijkanten, achterhoofd): haar vanaf de kruin (of, bij een kale kruin, vanaf waar het opzij begint)
  // tot boven de oren, en achterop tot in de nek; bij langer haar tot waar het op de foto opzij reikt.
  const ruleTop = crown ? Infinity : sideTop;
  const endSide = sides ? sideEnd : EAR_Y;
  const endBack = Math.min(NAPE_Y, endSide);
  const endFront = Math.max(endSide, LOBE_Y); // vóór het oor niet lager dan de oorlel
  // Haar tot onder de oren: hangt naast de kaak en achter de nek; op de foto te volgen tot de onderrand.
  let drape: HeadLook['drape'] = null;
  if (anyHair && hasMask && endSide < -0.07 && sideThick[row(-0.06)] > 0.012) {
    let low = row(-0.03);
    for (let r = low; r < MH; r++) {
      let n = 0;
      for (let c = 0; c < MW; c++) if (mask[r * MW + c] > 0.5) n++;
      if (n < 4) break;
      low = r;
    }
    const thick = sideThick[row(-0.02)];
    // loopt het haar door tot de onderrand van de foto, dan valt het tot op de schouders
    drape = { halfWidth: clamp(halfWidth(-0.02) + thick, 0.082, 0.125), bottom: low >= MH - 2 ? -HEAD.hy - 0.2 : rowY(low), depth: thick };
  }

  // Huid aan de rand van het gezicht, links en rechts op de foto: die kleur loopt achter de oren langs.
  const sideSkin = [-1, 1].map((s) => {
    const avg = average((c, r) => {
      const x = colX(c) * s;
      const y = rowY(r);
      return y > -0.035 && y < 0.01 && x > 0.66 * halfWidth(y) && x < 0.9 * halfWidth(y) && mask[r * MW + c] < 0.3;
    });
    return avg && avg.count >= 6 ? avg.rgb : skinRGB;
  });
  // Waar houdt het hoofd bovenaan op? Per kolom van de bovenrand van de foto omlaag: zolang de kleur die van de
  // achtergrond blijft, is het nog geen hoofd. Boven die grens telt de foto niet mee (anders komt de achtergrond
  // op de kruin); is de grens niet te vinden, dan geldt er geen.
  const headTop = new Float32Array(MW).fill(Infinity);
  const c0 = col(-0.065);
  const c1 = col(0.065);
  {
    const lowest = row(0.07);
    const found: number[] = [];
    for (let c = c0; c <= c1; c++) {
      const bg = [small[c * 4], small[c * 4 + 1], small[c * 4 + 2]];
      let r = 1;
      for (let off = 0; r <= lowest; r++) {
        const i = (r * MW + c) * 4;
        if (mask[r * MW + c] > 0.5 || Math.hypot(small[i] - bg[0], small[i + 1] - bg[1], small[i + 2] - bg[2]) > 34) {
          if (++off > 1) break;
        } else {
          off = 0;
          for (let ch = 0; ch < 3; ch++) bg[ch] += (small[i + ch] - bg[ch]) * 0.2;
        }
      }
      found.push(r > lowest ? Infinity : rowY(r - 1));
    }
    for (let c = c0; c <= c1; c++) headTop[c] = median(found.slice(Math.max(0, c - c0 - 2), c - c0 + 3));
  }
  const topAt = (x: number) => headTop[clamp(col(x), c0, c1)];
  const skullTop = Math.min(HEAD.hy, median(Array.from(headTop.slice(col(-0.03), col(0.03) + 1))));

  // Zachte overgang tussen haar en huid (ruim een centimeter): het haar ligt als één vloeiende vorm op het hoofd
  const tmp = new Float32Array(MW * MH);
  for (let pass = 0; pass < 8; pass++) {
    const down = pass % 2 === 1; // om en om: opzij, omlaag
    const from = down ? tmp : mask;
    const to = down ? mask : tmp;
    const step = down ? MW : 1;
    const n = down ? MH : MW;
    for (let i = 0; i < MW * MH; i++) {
      const k = down ? (i / MW) | 0 : i % MW; // plek langs de richting waarin vervaagd wordt
      let sum = 0;
      for (let d = -2; d <= 2; d++) sum += from[i + (clamp(k + d, 0, n - 1) - k) * step];
      to[i] = sum / 5;
    }
  }

  /** Waarde op de foto (kleurkanaal) of in het masker, vloeiend tussen de punten. */
  const sample = (data: ArrayLike<number>, w: number, h: number, stride: number, offset: number, u: number, v: number) => {
    const fx = clamp(u * w - 0.5, 0, w - 1.001);
    const fy = clamp(v * h - 0.5, 0, h - 1.001);
    const x0 = fx | 0;
    const y0 = fy | 0;
    const ax = fx - x0;
    const ay = fy - y0;
    const i = (y0 * w + x0) * stride + offset;
    return (data[i] * (1 - ax) + data[i + stride] * ax) * (1 - ay) + (data[i + w * stride] * (1 - ax) + data[i + w * stride + stride] * ax) * ay;
  };

  /**
   * Een punt op het hoofd (richting dx, dy, dz): hoe zwaar de foto daar telt (w: 1 op het gezicht, 0 opzij en
   * achterop), of er haar zit (hair, 0..1) en hoe dik dat is (thick, m).
   */
  const at = { w: 0, hair: 0, thick: 0 };
  const pt = { x: 0, y: 0, z: 0 };
  const locate = (dx: number, dy: number, dz: number) => {
    headSurface(dx, dy, dz, pt);
    const reach = INSET * halfWidth(pt.y);
    const v = PHOTO.top + (HEAD.hy - pt.y) / PHOTO.h;
    at.w = smoothstep(dz, -0.05, 0.4);
    let rule = 0;
    if (anyHair) {
      const end = endFront + (endBack - endFront) * smoothstep(-dz, 0, 0.45);
      rule = (1 - smoothstep(pt.y, ruleTop - 0.008, ruleTop + 0.008)) * smoothstep(pt.y, end - 0.007, end + 0.007);
    }
    const seen = sample(mask, MW, MH, 1, 0, 0.5 + clamp(pt.x, -reach, reach) / PHOTO.w, clamp(v, PHOTO.top + 0.01, PHOTO.chin));
    at.hair = rule + (seen - rule) * at.w;
    // op het haar telt de foto alleen recht van voren en boven de oren: opzij en naast de kaak zou hij uitrekken tot strepen
    at.w += (smoothstep(dz, 0.25, 0.6) * smoothstep(pt.y, -0.035, -0.005) - at.w) * at.hair;
    const up = Math.max(0, dy);
    const fr = clamp((PHOTO.top + (HEAD.hy - Math.min(pt.y, sides ? sideTop : EAR_Y + 0.03)) / PHOTO.h) * MH - 0.5, 0, MH - 1.001);
    const side = sideThick[fr | 0] + (sideThick[(fr | 0) + 1] - sideThick[fr | 0]) * (fr % 1);
    // Onder de oren ligt het haar plat op het hoofd: wat daar hangt is de haardos naast en achter de nek (drape).
    // Aan de rand van het haar loopt de dikte geleidelijk af, zodat er geen scherpe richel ontstaat.
    const body = (side + (topThick - side) * up * up) * smoothstep(pt.y, -0.075, -0.02);
    at.thick = Math.max(MIN_HAIR * at.hair, body * smoothstep(at.hair, 0.25, 0.9));
    return at;
  };
  const hairAt = (dx: number, dy: number, dz: number) => locate(dx, dy, dz).thick;

  /**
   * Stukje van de foto (midden cx, cy en w × h, in meters op het hoofd) als vulling voor de rest van het hoofd:
   * de gemiddelde kleur, en de fijne structuur zonder licht en schaduw, die gespiegeld herhaald kan worden.
   */
  const patch = (cx: number, cy: number, w: number, h: number) => {
    const step = PHOTO.h / H;
    const pw = Math.max(8, Math.round(w / step));
    const ph = Math.max(8, Math.round(h / step));
    const raw = new Float32Array(pw * ph * 3);
    for (let j = 0; j < ph; j++) {
      for (let i = 0; i < pw; i++) {
        const u = 0.5 + (cx + ((i + 0.5) / pw - 0.5) * w) / PHOTO.w;
        const v = PHOTO.top + (HEAD.hy - cy - (0.5 - (j + 0.5) / ph) * h) / PHOTO.h;
        for (let ch = 0; ch < 3; ch++) raw[(j * pw + i) * 3 + ch] = sample(px, W, H, 4, ch, u, v);
      }
    }
    // gemiddelde, in de tweede ronde zonder uitschieters (glans, een verdwaald stukje achtergrond)
    let mean = [0, 0, 0];
    for (let pass = 0; pass < 2; pass++) {
      const sum = [0, 0, 0];
      let n = 0;
      for (let i = 0; i < raw.length; i += 3) {
        if (pass && Math.hypot(raw[i] - mean[0], raw[i + 1] - mean[1], raw[i + 2] - mean[2]) > 50) continue;
        for (let ch = 0; ch < 3; ch++) sum[ch] += raw[i + ch];
        n++;
      }
      if (n) mean = sum.map((v) => v / n);
    }
    // structuur = het stukje min zijn vervaagde versie (eerst opzij vervaagd, dan omlaag)
    const blur = raw.slice();
    const line = new Float32Array(Math.max(pw, ph) * 3);
    for (const [n, m, stride, other] of [
      [pw, ph, 3, pw * 3],
      [ph, pw, pw * 3, 3],
    ]) {
      for (let k = 0; k < m; k++) {
        for (let a = 0; a < n; a++) for (let ch = 0; ch < 3; ch++) line[a * 3 + ch] = blur[k * other + a * stride + ch];
        for (let a = 0; a < n; a++) {
          for (let ch = 0; ch < 3; ch++) {
            let sum = 0;
            for (let d = -5; d <= 5; d++) sum += line[clamp(a + d, 0, n - 1) * 3 + ch];
            blur[k * other + a * stride + ch] = sum / 11;
          }
        }
      }
    }
    for (let i = 0; i < raw.length; i++) raw[i] = clamp(raw[i] - blur[i], -40, 40);
    const tri = (q: number) => {
      q = ((q % 2) + 2) % 2;
      return q > 1 ? 2 - q : q;
    };
    /** Structuur op plek (s, t) in meters, eindeloos herhaald (om en om gespiegeld, dus zonder naden). */
    const detail = (s: number, t: number, ch: number) => raw[(Math.min(ph - 1, (tri(t / h) * ph) | 0) * pw + Math.min(pw - 1, (tri(s / w) * pw) | 0)) * 3 + ch];
    return { mean, detail };
  };
  // Bovenkant van het hoofd op de foto: het haar zelf, of bij een kaal hoofd de huid net onder de kruin.
  const TOP_W = 0.06;
  const topEdge = crown ? HEAD.hy + topThick - 0.008 : Math.min(HEAD.hy - 0.02, skullTop - 0.012);
  const top = patch(0, topEdge - 0.012, TOP_W, 0.024);
  const chin = patch(0, 0.018 - HEAD.hy, 0.05, 0.022);

  // Kleur van het hele hoofd: de foto op de voorkant, en daarbuiten de foto doorgetrokken: de structuur van de
  // bovenkant over de kruin en het achterhoofd (haar tot de verzonnen haargrens in de nek, of kale huid), de huid
  // van de zijkant achter de oren langs, de kin tot de nek. Waar haar zit wordt de foto gelezen op de plek van
  // het haar zelf (buiten de schedel), zodat de haardos van de foto past.
  const canvas = document.createElement('canvas');
  canvas.width = TW;
  canvas.height = TH;
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(TW, TH);
  const hairC = hairRGB ?? skinRGB;
  for (let j = 0; j < TH; j++) {
    const theta = ((j + 0.5) / TH) * Math.PI;
    const dy = Math.cos(theta);
    for (let i = 0; i < TW; i++) {
      const phi = -Math.PI / 2 + ((i + 0.5) / TW) * Math.PI * 2;
      const dx = -Math.cos(phi) * Math.sin(theta);
      const dz = Math.sin(phi) * Math.sin(theta);
      const p = locate(dx, dy, dz);
      const o = (j * TW + i) * 4;
      let w = p.w;
      let u = 0;
      let v = 0;
      let real = 1;
      if (w > 0) {
        // plek op de foto: op het haar een eind naar buiten langs de normaal
        const nx = dx / HEAD.hx;
        const ny = dy / HEAD.hy;
        const nz = dz / (dz >= 0 ? HEAD.front : HEAD.back);
        const l = (0.75 * p.thick) / Math.hypot(nx, ny, nz);
        const x = pt.x + nx * l;
        const y = pt.y + ny * l;
        const reach = p.hair > 0.5 ? Infinity : INSET * halfWidth(y);
        u = 0.5 + clamp(x, -reach, reach) / PHOTO.w;
        v = clamp(PHOTO.top + (HEAD.hy - y) / PHOTO.h, 0.01, PHOTO.chin - 0.004);
        // op het haar alleen de foto gebruiken waar daar ook echt haar staat (niet de achtergrond)
        if (p.hair > 0.5 && hasMask) real = smoothstep(sample(mask, MW, MH, 1, 0, u, v), 0.3, 0.6);
        // op de huid telt de foto niet bovenop het hoofd (daar rekt hij uit) en niet boven de rand van het hoofd op de foto
        const bare = 1 - smoothstep(p.hair, 0.2, 0.6);
        const edge = topAt(x);
        w *= (1 - bare * smoothstep(dy, 0.75, 0.95)) * (1 - bare * smoothstep(y, edge - 0.012, edge - 0.004));
      }
      // Vulling buiten de foto. De structuur ligt bovenop plat op het hoofd en loopt opzij rond het hoofd
      // (precies vier keer heen en terug, dus zonder naad achterop).
      const flat = smoothstep(dy, 0.45, 0.8);
      const round = ((i + 0.5) / TW) * 8 * TOP_W;
      const right = smoothstep(pt.x, -0.04, 0.04);
      const up = crown ? 0 : smoothstep(pt.y, 0.03, 0.085); // kaal: naar boven toe de kleur van de kruin
      const under = smoothstep(-pt.y, HEAD.hy - 0.02, HEAD.hy - 0.006) * smoothstep(dz, -0.25, 0.05) * (1 - p.hair); // onder de kin, tot de nek
      for (let ch = 0; ch < 3; ch++) {
        const d = top.detail(pt.x, pt.z, ch) * flat + top.detail(round, pt.y, ch) * (1 - flat);
        const side = sideSkin[0][ch] + (sideSkin[1][ch] - sideSkin[0][ch]) * right;
        const skinFill = side + (top.mean[ch] - side) * up + (crown ? 0 : d);
        const hairFill = hairC[ch] + (crown ? d : 0);
        let c = skinFill + (hairFill - skinFill) * p.hair;
        if (w > 0) c += (hairC[ch] + (sample(px, W, H, 4, ch, u, v) - hairC[ch]) * real - c) * w;
        c += (chin.mean[ch] + chin.detail(pt.x, pt.z, ch) - c) * under;
        out.data[o + ch] = c;
      }
      out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  const color = (rgb: number[]) => new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
  return { texture, skin: color(skinRGB), hair: anyHair && hairRGB ? color(hairRGB) : null, drape, hairAt };
}
