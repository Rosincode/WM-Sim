import { WMS_ACTIONS, onProcessEvent, type ProcessEvent } from '../sim/events';
import { articleName } from '../sim/catalog';
import type { Warehouse } from '../sim/warehouse';
import { menu } from './menu';
import { skuColor } from './warehouseView';

// HUD voor het magazijnproces: de opdracht (linksonder). API-log en voorraad staan in het menu rechtsboven;
// welke toets je bij een object indrukt staat midden in beeld (src/ui/prompts.ts).

const css = `
.proc-task { position: fixed; left: 16px; bottom: 16px; width: min(380px, calc(100vw - 32px)); box-sizing: border-box;
  padding: 10px 14px; border-radius: 8px; background: rgba(0,0,0,.7); color: #fff;
  font: 13px system-ui, sans-serif; line-height: 1.45; pointer-events: none; }
.proc-task .goal { margin-bottom: 4px; font-size: 15px; font-weight: 600; color: #80deea; }
.proc-task .msg { font-size: 12px; color: #cfd8dc; }
.proc-task .msg.ok { color: #a5d6a7; }
.proc-task .msg.err { color: #ff8a80; }
.proc-side table { width: 100%; border-collapse: collapse; font-size: 12px; }
.proc-side td { padding: 2px 4px; vertical-align: top; border-bottom: 1px solid rgba(255,255,255,.08); }
.proc-side .t { color: #9aa0a6; white-space: nowrap; }
.proc-side .badge { padding: 0 5px; border-radius: 3px; font-size: 11px; white-space: nowrap; }
.proc-side .linked { background: #2e7d32; }
.proc-side .proposed { background: #6d4c41; }
.proc-side .error { background: #c62828; }
.proc-side .sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; }
.proc-side h4:first-child { margin-top: 0; }
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
  task.className = 'proc-task';
  document.body.appendChild(task);
  const logEl = document.createElement('div');
  logEl.className = 'proc-side';
  const stockEl = document.createElement('div');
  stockEl.className = 'proc-side';
  menu.addSection('log', 'API-log', logEl, 3);
  menu.addSection('stock', 'Voorraad & orders', stockEl, 4);

  // --- API-log ---
  const log: LogRow[] = [];
  let logDirty = true;
  const pushLog = (row: LogRow) => {
    log.unshift(row);
    if (log.length > 60) log.pop();
    logDirty = true;
  };
  // WMS = door de WMS verwerkt, geweigerd = de WMS zei nee, lokaal = nog geen endpoint (alleen in de game).
  onProcessEvent((e, result) => {
    pushLog({
      at: now(),
      title: `${e.type} → ${WMS_ACTIONS[e.type]}`,
      detail: result.ok ? describe(e) : `${describe(e)} — ${result.error ?? 'geweigerd'}`,
      badge: !result.ok ? 'geweigerd' : result.linked ? 'WMS' : 'lokaal',
      cls: !result.ok ? 'error' : result.linked ? 'linked' : 'proposed',
    });
  });

  function addError(msg: string) {
    pushLog({ at: now(), title: 'WMS-fout', detail: msg, badge: 'fout', cls: 'error' });
    menu.notify('log'); // het log zit in het menu: rode stip op de knop
  }

  function renderLog() {
    logEl.innerHTML = log.length
      ? `<table>${log
          .map(
            (r) => `<tr><td class="t">${r.at}</td><td><b>${esc(r.title)}</b><br>${esc(r.detail)}</td>
              <td><span class="badge ${r.cls}">${r.badge}</span></td></tr>`,
          )
          .join('')}</table>`
      : '<div class="t">Nog geen processtappen.</div>';
  }

  let lastStock = '';
  function renderStock() {
    const totals = new Map<string, number>();
    for (const s of sim.stockList()) totals.set(s.sku, (totals.get(s.sku) ?? 0) + s.qty);
    const stockRows = [...totals]
      .sort()
      .map(([sku, qty]) => `<tr><td><span class="sw" style="background:${skuColor(sku)}"></span>${esc(sku)}</td>
        <td>${esc(articleName(sku))}</td><td style="text-align:right">${qty}</td></tr>`)
      .join('');
    const orderRows = sim.orders
      .filter((o) => o.status !== 'shipped')
      .map((o) => `<tr><td>${o.id}</td><td>${o.status}</td><td>${o.lines.map((l) => `${l.qty}× ${l.sku}`).join(', ')}</td></tr>`)
      .join('');
    const html = `<h4>Voorraad (totaal per artikel)</h4><table>${stockRows || '<tr><td>Leeg</td></tr>'}</table>
      <h4>Orders</h4><table>${orderRows || '<tr><td>Geen orders</td></tr>'}</table>`;
    if (html === lastStock) return;
    lastStock = html;
    stockEl.innerHTML = html;
  }

  let lastTask = '';
  let stockRefresh = 0;

  function update(dt: number) {
    const obj = sim.objective();
    const c = sim.carry;
    const carrying =
      c?.kind === 'pallet'
        ? `Je draagt ${c.pallet.id} (${c.pallet.qty}× ${c.pallet.sku})`
        : c?.kind === 'order'
          ? `Je hebt de pallet van ${c.orderId}`
          : 'Handen vrij';
    const html = `
      <div class="goal">${esc(obj?.text ?? 'Wachten op werk…')}</div>
      <div class="msg">${esc(carrying)}</div>
      ${sim.messages.slice(-3).map((m) => `<div class="msg ${m.kind}">${esc(m.text)}</div>`).join('')}`;
    if (html !== lastTask) {
      task.innerHTML = html;
      lastTask = html;
    }

    // Alleen tekenen wat in beeld is
    if (menu.showing('stock') && (stockRefresh -= dt) <= 0) {
      stockRefresh = 0.5;
      renderStock();
    }
    if (logDirty && menu.showing('log')) {
      logDirty = false;
      renderLog();
    }
  }

  return { update, addError };
}
