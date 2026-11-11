import type { ProcessEvent } from './events';

// De poort van de sim naar de WMS. De sim is alleen de fysieke wereld: bij elke handeling vraagt hij
// de WMS om die te verwerken, en pas als de WMS akkoord is gebeurt het ook fysiek.
// Wie de poort invult (de echte WMS, de mock) bepaalt src/ui/wmsGateway.ts.

/** linked = de WMS heeft de handeling echt verwerkt; false = er is (nog) geen endpoint voor. */
export type WmsReply = { ok: true; linked: boolean } | { ok: false; error: string };

export interface WmsGateway {
  send(e: ProcessEvent): Promise<WmsReply>;
}

/** Zonder WMS: elke handeling mag, niets wordt geboekt. */
export const offlineGateway: WmsGateway = { send: async () => ({ ok: true, linked: false }) };
