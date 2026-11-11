# WM-Sim
- Stack: Vite + TypeScript + Three.js (3D). Camera-modi: overzicht (OrbitControls) en third person (volgcamera), wisselen met C.
- Architectuur: sim publiceert events via src/shared/bus.ts; UI leest alleen state; integrations luisteren op events.
- src/shared/* NIET wijzigen; stel wijzigingen voor in de chat.
- Integrations hebben altijd een mock-modus: zonder WMS-login draait alles op de mock-client (src/integrations/wms/mock.ts), dus de game werkt ook zonder WMS.
- WMS-inloggegevens worden alleen in het inlogpaneel ingevuld (sessionStorage). NOOIT in code, repo, build of VITE_-variabelen: de repo en GitHub Page zijn publiek.
- Instructies voor de WMS-app (entiteiten, acties) staan in docs/wms/; de URL-opbouw van de WMS-API zit alleen in src/integrations/wms/live.ts.
- Kleine, werkende stappen; nooit de build breken.
- Starten: `npm run dev` (http://localhost:5173). Check vóór je klaar bent: `npm run build` moet slagen.
