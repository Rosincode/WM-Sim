import { bus } from '../../shared/bus';
import type { SimEvent } from '../../shared/contract';
import { onProcessEvent } from '../../sim/events';
import { createLiveClient } from './live';
import { createMockClient } from './mock';
import { clearCredentials, loadCredentials, saveCredentials } from './session';
import type { WmsClient, WmsCredentials } from './types';

export type { WmsClient, WmsCredentials, WmsItem, WmsLocation } from './types';
export { WmsError } from './types';

// Zonder login (of met VITE_USE_MOCK en geen login) draait alles op de mock.
const saved = loadCredentials();
let client: WmsClient = saved ? createLiveClient(saved) : createMockClient();
let connectedUrl: string | null = saved?.baseUrl ?? null;

type Listener = () => void;
const changeListeners: Listener[] = [];
const errorListeners: ((msg: string) => void)[] = [];
const idleListeners: Listener[] = [];

// Boekingen gaan één voor één en in volgorde naar de WMS: een pallet moet eerst ontvangen zijn
// voordat het wegzetten ervan wordt geboekt.
let queue: Promise<void> = Promise.resolve();
let pending = 0;
let writes = 0;
let locationsStamp = 0;

function enqueue(label: string, call: (c: WmsClient) => Promise<unknown>) {
  const target = client; // boeking hoort bij de WMS waar hij ontstond, ook als er intussen wordt uitgelogd
  pending++;
  writes++;
  queue = queue
    .then(() => call(target))
    .then(
      () => undefined,
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[WMS] ${label} mislukt:`, msg);
        errorListeners.forEach((l) => l(`${label}: ${msg}`));
      },
    )
    .then(() => {
      if (--pending === 0) idleListeners.forEach((l) => l());
    });
}

export const wms = {
  get client() {
    return client;
  },
  get connectedUrl() {
    return connectedUrl;
  },
  /** Aantal boekingen dat nog onderweg is naar de WMS. */
  get pending() {
    return pending;
  },
  /** Teller van alle boekingen; verandert hij, dan is er sinds je vorige lezing iets geboekt. */
  get writes() {
    return writes;
  },
  /** Verandert als er locaties in de WMS zijn bijgekomen: lees ze dan opnieuw. */
  get locationsStamp() {
    return locationsStamp;
  },
  locationsChanged() {
    locationsStamp++;
    changeListeners.forEach((l) => l());
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
  /** Alle boekingen zijn verwerkt: de WMS is weer actueel om uit te lezen. */
  onIdle(l: Listener) {
    idleListeners.push(l);
  },
};

/** Koppelt sim-events aan WMS-acties. */
export function startWmsBridge() {
  bus.on(handle);

  // Wegzetten (ook verplaatsen met de heftruck): het contract-event mist aantal en van-locatie,
  // daarom luistert de bridge hiervoor naar het volledige proces-event van de sim.
  onProcessEvent((e) => {
    if (e.type !== 'PutawayDone') return;
    enqueue('PutawayDone', (c) =>
      c.confirmPutaway({ sku: e.sku, qty: e.qty, fromLocationId: e.fromLocationId, toLocationId: e.locationId }),
    );
  });
}

function handle(e: SimEvent) {
  switch (e.type) {
    case 'GoodsReceived':
      return enqueue(e.type, (c) => c.registerGoodsReceived({ sku: e.sku, qty: e.qty, dockId: e.dockId }));
    case 'OrderCreated':
      return enqueue(e.type, (c) => c.createOrder(e.order.lines, e.order.id));
    case 'PickCompleted':
      return enqueue(e.type, async (c) => {
        await c.startPicking(e.orderId);
        await c.confirmPick(e.orderId);
      });
    case 'PutawayDone':
      return; // zie startWmsBridge: geboekt via het proces-event
  }
}
