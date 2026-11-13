import { wms, WmsError } from '../integrations/wms';
import { onProcessEvent, type ProcessEvent } from '../sim/events';
import type { RobotTask } from '../sim/robots';
import type { WmsGateway } from '../sim/wms';

// Vult de poort van de sim (src/sim/wms.ts) in met de WMS-client: elke processtap wordt een API-aanroep
// en het antwoord van de WMS gaat terug naar de sim. Een palletverplaatsing komt hier binnen als PutawayDone:
// met een sticker die de WMS kent verhuist de pallet, anders gaat het aantal als losse voorraad over.
// De robotacties (docs/wms/08) heeft alleen de echte WMS; op de mock gaan die stappen door zonder aanroep.

/**
 * De robotacties van de WMS (docs/wms/08). Heeft de WMS-client ze, dan haalt de game zijn robotopdrachten uit de
 * WMS en meldt hij ze daar terug; anders speelt de game de robotsturing zelf na (src/ui/robotDispatch.ts).
 */
export type WmsRobotApi = {
  /** De nummers van de robots die de WMS kent. */
  getRobots?(): Promise<string[]>;
  /** De opdrachten met status open; met `running` ook die waar een robot mee bezig is (dan met robotId). */
  getRobotTasks(running?: boolean): Promise<(RobotTask & { robotId?: string })[]>;
  startRobotTask(p: { taskId: string; robotId: string }): Promise<void>;
  /** De WMS boekt de voorraad om van de van- naar de naar-locatie van de opdracht. */
  completeRobotTask(p: { taskId: string; robotId: string }): Promise<void>;
  failRobotTask(p: { taskId: string; robotId?: string; reason: string; palletOnRobot: boolean }): Promise<void>;
};

/** De robotacties van de huidige WMS-client, of null als die ze niet heeft. */
export function robotApi(): WmsRobotApi | null {
  const client = wms.client;
  return client.getRobotTasks && client.startRobotTask && client.completeRobotTask && client.failRobotTask
    ? (client as WmsRobotApi)
    : null;
}

/** true = de WMS heeft de stap verwerkt; false = geen endpoint in de client. Gooit bij een weigering. */
async function call(e: ProcessEvent): Promise<boolean> {
  const client = wms.client;
  switch (e.type) {
    case 'GoodsReceived':
      await client.registerGoodsReceived({ sku: e.sku, qty: e.qty, dockId: e.dockId });
      return true;
    case 'PutawayDone':
      await client.confirmPutaway({ sku: e.sku, qty: e.qty, fromLocationId: e.fromLocationId, toLocationId: e.locationId, palletId: e.palletId });
      return true;
    case 'PalletLabeled':
      await client.registerPallet({ palletId: e.palletId, sku: e.sku, qty: e.qty, locationId: e.locationId });
      return true;
    case 'TruckCheckedIn':
      await client.truckCheckIn({ truckId: e.truckId, direction: e.direction, dockId: e.dockId });
      return true;
    case 'TruckCheckedOut':
      await client.truckCheckOut({ truckId: e.truckId });
      return true;
    case 'OrderCreated':
      await client.createOrder(e.order.lines, e.order.id);
      return true;
    case 'PickStarted':
      await client.startPicking(e.orderId);
      return true;
    case 'PickLineConfirmed':
      await client.confirmPickLine({ orderId: e.orderId, sku: e.sku, qty: e.qty, locationId: e.locationId });
      return true;
    case 'PickCompleted':
      await client.confirmPick(e.orderId);
      return true;
    case 'OrderStaged':
      await client.stageOrder({ orderId: e.orderId, dockId: e.dockId });
      return true;
    case 'OrderLoaded':
      await client.loadOrder({ orderId: e.orderId, truckId: e.truckId });
      return true;
    // Een levering uit de WMS: lossen en tellen. false = de WMS heeft van deze pallet geen ontvangst die daarop wacht.
    case 'PalletUnloaded':
      return (await client.unloadReceipt?.({ palletId: e.palletId })) ?? false;
    case 'PalletCounted':
      return (await client.countReceipt?.({ palletId: e.palletId, qty: e.qty })) ?? false;
    // Geek+-robots (docs/wms/08). Zolang de client de robotacties niet heeft, boekt het afronden van een
    // robotopdracht de pallet om als palletverplaatsing; starten en mislukken blijven dan lokaal.
    case 'RobotTaskStarted': {
      const api = robotApi();
      if (!api) return false;
      await api.startRobotTask({ taskId: e.taskId, robotId: e.robotId });
      return true;
    }
    case 'RobotTaskCompleted': {
      const api = robotApi();
      if (api) await api.completeRobotTask({ taskId: e.taskId, robotId: e.robotId });
      else await client.confirmPutaway({ sku: e.sku, qty: e.qty, fromLocationId: e.fromLocationId, toLocationId: e.locationId, palletId: e.palletId });
      return true;
    }
    case 'RobotTaskFailed': {
      const api = robotApi();
      if (!api) return false;
      await api.failRobotTask({ taskId: e.taskId, robotId: e.robotId, reason: e.reason, palletOnRobot: e.palletOnRobot });
      return true;
    }
    default:
      return false;
  }
}

/** @param bypass true: de WMS van deze speler loopt niet gelijk met de gedeelde wereld en wordt overgeslagen. */
export function createWmsGateway({ bypass }: { bypass: () => boolean }): WmsGateway {
  // Elke scan gaat naar het scanlog van de WMS. Dat is alleen een logboek: de speler wacht er niet op en
  // een fout houdt niets tegen. Mag de API-client het niet (403), dan stopt het loggen voor die client.
  const noScanLog = new WeakSet<object>();
  onProcessEvent((e) => {
    const client = wms.client;
    if (e.type !== 'Scanned' || bypass() || noScanLog.has(client)) return;
    client.logScan({ kind: e.kind, barcode: e.barcode, ok: e.ok, locationId: e.locationId }).catch((err: unknown) => {
      if (err instanceof WmsError && err.status === 403 && !noScanLog.has(client)) {
        noScanLog.add(client);
        console.warn('[WMS] scanlog uitgeschakeld:', err.message);
      }
    });
  });
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
