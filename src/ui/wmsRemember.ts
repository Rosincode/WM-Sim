import type { WmsCredentials } from '../integrations/wms';

// "Onthouden op deze pc": de WMS-inloggegevens blijven versleuteld in deze browser staan (IndexedDB).
// De sleutel is een niet-exporteerbare AES-sleutel die de browser zelf bewaart: het wachtwoord staat
// nergens leesbaar, ook niet in DevTools of in een kopie van het profiel zonder die sleutel.
// Niets hiervan komt in de repo, de build of bij andere spelers terecht.

const DB = 'wm-sim';
const STORE = 'wms-remember';
const KEY_ID = 'key';
const DATA_ID = 'credentials';

type Sealed = { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** De bewaarde inloggegevens, of null als er niets (leesbaars) bewaard is. */
export async function loadRemembered(): Promise<WmsCredentials | null> {
  try {
    const key = await tx<CryptoKey | undefined>('readonly', (s) => s.get(KEY_ID));
    const sealed = await tx<Sealed | undefined>('readonly', (s) => s.get(DATA_ID));
    if (!key || !sealed) return null;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, key, sealed.data);
    return JSON.parse(new TextDecoder().decode(plain)) as WmsCredentials;
  } catch {
    return null;
  }
}

/** Bewaart de inloggegevens versleuteld in deze browser. Geeft false als de browser dat niet toelaat. */
export async function remember(c: WmsCredentials): Promise<boolean> {
  try {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(c)));
    await tx('readwrite', (s) => s.put(key, KEY_ID));
    await tx('readwrite', (s) => s.put({ iv, data } satisfies Sealed, DATA_ID));
    return true;
  } catch {
    return false;
  }
}

/** Wist de bewaarde inloggegevens en de sleutel. */
export async function forget(): Promise<void> {
  try {
    await tx('readwrite', (s) => s.clear());
  } catch {
    // niets te wissen
  }
}
