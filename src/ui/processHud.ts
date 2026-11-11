import { WMS_ACTIONS, onProcessEvent, type ProcessEvent } from '../sim/events';
import { SKU_NAMES } from '../sim/layout';
import type { Warehouse } from '../sim/warehouse';
import { SKU_COLORS } from './warehouseView';

// HUD voor het magazijnproces: opdracht + actie (linksonder) en API-log / voorraad (rechtsonder).

const css = `
.proc { position: fixed; padding: 10px 14px; border-radius: 8px; background: rgba(0,0,0,.7); color: #fff;
  font: 13px system-ui, sans-serif; line-height: 1.45; }
.proc-task { left: 16px; bottom: 16px; width: 380px; pointer-events: none; }
.proc-task .goal { font-size: 15px; font-weight: 600; color: #80deea; }
.proc-task .act { margin: 6px 0; padding: 6px 8px; border-radius: 6px; background: rgba(255,255,255,.08); }
.proc-task .act.off { color: #9aa0a6; }
.proc-task kbd { display: inline-block; min-width: 18px; padding: 0 5px; margin-right: 6px; border-radius: 4px;
  background: #fff; color: #000; font: bold 12px system-ui; text-align: center; }
.proc-task .msg { font-size: 12px; color: #cfd8dc; }
.proc-task .msg.ok { color: #a5d6a7; }
.proc-task .msg.err { color: #ff8a80; }
.proc-side { right: 16px; bottom: 16px; width: 420px; max-height: 45vh; display: flex; flex-direction: column; }
.proc-side .tabs { display: flex; gap: 6px; margin-bottom: 6px; }
.proc-side .tabs button { padding: 3px 10px; border: 0; border-radius: 4px; background: #444; color: #fff; font: inherit; cursor: pointer; }
.proc-side .tabs button.on { background: #3b6ea5; }
.proc-side .body { overflow-y: auto; }
.proc-side table { width: 100%; border-collapse: collapse; font-size: 12px; }
.proc-side td { padding: 2px 4px; vertical-align: top; border-bottom: 1px solid rgba(255,255,255,.08); }
.proc-side .t { color: #9aa0a6; white-space: nowrap; }
.proc-side .badge { padding: 0 5px; border-radius: 3px; font-size: 11px; white-space: nowrap; }
.proc-side .linked { background: #2e7d32; }
.proc-side .proposed { background: #6d4c41; }
.proc-side .error { background: #c62828; }
.proc-side .sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; }
.proc-side h4 { margin: 8px 0 2px; font-size: 12px; color: #9aa0a6; text-transform: uppercase; letter-spacing: .04em; }
`;

type LogRow = { at: string; title: string; detail: string; badge: string; cls: 'linked' | 'proposed' | 'error' };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const now = () => new Date().toLocaleTimeString('nl-NL');

function describe(e: ProcessEvent): string {
  const { type: _type, ...rest } = e;
  if (e.type === 'OrderCreated') return `${e.order.id}: ${e.order.lines.map((l) => `${l.qty}× ${l.sku}`).join(', ')}`;
  return Object.entries(rest)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(',')}]` : v}`)
    .join(' ');
}

export function createProcessHud(sim: Warehouse) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const task = document.createElement('div');
  task.className = 'proc proc-task';
  const side = document.createElement('div');
  side.className = 'proc proc-side';
  document.body.append(task, side);

  // --- API-log ---
  const log: LogRow[] = [];
  const pushLog = (row: LogRow) => {
    log.unshift(row);
    if (log.length > 60) log.pop();
    dirty = true;
  };
  onProcessEvent((e) => {
    const map = WMS_ACTIONS[e.type];
    pushLog({
      at: now(),
      title: `${e.type} → ${map.action}`,
      detail: describe(e),
      badge: map.linked ? 'WMS' : 'voorstel',
      cls: map.linked ? 'linked' : 'proposed',
    });
  });

  let tab: 'log' | 'stock' = 'log';
  let dirty = true;

  function addError(msg: string) {
    pushLog({ at: now(), title: 'WMS-fout', detail: msg, badge: 'fout', cls: 'error' });
  }

  function renderSide() {
    const tabs = `<div class="tabs">
      <button data-tab="log" class="${tab === 'log' ? 'on' : ''}">API-log (L)</button>
      <button data-tab="stock" class="${tab === 'stock' ? 'on' : ''}">Voorraad &amp; orders (I)</button>
    </div>`;
    let body = '';
    if (tab === 'log') {
      body = log.length
        ? `<table>${log
            .map(
              (r) => `<tr><td class="t">${r.at}</td><td><b>${esc(r.title)}</b><br>${esc(r.detail)}</td>
                <td><span class="badge ${r.cls}">${r.badge}</span></td></tr>`,
            )
            .join('')}</table>`
        : '<div class="t">Nog geen processtappen.</div>';
    } else {
      const totals = new Map<string, number>();
      for (const s of sim.stockList()) totals.set(s.sku, (totals.get(s.sku) ?? 0) + s.qty);
      const stockRows = [...totals]
        .sort()
        .map(([sku, qty]) => `<tr><td><span class="sw" style="background:${SKU_COLORS[sku] ?? '#888'}"></span>${sku}</td>
          <td>${esc(SKU_NAMES[sku] ?? '')}</td><td style="text-align:right">${qty}</td></tr>`)
        .join('');
      const orderRows = sim.orders
        .filter((o) => o.status !== 'shipped')
        .map((o) => `<tr><td>${o.id}</td><td>${o.status}</td><td>${o.lines.map((l) => `${l.qty}× ${l.sku}`).join(', ')}</td></tr>`)
        .join('');
      body = `<h4>Voorraad (totaal per artikel)</h4><table>${stockRows || '<tr><td>Leeg</td></tr>'}</table>
        <h4>Orders</h4><table>${orderRows || '<tr><td>Geen orders</td></tr>'}</table>`;
    }
    const scroll = side.querySelector('.body')?.scrollTop ?? 0;
    side.innerHTML = tabs + `<div class="body">${body}</div>`;
    side.querySelector('.body')!.scrollTop = scroll;
    side.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => setTab(b.dataset.tab as typeof tab)),
    );
  }

  function setTab(t: typeof tab) {
    tab = t;
    dirty = true;
  }

  let lastTask = '';
  let stockRefresh = 0;

  function update(dt: number, pos: { x: number; z: number }) {
    const obj = sim.objective();
    const it = sim.interactionAt(pos);
    const c = sim.carry;
    const carrying =
      c?.kind === 'pallet'
        ? `Je draagt ${c.pallet.id} (${c.pallet.qty}× ${c.pallet.sku})`
        : c?.kind === 'order'
          ? `Je hebt rolcontainer ${c.orderId}`
          : 'Handen vrij';
    const html = `
      <div class="goal">${esc(obj?.text ?? 'Wachten op werk…')}</div>
      <div class="act ${it?.enabled ? '' : 'off'}"><kbd>E</kbd>${esc(it?.label ?? 'Loop naar een vrachtwagen, baan, terminal of stelling')}</div>
      <div class="msg">${esc(carrying)}</div>
      ${sim.messages.slice(-3).map((m) => `<div class="msg ${m.kind}">${esc(m.text)}</div>`).join('')}`;
    if (html !== lastTask) {
      task.innerHTML = html;
      lastTask = html;
    }

    if (tab === 'stock' && (stockRefresh -= dt) <= 0) {
      stockRefresh = 0.5;
      dirty = true;
    }
    if (dirty) {
      dirty = false;
      renderSide();
    }
  }

  return { update, setTab, addError };
}
