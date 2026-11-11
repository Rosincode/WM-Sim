# WM-Sim
- Architectuur: sim publiceert events via src/shared/bus.ts; UI leest alleen state; integrations luisteren op events.
- src/shared/* NIET wijzigen; stel wijzigingen voor in de chat.
- Integrations hebben altijd een mock-modus (import.meta.env.VITE_USE_MOCK) zodat de game zonder server werkt.
- Kleine, werkende stappen; nooit de build breken.
- Starten: `npm run dev` (http://localhost:5173). Check vóór je klaar bent: `npm run build` moet slagen.
