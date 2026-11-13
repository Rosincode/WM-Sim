// Afbeeldingen van de robots die het bedrijf verkoopt (de artikelen, docs/wms/03): per artikel een tekening,
// en het bord op de kop van een stelling dat laat zien welke robots daar liggen.
// Borden met een afbeelding mogen een canvastextuur hebben (zie "Stijl van 3D-modellen" in CLAUDE.md).

type G = CanvasRenderingContext2D;
type Pt = [number, number];

const INK = '#23262b';
const SHELL = '#eef0f2';
const SHADE = '#c9ced4';
const DARK = '#3a3f46';
const EYE = '#27c4e8';

// Tekenhulpjes: alles in een vak van 100 × 100, met een donkere omlijning.
function paint(g: G, fill?: string, stroke: string | null = INK, width = 2.2) {
  if (fill) {
    g.fillStyle = fill;
    g.fill();
  }
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = width;
    g.lineJoin = g.lineCap = 'round';
    g.stroke();
  }
}
function box(g: G, x: number, y: number, w: number, h: number, r: number, fill?: string, stroke: string | null = INK) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  paint(g, fill, stroke);
}
function oval(g: G, x: number, y: number, rx: number, ry: number, fill?: string, stroke: string | null = INK) {
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  paint(g, fill, stroke);
}
function shape(g: G, pts: Pt[], fill?: string, stroke: string | null = INK) {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  paint(g, fill, stroke);
}
function line(g: G, pts: Pt[], color = INK, width = 2.2) {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  paint(g, undefined, color, width);
}
/** Arm of been: een dikke lijn met een omlijning. */
function limb(g: G, pts: Pt[], color = SHADE, width = 5) {
  line(g, pts, INK, width + 3);
  line(g, pts, color, width);
}
function eyes(g: G, x: number, y: number, gap: number, r = 2.6) {
  for (const dx of [-gap / 2, gap / 2]) {
    oval(g, x + dx, y, r, r, EYE, INK);
    oval(g, x + dx - r * 0.3, y - r * 0.3, r * 0.3, r * 0.3, '#ffffff', null);
  }
}
function antenna(g: G, x: number, y: number, h: number, color: string) {
  line(g, [[x, y], [x, y - h]]);
  oval(g, x, y - h, 2.4, 2.4, color);
}
function note(g: G, x: number, y: number, color: string) {
  line(g, [[x + 2.6, y], [x + 2.6, y - 11], [x + 8, y - 9]], color, 2);
  oval(g, x, y, 3, 2.3, color, null);
}
function sparkle(g: G, x: number, y: number, r: number, color: string) {
  shape(g, [[x, y - r], [x + r * 0.28, y - r * 0.28], [x + r, y], [x + r * 0.28, y + r * 0.28], [x, y + r], [x - r * 0.28, y + r * 0.28], [x - r, y], [x - r * 0.28, y - r * 0.28]], color, null);
}
const ground = (g: G, y = 92, rx = 30) => oval(g, 50, y, rx, 3.5, 'rgba(0,0,0,.16)', null);

type Art = { tint: string; accent: string; draw: (g: G, accent: string) => void };

const HOUSE = '#dbe9f7';
const PET = '#fde7cf';
const FUN = '#eadcf6';

const ART: Record<string, Art> = {
  // Stofzuigrobot Dusty: een platte ronde schijf met borsteltjes
  'SKU-001': {
    tint: HOUSE, accent: '#d6402a',
    draw(g, accent) {
      ground(g, 80, 38);
      for (const s of [-1, 1]) for (const a of [0, 1, 2]) line(g, [[50 + s * 30, 68], [50 + s * (38 + a * 3), 76 - a * 4]], DARK, 1.8);
      oval(g, 50, 64, 36, 15, DARK);
      oval(g, 50, 56, 36, 15, SHELL);
      oval(g, 50, 55, 25, 9.5, SHADE);
      oval(g, 50, 54, 6, 3.4, accent);
      eyes(g, 50, 71.5, 16, 2.4);
      for (const [x, y, r] of [[16, 40, 3], [10, 48, 2], [86, 42, 2.6], [91, 50, 1.8]]) oval(g, x, y, r, r, '#b9b2a6', null);
    },
  },
  // Wasvouwrobot Foldy: houdt een stapel gevouwen was vast
  'SKU-002': {
    tint: HOUSE, accent: '#2f78c8',
    draw(g, accent) {
      ground(g);
      oval(g, 38, 87, 5, 5, DARK);
      oval(g, 62, 87, 5, 5, DARK);
      box(g, 30, 36, 40, 48, 9, SHELL);
      antenna(g, 50, 14, 8, accent);
      box(g, 35, 14, 30, 20, 7, SHELL);
      box(g, 39, 19, 22, 10, 5, DARK);
      eyes(g, 50, 24, 10, 2.2);
      box(g, 28, 66, 44, 8, 2.5, accent);
      box(g, 30, 58, 40, 8, 2.5, '#ffffff');
      box(g, 32, 50, 36, 8, 2.5, '#e8a23a');
      limb(g, [[30, 46], [20, 62], [30, 72]]);
      limb(g, [[70, 46], [80, 62], [70, 72]]);
    },
  },
  // Robothond Bolt
  'SKU-003': {
    tint: PET, accent: '#e2601a',
    draw(g, accent) {
      ground(g, 90, 34);
      line(g, [[26, 50], [13, 34]], INK, 3);
      oval(g, 12, 32, 3.4, 3.4, accent);
      for (const x of [27, 38, 54, 63]) box(g, x, 60, 8, 26, 3.5, x === 38 || x === 54 ? SHADE : DARK);
      box(g, 22, 42, 50, 24, 11, SHELL);
      box(g, 56, 40, 8, 26, 3, accent);
      shape(g, [[64, 30], [68, 12], [76, 28]], accent);
      box(g, 62, 24, 24, 22, 8, SHELL);
      box(g, 80, 34, 13, 10, 4.5, SHADE);
      oval(g, 91, 37, 2.2, 2.2, INK, null);
      eyes(g, 78, 32, 0, 2.8);
      line(g, [[82, 44], [88, 44]], INK, 1.6);
    },
  },
  // Robotkat Miso: zit rechtop, staart omhoog
  'SKU-004': {
    tint: PET, accent: '#e58aa0',
    draw(g, accent) {
      ground(g, 92, 28);
      g.beginPath();
      g.moveTo(66, 84);
      g.bezierCurveTo(90, 84, 90, 60, 80, 52);
      paint(g, undefined, INK, 8);
      g.beginPath();
      g.moveTo(66, 84);
      g.bezierCurveTo(90, 84, 90, 60, 80, 52);
      paint(g, undefined, SHADE, 5);
      oval(g, 50, 70, 19, 21, SHELL);
      oval(g, 50, 74, 9, 12, '#ffffff', null);
      oval(g, 42, 89, 7, 4, SHADE);
      oval(g, 58, 89, 7, 4, SHADE);
      for (const s of [-1, 1]) {
        shape(g, [[50 + s * 19, 30], [50 + s * 16, 9], [50 + s * 4, 22]], SHELL);
        shape(g, [[50 + s * 16, 26], [50 + s * 14.5, 15], [50 + s * 8, 23]], accent, null);
      }
      oval(g, 50, 38, 20, 17, SHELL);
      eyes(g, 50, 37, 17, 3.4);
      shape(g, [[47.5, 43], [52.5, 43], [50, 46]], accent, null);
      for (const s of [-1, 1]) for (const dy of [-2, 2]) line(g, [[50 + s * 9, 45], [50 + s * 22, 45 + dy * 1.6]], INK, 1.2);
    },
  },
  // Dansrobot Groove: midden in een danspas
  'SKU-005': {
    tint: FUN, accent: '#8a4fd0',
    draw(g, accent) {
      ground(g, 93, 30);
      limb(g, [[45, 56], [36, 72], [40, 89]]);
      limb(g, [[55, 56], [68, 70], [76, 86]]);
      box(g, 33, 87, 12, 5, 2.5, DARK);
      box(g, 72, 84, 12, 5, 2.5, DARK);
      limb(g, [[39, 35], [25, 26], [21, 11]]);
      limb(g, [[61, 35], [77, 44], [84, 31]]);
      oval(g, 21, 10, 3.6, 3.6, SHELL);
      oval(g, 84, 30, 3.6, 3.6, SHELL);
      box(g, 37, 30, 26, 28, 8, accent);
      oval(g, 50, 43, 5, 5, '#ffffff', null);
      antenna(g, 50, 10, 6, accent);
      box(g, 39, 10, 22, 17, 6, SHELL);
      eyes(g, 50, 18, 10, 2.3);
      note(g, 86, 16, accent);
      note(g, 9, 44, accent);
    },
  },
  // Ramenwasrobot Clearo: hangt met zuignappen op een ruit
  'SKU-006': {
    tint: HOUSE, accent: '#1fa7b8',
    draw(g, accent) {
      box(g, 14, 8, 72, 84, 3, '#bfe3f2');
      shape(g, [[16, 62], [84, 30], [84, 90], [16, 90]], '#e3f5fb', null);
      line(g, [[50, 8], [50, 92]], '#ffffff', 3);
      box(g, 14, 8, 72, 84, 3, undefined);
      for (const [x, y] of [[33, 33], [67, 33], [33, 63], [67, 63]]) oval(g, x, y, 5, 5, DARK);
      box(g, 33, 32, 34, 32, 9, SHELL);
      box(g, 38, 38, 24, 10, 5, DARK);
      eyes(g, 50, 43, 11, 2.2);
      oval(g, 50, 56, 3, 3, accent);
      box(g, 28, 66, 44, 6, 2.5, accent);
      sparkle(g, 26, 22, 6, '#ffffff');
      sparkle(g, 76, 20, 4.5, '#ffffff');
      sparkle(g, 74, 80, 5, '#ffffff');
    },
  },
  // Robotvogel Pip
  'SKU-007': {
    tint: PET, accent: '#f0b400',
    draw(g, accent) {
      ground(g, 91, 24);
      for (const x of [43, 54]) {
        line(g, [[x, 72], [x, 88]], INK, 2.6);
        line(g, [[x - 4, 89], [x + 6, 89]], INK, 2.6);
      }
      shape(g, [[30, 52], [8, 42], [11, 62]], DARK);
      oval(g, 48, 55, 25, 20, accent);
      oval(g, 54, 62, 13, 9, '#fff3c4', null);
      oval(g, 40, 54, 14, 10, SHELL);
      line(g, [[32, 54], [48, 54]], SHADE, 1.6);
      line(g, [[34, 58], [46, 58]], SHADE, 1.6);
      antenna(g, 68, 24, 8, '#e2601a');
      oval(g, 68, 36, 13, 13, accent);
      shape(g, [[79, 32], [93, 37], [79, 42]], '#e2601a');
      eyes(g, 71, 34, 0, 3);
    },
  },
  // Muziekrobot Beat: een luidspreker met een koptelefoon op
  'SKU-008': {
    tint: FUN, accent: '#e0457b',
    draw(g, accent) {
      ground(g, 92, 32);
      box(g, 25, 36, 50, 54, 9, DARK);
      oval(g, 50, 66, 17, 17, SHADE);
      oval(g, 50, 66, 10, 10, DARK);
      oval(g, 50, 66, 4.5, 4.5, accent);
      oval(g, 50, 43, 3.5, 3.5, SHADE);
      g.beginPath();
      g.arc(50, 22, 18, Math.PI, 0);
      paint(g, undefined, INK, 5);
      box(g, 36, 12, 28, 21, 7, SHELL);
      box(g, 40, 17, 20, 9, 4.5, DARK);
      eyes(g, 50, 21.5, 9, 2);
      box(g, 28, 15, 8, 15, 3.5, accent);
      box(g, 64, 15, 8, 15, 3.5, accent);
      note(g, 84, 34, accent);
      note(g, 8, 28, accent);
    },
  },
  // Robotkonijn Hop
  'SKU-009': {
    tint: PET, accent: '#f29bb0',
    draw(g, accent) {
      ground(g, 93, 26);
      for (const x of [35, 54]) {
        box(g, x, 4, 11, 34, 5.5, SHELL);
        box(g, x + 3, 9, 5, 24, 2.5, accent, null);
      }
      oval(g, 50, 75, 18, 16, SHELL);
      oval(g, 50, 78, 9, 9, '#ffffff', null);
      oval(g, 38, 90, 9, 4.5, SHADE);
      oval(g, 62, 90, 9, 4.5, SHADE);
      oval(g, 50, 46, 18, 16, SHELL);
      eyes(g, 50, 44, 15, 3);
      oval(g, 50, 50, 2.4, 1.8, accent, null);
      box(g, 47.6, 53, 4.8, 5, 1, '#ffffff');
      line(g, [[50, 53], [50, 58]], INK, 1);
    },
  },
  // Goochelrobot Magix: hoge hoed, cape en toverstaf
  'SKU-010': {
    tint: FUN, accent: '#b3262e',
    draw(g, accent) {
      ground(g, 93, 34);
      shape(g, [[34, 50], [66, 50], [82, 91], [18, 91]], accent);
      box(g, 38, 50, 24, 36, 7, SHELL);
      shape(g, [[50, 55], [42, 51], [42, 59]], INK, null);
      shape(g, [[50, 55], [58, 51], [58, 59]], INK, null);
      limb(g, [[62, 58], [76, 50], [80, 40]]);
      line(g, [[78, 44], [90, 22]], INK, 3.4);
      line(g, [[88.4, 25], [90, 22]], '#ffffff', 2);
      sparkle(g, 90, 15, 7, '#f0b400');
      sparkle(g, 76, 20, 3.5, '#f0b400');
      box(g, 36, 29, 28, 20, 7, SHELL);
      eyes(g, 50, 39, 11, 2.4);
      box(g, 27, 25, 46, 5, 2.5, INK);
      box(g, 36, 4, 28, 22, 2, INK);
      box(g, 36, 18, 28, 5, 0, accent, null);
    },
  },
};

/** Een artikel zonder eigen tekening: een gewone robot, in een kleur die van de sku is afgeleid. */
function fallback(sku: string): Art {
  let h = 0;
  for (const c of sku) h = (h * 31 + c.charCodeAt(0)) % 360;
  return {
    tint: '#e6e9ec', accent: `hsl(${h} 60% 45%)`,
    draw(g, accent) {
      ground(g);
      oval(g, 40, 88, 5, 5, DARK);
      oval(g, 60, 88, 5, 5, DARK);
      limb(g, [[32, 48], [22, 62]]);
      limb(g, [[68, 48], [78, 62]]);
      box(g, 32, 40, 36, 44, 8, SHELL);
      box(g, 40, 50, 20, 12, 3, accent);
      antenna(g, 50, 16, 8, accent);
      box(g, 36, 16, 28, 20, 7, SHELL);
      eyes(g, 50, 26, 11, 2.4);
    },
  };
}

/** Tekent de robot van een artikel in het vierkant (x, y, size) op een canvas. */
export function drawRobot(g: G, sku: string, x: number, y: number, size: number) {
  const art = ART[sku] ?? fallback(sku);
  g.save();
  g.translate(x, y);
  g.scale(size / 100, size / 100);
  box(g, 0, 0, 100, 100, 10, art.tint, null);
  g.beginPath();
  g.roundRect(0, 0, 100, 100, 10);
  g.clip();
  art.draw(g, art.accent);
  g.restore();
}

export type BoardItem = { sku: string; name: string };

/** Het bord op de kop van een stelling: de robots (artikelen) die in die stelling liggen, elk met zijn afbeelding. */
export function drawRackBoard(g: G, w: number, h: number, title: string, items: BoardItem[]) {
  g.fillStyle = '#f7f7f2';
  g.fillRect(0, 0, w, h);
  const head = Math.round(h * 0.1);
  g.fillStyle = '#17346b';
  g.fillRect(0, 0, w, head);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${Math.round(head * 0.52)}px Arial`;
  g.fillText(title, w / 2, head / 2 + 2, w - 24);
  if (!items.length) {
    g.fillStyle = '#8a9097';
    g.font = `bold ${Math.round(w * 0.075)}px Arial`;
    g.fillText('Stelling is leeg', w / 2, head + (h - head) / 2);
    return;
  }
  const cols = items.length <= 2 ? 1 : items.length <= 6 ? 2 : 3;
  const rows = Math.ceil(items.length / cols);
  const pad = 14;
  const cw = (w - pad) / cols;
  const ch = (h - head - pad) / rows;
  items.forEach((it, i) => {
    const text = Math.min(ch * 0.3, cw * 0.34);
    const size = Math.min(cw - pad, ch - pad - text);
    const cx = pad / 2 + (i % cols) * cw + cw / 2;
    const top = head + pad / 2 + Math.floor(i / cols) * ch + (ch - size - text) / 2;
    drawRobot(g, it.sku, cx - size / 2, top, size);
    // "Stofzuigrobot Dusty": de soort klein, de naam van de robot groot
    const cut = it.name.lastIndexOf(' ');
    const kind = cut > 0 ? it.name.slice(0, cut) : '';
    const name = cut > 0 ? it.name.slice(cut + 1) : it.name || it.sku;
    g.fillStyle = '#23262b';
    g.font = `bold ${Math.round(text * 0.46)}px Arial`;
    g.fillText(name, cx, top + size + text * 0.34, cw - 10);
    g.fillStyle = '#5b6168';
    g.font = `${Math.round(text * 0.27)}px Arial`;
    g.fillText(kind ? `${kind} · ${it.sku}` : it.sku, cx, top + size + text * 0.76, cw - 10);
  });
}
