import type * as THREE from 'three';
import type { Item, Location, Order } from '../shared/contract';
import { wms, type WmsClient } from '../integrations/wms';
import { POINTS, dist } from '../sim/layout';
import { createWarehouse, type SharedState, type Warehouse } from '../sim/warehouse';
import { createPcScreen } from './pcScreen';
import { createProcessHud } from './processHud';
import { createWarehouseView } from './warehouseView';
import { createWmsGateway } from './wmsGateway';
import { mountWmsPanel } from './wmsPanel';

// Koppelt de magazijn-sim aan de WMS (poort + stand ophalen), de 3D-scène, de HUD en het toetsenbord.
// Toetsen: E = scannen / actie (bij de pc: de WMS-app bedienen), L = API-log, I = voorraad & orders,
// K = aanmelden bij de WMS-API.

/** Binnen deze afstand van de pc opent E de WMS-app; verder weglopen sluit hem. */
const PC_RADIUS = 2;
/** Hoe vaak de stand uit de WMS wordt opgehaald (ms). */
const POLL_MS = 3000;

/** De laatste stand uit de WMS, voor het scherm van de handscanner. */
export type WmsData = { mode: 'live' | 'mock'; locations: Location[]; stock: Item[]; orders: Order[] };

export function mountWarehouse({
  scene,
  camera,
  player,
  rackStock = true,
}: {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  player: THREE.Object3D;
  /** false: de hal tekent de stellingvoorraad zelf (src/ui/scene/warehouse). */
  rackStock?: boolean;
}) {
  // Elke speler heeft zijn eigen mock-WMS. Zodra de wereld (mede) van een andere speler komt, loopt die mock
  // niet meer gelijk en slaan we hem over; de echte WMS is voor iedereen dezelfde en blijft altijd leidend.
  const mockOutOfStep = () => wms.client.mode === 'mock' && sim.foreign;
  const sim: Warehouse = createWarehouse({
    gateway: createWmsGateway({ bypass: mockOutOfStep }),
    demoOrders: () => wms.client.mode === 'mock', // met een echte WMS komen orders uit de WMS-app
  });
  const view = createWarehouseView(scene, player, sim, { rackStock });
  const hud = createProcessHud(sim);
  mountWmsPanel();

  const pos = () => ({ x: player.position.x, z: player.position.z });
  const nearPc = () => dist(pos(), POINTS.terminal) <= PC_RADIUS;

  // De pc toont alleen de echte WMS-app: al zichtbaar op de monitor als je langsloopt, met E te bedienen.
  const pc = createPcScreen({ camera, display: view.pcDisplay, world: scene });

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.repeat || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    if (e.code === 'KeyE') {
      if (pc.isOpen) pc.close();
      else if (nearPc()) pc.open();
      else sim.interact(pos());
    }
    if (e.code === 'KeyL') hud.setTab('log');
    if (e.code === 'KeyI') hud.setTab('stock');
  });

  // ---------- WMS is leidend: de stand ophalen ----------
  const dataListeners: ((d: WmsData) => void)[] = [];
  let lastData = '';
  let locations: Location[] = [];
  let locationsOf: WmsClient | null = null;
  /** De client waarvan de hele wereld is overgenomen; bij een andere client (in- of uitloggen) gebeurt dat opnieuw. */
  let loadedFrom: WmsClient | null = null;
  let polling = false;
  let lastPollAt = -Infinity;
  let lastError = '';
  let seenRevision = sim.revision;

  async function poll() {
    if (polling) return;
    polling = true;
    lastPollAt = performance.now();
    const client = wms.client;
    const revision = sim.revision;
    try {
      if (locationsOf !== client) {
        locations = await client.getLocations();
        locationsOf = client;
      }
      const [stock, orders] = await Promise.all([client.getStock(), client.getOpenOrders()]);
      if (client !== wms.client) return; // intussen in- of uitgelogd
      lastError = '';

      const data: WmsData = { mode: client.mode, locations, stock, orders };
      const json = JSON.stringify([data.mode, locations.length, stock, orders]);
      if (json !== lastData) {
        lastData = json;
        dataListeners.forEach((l) => l(data));
      }

      if (loadedFrom !== client) {
        // Multiplayer: wie bij een lopend spel aanschuift neemt die wereld over en laadt bij de start niet opnieuw.
        const joined = loadedFrom === null && sim.foreign;
        loadedFrom = client;
        if (!joined) sim.loadSnapshot(stock, orders, client.mode === 'live' ? 'de WMS' : 'de mock-WMS');
      } else if (sim.authority && !mockOutOfStep() && sim.pending === 0 && sim.revision === revision) {
        // Alleen de host haalt de stand binnen (de rest krijgt hem via de gedeelde wereld), en alleen als
        // er sinds het ophalen niets is gebeurd: anders zou een oude stand een verse handeling terugdraaien.
        sim.syncFromWms(stock, orders);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== lastError) hud.addError(`Stand ophalen uit de WMS mislukt: ${msg}`);
      lastError = msg;
    } finally {
      polling = false;
    }
  }
  wms.onChange(() => void poll());
  void poll();

  return {
    stockList: () => sim.stockList(),
    /** Draagt de speler iets (pallet of orderbak)? Voor de houding van de figuur. */
    carrying: () => !!sim.carry,
    /** Wat de speler draagt, voor andere spelers: '' (niets), 'order' of het artikel van de pallet. */
    carryLabel: () => (sim.carry?.kind === 'pallet' ? sim.carry.pallet.sku : sim.carry ? 'order' : ''),
    /** De handscanner las een locatielabel: de sim legt de scan voor aan de WMS. null = alleen kijken. */
    scan: (code: string) => sim.scan(code, pos()),
    /** De stand uit de WMS, telkens als die verandert (voor het scherm van de handscanner). */
    onWmsData(l: (d: WmsData) => void) {
      dataListeners.push(l);
    },
    /** Multiplayer: de gedeelde wereld lezen, overnemen en bepalen wie hem laat draaien. */
    shared: {
      state: () => sim.sharedState(),
      apply: (s: SharedState) => sim.applyShared(s),
      setAuthority: sim.setAuthority,
    },
    /** Voor de heftruck: hele pallets van en naar stellinglocaties. */
    forkliftTake: sim.forkliftTake,
    forkliftPlace: sim.forkliftPlace,
    update(dt: number) {
      sim.update(dt);
      view.update(dt);

      const near = nearPc();
      if (pc.isOpen && !near) pc.close();
      pc.update(dt);
      hud.update(dt, pos(), near ? (pc.isOpen ? 'Pc verlaten' : 'Pc gebruiken: WMS openen') : undefined);

      // Direct na een handeling de stand opnieuw ophalen, verder op een vast ritme.
      const settled = sim.pending === 0 && sim.revision !== seenRevision;
      if (settled) seenRevision = sim.revision;
      if (settled || performance.now() - lastPollAt > POLL_MS) void poll();
    },
  };
}
