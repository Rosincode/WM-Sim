import { bus } from '../../shared/bus';
import type { SimEvent } from '../../shared/contract';
import { createLiveClient } from './live';
import { createMockClient } from './mock';
import { clearCredentials, loadCredentials, saveCredentials } from './session';
import type { WmsClient, WmsCredentials } from './types';

export type { WmsClient, WmsCredentials } from './types';
export { WmsError } from './types';

// Zonder login (of met VITE_USE_MOCK en geen login) draait alles op de mock.
const saved = loadCredentials();
let client: WmsClient = saved ? createLiveClient(saved) : createMockClient();
let connectedUrl: string | null = saved?.baseUrl ?? null;

type Listener = () => void;
const changeListeners: Listener[] = [];
const errorListeners: ((msg: string) => void)[] = [];

export const wms = {
  get client() {
    return client;
  },
  get connectedUrl() {
    return connectedUrl;
  },
  /** Test de verbinding; bij succes worden de gegevens voor deze browsersessie bewaard. */
  async connect(c: WmsCredentials) {
    const live = createLiveClient(c);
    const locations = await live.getLocations();
    saveCredentials(c);
    client = live;
    connectedUrl = c.baseUrl;
    changeListeners.forEach((l) => l());
    return locations.length;
  },
  disconnect() {
    clearCredentials();
    client = createMockClient();
    connectedUrl = null;
    changeListeners.forEach((l) => l());
  },
  onChange(l: Listener) {
    changeListeners.push(l);
  },
  onError(l: (msg: string) => void) {
    errorListeners.push(l);
  },
};

/** Koppelt sim-events aan WMS-acties. */
export function startWmsBridge() {
  bus.on((e) => {
    handle(e).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[WMS] ${e.type} mislukt:`, msg);
      errorListeners.forEach((l) => l(`${e.type}: ${msg}`));
    });
  });
}

async function handle(e: SimEvent) {
  switch (e.type) {
    case 'GoodsReceived':
      return client.registerGoodsReceived({ sku: e.sku, qty: e.qty, dockId: e.dockId });
    case 'OrderCreated':
      await client.createOrder(e.order.lines, e.order.id);
      return;
    case 'PickCompleted':
      await client.startPicking(e.orderId);
      return client.confirmPick(e.orderId);
    case 'PutawayDone':
      // Event mist qty en van-locatie; zie voorstel contract-wijziging.
      console.warn('[WMS] PutawayDone nog niet gekoppeld: event mist qty en fromLocationId.');
      return;
  }
}
