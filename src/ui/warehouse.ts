import type * as THREE from 'three';
import { wms } from '../integrations/wms';
import { createWarehouse } from '../sim/warehouse';
import { createProcessHud } from './processHud';
import { createWarehouseView } from './warehouseView';

// Koppelt de magazijn-sim aan de 3D-scène, de HUD en het toetsenbord.
// Toetsen: E = scannen / actie, L = API-log, I = voorraad & orders.

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

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.repeat || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    if (e.code === 'KeyE') sim.interact(pos());
    if (e.code === 'KeyL') hud.setTab('log');
    if (e.code === 'KeyI') hud.setTab('stock');
  });

  // WMS is leidend: voorraad en open orders overnemen bij start en na in- of uitloggen (alleen lezen).
  async function syncFromWms() {
    const client = wms.client;
    try {
      const [stock, orders] = await Promise.all([client.getStock(), client.getOpenOrders()]);
      if (client === wms.client) sim.loadSnapshot(stock, orders, client.mode === 'live' ? 'de WMS' : 'de mock-WMS');
    } catch (err) {
      hud.addError(`Voorraad laden mislukt: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  wms.onChange(syncFromWms);
  wms.onError((msg) => hud.addError(msg));
  void syncFromWms();

  return {
    stockList: () => sim.stockList(),
    /** Voor de heftruck: hele pallets van en naar stellinglocaties. */
    forkliftTake: sim.forkliftTake,
    forkliftPlace: sim.forkliftPlace,
    update(dt: number) {
      sim.update(dt);
      view.update(dt);
      hud.update(dt, pos());
    },
  };
}
