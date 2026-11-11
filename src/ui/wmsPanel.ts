import { wms } from '../integrations/wms';

// Klein paneel rechtsboven: status van de WMS-koppeling + inlogformulier.

const css = `
.wms-panel { position: fixed; right: 16px; top: 16px; width: 280px; padding: 12px 14px; border-radius: 8px;
  background: rgba(0,0,0,.7); color: #fff; font: 14px system-ui, sans-serif; line-height: 1.4; }
.wms-panel b { display: block; margin-bottom: 4px; }
.wms-panel .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.wms-panel input { box-sizing: border-box; width: 100%; margin: 4px 0; padding: 6px 8px; border-radius: 4px;
  border: 1px solid #555; background: #222; color: #fff; font: inherit; }
.wms-panel button { margin-top: 6px; padding: 6px 10px; border: 0; border-radius: 4px; background: #3b6ea5;
  color: #fff; font: inherit; cursor: pointer; }
.wms-panel button.secondary { background: #444; }
.wms-panel button:disabled { opacity: .6; cursor: default; }
.wms-panel .msg { margin-top: 6px; font-size: 13px; word-break: break-word; }
.wms-panel .err { color: #ff8a80; }
.wms-panel .ok { color: #a5d6a7; }
.wms-panel .hint { color: #9aa0a6; font-size: 12px; }
`;

export function mountWmsPanel() {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.className = 'wms-panel';
  document.body.appendChild(panel);

  let showForm = false;
  let message = '';
  let messageClass = '';

  const setMessage = (text: string, cls: 'ok' | 'err' | '') => {
    message = text;
    messageClass = cls;
    render();
  };

  function render() {
    const live = wms.client.mode === 'live';
    const status = live
      ? `<span class="dot" style="background:#4caf50"></span>Verbonden met WMS<div class="hint">${escapeHtml(wms.connectedUrl ?? '')}</div>`
      : `<span class="dot" style="background:#f2b134"></span>Mock-modus (geen WMS)`;

    panel.innerHTML = `
      <b>WMS</b>
      <div>${status}</div>
      ${
        showForm
          ? `<form>
              <input name="baseUrl" type="url" placeholder="https://wms.example.com/api" required autocomplete="url">
              <input name="username" placeholder="Gebruikersnaam" required autocomplete="username">
              <input name="password" type="password" placeholder="Wachtwoord" required autocomplete="current-password">
              <button type="submit">Verbinden</button>
              <button type="button" class="secondary" data-act="cancel">Annuleren</button>
              <div class="hint">Alleen bewaard in dit tabblad (sessionStorage).</div>
            </form>`
          : live
            ? `<button data-act="test">Test verbinding</button> <button class="secondary" data-act="logout">Uitloggen</button>`
            : `<button data-act="login">Inloggen bij WMS</button>`
      }
      ${message ? `<div class="msg ${messageClass}">${escapeHtml(message)}</div>` : ''}
    `;

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
      setMessage('Uitgelogd, terug naar mock-modus.', '');
    });
    panel.querySelector('[data-act="test"]')?.addEventListener('click', async (e) => {
      (e.currentTarget as HTMLButtonElement).disabled = true;
      try {
        const [locs, stock, orders] = await Promise.all([
          wms.client.getLocations(),
          wms.client.getStock(),
          wms.client.getOpenOrders(),
        ]);
        setMessage(`OK: ${locs.length} locaties, ${stock.length} voorraadregels, ${orders.length} open orders.`, 'ok');
      } catch (err) {
        setMessage(err instanceof Error ? err.message : String(err), 'err');
      }
    });
    panel.querySelector('form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      form.querySelectorAll('button, input').forEach((el) => ((el as HTMLInputElement).disabled = true));
      try {
        const count = await wms.connect({
          baseUrl: String(data.get('baseUrl')),
          username: String(data.get('username')),
          password: String(data.get('password')),
        });
        showForm = false;
        setMessage(`Verbonden: ${count} locaties gevonden.`, 'ok');
      } catch (err) {
        showForm = true;
        setMessage(err instanceof Error ? err.message : String(err), 'err');
      }
    });
  }

  wms.onChange(render);
  wms.onError((msg) => setMessage(msg, 'err'));
  render();
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
