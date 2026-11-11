import { wms } from '../integrations/wms';
import { addMissingLocations, hallLocations, locationsCsv, missingLocations, type HallLocation } from './wmsLocations';
import { forget, loadRemembered, remember } from './wmsRemember';
import { wmsSync } from './wmsSync';

// Aanmelden bij de WMS-API: de koppeling waarmee de scanner en het magazijn hun handelingen aan de WMS
// voorleggen. Los van de WMS-app op pc en tablet (die heeft zijn eigen login in het iframe).
// Staat in het menu rechtsboven (K); zonder parent zweeft het ingeklapt in beeld.

const css = `
.wms-panel { position: fixed; right: 16px; top: 84px; width: 280px; padding: 12px 14px; border-radius: 8px; z-index: 40;
  background: rgba(0,0,0,.7); color: #fff; font: 14px system-ui, sans-serif; line-height: 1.4; }
.wms-panel.embedded { position: static; width: auto; padding: 0; background: none; }
.wms-panel.collapsed { width: auto; padding: 6px 12px; font-size: 13px; cursor: pointer; user-select: none; }
.wms-panel b { display: block; margin-bottom: 4px; }
.wms-panel .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.wms-panel input { box-sizing: border-box; width: 100%; margin: 4px 0; padding: 6px 8px; border-radius: 4px;
  border: 1px solid #555; background: #222; color: #fff; font: inherit; }
.wms-panel label.check { display: flex; align-items: center; gap: 6px; margin: 4px 0; font-size: 13px; cursor: pointer; }
.wms-panel label.check input { width: auto; margin: 0; }
.wms-panel button { margin-top: 6px; padding: 6px 10px; border: 0; border-radius: 4px; background: #3b6ea5;
  color: #fff; font: inherit; cursor: pointer; }
.wms-panel button.secondary { background: #444; }
.wms-panel button:disabled { opacity: .6; cursor: default; }
.wms-panel .msg { margin-top: 6px; font-size: 13px; word-break: break-word; }
.wms-panel .err { color: #ff8a80; }
.wms-panel .ok { color: #a5d6a7; }
.wms-panel .hint { color: #9aa0a6; font-size: 12px; }
.wms-panel .sync { margin-top: 8px; padding-top: 6px; border-top: 1px solid #444; font-size: 13px; }
.wms-panel .sync .warn { color: #ffcc80; }
`;

/** Zonder parent zweeft het paneel (ingeklapt) rechtsboven; met parent staat het uitgeklapt in dat element. */
export function mountWmsPanel(parent?: HTMLElement) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  (parent ?? document.body).appendChild(panel);

  let collapsed = !parent;
  let showForm = false;
  let message = '';
  let messageClass = '';
  /** Locaties van de hal die de WMS niet kent; null = nog niet gecontroleerd. */
  let missing: HallLocation[] | null = null;
  let checkedStamp = -1;
  let adding = '';

  async function checkLocations() {
    const client = wms.client;
    checkedStamp = wms.locationsStamp;
    try {
      const found = missingLocations(await client.getLocations());
      if (client !== wms.client) return;
      missing = found;
    } catch {
      missing = null; // de fout van het ophalen staat al in het API-log
    }
    render();
  }

  const setMessage = (text: string, cls: 'ok' | 'err' | '') => {
    message = text;
    messageClass = cls;
    render();
  };

  function setCollapsed(on: boolean) {
    collapsed = on;
    if (!on) document.exitPointerLock?.(); // muis vrij om te klikken en te typen
    else if (document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)) document.activeElement.blur();
    render();
  }

  /** Regel over de locaties: kloppen de hal en de WMS, en zo niet, wat ontbreekt er. */
  function locationsHtml() {
    if (missing === null) return '';
    const total = hallLocations().length;
    if (missing.length === 0) return `<div class="msg ok">Alle ${total} locaties van de hal staan in de WMS.</div>`;
    const sample = missing.slice(0, 3).map((l) => l.id).join(', ');
    return `<div class="msg err">De WMS mist ${missing.length} van de ${total} locaties van de hal (${escapeHtml(sample)}${missing.length > 3 ? ', …' : ''}). Daar weigert hij scans en boekingen.</div>
      <button data-act="add-locations" ${adding ? 'disabled' : ''}>${adding ? `Toevoegen… ${adding}` : 'Toevoegen aan de WMS'}</button>
      <button class="secondary" data-act="csv-locations">Lijst (CSV)</button>`;
  }

  /** Wat de game uit de WMS heeft overgenomen, en waar de hal en de WMS niet op elkaar passen. */
  function syncHtml() {
    const r = wmsSync.report;
    if (!r) return '';
    const sample = (ids: string[]) => `${escapeHtml(ids.slice(0, 3).join(', '))}${ids.length > 3 ? ', …' : ''}`;
    const source = !r.fromWms ? 'de gedeelde wereld van de spelers' : r.mode === 'live' ? 'de WMS' : 'de mock-WMS';
    const time = r.at.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const warn: string[] = [];
    if (r.locations.extra.length) warn.push(`${r.locations.extra.length} locaties staan in de WMS maar niet in de hal (${sample(r.locations.extra)}).`);
    if (r.locations.different.length) warn.push(`${r.locations.different.length} locaties hebben in de WMS een ander type, niveau of positie (${sample(r.locations.different)}).`);
    if (r.stock.hidden) warn.push(`${r.stock.hidden} voorraadregels liggen op een plek die de hal niet toont.`);
    if (r.stock.unknownSkus.length) warn.push(`Voorraad van onbekende artikelen: ${sample(r.stock.unknownSkus)}.`);
    return `<div class="sync"><b>Gelijk met ${source}</b>
      <div>${r.items} artikelen · ${r.stock.lines} voorraadregels · ${r.orders} open orders</div>
      <div>${r.locations.hall - r.locations.missing} van ${r.locations.hall} locaties${r.locations.blocked ? ` · ${r.locations.blocked} geblokkeerd` : ''}</div>
      ${warn.map((w) => `<div class="warn">${w}</div>`).join('')}
      <div class="hint">Laatste wijziging ${time}. Voorraad en orders elke 3 s, artikelen en locaties elke 30 s.</div></div>`;
  }

  function render() {
    const live = wms.client.mode === 'live';
    if (!collapsed && checkedStamp !== wms.locationsStamp) void checkLocations();
    const dot = `<span class="dot" style="background:${live ? '#4caf50' : '#f2b134'}"></span>`;
    panel.className = `wms-panel${parent ? ' embedded' : ''}${collapsed ? ' collapsed' : ''}`;
    if (collapsed) {
      panel.title = 'Aanmelden bij de WMS-API (K)';
      panel.innerHTML = `${dot}WMS-API: ${live ? 'verbonden' : 'mock-modus'} <span class="hint">· K</span>`;
      return;
    }
    panel.title = '';
    const status = live
      ? `${dot}Verbonden met WMS<div class="hint">${escapeHtml(wms.connectedUrl ?? '')}</div>`
      : `${dot}Mock-modus (geen WMS)`;

    panel.innerHTML = `
      <b>WMS-API</b>
      <div>${status}</div>
      ${
        showForm
          ? `<form>
              <input name="baseUrl" type="url" placeholder="https://wms.example.com/t/wm_sim/api" required autocomplete="url">
              <input name="apiKey" type="password" placeholder="API-sleutel (amk_...)" required autocomplete="off">
              <label class="check"><input name="remember" type="checkbox"> Onthouden op deze pc</label>
              <button type="submit">Verbinden</button>
              <button type="button" class="secondary" data-act="cancel">Annuleren</button>
              <div class="hint">Zonder vinkje: alleen in dit tabblad. Met vinkje: versleuteld in deze browser, tot je uitlogt. Niet doen op een gedeelde pc.</div>
            </form>`
          : live
            ? `<button data-act="test">Test verbinding</button> <button class="secondary" data-act="logout">Uitloggen</button>`
            : `<button data-act="login">Inloggen bij WMS</button>`
      }
      ${locationsHtml()}
      ${syncHtml()}
      ${parent ? '' : '<button class="secondary" data-act="collapse">Sluiten</button>'}
      ${message ? `<div class="msg ${messageClass}">${escapeHtml(message)}</div>` : ''}
      <div class="hint">De scanner en het magazijn leggen elke handeling via deze API voor aan de WMS. Zonder aanmelden draait alles op de mock-WMS.</div>
    `;

    panel.querySelector('[data-act="add-locations"]')?.addEventListener('click', async () => {
      if (!missing?.length || adding) return;
      const list = missing;
      adding = `0 / ${list.length}`;
      render();
      const { added, existing, error } = await addMissingLocations(list, (done, total) => {
        adding = `${done} / ${total}`;
        render();
      });
      adding = '';
      await checkLocations();
      const already = existing
        ? ` ${existing} stonden er al en zijn overgeslagen: de WMS gaf ze niet terug in de lijst met locaties (waarschijnlijk geeft de API maar een deel van de lijst).`
        : '';
      if (error) setMessage(`${added} locaties toegevoegd.${already} Daarna weigerde de WMS: ${error}`, 'err');
      else setMessage(`${added} locaties toegevoegd aan de WMS.${already}`, 'ok');
    });
    panel.querySelector('[data-act="csv-locations"]')?.addEventListener('click', () => {
      if (!missing?.length) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([locationsCsv(missing)], { type: 'text/csv' }));
      a.download = 'ontbrekende-locaties.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    });
    panel.querySelector('[data-act="collapse"]')?.addEventListener('click', (e) => {
      e.stopPropagation(); // anders klapt de klik op het paneel hem meteen weer open
      setCollapsed(true);
    });
    panel.querySelector('[data-act="login"]')?.addEventListener('click', () => {
      showForm = true;
      message = '';
      render();
      panel.querySelector<HTMLInputElement>('input[name="baseUrl"]')?.focus();
    });
    panel.querySelector('[data-act="cancel"]')?.addEventListener('click', () => {
      showForm = false;
      setMessage('', '');
    });
    panel.querySelector('[data-act="logout"]')?.addEventListener('click', () => {
      wms.disconnect();
      void forget();
      setMessage('Uitgelogd, terug naar mock-modus.', '');
    });
    panel.querySelector('[data-act="test"]')?.addEventListener('click', async (e) => {
      (e.currentTarget as HTMLButtonElement).disabled = true;
      try {
        const [locs, items, stock, orders] = await Promise.all([
          wms.client.getLocations(),
          wms.client.getItems(),
          wms.client.getStock(),
          wms.client.getOpenOrders(),
        ]);
        setMessage(`OK: ${locs.length} locaties, ${items.length} artikelen, ${stock.length} voorraadregels, ${orders.length} open orders.`, 'ok');
      } catch (err) {
        setMessage(err instanceof Error ? err.message : String(err), 'err');
      }
    });
    panel.querySelector('form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      form.querySelectorAll('button, input').forEach((el) => ((el as HTMLInputElement).disabled = true));
      const credentials = {
        baseUrl: String(data.get('baseUrl')),
        apiKey: String(data.get('apiKey')).trim(),
      };
      try {
        const count = await wms.connect(credentials);
        showForm = false;
        let note = '';
        if (data.get('remember')) {
          note = (await remember(credentials)) ? ' Onthouden op deze pc.' : ' Onthouden lukte niet in deze browser.';
        } else {
          void forget();
        }
        setMessage(`Verbonden: ${count} locaties gevonden.${note}`, 'ok');
      } catch (err) {
        showForm = true;
        setMessage(err instanceof Error ? err.message : String(err), 'err');
      }
    });
  }

  if (!parent) {
    panel.addEventListener('click', () => {
      if (collapsed) setCollapsed(false);
    });
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      if (e.repeat || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      if (e.code === 'KeyK') setCollapsed(!collapsed);
    });
  }

  wms.onChange(() => {
    missing = null;
    checkedStamp = -1; // andere WMS of nieuwe locaties: opnieuw controleren
    render();
  });
  wms.onError((msg) => setMessage(msg, 'err'));
  wmsSync.onChange(() => {
    // Niet opnieuw tekenen terwijl iemand het inlogformulier invult.
    if (!collapsed && !showForm) render();
  });
  render();

  // Onthouden inloggegevens: bij het starten vanzelf weer verbinden.
  if (wms.client.mode !== 'live') {
    void loadRemembered().then(async (c) => {
      if (!c || wms.client.mode === 'live') return;
      try {
        await wms.connect(c);
      } catch (err) {
        setMessage(`Automatisch verbinden mislukt: ${err instanceof Error ? err.message : String(err)}`, 'err');
      }
    });
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
