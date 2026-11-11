import type { WmsCredentials } from './types';

// Credentials staan alleen in de sessionStorage van de eigen browser:
// nooit in de repo, nooit in de build, weg zodra het tabblad sluit.
const KEY = 'wm-sim.wms-credentials';

export function loadCredentials(): WmsCredentials | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as WmsCredentials) : null;
  } catch {
    return null;
  }
}

export function saveCredentials(c: WmsCredentials) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    // Opslag geblokkeerd: verbinding werkt dan alleen tot de pagina herlaadt.
  }
}

export function clearCredentials() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // niets te doen
  }
}
