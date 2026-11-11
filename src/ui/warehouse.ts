import type * as THREE from 'three';
import { wms } from '../integrations/wms';
import type { Item } from '../shared/contract';
import { POINTS, dist, location } from '../sim/layout';
import { createWarehouse, type SharedState } from '../sim/warehouse';
import { createPcScreen } from './pcScreen';
import { createProcessHud } from './processHud';
import { createWarehouseView } from './warehouseView';

// Koppelt de magazijn-sim aan de 3D-scène, de HUD en het toetsenbord.
// Toetsen: E = scannen / actie (bij de pc: pc gebruiken), L = API-log, I = voorraad & orders.

/** Binnen deze afstand van de pc opent E het pc-scherm; verder weglopen sluit het. */
const PC_RADIUS = 2;

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
  const sim = createWarehouse();
  const view = createWarehouseView(scene, player, sim, { rackStock });
  const hud = createProcessHud(sim);

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

  // WMS is leidend: voorraad en open orders overnemen bij start en na in- of uitloggen (alleen lezen).
  // Multiplayer: wie bij een lopend spel aanschuift neemt die wereld over en laadt bij de start niet opnieuw.
  let adopted = false;
  async function syncFromWms(initial = false) {
    const client = wms.client;
    try {
      const [stock, orders] = await Promise.all([client.getStock(), client.getOpenOrders()]);
      if (initial && adopted) return;
      if (client === wms.client) sim.loadSnapshot(stock, orders, client.mode === 'live' ? 'de WMS' : 'de mock-WMS');
    } catch (err) {
      hud.addError(`Voorraad laden mislukt: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  wms.onChange(() => void syncFromWms());
  wms.onError((msg) => hud.addError(msg));
  void syncFromWms(true);

  // --- Voorraad afstemmen: de WMS is leidend ---
  // Elke handeling wordt bij de WMS geboekt. Wijkt de voorraad daarna toch af (een boeking is geweigerd,
  // of iemand heeft in de WMS zelf iets gewijzigd), dan neemt het spel de stand van de WMS over.
  let inTransit: () => Item[] = () => [];
  let authority = true;
  let checking = false;
  let lastDiff = '';
  let checkTimer = 6;

  function totals(items: Item[], sign = 1, into = new Map<string, number>()) {
    for (const i of items) {
      const k = `${i.locationId}|${i.sku}`;
      into.set(k, (into.get(k) ?? 0) + sign * i.qty);
    }
    return into;
  }
  const toItems = (m: Map<string, number>): Item[] =>
    [...m]
      .filter(([, qty]) => qty > 0)
      .map(([k, qty]) => {
        const [locationId, sku] = k.split('|');
        return { locationId, sku, qty };
      });
  /** Wat het spel al heeft afgeboekt maar de WMS nog niet: gepickte regels en pallets op de heftruck. */
  const transit = () => [...sim.pickedUnconfirmed(), ...inTransit()];
  /** De voorraad die de WMS hoort te hebben als alles klopt. */
  const expectedInWms = () => totals(transit(), 1, totals(sim.stockList()));

  async function reconcile(force = false): Promise<string> {
    const client = wms.client;
    if (checking || wms.pending > 0) return 'bezig';
    // Zonder echte WMS valt er niets af te stemmen; bij samen spelen doet alleen de host dit.
    if (!force && (client.mode !== 'live' || !authority)) return 'niet van toepassing';
    checking = true;
    try {
      const mark = wms.writes;
      const items = await client.getStock();
      if (client !== wms.client || wms.pending > 0 || wms.writes !== mark) return 'bezig'; // intussen is er geboekt
      const inWms = totals(items.filter((i) => location(i.locationId) && i.qty > 0));
      const expected = expectedInWms();
      const diff = [...new Set([...inWms.keys(), ...expected.keys()])]
        .filter((k) => (inWms.get(k) ?? 0) !== (expected.get(k) ?? 0))
        .sort()
        .join(', ');
      if (!diff) {
        lastDiff = '';
        return 'gelijk';
      }
      // Pas corrigeren als hetzelfde verschil twee keer achter elkaar gezien is: een boeking van een
      // medespeler kan net onderweg zijn.
      if (!force && diff !== lastDiff) {
        lastDiff = diff;
        return `verschil: ${diff}`;
      }
      lastDiff = '';
      const n = diff.split(', ').length;
      sim.syncStock(toItems(totals(transit(), -1, inWms)), `Voorraad gelijkgetrokken met de WMS (${n} regel${n === 1 ? '' : 's'} week af).`);
      return `gecorrigeerd: ${diff}`;
    } catch (err) {
      return `fout: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      checking = false;
    }
  }
  wms.onIdle(() => (checkTimer = Math.min(checkTimer, 1.5)));

  /** Samen spelen zonder echte WMS: de eigen mock volgt de gedeelde wereld, zodat scanner en tablet kloppen. */
  function mirrorToMock() {
    const client = wms.client;
    if (client.mode !== 'mock' || !client.mirror || wms.pending > 0) return;
    client.mirror(
      toItems(expectedInWms()),
      sim.orders
        .filter((o) => o.status === 'open' || o.status === 'picking')
        .map((o) => ({ id: o.id, lines: o.lines, status: 'open' as const })),
    );
  }

  return {
    stockList: () => sim.stockList(),
    /** Draagt de speler iets (pallet of orderbak)? Voor de houding van de figuur. */
    carrying: () => !!sim.carry,
    /** Wat de speler draagt, voor andere spelers: '' (niets), 'order' of het artikel van de pallet. */
    carryLabel: () => (sim.carry?.kind === 'pallet' ? sim.carry.pallet.sku : sim.carry ? 'order' : ''),
    /** Multiplayer: de gedeelde wereld lezen, overnemen en bepalen wie hem laat draaien. */
    shared: {
      state: () => sim.sharedState(),
      apply(s: SharedState) {
        adopted = true;
        sim.applyShared(s);
        mirrorToMock();
      },
      setAuthority(on: boolean) {
        authority = on;
        sim.setAuthority(on);
      },
    },
    /** Voor de heftruck: hele pallets van en naar stellinglocaties. */
    forkliftTake: sim.forkliftTake,
    forkliftPlace: sim.forkliftPlace,
    /** Pallets die van een locatie zijn gehaald maar nog niet zijn neergezet (heftruck). */
    setInTransit(fn: () => Item[]) {
      inTransit = fn;
    },
    /** Vergelijkt de voorraad met de WMS en neemt bij een blijvend verschil de WMS over. */
    reconcile,
    update(dt: number) {
      sim.update(dt);
      if ((checkTimer -= dt) <= 0) {
        checkTimer = 6;
        void reconcile();
      }
      view.update(dt);

      const near = nearPc();
      if (pc.isOpen && !near) pc.close();
      pc.update(dt);
      hud.update(dt, pos(), near ? (pc.isOpen ? 'Pc verlaten' : 'Pc gebruiken: WMS openen') : undefined);
    },
  };
}
