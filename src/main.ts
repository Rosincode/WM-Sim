import { Application } from 'pixi.js';

const app = new Application();
await app.init({ resizeTo: window, background: '#1e1e1e', antialias: true });
document.querySelector<HTMLDivElement>('#app')!.appendChild(app.canvas);
