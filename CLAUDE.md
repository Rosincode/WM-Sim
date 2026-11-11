# WM-Sim
- Stack: Vite + TypeScript + Three.js (3D). Camera-modi: overzicht (OrbitControls) en third person (volgcamera), wisselen met C.
- Architectuur: sim publiceert events via src/shared/bus.ts; UI leest alleen state; integrations luisteren op events.
- src/shared/* NIET wijzigen; stel wijzigingen voor in de chat.
- Integrations hebben altijd een mock-modus: zonder WMS-login draait alles op de mock-client (src/integrations/wms/mock.ts), dus de game werkt ook zonder WMS.
- WMS-inloggegevens worden alleen in het inlogpaneel ingevuld (sessionStorage). NOOIT in code, repo, build of VITE_-variabelen: de repo en GitHub Page zijn publiek.
- Instructies voor de WMS-app (entiteiten, acties) staan in docs/wms/; de URL-opbouw van de WMS-API zit alleen in src/integrations/wms/live.ts.
- Kleine, werkende stappen; nooit de build breken.
- Git: er is geen automatische sync meer. Commit en push nooit uit jezelf. Sluit elke afgeronde aanpassing (build slaagt) af met de vraag aan de gebruiker of je mag committen en pushen; noem daarbij kort wat erin zit. Stel die vraag als klikbare keuze met de AskUserQuestion-tool (opties: "Committen en pushen", "Alleen committen", "Niets doen"), niet als losse tekst. Bij ja: `git pull --rebase`, conflicten oplossen, dan pushen. Bij nee: niets doen.
- Starten: `npm run dev` (http://localhost:5173). Check vóór je klaar bent: `npm run build` moet slagen.
