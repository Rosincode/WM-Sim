export type Location = { id: string; x: number; y: number; type: 'dock' | 'rack' | 'pick' };
export type Item     = { sku: string; qty: number; locationId: string };
export type Order    = { id: string; lines: { sku: string; qty: number }[]; status: 'open' | 'picking' | 'done' };

export type SimEvent =
  | { type: 'GoodsReceived'; sku: string; qty: number; dockId: string }
  | { type: 'PutawayDone';   sku: string; locationId: string }
  | { type: 'OrderCreated';  order: Order }
  | { type: 'PickCompleted'; orderId: string };
