import { createAppFrame, getAppUrl } from './wmsApp';
import { mountWmsPanel } from './wmsPanel';

// Het scherm van de pc in het magazijn: de echte WMS-app (iframe) en de koppeling (aanmelden + orders).
// Opent met E bij de pc; sluit met Esc, E, het kruisje of door weg te lopen.

const css = `
.pc-backdrop { position: fixed; inset: 0; z-index: 50; display: none; align-items: center; justify-content: center;
  background: rgba(0,0,0,.5); font: 14px system-ui, sans-serif; color: #fff; }
.pc-backdrop.open { display: flex; }
.pc-monitor { width: min(1100px, 96vw); padding: 14px 14px 22px; border-radius: 14px; background: #15171a;
  box-shadow: 0 20px 60px rgba(0,0,0,.6); }
.pc-display { display: flex; flex-direction: column; height: min(680px, 84vh); border-radius: 4px; overflow: hidden;
  background: #10243a; }
.pc-bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #1b3a5c; }
.pc-bar b { margin-right: 8px; }
.pc-bar .clock { flex: 1; text-align: right; color: #9fb3c8; font-variant-numeric: tabular-nums; }
.pc-bar button { border: 0; border-radius: 4px; padding: 2px 9px; background: #c62828; color: #fff; font: inherit; cursor: pointer; }
.pc-bar button.tab { padding: 3px 12px; background: rgba(255,255,255,.12); }
.pc-bar button.tab.on { background: #3b6ea5; }
.pc-app { flex: 1; min-height: 0; }
.pc-body { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 14px; padding: 14px; min-height: 0; }
.pc-pane { padding: 12px 14px; border-radius: 8px; background: rgba(255,255,255,.06); overflow-y: auto; line-height: 1.45; }
.pc-pane h3 { margin: 0 0 8px; font-size: 13px; color: #9fb3c8; text-transform: uppercase; letter-spacing: .05em; }
.pc-pane .hint { color: #9aa0a6; font-size: 12px; margin-top: 8px; }
.pc-pane .action { width: 100%; margin-bottom: 10px; padding: 8px 10px; border: 0; border-radius: 4px; background: #3b6ea5;
  color: #fff; font: inherit; text-align: left; cursor: pointer; }
.pc-pane .action:disabled { background: #444; color: #9aa0a6; cursor: default; }
.pc-pane table { width: 100%; border-collapse: collapse; font-size: 13px; }
.pc-pane td { padding: 3px 4px; vertical-align: top; border-bottom: 1px solid rgba(255,255,255,.08); }
.pc-foot { padding: 6px 12px; color: #9fb3c8; font-size: 12px; background: rgba(0,0,0,.25); }
@media (max-width: 640px) { .pc-body { grid-template-columns: 1fr; overflow-y: auto; } }
`;

export type PcOrderRow = { id: string; status: string; lines: string };
export type PcOrderAction = { label: string; enabled: boolean };

interface Options {
  /** Wat er nu met orders kan op de pc (null = niets). */
  orderAction: () => PcOrderAction | null;
  runOrderAction: () => void;
  orders: () => PcOrderRow[];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function createPcScreen({ orderAction, runOrderAction, orders }: Options) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'pc-backdrop';
  backdrop.innerHTML = `
    <div class="pc-monitor">
      <div class="pc-display">
        <div class="pc-bar"><b>WMS-werkstation</b>
          <button class="tab" data-tab="app">WMS-app</button>
          <button class="tab" data-tab="link">Koppeling &amp; orders</button>
          <span class="clock"></span><button data-act="close" title="Sluiten (Esc)">✕</button></div>
        <div class="pc-app" data-view="app"></div>
        <div class="pc-body" data-view="link">
          <div class="pc-pane" data-pane="login">
            <h3>Aanmelden</h3>
            <div class="hint">Zonder aanmelden draait het magazijn op de mock-WMS.</div>
          </div>
          <div class="pc-pane"><h3>Orders</h3><div data-pane="orders"></div></div>
        </div>
        <div class="pc-foot">Esc of E: pc verlaten</div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const loginPane = backdrop.querySelector<HTMLElement>('[data-pane="login"]')!;
  const ordersPane = backdrop.querySelector<HTMLElement>('[data-pane="orders"]')!;
  const clock = backdrop.querySelector<HTMLElement>('.clock')!;
  mountWmsPanel(loginPane);
  loginPane.appendChild(loginPane.querySelector('.hint')!); // hint onder het inlogpaneel

  // Tabbladen: de echte WMS-app (iframe) of de koppeling + orders van de sim
  const app = createAppFrame();
  backdrop.querySelector('[data-view="app"]')!.appendChild(app.el);
  let tab: 'app' | 'link' = getAppUrl() ? 'app' : 'link';
  function setTab(t: typeof tab) {
    tab = t;
    backdrop.querySelectorAll<HTMLElement>('[data-view]').forEach((v) => (v.style.display = v.dataset.view === t ? '' : 'none'));
    backdrop.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    if (t === 'app' && open) app.show();
  }
  backdrop.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => setTab(b.dataset.tab as typeof tab)),
  );

  let open = false;
  let lastOrders = '';
  setTab(tab);

  function setOpen(value: boolean) {
    if (open === value) return;
    open = value;
    backdrop.classList.toggle('open', open);
    if (open) {
      document.exitPointerLock?.(); // muis vrij om te klikken en te typen
      lastOrders = '';
      if (tab === 'app') app.show();
      refresh();
    } else if (document.activeElement instanceof HTMLElement && backdrop.contains(document.activeElement)) {
      document.activeElement.blur(); // anders blijft de besturing denken dat je typt
    }
  }

  function refresh() {
    if (!open) return;
    clock.textContent = new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    const action = orderAction();
    const rows = orders();
    const html = `
      <button class="action" ${action?.enabled ? '' : 'disabled'}>${esc(action?.label ?? 'Geen orderactie: zet eerst weg wat je draagt')}</button>
      <table>${
        rows.map((o) => `<tr><td>${esc(o.id)}</td><td>${esc(o.status)}</td><td>${esc(o.lines)}</td></tr>`).join('') ||
        '<tr><td>Geen orders</td></tr>'
      }</table>`;
    if (html === lastOrders) return;
    lastOrders = html;
    ordersPane.innerHTML = html;
    ordersPane.querySelector<HTMLButtonElement>('.action')!.addEventListener('click', () => {
      runOrderAction();
      setOpen(false); // aan het werk
    });
  }

  backdrop.querySelector('[data-act="close"]')!.addEventListener('click', () => setOpen(false));
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
    /** Elke frame aanroepen: houdt orders en klok bij. */
    update: refresh,
  };
}
