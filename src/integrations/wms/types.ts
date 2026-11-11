import type { Item, Location, Order } from '../../shared/contract';

/** Aanmelden bij de WMS-API: het basisadres en de API-sleutel van een API-client (rol game). */
export type WmsCredentials = { baseUrl: string; apiKey: string };

export type OrderLine = { sku: string; qty: number };

/** Eén interface voor zowel de echte WMS als de mock. */
export interface WmsClient {
  readonly mode: 'live' | 'mock';
  getLocations(): Promise<Location[]>;
  /** Voegt een locatie van de hal toe die de WMS nog niet kent. */
  createLocation(l: Location & { level: number }): Promise<void>;
  getStock(): Promise<Item[]>;
  getOpenOrders(): Promise<Order[]>;
  registerGoodsReceived(p: { sku: string; qty: number; dockId: string }): Promise<void>;
  confirmPutaway(p: { sku: string; qty: number; fromLocationId: string; toLocationId: string }): Promise<void>;
  createOrder(lines: OrderLine[], orderId?: string): Promise<string>;
  startPicking(orderId: string): Promise<void>;
  confirmPick(orderId: string): Promise<void>;
  /**
   * Alleen de mock: neemt de stand van het spel over. Nodig bij samen spelen zonder echte WMS,
   * want dan heeft elke speler zijn eigen mock die de acties van de anderen niet ziet.
   */
  mirror?(stock: Item[], openOrders: Order[]): void;
}

export class WmsError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}
