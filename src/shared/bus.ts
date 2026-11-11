import type { SimEvent } from './contract';
type Handler = (e: SimEvent) => void;
const handlers: Handler[] = [];
export const bus = {
  emit: (e: SimEvent) => handlers.forEach(h => h(e)),
  on:   (h: Handler) => { handlers.push(h); return () => handlers.splice(handlers.indexOf(h), 1); },
};
