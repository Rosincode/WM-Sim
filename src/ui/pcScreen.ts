import { createAppFrame } from './wmsApp';

// Het scherm van de pc in het magazijn: alleen de echte WMS-app (iframe).
// Opent met E bij de pc; sluit met Esc, E, het kruisje of door weg te lopen.

const css = `
.pc-backdrop { position: fixed; inset: 0; z-index: 50; display: none; align-items: center; justify-content: center;
  background: rgba(0,0,0,.5); font: 14px system-ui, sans-serif; color: #fff; }
.pc-backdrop.open { display: flex; }
.pc-monitor { width: min(1100px, 96vw); padding: 14px 14px 22px; border-radius: 14px; background: #15171a;
  box-shadow: 0 20px 60px rgba(0,0,0,.6); }
.pc-display { display: flex; flex-direction: column; height: min(680px, 84vh); border-radius: 4px; overflow: hidden;
  background: #fff; }
.pc-bar { display: flex; align-items: center; gap: 10px; padding: 4px 10px; background: #25272b; color: #cfd3d6; font-size: 13px; }
.pc-bar span { flex: 1; }
.pc-bar button { border: 0; border-radius: 4px; padding: 2px 9px; background: #c62828; color: #fff; font: inherit; cursor: pointer; }
.pc-app { flex: 1; min-height: 0; }
`;

export function createPcScreen() {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'pc-backdrop';
  backdrop.innerHTML = `
    <div class="pc-monitor">
      <div class="pc-display">
        <div class="pc-bar"><span>Pc · WMS — Esc: verlaten</span><button title="Sluiten (Esc)">✕</button></div>
        <div class="pc-app"></div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const app = createAppFrame();
  backdrop.querySelector('.pc-app')!.appendChild(app.el);

  let open = false;
  function setOpen(value: boolean) {
    if (open === value) return;
    open = value;
    backdrop.classList.toggle('open', open);
    if (open) {
      document.exitPointerLock?.(); // muis vrij om te klikken en te typen
      app.show();
    } else if (document.activeElement instanceof HTMLElement && backdrop.contains(document.activeElement)) {
      document.activeElement.blur(); // anders blijft de besturing denken dat je typt
    }
  }

  backdrop.querySelector('button')!.addEventListener('click', () => setOpen(false));
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) setOpen(false); // klik naast de monitor
  });
  window.addEventListener('keydown', (e) => {
    if (open && e.code === 'Escape') setOpen(false);
  });

  return {
    get isOpen() {
      return open;
    },
    open: () => setOpen(true),
    close: () => setOpen(false),
  };
}
