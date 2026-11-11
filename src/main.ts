import { Application, Container, Graphics, Text } from 'pixi.js';

const app = new Application();
await app.init({ resizeTo: window, background: '#1e1e1e', antialias: true });
document.querySelector<HTMLDivElement>('#app')!.appendChild(app.canvas);

// Tijdelijke placeholder-scène: wordt vervangen door src/ui zodra die er is.
const scene = new Container();
app.stage.addChild(scene);

const title = new Text({ text: 'WM-Sim', style: { fill: '#ffffff', fontSize: 36, fontWeight: 'bold' } });
const subtitle = new Text({ text: 'Magazijnsimulatie — in aanbouw', style: { fill: '#9aa0a6', fontSize: 16 } });
subtitle.y = 46;
scene.addChild(title, subtitle);

const floor = new Graphics().roundRect(0, 90, 640, 360, 8).fill('#2a2d31').stroke({ width: 2, color: '#3c4043' });
scene.addChild(floor);

// Dock links
const dock = new Graphics().rect(20, 200, 60, 140).fill('#c58a2b');
const dockLabel = new Text({ text: 'DOCK', style: { fill: '#1e1e1e', fontSize: 12, fontWeight: 'bold' } });
dockLabel.anchor.set(0.5);
dockLabel.position.set(50, 270);
scene.addChild(dock, dockLabel);

// Stellingen
for (let col = 0; col < 4; col++) {
  for (let row = 0; row < 3; row++) {
    scene.addChild(new Graphics().rect(160 + col * 110, 120 + row * 110, 70, 50).fill('#3b6ea5'));
  }
}

// Heftruck die rondrijdt
const forklift = new Graphics().roundRect(-10, -7, 20, 14, 3).fill('#4caf50');
scene.addChild(forklift);
const path = [[80, 270], [130, 270], [130, 395], [580, 395], [580, 175], [130, 175], [130, 270]];
let seg = 0;
let t = 0;
app.ticker.add((ticker) => {
  const [x1, y1] = path[seg];
  const [x2, y2] = path[(seg + 1) % path.length];
  const len = Math.hypot(x2 - x1, y2 - y1);
  t += (ticker.deltaTime * 2.5) / len;
  if (t >= 1) { t = 0; seg = (seg + 1) % path.length; }
  forklift.position.set(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
  forklift.rotation = Math.atan2(y2 - y1, x2 - x1);
});

const center = () => scene.position.set(Math.max(16, (app.screen.width - 640) / 2), Math.max(16, (app.screen.height - 450) / 2));
center();
app.renderer.on('resize', center);
