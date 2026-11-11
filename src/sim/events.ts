import { bus } from '../shared/bus';
import type { Order, SimEvent } from '../shared/contract';

// Alle processtappen in de game. Elke stap gaat eerst als vraag naar de WMS (src/sim/wms.ts); het antwoord
// komt hier langs voor het API-log. Vier stappen bestaan ook in het contract (src/shared/contract.ts) en
// gaan na akkoord van de WMS de bus op.

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
  | { type: 'OrderLoaded'; orderId: string; truckId: string; dockId: string }
  /** Er is een palletsticker geplakt: de voorraad op die pallet ligt nu onder een barcode vast (docs/wms/07). */
  | { type: 'PalletLabeled'; palletId: string; sku: string; qty: number; locationId: string };

export type ProcessEventType = ProcessEvent['type'];

/** Welke WMS-actie bij een processtap hoort (docs/wms/01 en 04). */
export const WMS_ACTIONS: Record<ProcessEventType, string> = {
  GoodsReceived: 'register_goods_received',
  PutawayDone: 'confirm_putaway',
  OrderCreated: 'create_order',
  PickStarted: 'start_picking',
  PickCompleted: 'confirm_pick',
  TruckCheckedIn: 'truck_check_in',
  TruckCheckedOut: 'truck_check_out',
  Scanned: 'register_scan',
  PickLineConfirmed: 'confirm_pick_line',
  OrderStaged: 'stage_order',
  OrderLoaded: 'load_order',
  PalletLabeled: 'register_pallet',
};

/** Wat de WMS met de stap deed. linked = echt in de WMS verwerkt; false = alleen lokaal (nog geen endpoint). */
export type EventResult = { ok: boolean; linked: boolean; error?: string };

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

type Listener = (e: ProcessEvent, result: EventResult) => void;
const listeners: Listener[] = [];

export function onProcessEvent(l: Listener) {
  listeners.push(l);
  return () => listeners.splice(listeners.indexOf(l), 1);
}

/** Meldt een processtap met het antwoord van de WMS. Alleen geslaagde stappen gaan de bus op. */
export function publish(e: ProcessEvent, result: EventResult = { ok: true, linked: false }) {
  listeners.forEach((l) => l(e, result));
  if (!result.ok) return;
  const shared = toContract(e);
  if (shared) bus.emit(shared);
}
