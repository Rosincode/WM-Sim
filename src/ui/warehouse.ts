import type * as THREE from 'three';
import type { Item, Order } from '../shared/contract';
import { wms, type WmsClient, type WmsItem, type WmsLocation } from '../integrations/wms';
import { articles, setArticles, setBlockedLocations } from '../sim/catalog';
import { LOCATIONS, POINTS, dist } from '../sim/layout';
import { createWarehouse, type Delivery, type SharedState, type Warehouse } from '../sim/warehouse';
import { mountDockCounter } from './dockCounter';
import { menu } from './menu';
import { createPcScreen } from './pcScreen';
import { createProcessHud } from './processHud';
import { createRobotDispatch } from './robotDispatch';
import { createWarehouseView } from './warehouseView';
import { createWmsGateway } from './wmsGateway';
import { compareLocations } from './wmsLocations';
import { wmsSync } from './wmsSync';
import { mountWmsPanel } from './wmsPanel';

// Koppelt de magazijn-sim aan de WMS (poort + stand ophalen), de 3D-scène, de HUD en het toetsenbord.
// De hal heeft zijn eigen voorraad, voor alle spelers dezelfde. De WMS hoort wat er gebeurt via scans en kan
// dus afwijken; alleen open orders komen doorlopend uit de WMS. De voorraad van de WMS komt alleen in de hal
// bij de allereerste start (als er nog geen bewaarde wereld is) en met de knop 'Hal resetten' (menu, WMS-API).
// Toetsen: E = scannen / actie (bij de pc: de WMS-app bedienen). In het menu rechtsboven: L = API-log,
// I = voorraad & orders, K = aanmelden bij de WMS-API.

/** Binnen deze afstand van de pc opent E de WMS-app; verder weglopen sluit hem. */
const PC_RADIUS = 2;

/**
 * Extra werkplek met de WMS-app naast de pc in de hal (de bureaus in het kantoor): het beeldvlak van de monitor
 * (w × h m, beeld naar +z) en de plek (x, z) waar je binnen `radius` m met E het scherm opent.
 */
export interface PcDesk {
  display: THREE.Object3D;
  w: number;
  h: number;
  x: number;
  z: number;
  radius: number;
  /** Tekst van de toetsprompt zolang het scherm dicht is. */
  label?: () => string;
}
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
  perPallet,
  palletLoad,
  orderLoad,
  desks = [],
  onPcOpen,
}: {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  player: THREE.Object3D;
  /** Stuks op een volle pallet van een artikel. */
  perPallet?: (sku: string) => number;
  /** Bouwt een pallet met precies `qty` dozen van een artikel (de hal, src/ui/scene/warehouse). */
  palletLoad: (sku: string, qty: number, key: string, sticker: boolean) => THREE.Object3D;
  /** Bouwt de pallet van een order, met van elk artikel het aantal dozen (de hal). */
  orderLoad: (lines: { sku: string; qty: number }[], key: string) => THREE.Object3D;
  /** Werkplekken met de WMS-app naast de pc in de hal (de bureaus in het kantoor). */
  desks?: PcDesk[];
  /** De speler opent het scherm van zo'n werkplek (E): daar gaat hij bijvoorbeeld bij zitten. */
  onPcOpen?: (desk: PcDesk) => void;
}) {
  // Elke speler heeft zijn eigen mock-WMS. Zodra de wereld (mede) van een andere speler komt, loopt die mock
  // niet meer gelijk en slaan we hem over; de echte WMS is voor iedereen dezelfde en blijft altijd leidend.
  const mockOutOfStep = () => wms.client.mode === 'mock' && sim.foreign;
  const sim: Warehouse = createWarehouse({
    gateway: createWmsGateway({ bypass: mockOutOfStep }),
    demoOrders: () => wms.client.mode === 'mock', // met een echte WMS komen orders uit de WMS-app
    perPallet,
    // Meldt de WMS zelf leveringen aan (de flow 'Simulatie: leveringen en orders'), dan komen de vrachtwagens daarvandaan
    deliveryFeed: () => !!wms.client.getDeliveries && !mockOutOfStep(),
    // Staan de robots aan, dan doen ze het inkomende werk zelf: lossen, tellen, wegzetten en de wagen afmelden
    automation: () => robotDispatch.enabled,
  });
  // De Geek+-robots krijgen hun opdrachten uit de WMS, of nagespeeld zolang de WMS die nog niet uitgeeft.
  const robotDispatch = createRobotDispatch({ fleet: sim.robots, authority: () => sim.authority, bypass: mockOutOfStep });
  const view = createWarehouseView(scene, player, sim, { palletLoad, orderLoad });
  const dockCounter = mountDockCounter(scene, sim.counter);
  const hud = createProcessHud(sim);
  // Aanmelden bij de WMS-API zit in het menu rechtsboven (K).
  const wmsSection = document.createElement('div');
  menu.addSection('wms', 'WMS-API', wmsSection, 2);
  mountWmsPanel(wmsSection);

  // Reset: de hal weer gelijkzetten met de voorraad in de WMS (voor alle spelers).
  const resetBox = document.createElement('div');
  resetBox.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px solid #3a4047';
  resetBox.innerHTML =
    '<div style="margin-bottom:6px">De hal heeft zijn eigen voorraad, voor alle spelers dezelfde. De WMS hoort alleen via scans wat er ' +
    'verandert en kan dus afwijken van wat er echt staat.</div>' +
    '<button style="padding:6px 10px;border:0;border-radius:5px;background:#8a3b2e;color:#fff;font:inherit;cursor:pointer"></button>' +
    '<div class="note" style="margin-top:6px;color:#9aa0a6"></div>';
  const resetButton = resetBox.querySelector('button')!;
  const resetNote = resetBox.querySelector<HTMLDivElement>('.note')!;
  const RESET_LABEL = 'Hal resetten naar de WMS-voorraad';
  resetButton.textContent = RESET_LABEL;
  let resetArmed = 0;
  resetButton.addEventListener('click', () => {
    resetButton.blur();
    // Twee keer klikken: de reset geldt voor iedereen en gooit weg wat fysiek afweek.
    if (performance.now() - resetArmed > 5000) {
      resetArmed = performance.now();
      resetButton.textContent = 'Zeker weten? Klik nog een keer';
      resetNote.textContent = 'Verplaatste pallets, lopende picks en wat er op de docks staat vervallen, voor alle spelers.';
      setTimeout(() => performance.now() - resetArmed >= 5000 && (resetButton.textContent = RESET_LABEL), 5100);
      return;
    }
    resetArmed = 0;
    resetButton.textContent = RESET_LABEL;
    resetNote.textContent = 'Bezig...';
    resetToWms().then(
      (n) => (resetNote.textContent = `De hal is gelijkgezet met de WMS (${n} voorraadregels).`),
      (err) => (resetNote.textContent = `Reset mislukt: ${err instanceof Error ? err.message : err}`),
    );
  });
  wmsSection.appendChild(resetBox);
  const resetListeners: (() => void)[] = [];
  /** Zet de hal gelijk met de voorraad en open orders in de WMS; geeft het aantal voorraadregels terug. */
  async function resetToWms() {
    const client = wms.client;
    const [stock, orders, pallets] = await Promise.all([client.getStock(), client.getOpenOrders(), readPallets(client)]);
    resetListeners.forEach((l) => l()); // eerst: wat op vorken of los op de vloer staat verdwijnt
    sim.loadSnapshot(stock, orders, client.mode === 'live' ? 'de WMS' : 'de mock-WMS', pallets);
    return stock.length;
  }
  /**
   * De pallets met sticker uit de WMS: de hal neemt hun nummers over, zodat een scan in de WMS op dezelfde pallet
   * uitkomt. Lukt het lezen niet (de API-client mag het niet), dan geeft de hal zijn pallets zelf een nummer.
   */
  async function readPallets(client: WmsClient) {
    try {
      return await client.getPallets();
    } catch (err) {
      hud.addError(`Pallets ophalen uit de WMS mislukt: ${err instanceof Error ? err.message : err} De hal geeft de pallets nu zelf een nummer.`);
      return [];
    }
  }
  wms.onError(() => menu.notify('wms'));
  /** Wat E hier doet, voor de toetsprompt in beeld; null als er niets te doen is. */
  let action: { label: string; enabled: boolean } | null = null;

  const pos = () => ({ x: player.position.x, z: player.position.z });
  /** De werkplek uit het kantoor waar de speler bij staat of zit, anders null. */
  const nearDesk = () => desks.find((d) => dist(pos(), d) <= d.radius) ?? null;
  const nearPc = () => dist(pos(), POINTS.terminal) <= PC_RADIUS || !!nearDesk();

  // De pc's tonen alleen de echte WMS-app: al zichtbaar op de monitor als je langsloopt, met E te bedienen.
  const pc = createPcScreen({
    camera,
    displays: [{ object: view.pcDisplay, w: 0.7, h: 0.7 * (9 / 16) }, ...desks.map((d) => ({ object: d.display, w: d.w, h: d.h }))],
    world: scene,
  });

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.repeat || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    if (e.code === 'KeyE') {
      if (pc.isOpen) pc.close();
      else if (nearPc()) {
        pc.open();
        const desk = nearDesk();
        if (desk) onPcOpen?.(desk);
      }
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
  /** Is de eerste stand uit de WMS binnen? Alleen dan, en alleen zonder bewaarde of gedeelde wereld, vult die de hal. */
  let started = false;
  let polling = false;
  let lastPollAt = -Infinity;
  let lastError = '';
  let lastWarning = '';
  let deliveryError = '';
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
      // Leveringen die de WMS zelf heeft aangemeld. Vóór de voorraad opgehaald: zo staat de ontvangst van een
      // levering die we hier zien zeker in de voorraad van daarna.
      let deliveries: Delivery[] | null = null;
      if (client.getDeliveries && sim.authority && !mockOutOfStep()) {
        try {
          deliveries = await client.getDeliveries();
          deliveryError = '';
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg !== deliveryError) hud.addError(`Leveringen ophalen uit de WMS mislukt: ${msg}`);
          deliveryError = msg;
        }
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

      if (!started) {
        // Allereerste start: is er (nog) geen wereld van een medespeler of van de broker, dan begint de hal met de
        // voorraad uit de WMS. Komt de bewaarde wereld daarna alsnog binnen, dan vervangt die deze stand.
        // Later in- of uitloggen laat de hal met rust: die is van de game, niet van de WMS.
        started = true;
        const pallets = await readPallets(client);
        if (!sim.foreign) sim.loadSnapshot(stock, orders, client.mode === 'live' ? 'de WMS' : 'de mock-WMS', pallets);
      } else if (sim.authority && !mockOutOfStep() && sim.pending === 0 && sim.revision === revision) {
        // Alleen de host haalt de open orders binnen (de rest krijgt ze via de gedeelde wereld), en alleen als
        // er sinds het ophalen niets is gebeurd: anders zou een oude stand een verse handeling terugdraaien.
        sim.syncOrders(orders);
      }
      if (deliveries && sim.authority) {
        // Elke levering komt als vrachtwagen aanrijden, met alleen de pallets die in de WMS nog op de dockdeur
        // staan: wat daar al weg is, is al weggezet (bijvoorbeeld vóór een herstart van de game).
        const onDock = (dockId: string, sku: string) => stock.find((s) => s.locationId === dockId && s.sku === sku)?.qty ?? 0;
        sim.syncDeliveries(deliveries.map((d) => ({ ...d, pallets: d.pallets.filter((p) => onDock(d.dockId, p.sku) >= p.qty) })));
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
    /** Hoeveel lege pallets er op de stapels langs de wand liggen, voor de hal. */
    emptyPallets: () => sim.emptyPallets,
    /** Draagt de speler iets (een pallet of de pallet van een order)? Voor de houding van de figuur. */
    carrying: () => !!sim.carry,
    /** Wat de toets E op deze plek doet (enabled: false = kan nu niet), of null als hier niets te doen is. */
    action: () => action,
    /** Wat de speler draagt, als tekst voor andere spelers ('' = niets); carryMesh bouwt er dezelfde pallet met dozen van. */
    carryLabel: view.carryLabel,
    carryMesh: view.carryMesh,
    /** Waar de speler tegenaan loopt: het bureau, de pallets op de banen en de telrobot. */
    solids: () => [...view.solids(), ...dockCounter.solids()],
    /** Waar de speler buiten tegenaan loopt: de vrachtwagens op het terrein. */
    truckSolids: view.truckSolids,
    /** Hoe ver de slagboom van het terrein open moet staan (0..1): omhoog als er een vrachtwagen aankomt. */
    gateOpen: view.gateOpen,
    /** Vaste obstakels voor de heftruck (die rijdt nergens onderdoor): het bureau. */
    colliders: view.colliders,
    /** De telrobot bij de inslagbanen: waar hij staat en waar hij voor stopt. */
    counter: sim.counter,
    /** De handscanner las een locatielabel of palletsticker: de sim legt de scan voor aan de WMS. null = alleen kijken. */
    scan: (code: string) => sim.scan(code, pos()),
    /** De stand uit de WMS, telkens als die verandert (voor het scherm van de handscanner). */
    onWmsData(l: (d: WmsData) => void) {
      dataListeners.push(l);
    },
    /** Multiplayer: de gedeelde wereld lezen, overnemen en bepalen wie hem laat draaien. */
    shared: {
      state: () => sim.sharedState(),
      apply(s: SharedState, saved = false) {
        sim.applyShared(s);
        if (saved) sim.dropCarried();
        // Zonder eigen WMS gelden de artikelen van de wereld die je deelt (die van de WMS van de host).
        if (wms.client.mode === 'mock' && s.articles?.length) setArticles(s.articles);
      },
      setAuthority: sim.setAuthority,
    },
    /** De hal wordt gereset naar de WMS: wat op vorken of los op de vloer staat moet weg. */
    onReset(l: () => void) {
      resetListeners.push(l);
    },
    /** Het scherm van de pc sluiten (bijvoorbeeld als de speler opstaat van zijn bureau). */
    closePc: () => pc.close(),
    /** Voor de heftruck en de pompwagen: hele pallets uit en in de stellingen. */
    forkliftTake: sim.forkliftTake,
    forkliftPlace: sim.forkliftPlace,
    /** De Geek+-robots en waar hun opdrachten vandaan komen, voor src/ui/robots.ts. */
    robots: {
      fleet: sim.robots,
      dispatch: robotDispatch,
      /** De pallet van een order, voor achter op een pickrobot. */
      orderLoads: view.orderLoads,
    },
    /** De chauffeurs en de vrachtwagens op het terrein, voor src/ui/drivers.ts. */
    docks: {
      drivers: sim.drivers,
      trucks: () => [sim.trucks.in, sim.trucks.out, ...sim.deliveries].filter((t): t is NonNullable<typeof t> => !!t),
      /** De pallet uit de wagen en de pallet van een order, voor op de pompwagen van de chauffeur. */
      palletLoads: view.palletLoads,
      orderLoads: view.orderLoads,
    },
    update(dt: number) {
      robotDispatch.update(dt);
      sim.update(dt);
      view.update(dt);
      dockCounter.update(dt);

      const near = nearPc();
      if (pc.isOpen && !near) pc.close();
      pc.update(dt);
      hud.update(dt);
      const it = near ? null : sim.interactionAt(pos());
      action = near
        ? { label: pc.isOpen ? 'Pc verlaten' : (nearDesk()?.label?.() ?? 'Pc gebruiken: WMS openen'), enabled: true }
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
