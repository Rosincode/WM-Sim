import { createAppFrame } from './wmsApp';

// De tablet van dichtbij: de echte WMS-app op het tabletscherm. Opent met F (tablet in de hand),
// sluit met Esc, het kruisje of een klik naast de tablet.

const css = `
.tab-backdrop { position: fixed; inset: 0; z-index: 50; display: none; align-items: center; justify-content: center;
  background: rgba(0,0,0,.5); font: 13px system-ui, sans-serif; color: #fff; }
.tab-backdrop.open { display: flex; }
.tab-device { display: flex; flex-direction: column; width: min(1040px, 96vw); height: min(680px, 88vh); padding: 14px;
  border-radius: 26px; background: #25272b; box-shadow: 0 20px 60px rgba(0,0,0,.6), inset 0 0 0 3px #111214; }
.tab-top { display: flex; align-items: center; gap: 10px; padding: 0 6px 8px; color: #9aa0a6; }
.tab-top span { flex: 1; }
.tab-top button { border: 0; border-radius: 4px; padding: 2px 9px; background: #c62828; color: #fff; font: inherit; cursor: pointer; }
.tab-screen { flex: 1; min-height: 0; border-radius: 6px; overflow: hidden; }
`;

export function createTabletApp() {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'tab-backdrop';
  backdrop.innerHTML = `
    <div class="tab-device">
      <div class="tab-top"><span>Tablet · WMS-app — Esc: wegleggen</span><button title="Sluiten (Esc)">✕</button></div>
      <div class="tab-screen"></div>
    </div>`;
  document.body.appendChild(backdrop);
  const app = createAppFrame();
  backdrop.querySelector('.tab-screen')!.appendChild(app.el);

  let open = false;
  function setOpen(value: boolean) {
    if (open === value) return;
    open = value;
    backdrop.classList.toggle('open', open);
    if (open) {
      document.exitPointerLock?.(); // muis vrij voor de app
      app.show();
    } else if (document.activeElement instanceof HTMLElement && backdrop.contains(document.activeElement)) {
      document.activeElement.blur(); // toetsen weer naar de game
    }
  }

  backdrop.querySelector('button')!.addEventListener('click', () => setOpen(false));
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) setOpen(false);
  });
  window.addEventListener('keydown', (e) => {
    if (open && e.code === 'Escape') setOpen(false);
  });

  return {
    get isOpen() {
      return open;
    },
    toggle: () => setOpen(!open),
    close: () => setOpen(false),
  };
}
