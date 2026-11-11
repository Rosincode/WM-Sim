import type * as THREE from 'three';
import type { Item, Order } from '../shared/contract';
import { wms, type WmsClient, type WmsItem, type WmsLocation } from '../integrations/wms';
import { articles, setArticles, setBlockedLocations } from '../sim/catalog';
import { LOCATIONS, POINTS, dist } from '../sim/layout';
import { createWarehouse, type SharedState, type Warehouse } from '../sim/warehouse';
import { menu } from './menu';
import { createPcScreen } from './pcScreen';
import { createProcessHud } from './processHud';
import { createWarehouseView } from './warehouseView';
import { createWmsGateway } from './wmsGateway';
import { compareLocations } from './wmsLocations';
import { wmsSync } from './wmsSync';
import { mountWmsPanel } from './wmsPanel';

// Koppelt de magazijn-sim aan de WMS (poort + stand ophalen), de 3D-scène, de HUD en het toetsenbord.
// Toetsen: E = scannen / actie (bij de pc: de WMS-app bedienen). In het menu rechtsboven: L = API-log,
// I = voorraad & orders, K = aanmelden bij de WMS-API.

/** Binnen deze afstand van de pc opent E de WMS-app; verder weglopen sluit hem. */
const PC_RADIUS = 2;
/** Hoe vaak de stand uit de WMS wordt opgehaald (ms). */
const POLL_MS = 3000;
/** Hoe vaak artikelen en locaties (stamgegevens) opnieuw worden opgehaald (ms). */
const MASTER_MS = 30000;

/** De laatste stand uit de WMS, voor het scherm van de handscanner. */
export type WmsData = { mode: 'live' | 'mock'; locations: WmsLocation[]; items: WmsItem[]; stock: Item[]; orders: Order[] };

export function mountWarehouse({
  scene,
  camera,
  player,
  rackStock = true,
  perPallet,
}: {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  player: THREE.Object3D;
  /** false: de hal tekent de stellingvoorraad zelf (src/ui/scene/warehouse). */
  rackStock?: boolean;
  /** Stuks op een volle pallet van een artikel. */
  perPallet?: (sku: string) => number;
}) {
  // Elke speler heeft zijn eigen mock-WMS. Zodra de wereld (mede) van een andere speler komt, loopt die mock
  // niet meer gelijk en slaan we hem over; de echte WMS is voor iedereen dezelfde en blijft altijd leidend.
  const mockOutOfStep = () => wms.client.mode === 'mock' && sim.foreign;
  const sim: Warehouse = createWarehouse({
    gateway: createWmsGateway({ bypass: mockOutOfStep }),
    demoOrders: () => wms.client.mode === 'mock', // met een echte WMS komen orders uit de WMS-app
    perPallet,
  });
  const view = createWarehouseView(scene, player, sim, { rackStock });
  const hud = createProcessHud(sim);
  // Aanmelden bij de WMS-API zit in het menu rechtsboven (K).
  const wmsSection = document.createElement('div');
  menu.addSection('wms', 'WMS-API', wmsSection, 2);
  mountWmsPanel(wmsSection);
  wms.onError(() => menu.notify('wms'));
  /** Wat E hier doet, voor de toetsprompt in beeld; null als er niets te doen is. */
  let action: { label: string; enabled: boolean } | null = null;

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
    if (e.code === 'KeyL') menu.toggle('log');
    if (e.code === 'KeyI') menu.toggle('stock');
    if (e.code === 'KeyK') menu.toggle('wms');
  });

  // ---------- WMS is leidend: de stand ophalen ----------
  const dataListeners: ((d: WmsData) => void)[] = [];
  let lastData = '';
  let locations: WmsLocation[] = [];
  let items: WmsItem[] = [];
  let masterOf: WmsClient | null = null;
  let masterAt = -Infinity;
  let locationsStamp = -1;
  /** De client waarvan de hele wereld is overgenomen; bij een andere client (in- of uitloggen) gebeurt dat opnieuw. */
  let loadedFrom: WmsClient | null = null;
  let polling = false;
  let lastPollAt = -Infinity;
  let lastError = '';
  let lastWarning = '';
  let seenRevision = sim.revision;
  let worldRefresh = 0;
  const hallIds = new Set(LOCATIONS.map((l) => l.id)); // stellingen en in-/uitslaglocaties: wat de hal kan tonen

  /** Geeft de stand door aan de scanner en het WMS-paneel, alleen als er iets is veranderd. */
  function emit(data: WmsData, fromWms: boolean) {
    const json = JSON.stringify([fromWms, data]);
    if (json === lastData) return;
    lastData = json;
    dataListeners.forEach((l) => l(data));
    const cmp = compareLocations(data.locations);
    const known = new Set(data.items.map((i) => i.sku));
    wmsSync.set({
      mode: data.mode,
      fromWms,
      at: new Date(),
      items: data.items.length,
      locations: { hall: cmp.hall, missing: cmp.missing.length, extra: cmp.extra, different: cmp.different, blocked: cmp.blocked.length },
      stock: {
        lines: data.stock.length,
        hidden: data.stock.filter((s) => !hallIds.has(s.locationId)).length,
        unknownSkus: [...new Set(data.stock.map((s) => s.sku).filter((sku) => !known.has(sku)))],
      },
      orders: data.orders.length,
    });
  }

  /**
   * Speelt deze speler op de mock terwijl de wereld (mede) van anderen komt, dan zegt zijn eigen mock niets:
   * de scanner toont dan de wereld die alle spelers delen, zodat iedereen dezelfde voorraad ziet.
   */
  function emitWorld() {
    emit(
      {
        mode: 'mock',
        locations,
        items: articles().map((a) => ({ sku: a.sku, description: a.name, category: a.category })),
        stock: sim.worldStock().sort((x, y) => (x.locationId + x.sku).localeCompare(y.locationId + y.sku)),
        orders: sim.orders
          .filter((o) => o.status === 'open' || o.status === 'picking')
          .map((o) => ({ id: o.id, status: o.status as Order['status'], lines: o.lines.map((l) => ({ sku: l.sku, qty: l.qty })) })),
      },
      false,
    );
  }

  async function poll() {
    if (polling) return;
    polling = true;
    lastPollAt = performance.now();
    const client = wms.client;
    const revision = sim.revision;
    try {
      // Stamgegevens: artikelen en locaties. Bij een andere WMS, nieuwe locaties en verder af en toe.
      if (masterOf !== client || locationsStamp !== wms.locationsStamp || lastPollAt - masterAt > MASTER_MS) {
        locationsStamp = wms.locationsStamp;
        const [locs, its] = await Promise.all([client.getLocations(), client.getItems()]);
        if (client !== wms.client) return; // intussen in- of uitgelogd
        locations = locs;
        items = its;
        masterOf = client;
        masterAt = lastPollAt;
        const cmp = compareLocations(locations);
        setBlockedLocations(cmp.blocked);
        // De WMS weigert elke scan en boeking op een locatie die hij niet kent: meld dat meteen.
        const warning =
          cmp.missing.length > 0
            ? `De WMS mist ${cmp.missing.length} locatie${cmp.missing.length === 1 ? '' : 's'} van de hal (bijvoorbeeld ${cmp.missing[0].id}). ` +
              'Druk op K om ze toe te voegen.'
            : items.length === 0
              ? 'De WMS heeft geen artikelen: er komen geen vrachtwagens met goederen.'
              : '';
        if (warning && warning !== lastWarning) hud.addError(warning);
        lastWarning = warning;
      }
      const [stock, orders] = await Promise.all([client.getStock(), client.getOpenOrders()]);
      if (client !== wms.client) return; // intussen in- of uitgelogd
      lastError = '';

      if (mockOutOfStep()) emitWorld();
      else {
        // De WMS bepaalt welke artikelen er zijn en hoe ze heten.
        setArticles(items.map((i) => ({ sku: i.sku, name: i.description, category: i.category })));
        emit({ mode: client.mode, locations, items, stock, orders }, true);
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
    /** Orders zoals de sim ze kent (alleen lezen), voor de printer. */
    orders: () => sim.orders,
    /** Id van de order die deze speler onderhanden heeft, anders null. */
    carriedOrder: () => (sim.carry?.kind === 'order' ? sim.carry.orderId : null),
    /** De pallets in de stellingen, voor de hal. */
    pallets: () => sim.pallets(),
    /** Draagt de speler iets (pallet of orderbak)? Voor de houding van de figuur. */
    carrying: () => !!sim.carry,
    /** Wat de toets E op deze plek doet (enabled: false = kan nu niet), of null als hier niets te doen is. */
    action: () => action,
    /** Wat de speler draagt, voor andere spelers: '' (niets), 'order' of het artikel van de pallet. */
    carryLabel: () => (sim.carry?.kind === 'pallet' ? sim.carry.pallet.sku : sim.carry ? 'order' : ''),
    /** De handscanner las een locatielabel of palletsticker: de sim legt de scan voor aan de WMS. null = alleen kijken. */
    scan: (code: string) => sim.scan(code, pos()),
    /** De stand uit de WMS, telkens als die verandert (voor het scherm van de handscanner). */
    onWmsData(l: (d: WmsData) => void) {
      dataListeners.push(l);
    },
    /** Multiplayer: de gedeelde wereld lezen, overnemen en bepalen wie hem laat draaien. */
    shared: {
      state: () => sim.sharedState(),
      apply(s: SharedState) {
        sim.applyShared(s);
        // Zonder eigen WMS gelden de artikelen van de wereld die je deelt (die van de WMS van de host).
        if (wms.client.mode === 'mock' && s.articles?.length) setArticles(s.articles);
      },
      setAuthority: sim.setAuthority,
    },
    /** Voor de heftruck en de pompwagen: hele pallets uit en in de stellingen. */
    forkliftTake: sim.forkliftTake,
    forkliftPlace: sim.forkliftPlace,
    update(dt: number) {
      sim.update(dt);
      view.update(dt);

      const near = nearPc();
      if (pc.isOpen && !near) pc.close();
      pc.update(dt);
      hud.update(dt);
      const it = near ? null : sim.interactionAt(pos());
      action = near
        ? { label: pc.isOpen ? 'Pc verlaten' : 'Pc gebruiken: WMS openen', enabled: true }
        : it && { label: it.label, enabled: !!it.enabled };

      // Direct na een handeling de stand opnieuw ophalen, verder op een vast ritme.
      if (mockOutOfStep() && (worldRefresh -= dt) <= 0) {
        worldRefresh = 0.5;
        emitWorld();
      }
      const settled = sim.pending === 0 && sim.revision !== seenRevision;
      if (settled) seenRevision = sim.revision;
      if (settled || performance.now() - lastPollAt > POLL_MS) void poll();
    },
  };
}
