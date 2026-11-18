import { wms, WmsError, type WmsItem } from '../integrations/wms';
import { drawRobot } from './scene/robotArt';

// Het blok in het WMS-paneel (K) dat de artikelen in de WMS een afbeelding geeft: de tekening van de robot die
// ook op de postertjes aan de stellingen hangt. Zo toont de WMS-app hetzelfde plaatje als de hal.
// Alleen met een echte WMS; de mock kent geen afbeeldingen.

/** Zijde (px) van de afbeelding die naar de WMS gaat. */
const SIZE = 512;
/** Zo lang wachten we per artikel op de WMS. */
const UPLOAD_TIMEOUT_MS = 60_000;

/** De tekening van een artikel als png. */
export function articleImage(sku: string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  drawRobot(canvas.getContext('2d')!, sku, 0, 0, SIZE);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('De tekening kon niet als png worden opgeslagen.'))), 'image/png'),
  );
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function mountWmsImages(parent: HTMLElement) {
  const box = document.createElement('div');
  box.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px solid #3a4047;font-size:13px';
  parent.appendChild(box);

  let items: WmsItem[] | null = null;
  let busy = '';
  let note = '';
  let error = '';

  async function check() {
    const client = wms.client;
    if (client.mode !== 'live') return;
    try {
      const list = await client.getItems();
      if (client !== wms.client) return;
      items = list;
      error = '';
    } catch (err) {
      error = `Artikelen ophalen uit de WMS mislukt: ${err instanceof Error ? err.message : String(err)}`;
    }
    render();
  }

  /** @param all ook de artikelen die al een afbeelding hebben: die wordt vervangen */
  async function upload(all: boolean) {
    const client = wms.client;
    if (!items || busy || !client.uploadItemImage) return;
    const todo = items.filter((i) => all || !i.hasImage);
    if (!todo.length) return;
    let done = 0;
    const failed: string[] = [];
    busy = `0 / ${todo.length}`;
    note = error = '';
    render();
    for (const item of todo) {
      try {
        const data = await articleImage(item.sku);
        // De upload wacht achter de andere boekingen van de hal, en die wachten bij 'te veel aanroepen' (429) op
        // de WMS. Duurt het te lang, dan stoppen in plaats van eindeloos 'Bezig…' te tonen.
        let timer = 0;
        const slow = new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error('slow')), UPLOAD_TIMEOUT_MS);
        });
        try {
          await Promise.race([client.uploadItemImage({ sku: item.sku, fileName: `${item.sku}.png`, data }), slow]);
        } finally {
          clearTimeout(timer);
        }
        done++;
      } catch (err) {
        if (err instanceof Error && err.message === 'slow') {
          failed.push(
            `geen antwoord van de WMS binnen ${UPLOAD_TIMEOUT_MS / 1000} s: de WMS krijgt te veel aanroepen ` +
              '(hooguit 120 per minuut) of de hal heeft nog veel boekingen in de rij. Probeer het zo opnieuw.',
          );
          break;
        }
        // Komt de upload niet eens bij de WMS aan terwijl het ophalen wel lukt, dan weigert de browser hem:
        // de WMS staat de header X-File-Name niet toe in CORS (docs/wms/16, 2.1).
        if (err instanceof WmsError && err.status === undefined) {
          failed.push(
            'de browser houdt de upload tegen: de WMS moet de header X-File-Name toestaan in CORS ' +
              '(Access-Control-Allow-Headers, zie docs/wms/16)',
          );
          break;
        }
        failed.push(`${item.sku}: ${err instanceof Error ? err.message : String(err)}`);
        // Is de WMS niet bereikbaar of mag het niet, dan geldt dat ook voor de rest
        if (failed.length >= 2 && done === 0) break;
      }
      busy = `${done + failed.length} / ${todo.length}`;
      render();
    }
    busy = '';
    note = `${count(done, 'afbeelding', 'afbeeldingen')} naar de WMS gestuurd.`;
    if (failed.length) error = `Mislukt: ${failed.slice(0, 3).join(' · ')}${failed.length > 3 ? ' · …' : ''}`;
    await check();
  }

  function render() {
    const client = wms.client;
    if (client.mode !== 'live' || !client.uploadItemImage) {
      box.style.display = 'none';
      return;
    }
    box.style.display = '';
    const missing = items?.filter((i) => !i.hasImage).length ?? 0;
    const button = (act: string, text: string, color: string) =>
      `<button data-act="${act}" ${busy ? 'disabled' : ''} style="margin-top:6px;padding:6px 10px;border:0;border-radius:5px;background:${color};color:#fff;font:inherit;cursor:pointer">${text}</button>`;
    box.innerHTML = `<b style="display:block;margin-bottom:4px">Afbeeldingen van de artikelen</b>
      ${
        !items
          ? '<div style="color:#9aa0a6">Nog niet gecontroleerd.</div>'
          : missing
            ? `<div style="color:#ffcc80">${count(missing, 'artikel heeft', 'artikelen hebben')} in de WMS nog geen afbeelding (van de ${items.length}).</div>`
            : `<div style="color:#a5d6a7">Alle ${items.length} artikelen hebben in de WMS een afbeelding.</div>`
      }
      ${busy ? `<div style="margin-top:6px">Bezig… ${busy}</div>` : ''}
      ${items && missing ? button('missing', `Tekening uploaden voor ${count(missing, 'artikel', 'artikelen')}`, '#3b6ea5') : ''}
      ${items?.length ? button('all', 'Alle afbeeldingen vervangen door de tekening', '#444') : ''}
      ${note ? `<div style="margin-top:6px">${escapeHtml(note)}</div>` : ''}
      ${error ? `<div style="margin-top:6px;color:#ff8a80">${escapeHtml(error)}</div>` : ''}
      <div style="margin-top:6px;color:#9aa0a6">De tekening is de robot van het postertje aan de stelling (png, ${SIZE} × ${SIZE}).</div>`;
    box.querySelector('[data-act="missing"]')?.addEventListener('click', () => void upload(false));
    box.querySelector('[data-act="all"]')?.addEventListener('click', () => void upload(true));
  }

  wms.onChange(() => {
    items = null;
    note = error = '';
    render();
    void check();
  });
  render();
  void check();
}
