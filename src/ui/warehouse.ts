import type * as THREE from 'three';
import { wms } from '../integrations/wms';
import { POINTS, dist } from '../sim/layout';
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
  player,
  rackStock = true,
}: {
  scene: THREE.Scene;
  player: THREE.Object3D;
  /** false: de hal tekent de stellingvoorraad zelf (src/ui/scene/warehouse). */
  rackStock?: boolean;
}) {
  const sim = createWarehouse();
  const view = createWarehouseView(scene, player, sim, { rackStock });
  const hud = createProcessHud(sim);

  const pos = () => ({ x: player.position.x, z: player.position.z });
  const nearPc = () => dist(pos(), POINTS.terminal) <= PC_RADIUS;

  // De pc: aanmelden bij het WMS + de orderacties van de sim (start picken / testorder).
  const pcOrderAction = () => {
    const it = sim.interactionAt(POINTS.terminal);
    return it && it.point === POINTS.terminal ? it : null;
  };
  const pc = createPcScreen({
    orderAction: pcOrderAction,
    runOrderAction: () => pcOrderAction() && sim.interact(POINTS.terminal),
    orders: () =>
      sim.orders
        .filter((o) => o.status !== 'shipped')
        .map((o) => ({ id: o.id, status: o.status, lines: o.lines.map((l) => `${l.qty}× ${l.sku}`).join(', ') })),
  });

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

  function pcHost() {
    try {
      return new URL(wms.connectedUrl ?? '').host;
    } catch {
      return wms.connectedUrl ?? '';
    }
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
      },
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
      pc.update();
      hud.update(dt, pos(), near ? (pc.isOpen ? 'Pc verlaten' : 'Pc gebruiken: aanmelden en orders') : undefined);

      const live = wms.client.mode === 'live';
      const open = sim.orders.filter((o) => o.status === 'open').length;
      view.setPcScreen({
        loggedIn: live,
        subtitle: live ? pcHost() : 'Mock-modus (geen WMS)',
        lines: [`${open} open order${open === 1 ? '' : 's'}`],
      });
    },
  };
}
