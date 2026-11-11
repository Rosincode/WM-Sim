import type { Item, Location, Order } from '../../shared/contract';

/** Aanmelden bij de WMS-API: het basisadres en de API-sleutel van een API-client (rol game). */
export type WmsCredentials = { baseUrl: string; apiKey: string };

export type OrderLine = { sku: string; qty: number };

/** Artikel zoals de WMS het kent (entiteit `item`, docs/wms/01 en 03). */
export type WmsItem = { sku: string; description: string; category?: string };

/** Locatie met wat de WMS er verder van weet; level en blocked ontbreken als de WMS ze niet teruggeeft. */
export type WmsLocation = Location & { level?: number; blocked?: boolean };

/** Eén interface voor zowel de echte WMS als de mock. */
export interface WmsClient {
  readonly mode: 'live' | 'mock';
  getLocations(): Promise<WmsLocation[]>;
  /** Alle artikelen: de WMS bepaalt welke artikelen er bestaan en hoe ze heten. */
  getItems(): Promise<WmsItem[]>;
  /** Voegt een locatie van de hal toe die de WMS nog niet kent. false = de locatie stond er al; er is niets aangemaakt. */
  createLocation(l: Location & { level: number }): Promise<boolean>;
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
