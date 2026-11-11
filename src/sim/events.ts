import { bus } from '../shared/bus';
import type { Order, SimEvent } from '../shared/contract';

// Alle processtappen in de game. Vier ervan bestaan al in het contract (src/shared/contract.ts)
// en gaan via de bus naar de WMS-bridge. De rest is een voorstel voor het contract; tot dat er is,
// blijven ze lokaal (log in de UI) en roept de bridge nog geen API aan.

export type Direction = 'in' | 'out';
export type ScanKind = 'truck' | 'pallet' | 'location' | 'order';

export type ProcessEvent =
  // --- bestaand contract ---
  | { type: 'GoodsReceived'; sku: string; qty: number; dockId: string; palletId: string }
  | { type: 'PutawayDone'; sku: string; qty: number; fromLocationId: string; locationId: string; palletId: string }
  | { type: 'OrderCreated'; order: Order }
  | { type: 'PickCompleted'; orderId: string }
  // --- voorstel contract-uitbreiding ---
  | { type: 'TruckCheckedIn'; truckId: string; direction: Direction; dockId: string }
  | { type: 'TruckCheckedOut'; truckId: string; direction: Direction; dockId: string; orderIds: string[] }
  | { type: 'Scanned'; kind: ScanKind; barcode: string; ok: boolean; locationId?: string }
  | { type: 'PickStarted'; orderId: string }
  | { type: 'PickLineConfirmed'; orderId: string; sku: string; qty: number; locationId: string }
  | { type: 'OrderStaged'; orderId: string; dockId: string }
  | { type: 'OrderLoaded'; orderId: string; truckId: string; dockId: string };

export type ProcessEventType = ProcessEvent['type'];

/** Welke WMS-actie bij een event hoort, en of die al via de bus gekoppeld is. */
export const WMS_ACTIONS: Record<ProcessEventType, { action: string; linked: boolean }> = {
  GoodsReceived: { action: 'register_goods_received', linked: true },
  PutawayDone: { action: 'confirm_putaway', linked: true },
  OrderCreated: { action: 'create_order', linked: true },
  PickCompleted: { action: 'start_picking + confirm_pick', linked: true },
  TruckCheckedIn: { action: 'truck_check_in', linked: false },
  TruckCheckedOut: { action: 'truck_check_out', linked: false },
  Scanned: { action: 'register_scan', linked: false },
  PickStarted: { action: 'start_picking', linked: false },
  PickLineConfirmed: { action: 'confirm_pick_line', linked: false },
  OrderStaged: { action: 'stage_order', linked: false },
  OrderLoaded: { action: 'load_order', linked: false },
};

/** Vertaalt naar het huidige contract; null = (nog) niet in het contract. */
function toContract(e: ProcessEvent): SimEvent | null {
  switch (e.type) {
    case 'GoodsReceived':
      return { type: 'GoodsReceived', sku: e.sku, qty: e.qty, dockId: e.dockId };
    case 'PutawayDone':
      return { type: 'PutawayDone', sku: e.sku, locationId: e.locationId };
    case 'OrderCreated':
      return { type: 'OrderCreated', order: e.order };
    case 'PickCompleted':
      return { type: 'PickCompleted', orderId: e.orderId };
    default:
      return null;
  }
}

type Listener = (e: ProcessEvent) => void;
const listeners: Listener[] = [];

export function onProcessEvent(l: Listener) {
  listeners.push(l);
  return () => listeners.splice(listeners.indexOf(l), 1);
}

export function publish(e: ProcessEvent) {
  listeners.forEach((l) => l(e));
  const shared = toContract(e);
  if (shared) bus.emit(shared);
}
