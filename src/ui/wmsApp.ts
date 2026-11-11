// De echte WMS-applicatie in een iframe, voor het scherm van de pc en van de tablet.
// Het adres is standaard DEFAULT_APP_URL (voor iedereen gelijk). Afwijken kan per browser via de adresbalk
// (bewaard in localStorage) of lokaal met VITE_WMS_APP_URL in .env.local. Alleen het adres, nooit inloggegevens.
// Let op: de app moet insluiten toestaan (CSP frame-ancestors) voor de origin van de game.

/** Startpagina van de WMS-app op de pc en de tablet (alleen bereikbaar binnen het tailnet). */
const DEFAULT_APP_URL = 'https://dev.tail24c580.ts.net/';

const KEY = 'wm-sim.wmsAppUrl';
const listeners: (() => void)[] = [];

export function getAppUrl(): string {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return saved;
  } catch {
    // geen opslag: val terug op de build-instelling
  }
  return (import.meta.env.VITE_WMS_APP_URL as string | undefined) || DEFAULT_APP_URL;
}

function setAppUrl(url: string) {
  try {
    localStorage.setItem(KEY, url);
  } catch {
    // geen opslag: het adres geldt dan alleen voor dit frame
  }
  listeners.forEach((l) => l());
}

/** Alleen http(s)-adressen; zonder schema wordt https aangenomen. Leeg = ongeldig. */
function normalize(input: string): string {
  const text = input.trim();
  if (!text) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

const css = `
.wms-app { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; background: #fff; color: #111;
  font: 13px system-ui, sans-serif; }
.wms-app form { display: flex; gap: 6px; align-items: center; padding: 5px 8px; background: #e3e8ef; }
.wms-app input { flex: 1; min-width: 0; padding: 4px 10px; border: 1px solid #b8c0cc; border-radius: 12px; background: #fff;
  color: #111; font: inherit; }
.wms-app button, .wms-app a { padding: 4px 10px; border: 0; border-radius: 4px; background: #3b6ea5; color: #fff;
  font: inherit; text-decoration: none; cursor: pointer; white-space: nowrap; }
.wms-app a { background: #5b6675; }
.wms-app iframe { flex: 1; width: 100%; min-height: 0; border: 0; background: #fff; }
.wms-app .empty { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center;
  color: #4d5866; line-height: 1.5; }
.wms-app .note { padding: 4px 10px; background: #fff8e1; color: #6d4c00; font-size: 12px; }
`;
let styled = false;

/** Adresbalk + iframe. De app laadt pas bij de eerste show(), zodat de game niet onnodig verbinding maakt. */
export function createAppFrame() {
  if (!styled) {
    styled = true;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  const el = document.createElement('div');
  el.className = 'wms-app';
  el.innerHTML = `
    <form>
      <input name="url" inputmode="url" placeholder="Adres van de WMS-app (https://…)" autocomplete="off" spellcheck="false">
      <button type="submit">Ga</button>
      <a target="_blank" rel="noopener noreferrer" title="Open in een nieuw tabblad">↗</a>
    </form>
    <div class="note">Blijft dit leeg of geweigerd? Dan staat de app insluiten niet toe (frame-ancestors). Open hem met ↗.</div>
    <div class="empty">Nog geen adres van de WMS-app.<br>Pak dit scherm erbij (pc: E, tablet: F) en vul het adres in.</div>`;
  const form = el.querySelector('form')!;
  const input = el.querySelector('input')!;
  const link = el.querySelector('a')!;
  const empty = el.querySelector<HTMLElement>('.empty')!;
  const note = el.querySelector<HTMLElement>('.note')!;

  let iframe: HTMLIFrameElement | null = null;
  let shown = false;
  let loaded = '';

  function load() {
    const url = getAppUrl();
    input.value = url;
    link.style.display = note.style.display = url ? '' : 'none';
    if (url) link.href = url;
    if (!shown || url === loaded) return;
    loaded = url;
    iframe?.remove();
    iframe = null;
    empty.style.display = url ? 'none' : '';
    if (!url) return;
    iframe = document.createElement('iframe');
    iframe.title = 'WMS-applicatie';
    iframe.referrerPolicy = 'no-referrer';
    iframe.src = url;
    el.appendChild(iframe);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = normalize(input.value);
    if (!url && input.value.trim()) {
      input.setCustomValidity('Geen geldig http(s)-adres');
      input.reportValidity();
      return;
    }
    loaded = ''; // ook hetzelfde adres opnieuw laden
    setAppUrl(url);
  });
  input.addEventListener('input', () => input.setCustomValidity(''));
  listeners.push(load);
  load();

  return {
    el,
    /** Aanroepen zodra het scherm zichtbaar wordt. */
    show() {
      shown = true;
      load();
    },
  };
}
