// Robotassortiment van het magazijn. Moet gelijk blijven aan de seed-data in docs/wms/03-robotassortiment.md.

export type RobotCategory = 'huishouden' | 'huisdier' | 'vermaak';

export type Robot = { sku: string; description: string; category: RobotCategory };

export const ROBOTS: readonly Robot[] = [
  { sku: 'SKU-001', description: 'Stofzuigrobot Dusty', category: 'huishouden' },
  { sku: 'SKU-002', description: 'Wasvouwrobot Foldy', category: 'huishouden' },
  { sku: 'SKU-003', description: 'Robothond Bolt', category: 'huisdier' },
  { sku: 'SKU-004', description: 'Robotkat Miso', category: 'huisdier' },
  { sku: 'SKU-005', description: 'Dansrobot Groove', category: 'vermaak' },
];

/** Dooskleur per categorie, zodat je in de stelling ziet wat waar ligt. */
export const CATEGORY_COLORS: Record<RobotCategory, string> = {
  huishouden: '#4fa3e0',
  huisdier: '#e08a4f',
  vermaak: '#b46be0',
};

export const CATEGORY_LABELS: Record<RobotCategory, string> = {
  huishouden: 'Huishoudrobot',
  huisdier: 'Robothuisdier',
  vermaak: 'Vermaakrobot',
};

export function robotBySku(sku: string): Robot | undefined {
  return ROBOTS.find((r) => r.sku === sku);
}
