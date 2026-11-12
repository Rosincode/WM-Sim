import { wms } from '../integrations/wms';
import type { ProcessEvent } from '../sim/events';
import type { RobotTask } from '../sim/robots';
import type { WmsGateway } from '../sim/wms';

// Vult de poort van de sim (src/sim/wms.ts) in met de WMS-client: elke processtap wordt een API-aanroep
// en het antwoord van de WMS gaat terug naar de sim. Stappen waar de client nog geen methode voor heeft
// (aanmelden, pick per regel, klaarzetten, inladen, uitmelden: zie docs/wms/04; palletsticker plakken:
// docs/wms/07) gaan door zonder aanroep. Een palletverplaatsing komt hier binnen als PutawayDone.

/**
 * De robotacties van de WMS (docs/wms/08). Ze zitten nog niet in de WMS-client (src/integrations/wms): zodra de
 * client deze methodes krijgt, haalt de game zijn robotopdrachten uit de WMS en meldt hij ze daar terug.
 */
export type WmsRobotApi = {
  /** Robotopdrachten die nog geen robot hebben (status open). */
  getRobotTasks(): Promise<RobotTask[]>;
  startRobotTask(p: { taskId: string; robotId: string }): Promise<void>;
  /** De WMS boekt de voorraad om van de van- naar de naar-locatie van de opdracht. */
  completeRobotTask(p: { taskId: string; robotId: string }): Promise<void>;
  failRobotTask(p: { taskId: string; robotId?: string; reason: string; palletOnRobot: boolean }): Promise<void>;
};

/** De robotacties van de huidige WMS-client, of null als die ze (nog) niet heeft. */
export function robotApi(): WmsRobotApi | null {
  const client = wms.client as Partial<WmsRobotApi>;
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
    // Geek+-robots (docs/wms/08). Zolang de client de robotacties niet heeft, boekt het afronden van een
    // robotopdracht de voorraad om met confirm_putaway; starten en mislukken blijven dan lokaal.
    case 'RobotTaskStarted': {
      const api = robotApi();
      if (!api) return false;
      await api.startRobotTask({ taskId: e.taskId, robotId: e.robotId });
      return true;
    }
    case 'RobotTaskCompleted': {
      const api = robotApi();
      if (api) await api.completeRobotTask({ taskId: e.taskId, robotId: e.robotId });
      else await client.confirmPutaway({ sku: e.sku, qty: e.qty, fromLocationId: e.fromLocationId, toLocationId: e.locationId });
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
