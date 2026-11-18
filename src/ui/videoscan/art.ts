import * as THREE from 'three';
import { canvasTexture, rng } from '../scene/textures';
import { onTop } from '../scene/style';

// Teksten op canvas voor de videoscan-scène: labels, borden, schermen. Mag als texture (zie CLAUDE.md:
// stickers, schermen en borden met tekst).

type G = CanvasRenderingContext2D;

export function barcode(g: G, x: number, y: number, w: number, h: number, seed: number) {
  const r = rng(seed);
  g.fillStyle = '#111';
  let cx = x;
  while (cx < x + w - 4) {
    const bw = 1 + Math.floor(r() * 3) * (w / 160);
    if (r() < 0.55) g.fillRect(cx, y, bw, h);
    cx += bw + w / 220;
  }
}

/** Plat bord als mesh: tekening op canvas, laag +layers boven de ondergrond. */
export function board(w: number, h: number, px: number, draw: (g: G, w: number, h: number) => void, layers = 1) {
  const t = canvasTexture(Math.round(w * px), Math.round(h * px), draw);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), onTop(new THREE.MeshStandardMaterial({ map: t, roughness: 0.6 }), layers));
  m.receiveShadow = true;
  return m;
}

/** Bord met tekst in het midden (een of meer regels). */
export function textBoard(w: number, h: number, lines: string[], bg: string, fg: string, opts: { border?: boolean; px?: number; bold?: boolean } = {}) {
  return board(w, h, opts.px ?? 256, (g, W, H) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    if (opts.border !== false) {
      g.strokeStyle = fg;
      g.lineWidth = Math.min(W, H) * 0.05;
      g.strokeRect(g.lineWidth, g.lineWidth, W - 2 * g.lineWidth, H - 2 * g.lineWidth);
    }
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const lh = (H * 0.8) / lines.length;
    lines.forEach((line, i) => {
      g.font = `${opts.bold === false ? '' : 'bold '}${Math.round(lh * (i === 0 ? 0.78 : 0.62))}px Arial`;
      g.fillText(line, W / 2, H * 0.1 + lh * (i + 0.55), W * 0.9);
    });
  });
}

/** Locatielabel op de ligger: geel, code groot, barcode, controlecijfer in een rondje. */
export function drawLocation(g: G, W: number, H: number, code: string, check: number) {
  g.fillStyle = '#f2c81a';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#111';
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.font = `bold ${Math.round(H * 0.42)}px Arial`;
  g.fillText(code, W * 0.04, H * 0.3, W * 0.7);
  g.fillStyle = '#fff';
  g.fillRect(W * 0.04, H * 0.58, W * 0.66, H * 0.34);
  barcode(g, W * 0.06, H * 0.61, W * 0.62, H * 0.28, code.length * 977 + check);
  g.beginPath();
  g.arc(W * 0.86, H * 0.5, H * 0.34, 0, Math.PI * 2);
  g.fillStyle = '#fff';
  g.fill();
  g.lineWidth = H * 0.05;
  g.strokeStyle = '#111';
  g.stroke();
  g.fillStyle = '#111';
  g.textAlign = 'center';
  g.font = `bold ${Math.round(H * 0.36)}px Arial`;
  g.fillText(String(check), W * 0.86, H * 0.52);
}

/** Controlecijfer van een locatie: vast per code (een paar staan in de transcriptie). */
const FIXED_CHECK: Record<string, number> = { 'D-07-3-2': 47, 'D-07-0-2': 54 };
export function checkDigit(code: string) {
  if (FIXED_CHECK[code]) return FIXED_CHECK[code];
  let h = 7;
  for (const c of code) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 10 + (h % 90);
}

/** Atlas van veel locatielabels op één texture; rects[i] = uv [u0, v0, u1, v1]. */
export function labelAtlas(codes: string[]) {
  const COLS = 16;
  const TW = 160;
  const TH = 56;
  const W = COLS * TW;
  const H = Math.max(1, Math.ceil(codes.length / COLS)) * TH;
  const rects: [number, number, number, number][] = [];
  const texture = canvasTexture(W, H, (g) => {
    codes.forEach((code, i) => {
      const x = (i % COLS) * TW;
      const y = Math.floor(i / COLS) * TH;
      g.save();
      g.translate(x + 2, y + 2);
      drawLocation(g, TW - 4, TH - 4, code, checkDigit(code));
      g.restore();
      rects.push([(x + 2) / W, 1 - (y + TH - 2) / H, (x + TW - 2) / W, 1 - (y + 2) / H]);
    });
  });
  return { texture, rects };
}

/** Scherm met regels tekst (terminal, scanner, planningscherm). */
export function screen(w: number, h: number, lines: string[], opts: { bg?: string; fg?: string; px?: number; title?: string } = {}) {
  const bg = opts.bg ?? '#0e1b26';
  const fg = opts.fg ?? '#e8f1f6';
  const t = canvasTexture(Math.round(w * (opts.px ?? 1200)), Math.round(h * (opts.px ?? 1200)), (g, W, H) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    let y = 0;
    if (opts.title) {
      g.fillStyle = '#1f6fb2';
      g.fillRect(0, 0, W, H * 0.2);
      g.fillStyle = '#fff';
      g.font = `bold ${Math.round(H * 0.12)}px Arial`;
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      g.fillText(opts.title, W * 0.05, H * 0.1, W * 0.9);
      y = H * 0.2;
    }
    const lh = (H - y) / Math.max(lines.length, 3);
    g.textBaseline = 'middle';
    lines.forEach((line, i) => {
      const warn = line.startsWith('!');
      g.fillStyle = warn ? '#ffcf3a' : fg;
      g.font = `bold ${Math.round(lh * 0.55)}px Arial`;
      g.fillText(warn ? line.slice(1) : line, W * 0.05, y + lh * (i + 0.5), W * 0.9);
    });
  });
  const mat = new THREE.MeshBasicMaterial({ map: t, toneMapped: false });
  mat.color.setScalar(0.85);
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), onTop(mat));
}

/** Planningscherm in het expeditiekantoor: tabel met ritten. */
export function planningScreen(w: number, h: number) {
  const t = canvasTexture(1600, 900, (g, W, H) => {
    g.fillStyle = '#f4f6f8';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#17346b';
    g.fillRect(0, 0, W, 90);
    g.fillStyle = '#fff';
    g.font = 'bold 48px Arial';
    g.textBaseline = 'middle';
    g.fillText('EXPEDITIEPLANNING  wo 12-11  NACHT', 30, 46);
    const cols = ['RIT', 'STOPS', 'ROLCO', 'START PICK', 'VERTREK', 'DOCK'];
    const cx = [30, 280, 520, 760, 1080, 1380];
    g.fillStyle = '#d9e0e7';
    g.fillRect(0, 95, W, 58);
    g.fillStyle = '#17346b';
    g.font = 'bold 34px Arial';
    cols.forEach((c, i) => g.fillText(c, cx[i], 124));
    const rows: [string, number, number, string, string, string][] = [
      ['RIT 01', 9, 27, '21:30', '05:30', '4'], ['RIT 02', 8, 24, '21:30', '05:30', '5'], ['RIT 03', 7, 22, '21:45', '05:45', '6'],
      ['RIT 04', 10, 31, '22:00', '05:45', '7'], ['RIT 05', 8, 25, '22:30', '06:00', '8'], ['RIT 06', 6, 19, '23:00', '06:00', '4'],
      ['RIT 07', 9, 28, '23:30', '06:15', '5'], ['RIT 08', 8, 23, '00:15', '06:15', '6'], ['RIT 09', 7, 21, '01:00', '06:30', '7'],
      ['RIT 10', 9, 26, '01:45', '06:30', '8'], ['RIT 11', 8, 24, '02:30', '06:45', '4'], ['RIT 12', 9, 30, '03:00', '06:45', '5'],
    ];
    g.font = '32px Arial';
    rows.forEach((r, i) => {
      const y = 186 + i * 58;
      if (i % 2) {
        g.fillStyle = '#e8ecf0';
        g.fillRect(0, y - 29, W, 58);
      }
      g.fillStyle = '#1b1f24';
      r.forEach((v, j) => g.fillText(String(v), cx[j], y));
    });
  });
  const mat = new THREE.MeshBasicMaterial({ map: t, toneMapped: false });
  mat.color.setScalar(0.9);
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), onTop(mat));
}

/** Palletlabel (GS1): SSCC, GTIN, THT, batch met drie barcodes. */
export function palletLabel(sscc: string, gtin: string, tht: string, batch: string, product: string) {
  return board(0.15, 0.21, 2400, (g, W, H) => {
    g.fillStyle = '#fbfbf7';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#111';
    g.textBaseline = 'top';
    g.textAlign = 'left';
    const f = (s: number, bold = true) => (g.font = `${bold ? 'bold ' : ''}${Math.round(W * s)}px Arial`);
    f(0.075);
    g.fillText(product, W * 0.05, H * 0.03, W * 0.9);
    f(0.05, false);
    g.fillText('SSCC', W * 0.05, H * 0.11);
    f(0.075);
    g.fillText(sscc, W * 0.05, H * 0.145, W * 0.9);
    f(0.05, false);
    g.fillText('GTIN', W * 0.05, H * 0.215);
    g.fillText('THT', W * 0.55, H * 0.215);
    f(0.07);
    g.fillText(gtin, W * 0.05, H * 0.245, W * 0.48);
    g.fillText(tht, W * 0.55, H * 0.245, W * 0.42);
    f(0.05, false);
    g.fillText('BATCH', W * 0.05, H * 0.31);
    g.fillText('AANTAL', W * 0.55, H * 0.31);
    f(0.07);
    g.fillText(batch, W * 0.05, H * 0.34);
    g.fillText('72 COLLI', W * 0.55, H * 0.34);
    for (let i = 0; i < 3; i++) {
      barcode(g, W * 0.06, H * (0.43 + i * 0.185), W * 0.88, H * 0.13, 101 + i * 37);
      f(0.04, false);
      g.fillStyle = '#111';
      g.fillText(['(02)' + gtin + '(15)' + tht.split('-').reverse().join('').slice(2) + '(10)' + batch, '(00)' + sscc, '(37)72'][i], W * 0.06, H * (0.565 + i * 0.185), W * 0.88);
    }
  });
}
