import { wms } from '../integrations/wms';
import type { ProcessEvent } from '../sim/events';
import type { WmsGateway } from '../sim/wms';

// Vult de poort van de sim (src/sim/wms.ts) in met de WMS-client: elke processtap wordt een API-aanroep
// en het antwoord van de WMS gaat terug naar de sim. Stappen waar de client nog geen methode voor heeft
// (aanmelden, pick per regel, klaarzetten, inladen, uitmelden: zie docs/wms/04; palletsticker plakken:
// docs/wms/07) gaan door zonder aanroep. Een palletverplaatsing komt hier binnen als PutawayDone.

/** true = de WMS heeft de stap verwerkt; false = geen endpoint in de client. Gooit bij een weigering. */
async function call(e: ProcessEvent): Promise<boolean> {
  const client = wms.client;
  switch (e.type) {
    case 'GoodsReceived':
      await client.registerGoodsReceived({ sku: e.sku, qty: e.qty, dockId: e.dockId });
      return true;
    case 'PutawayDone':
      await client.confirmPutaway({ sku: e.sku, qty: e.qty, fromLocationId: e.fromLocationId, toLocationId: e.locationId });
      return true;
    case 'OrderCreated':
      await client.createOrder(e.order.lines, e.order.id);
      return true;
    case 'PickStarted':
      await client.startPicking(e.orderId);
      return true;
    case 'PickCompleted':
      await client.confirmPick(e.orderId);
      return true;
    default:
      return false;
  }
}

/** @param bypass true: de WMS van deze speler loopt niet gelijk met de gedeelde wereld en wordt overgeslagen. */
export function createWmsGateway({ bypass }: { bypass: () => boolean }): WmsGateway {
  return {
    async send(e) {
      if (bypass()) return { ok: true, linked: false };
      try {
        return { ok: true, linked: await call(e) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
