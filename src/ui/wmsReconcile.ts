import { wms, type WmsClient } from '../integrations/wms';
import { location } from '../sim/layout';

// Legt de pallets in de stellingen van de hal naast die in de WMS, en werkt de WMS bij naar de hal.
// De hal is de fysieke wereld: staat een pallet daar ergens anders dan de WMS denkt, dan heeft de WMS het mis.
// Het tegenovergestelde van 'Hal resetten' (src/ui/warehouse.ts), dat de hal gelijkzet met de WMS.
// Via de API kan alleen een verplaatsing worden rechtgezet (pallet_move). Een ander aantal, of een pallet die
// maar aan één kant bestaat, kan de game alleen laten zien: dat moet in de WMS-app (docs/wms/13).

export type HallPallet = { id: string; sku: string; qty: number; locationId: string };
type WmsPallet = Awaited<ReturnType<WmsClient['getPallets']>>[number];

export type PalletMove = { palletId: string; sku: string; qty: number; fromLocationId: string; toLocationId: string };

export type StockDiff = {
  /** Pallets in de stellingen van de hal die zijn vergeleken. */
  compared: number;
  /** De WMS heeft de pallet op een andere locatie dan waar hij in de hal staat. */
  moves: PalletMove[];
  /** Zelfde pallet, ander aantal of ander artikel. */
  quantities: { palletId: string; locationId: string; hall: string; wms: string }[];
  /** In een stelling van de hal, in de WMS geen actieve pallet met dit nummer. */
  onlyHall: HallPallet[];
  /** In de WMS in een stelling, in de hal nergens te vinden. */
  onlyWms: WmsPallet[];
};

const isShelf = (id: string) => {
  const l = location(id);
  return !!l && l.type !== 'dock';
};

/**
 * @param racked de pallets in de stellingen van de hal
 * @param busy pallets die onderweg zijn (op een baan, in een wagen, op een robot of op de vorken): die slaan we over
 */
export function compareStock(racked: HallPallet[], busy: Set<string>, inWms: WmsPallet[]): StockDiff {
  const wmsById = new Map(inWms.map((p) => [p.id, p]));
  const hallIds = new Set(racked.map((p) => p.id));
  const diff: StockDiff = { compared: racked.length, moves: [], quantities: [], onlyHall: [], onlyWms: [] };
  for (const h of racked) {
    const w = wmsById.get(h.id);
    if (!w) {
      diff.onlyHall.push(h);
      continue;
    }
    if (w.locationId !== h.locationId) {
      diff.moves.push({ palletId: h.id, sku: h.sku, qty: h.qty, fromLocationId: w.locationId, toLocationId: h.locationId });
    }
    if (w.sku !== h.sku || w.qty !== h.qty) {
      diff.quantities.push({ palletId: h.id, locationId: h.locationId, hall: `${h.qty}× ${h.sku}`, wms: `${w.qty}× ${w.sku}` });
    }
  }
  // Wat de WMS op een dock heeft staan is nog onderweg in het inslagproces en hoort niet in deze vergelijking
  for (const w of inWms) if (!hallIds.has(w.id) && !busy.has(w.id) && isShelf(w.locationId)) diff.onlyWms.push(w);
  return diff;
}

/**
 * Verplaatst de pallets in de WMS naar waar ze in de hal staan. Een geweigerde verplaatsing krijgt een tweede
 * kans: de plek kan vol zijn geweest tot een andere pallet uit deze lijst er weg was.
 */
export async function alignWms(client: WmsClient, moves: PalletMove[], onProgress: (done: number, total: number) => void) {
  let todo = moves;
  let moved = 0;
  let errors: string[] = [];
  for (let pass = 0; pass < 2 && todo.length; pass++) {
    const failed: PalletMove[] = [];
    errors = [];
    for (const m of todo) {
      try {
        await client.confirmPutaway(m);
        moved++;
      } catch (err) {
        failed.push(m);
        errors.push(`${m.palletId} naar ${m.toLocationId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      onProgress(moved, moves.length);
    }
    if (failed.length === todo.length) break; // niets gelukt: nog een ronde helpt niet
    todo = failed;
  }
  return { moved, errors };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Het blok in het WMS-paneel (K): de verschillen tussen de hal en de WMS, en de knop om de WMS bij te werken.
 * Alleen met een echte WMS; de mock volgt de hal vanzelf.
 */
export function mountWmsReconcile(
  parent: HTMLElement,
  o: {
    /** De pallets in de stellingen van de hal, en wat er onderweg is. */
    hall: () => { racked: HallPallet[]; busy: Set<string> };
    /** true: er loopt geen boeking naar de WMS. Alleen dan zegt de vergelijking iets. */
    settled: () => boolean;
  },
) {
  const box = document.createElement('div');
  box.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px solid #3a4047;font-size:13px';
  parent.appendChild(box);

  let diff: StockDiff | null = null;
  let checkedAt: Date | null = null;
  let checking = false;
  let busy = '';
  let note = '';
  let error = '';

  async function check() {
    const client = wms.client;
    if (client.mode !== 'live' || checking || busy) return;
    if (!o.settled()) return; // er is nog een boeking onderweg: de volgende keer
    checking = true;
    try {
      const inWms = await client.getPallets();
      if (client !== wms.client || !o.settled()) return; // uitgelogd, of intussen is er iets geboekt
      const { racked, busy: moving } = o.hall();
      diff = compareStock(racked, moving, inWms);
      checkedAt = new Date();
      error = '';
    } catch (err) {
      error = `Pallets ophalen uit de WMS mislukt: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      checking = false;
      render();
    }
  }

  async function align() {
    const client = wms.client;
    if (!diff?.moves.length || busy) return;
    const moves = diff.moves;
    busy = `0 / ${moves.length}`;
    note = '';
    render();
    const result = await alignWms(client, moves, (done, total) => {
      busy = `${done} / ${total}`;
      render();
    });
    busy = '';
    note = `${count(result.moved, 'pallet', 'pallets')} verplaatst in de WMS.${
      result.errors.length ? ` Geweigerd: ${result.errors.slice(0, 3).join(' · ')}${result.errors.length > 3 ? ' · …' : ''}` : ''
    }`;
    await check();
    render();
  }

  function render() {
    if (wms.client.mode !== 'live') {
      box.style.display = 'none';
      return;
    }
    box.style.display = '';
    const sample = (list: string[]) => `${escapeHtml(list.slice(0, 3).join(' · '))}${list.length > 3 ? ' · …' : ''}`;
    const lines: string[] = [];
    if (diff) {
      const { moves, quantities, onlyHall, onlyWms } = diff;
      if (moves.length) {
        lines.push(
          `${count(moves.length, 'pallet staat', 'pallets staan')} in de WMS op een andere locatie (${sample(
            moves.map((m) => `${m.palletId}: hal ${m.toLocationId}, WMS ${m.fromLocationId}`),
          )}).`,
        );
      }
      if (quantities.length) {
        lines.push(
          `${count(quantities.length, 'pallet heeft', 'pallets hebben')} in de WMS een andere inhoud (${sample(
            quantities.map((q) => `${q.palletId}: hal ${q.hall}, WMS ${q.wms}`),
          )}).`,
        );
      }
      if (onlyHall.length) {
        lines.push(
          `${count(onlyHall.length, 'pallet', 'pallets')} in de hal kent de WMS niet (${sample(onlyHall.map((p) => `${p.id} op ${p.locationId}`))}).`,
        );
      }
      if (onlyWms.length) {
        lines.push(
          `${count(onlyWms.length, 'pallet', 'pallets')} uit de WMS staat nergens in de hal (${sample(onlyWms.map((p) => `${p.id} op ${p.locationId}`))}).`,
        );
      }
    }
    const time = checkedAt?.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const manual = diff && diff.quantities.length + diff.onlyHall.length + diff.onlyWms.length > 0;
    box.innerHTML = `<b style="display:block;margin-bottom:4px">Pallets: hal naast WMS</b>
      ${
        !diff
          ? '<div style="color:#9aa0a6">Nog niet vergeleken.</div>'
          : lines.length
            ? lines.map((l) => `<div style="color:#ffcc80">${l}</div>`).join('')
            : `<div style="color:#a5d6a7">Alle ${diff.compared} pallets in de stellingen staan in de WMS op dezelfde plek met dezelfde inhoud.</div>`
      }
      ${
        diff?.moves.length
          ? `<button data-act="align" ${busy ? 'disabled' : ''} style="margin-top:6px;padding:6px 10px;border:0;border-radius:5px;background:#3b6ea5;color:#fff;font:inherit;cursor:pointer">${
              busy ? `Bezig… ${busy}` : `WMS bijwerken naar de hal (${count(diff.moves.length, 'pallet', 'pallets')})`
            }</button>`
          : ''
      }
      <button data-act="check" ${checking || busy ? 'disabled' : ''} style="margin-top:6px;padding:6px 10px;border:0;border-radius:5px;background:#444;color:#fff;font:inherit;cursor:pointer">Opnieuw vergelijken</button>
      ${manual ? '<div style="margin-top:6px;color:#9aa0a6">Een ander aantal, of een pallet die maar aan één kant bestaat, kan de game niet rechtzetten: dat moet in de WMS-app.</div>' : ''}
      ${note ? `<div style="margin-top:6px">${escapeHtml(note)}</div>` : ''}
      ${error ? `<div style="margin-top:6px;color:#ff8a80">${escapeHtml(error)}</div>` : ''}
      <div style="margin-top:6px;color:#9aa0a6">${time ? `Vergeleken om ${time}. ` : ''}Pallets die onderweg zijn (dock, wagen, robot, vorken) tellen niet mee.</div>`;
    box.querySelector('[data-act="align"]')?.addEventListener('click', () => void align());
    box.querySelector('[data-act="check"]')?.addEventListener('click', () => void check());
  }

  wms.onChange(() => {
    diff = null;
    checkedAt = null;
    note = error = '';
    render();
  });
  render();

  return {
    /** Vergelijkt opnieuw (één aanroep naar de WMS); doet niets op de mock of zolang er een boeking onderweg is. */
    check,
    /** Het aantal verschillen van de laatste vergelijking, of null als er nog niet is vergeleken. */
    get differences() {
      return diff && diff.moves.length + diff.quantities.length + diff.onlyHall.length + diff.onlyWms.length;
    },
  };
}
