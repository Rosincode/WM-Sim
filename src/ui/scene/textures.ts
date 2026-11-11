import * as THREE from 'three';

// Procedurele texturen (canvas) zodat het magazijn zonder externe assets werkt.

/** Deterministische random (mulberry32) zodat de scène elke keer hetzelfde oogt. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void;

export function canvasTexture(w: number, h: number, draw: Draw, opts: { srgb?: boolean; repeat?: boolean } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(c);
  if (opts.srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
  if (opts.repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function speckle(g: CanvasRenderingContext2D, w: number, h: number, r: () => number, n: number, alpha: number, max = 3) {
  for (let i = 0; i < n; i++) {
    const v = Math.floor(r() * 255);
    g.fillStyle = `rgba(${v},${v},${v},${alpha})`;
    const s = 1 + r() * max;
    g.fillRect(r() * w, r() * h, s, s);
  }
}

function blotches(g: CanvasRenderingContext2D, w: number, h: number, r: () => number, n: number, color: string, alpha: number) {
  for (let i = 0; i < n; i++) {
    const x = r() * w;
    const y = r() * h;
    const rad = 40 + r() * 260;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, color.replace('A', String(alpha * (0.4 + r() * 0.6))));
    grad.addColorStop(1, color.replace('A', '0'));
    g.fillStyle = grad;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
}

/** Gepolijste betonvloer; één tegel = 10 x 10 m met zaagsneden om de 5 m. */
export function concreteFloor() {
  const size = 2048;
  const map = canvasTexture(
    size,
    size,
    (g, w, h) => {
      const r = rng(11);
      g.fillStyle = '#7b7c79';
      g.fillRect(0, 0, w, h);
      blotches(g, w, h, r, 90, 'rgba(70,72,74,A)', 0.14);
      blotches(g, w, h, r, 60, 'rgba(225,225,220,A)', 0.12);
      speckle(g, w, h, r, 90000, 0.05);
      // bandensporen
      g.lineCap = 'round';
      for (let i = 0; i < 26; i++) {
        g.strokeStyle = `rgba(25,25,28,${0.03 + r() * 0.06})`;
        g.lineWidth = 14 + r() * 22;
        g.beginPath();
        const y = r() * h;
        g.moveTo(-50, y);
        g.bezierCurveTo(w * 0.3, y + (r() - 0.5) * 300, w * 0.7, y + (r() - 0.5) * 300, w + 50, y + (r() - 0.5) * 200);
        g.stroke();
      }
      // haarscheurtjes
      g.strokeStyle = 'rgba(40,40,40,0.25)';
      g.lineWidth = 1;
      for (let i = 0; i < 14; i++) {
        let x = r() * w;
        let y = r() * h;
        g.beginPath();
        g.moveTo(x, y);
        for (let k = 0; k < 12; k++) {
          x += (r() - 0.5) * 70;
          y += (r() - 0.5) * 70;
          g.lineTo(x, y);
        }
        g.stroke();
      }
      // zaagsneden
      g.strokeStyle = 'rgba(30,30,30,0.7)';
      g.lineWidth = 3;
      for (const p of [1.5, h / 2]) {
        g.beginPath();
        g.moveTo(0, p);
        g.lineTo(w, p);
        g.moveTo(p, 0);
        g.lineTo(p, h);
        g.stroke();
      }
    },
    { repeat: true },
  );
  const roughnessMap = canvasTexture(
    1024,
    1024,
    (g, w, h) => {
      const r = rng(12);
      g.fillStyle = 'rgb(84,84,84)';
      g.fillRect(0, 0, w, h);
      blotches(g, w, h, r, 50, 'rgba(40,40,40,A)', 0.5);
      blotches(g, w, h, r, 40, 'rgba(200,200,200,A)', 0.45);
      speckle(g, w, h, r, 20000, 0.08, 4);
    },
    { srgb: false, repeat: true },
  );
  return { map, roughnessMap };
}

/** Karton: zijkant met etiket/opdruk en bovenkant met tape. */
export function cardboard() {
  const base = (g: CanvasRenderingContext2D, w: number, h: number, seed: number) => {
    const r = rng(seed);
    g.fillStyle = '#b89268';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) {
      g.fillStyle = `rgba(${r() < 0.5 ? '90,60,30' : '235,205,160'},${0.03 + r() * 0.05})`;
      g.fillRect(0, r() * h, w, 1 + r() * 2);
    }
    speckle(g, w, h, r, 6000, 0.04, 2);
    const edge = g.createLinearGradient(0, 0, 0, h);
    edge.addColorStop(0, 'rgba(60,35,10,0.35)');
    edge.addColorStop(0.04, 'rgba(60,35,10,0)');
    edge.addColorStop(0.96, 'rgba(60,35,10,0)');
    edge.addColorStop(1, 'rgba(60,35,10,0.4)');
    g.fillStyle = edge;
    g.fillRect(0, 0, w, h);
    const side = g.createLinearGradient(0, 0, w, 0);
    side.addColorStop(0, 'rgba(60,35,10,0.35)');
    side.addColorStop(0.03, 'rgba(60,35,10,0)');
    side.addColorStop(0.97, 'rgba(60,35,10,0)');
    side.addColorStop(1, 'rgba(60,35,10,0.35)');
    g.fillStyle = side;
    g.fillRect(0, 0, w, h);
  };
  const side = canvasTexture(512, 512, (g, w, h) => {
    base(g, w, h, 21);
    const r = rng(22);
    // verzendetiket
    g.fillStyle = '#f4f2ec';
    g.fillRect(300, 250, 170, 120);
    g.fillStyle = '#111';
    for (let x = 312; x < 458; ) {
      const bw = 1 + Math.floor(r() * 4);
      g.fillRect(x, 262, bw, 50);
      x += bw + 1 + Math.floor(r() * 3);
    }
    g.font = 'bold 15px Arial';
    g.fillText('SSCC 3871234', 312, 334);
    g.font = '12px Arial';
    g.fillText('NL-5627 · 12 KG', 312, 354);
    // opdruk
    g.strokeStyle = 'rgba(70,40,15,0.75)';
    g.fillStyle = 'rgba(70,40,15,0.75)';
    g.lineWidth = 5;
    for (const x of [50, 110]) {
      g.beginPath();
      g.moveTo(x, 180);
      g.lineTo(x, 100);
      g.moveTo(x - 20, 122);
      g.lineTo(x, 98);
      g.lineTo(x + 20, 122);
      g.stroke();
    }
    g.fillRect(28, 192, 106, 5);
    g.font = 'bold 30px Arial';
    g.fillText('HANDLE WITH CARE', 30, 440);
  });
  const top = canvasTexture(512, 512, (g, w, h) => {
    base(g, w, h, 23);
    g.fillStyle = 'rgba(40,25,10,0.5)';
    g.fillRect(0, h / 2 - 1, w, 2);
    g.fillStyle = 'rgba(214,190,150,0.72)';
    g.fillRect(0, h / 2 - 34, w, 68);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(0, h / 2 - 30, w, 8);
  });
  return { side, top };
}

export function wood() {
  return canvasTexture(
    512,
    512,
    (g, w, h) => {
      const r = rng(31);
      g.fillStyle = '#c4a071';
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 420; i++) {
        g.strokeStyle = `rgba(${r() < 0.6 ? '95,62,28' : '240,215,170'},${0.05 + r() * 0.12})`;
        g.lineWidth = 0.5 + r() * 2;
        const y = r() * h;
        g.beginPath();
        g.moveTo(0, y);
        g.bezierCurveTo(w * 0.3, y + (r() - 0.5) * 14, w * 0.6, y + (r() - 0.5) * 14, w, y + (r() - 0.5) * 8);
        g.stroke();
      }
      for (let i = 0; i < 7; i++) {
        const x = r() * w;
        const y = r() * h;
        const grad = g.createRadialGradient(x, y, 0, x, y, 8 + r() * 10);
        grad.addColorStop(0, 'rgba(60,35,15,0.8)');
        grad.addColorStop(1, 'rgba(60,35,15,0)');
        g.fillStyle = grad;
        g.fillRect(x - 20, y - 20, 40, 40);
      }
      blotches(g, w, h, r, 14, 'rgba(50,40,30,A)', 0.22);
    },
    { repeat: true },
  );
}

/** Sandwichpaneel: één tegel = één paneel breed, volledige wandhoogte. */
export function wallPanel() {
  return canvasTexture(
    256,
    1024,
    (g, w, h) => {
      const r = rng(41);
      g.fillStyle = '#d5d9da';
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 8; i++) {
        const x = (i / 8) * w;
        const grad = g.createLinearGradient(x, 0, x + w / 8, 0);
        grad.addColorStop(0, 'rgba(0,0,0,0.10)');
        grad.addColorStop(0.15, 'rgba(255,255,255,0.10)');
        grad.addColorStop(0.5, 'rgba(0,0,0,0)');
        grad.addColorStop(1, 'rgba(0,0,0,0.06)');
        g.fillStyle = grad;
        g.fillRect(x, 0, w / 8, h);
      }
      g.fillStyle = 'rgba(40,45,50,0.55)';
      g.fillRect(0, 0, 3, h);
      const dirt = g.createLinearGradient(0, h * 0.72, 0, h);
      dirt.addColorStop(0, 'rgba(90,85,75,0)');
      dirt.addColorStop(1, 'rgba(90,85,75,0.35)');
      g.fillStyle = dirt;
      g.fillRect(0, 0, w, h);
      speckle(g, w, h, r, 2500, 0.03, 3);
    },
    { repeat: true },
  );
}

/** Stalen dakplaat (trapeziumprofiel), van onderaf gezien. */
export function roofDeck() {
  return canvasTexture(
    256,
    256,
    (g, w, h) => {
      g.fillStyle = '#c9cdd0';
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 4; i++) {
        const x = (i / 4) * w;
        const grad = g.createLinearGradient(x, 0, x + w / 4, 0);
        grad.addColorStop(0, 'rgba(0,0,0,0.38)');
        grad.addColorStop(0.3, 'rgba(0,0,0,0.05)');
        grad.addColorStop(0.55, 'rgba(255,255,255,0.12)');
        grad.addColorStop(0.75, 'rgba(0,0,0,0.05)');
        grad.addColorStop(1, 'rgba(0,0,0,0.38)');
        g.fillStyle = grad;
        g.fillRect(x, 0, w / 4, h);
      }
    },
    { repeat: true },
  );
}

/** Geel-zwarte waarschuwingsstrepen. */
export function hazardStripes() {
  return canvasTexture(
    256,
    256,
    (g, w, h) => {
      g.fillStyle = '#f0c20a';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#17171a';
      for (let i = -2; i < 4; i++) {
        g.beginPath();
        g.moveTo(i * 128, h);
        g.lineTo(i * 128 + 64, h);
        g.lineTo(i * 128 + 64 + h, 0);
        g.lineTo(i * 128 + h, 0);
        g.fill();
      }
      speckle(g, w, h, rng(51), 1500, 0.05, 3);
    },
    { repeat: true },
  );
}

/** Alfamasker voor versleten vloerverf. */
export function wornPaintAlpha() {
  return canvasTexture(
    512,
    512,
    (g, w, h) => {
      const r = rng(61);
      g.fillStyle = '#e8e8e8';
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 1400; i++) {
        const v = Math.floor(r() * 150);
        g.fillStyle = `rgba(${v},${v},${v},${0.25 + r() * 0.5})`;
        g.fillRect(r() * w, r() * h, 2 + r() * 26, 1 + r() * 4);
      }
      blotches(g, w, h, r, 16, 'rgba(0,0,0,A)', 0.6);
    },
    { srgb: false, repeat: true },
  );
}

/** Draadroosterlegbord (alfa-uitgesneden). */
export function wireDeck() {
  return canvasTexture(
    256,
    256,
    (g, w, h) => {
      g.clearRect(0, 0, w, h);
      g.strokeStyle = '#b9bec2';
      g.lineWidth = 5;
      for (let i = 0; i <= 8; i++) {
        const p = (i / 8) * w;
        g.beginPath();
        g.moveTo(p, 0);
        g.lineTo(p, h);
        g.stroke();
      }
      g.lineWidth = 8;
      for (let i = 0; i <= 2; i++) {
        const p = (i / 2) * h;
        g.beginPath();
        g.moveTo(0, p);
        g.lineTo(w, p);
        g.stroke();
      }
    },
    { repeat: true },
  );
}

/** Tranenplaat voor de dockleveller. */
export function treadPlate() {
  return canvasTexture(
    256,
    256,
    (g, w, h) => {
      g.fillStyle = '#5b6066';
      g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(210,215,220,0.55)';
      g.lineWidth = 5;
      g.lineCap = 'round';
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const cx = x * 32 + 16;
          const cy = y * 32 + 16;
          const d = (x + y) % 2 ? 8 : -8;
          g.beginPath();
          g.moveTo(cx - 8, cy - d);
          g.lineTo(cx + 8, cy + d);
          g.stroke();
        }
      speckle(g, w, h, rng(71), 2000, 0.06, 3);
    },
    { repeat: true },
  );
}

function barcode(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, seed: number) {
  const r = rng(seed);
  g.fillStyle = '#000';
  for (let p = x; p < x + w; ) {
    const bw = 2 + Math.floor(r() * 5);
    g.fillRect(p, y, Math.min(bw, x + w - p), h);
    p += bw + 2 + Math.floor(r() * 4);
  }
}

/** Locatielabel voor op de stellingligger. */
export function locationLabel(id: string, arrow: 'up' | 'down') {
  return canvasTexture(512, 192, (g, w, h) => {
    g.fillStyle = '#f7f7f2';
    g.fillRect(0, 0, w, h);
    g.fillStyle = arrow === 'up' ? '#f2c200' : '#2e8bd8';
    g.fillRect(0, 0, 92, h);
    g.fillStyle = '#111';
    g.beginPath();
    if (arrow === 'up') {
      g.moveTo(46, 30);
      g.lineTo(80, 96);
      g.lineTo(58, 96);
      g.lineTo(58, 162);
      g.lineTo(34, 162);
      g.lineTo(34, 96);
      g.lineTo(12, 96);
    } else {
      g.moveTo(46, 162);
      g.lineTo(80, 96);
      g.lineTo(58, 96);
      g.lineTo(58, 30);
      g.lineTo(34, 30);
      g.lineTo(34, 96);
      g.lineTo(12, 96);
    }
    g.fill();
    g.font = 'bold 74px Arial';
    g.textBaseline = 'top';
    g.fillText(id, 110, 14);
    barcode(g, 110, 104, 380, 70, hashString(id));
  });
}

/** Bord met grote tekst (gangpad, dock, veiligheid). */
export function sign(text: string, bg: string, fg: string, sub?: string) {
  return canvasTexture(512, 256, (g, w, h) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = fg;
    g.lineWidth = 10;
    g.strokeRect(12, 12, w - 24, h - 24);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${sub ? 110 : 140}px Arial`;
    g.fillText(text, w / 2, sub ? 104 : h / 2 + 6, w - 50);
    if (sub) {
      g.font = 'bold 44px Arial';
      g.fillText(sub, w / 2, 198, w - 50);
    }
  });
}

/** Voetgangerssymbool voor het looppad. */
export function walkwayIcon() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#f1f1ec';
    g.beginPath();
    g.arc(128, 44, 22, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 26;
    g.lineCap = 'round';
    g.strokeStyle = '#f1f1ec';
    g.beginPath();
    g.moveTo(128, 84);
    g.lineTo(122, 150);
    g.lineTo(92, 226);
    g.moveTo(122, 150);
    g.lineTo(164, 226);
    g.moveTo(126, 96);
    g.lineTo(80, 136);
    g.moveTo(126, 96);
    g.lineTo(176, 130);
    g.stroke();
  });
}
