import type { Item, Location, Order } from '../../shared/contract';

/** Aanmelden bij de WMS-API: het basisadres en de API-sleutel van een API-client (rol game). */
export type WmsCredentials = { baseUrl: string; apiKey: string };

export type OrderLine = { sku: string; qty: number };

/** Artikel zoals de WMS het kent (entiteit `item`, docs/wms/01 en 03). */
export type WmsItem = { sku: string; description: string; category?: string };

/** Locatie met wat de WMS er verder van weet; level en blocked ontbreken als de WMS ze niet teruggeeft. */
export type WmsLocation = Location & { level?: number; blocked?: boolean };

/** Pallet met sticker zoals de WMS hem kent (entiteit `pallet`): `id` is het nummer op de sticker. */
export type WmsPallet = { id: string; sku: string; qty: number; locationId: string };

/**
 * Een inkomende vrachtwagen die in de WMS is aangemeld (`truck_visit`, status checked_in), met zijn ontvangsten.
 * De ontvangst is in de WMS al geboekt: de voorraad staat daar op de dockdeur (`dockId`, bijvoorbeeld DOCK-03).
 * `palletId` ontbreekt als de ontvangst zonder pallet is geboekt.
 */
export type WmsDelivery = { truckId: string; dockId: string; pallets: { palletId?: string; sku: string; qty: number }[] };

/**
 * Robotopdracht uit de WMS (entiteit `robot_task`): breng deze pallet van de ene locatie naar de andere.
 * `robotId` is gezet bij een opdracht waar al een robot aan begonnen is (status in_progress).
 */
export type WmsRobotTask = { id: string; palletId: string; fromLocationId: string; toLocationId: string; robotId?: string };

/** Eén interface voor zowel de echte WMS als de mock. Alle sleutels zijn de tekstsleutels (SKU-001, DOCK-01, ORD-…, PAL-…). */
export interface WmsClient {
  readonly mode: 'live' | 'mock';
  getLocations(): Promise<WmsLocation[]>;
  /** Alle artikelen: de WMS bepaalt welke artikelen er bestaan en hoe ze heten. */
  getItems(): Promise<WmsItem[]>;
  /**
   * Voegt een locatie van de hal toe die de WMS nog niet kent. false = de locatie stond er al; er is niets aangemaakt.
   * De echte WMS staat aanmaken via de API niet meer toe en weigert: locaties worden in de WMS-app beheerd.
   */
  createLocation(l: Location & { level: number }): Promise<boolean>;
  getStock(): Promise<Item[]>;
  /** Actieve pallets (met sticker). Voorraad zonder pallet staat alleen in getStock. */
  getPallets(): Promise<WmsPallet[]>;
  getOpenOrders(): Promise<Order[]>;
  /** Ontvangst op een docklocatie: de voorraad ligt daar daarna los (zonder pallet). */
  registerGoodsReceived(p: { sku: string; qty: number; dockId: string }): Promise<void>;
  /** Sticker plakken: legt losse voorraad op een locatie vast als pallet met dit nummer. */
  registerPallet(p: { palletId: string; sku: string; qty: number; locationId: string }): Promise<void>;
  /**
   * Wegzetten of verplaatsen. Kent de WMS de pallet (`palletId`), dan verhuist de hele pallet;
   * anders gaat het aantal als losse voorraad van de van- naar de naar-locatie.
   */
  confirmPutaway(p: { sku: string; qty: number; fromLocationId: string; toLocationId: string; palletId?: string }): Promise<void>;
  createOrder(lines: OrderLine[], orderId?: string): Promise<string>;
  startPicking(orderId: string): Promise<void>;
  /** Eén pick op een locatie; boekt de voorraad daar af. */
  confirmPickLine(p: { orderId: string; sku: string; qty: number; locationId: string }): Promise<void>;
  /** Rondt de order af; boekt alleen af wat nog niet per regel is gepickt. */
  confirmPick(orderId: string): Promise<void>;
  stageOrder(p: { orderId: string; dockId: string }): Promise<void>;
  loadOrder(p: { orderId: string; truckId: string }): Promise<void>;
  truckCheckIn(p: { truckId: string; direction: 'in' | 'out'; dockId: string }): Promise<void>;
  truckCheckOut(p: { truckId: string }): Promise<void>;
  /**
   * De inkomende vrachtwagens die de WMS zelf heeft aangemeld (de flow 'Simulatie: leveringen en orders').
   * Ontbreekt bij een WMS die geen leveringen aanmaakt (de mock): dan laat de hal zelf vrachtwagens komen.
   */
  getDeliveries?(): Promise<WmsDelivery[]>;
  /**
   * Lossen van een levering uit de WMS: de pallet gaat daar van de dockdeur (DOCK-NN) naar de inslagbaan (DOCK-NN-IN).
   * false = de WMS heeft geen ontvangst van deze pallet die nog gelost moet worden; er is niets geboekt.
   */
  unloadReceipt?(p: { palletId: string }): Promise<boolean>;
  /**
   * Tellen van een geloste pallet op de inslagbaan; pas daarna mag hij worden weggezet.
   * false = de WMS heeft geen ontvangst van deze pallet die nog geteld moet worden; er is niets geboekt.
   */
  countReceipt?(p: { palletId: string; qty: number }): Promise<boolean>;
  // --- Robots (docs/wms/08). Ontbreken ze (de mock), dan speelt de game de robotsturing zelf na. ---
  /** De nummers van de robots die de WMS kent (GKP-01, …): alleen die kunnen een opdracht terugmelden. */
  getRobots?(): Promise<string[]>;
  /** De opdrachten met status open; met `running` ook die waar een robot mee bezig is (in_progress). */
  getRobotTasks?(running?: boolean): Promise<WmsRobotTask[]>;
  startRobotTask?(p: { taskId: string; robotId: string }): Promise<void>;
  /** De robot staat met de pallet op de doellocatie: de WMS boekt de pallet om. */
  completeRobotTask?(p: { taskId: string; robotId: string }): Promise<void>;
  failRobotTask?(p: { taskId: string; robotId?: string; reason: string; palletOnRobot: boolean }): Promise<void>;
  /** Logboek van scans; verandert niets aan de voorraad. */
  logScan(p: { kind: 'truck' | 'pallet' | 'location' | 'order'; barcode: string; ok: boolean; locationId?: string }): Promise<void>;
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
