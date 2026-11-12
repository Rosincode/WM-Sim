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

## Stijl van 3D-modellen
Alles in de hal (voertuigen, apparaten, inrichting) heeft dezelfde stijl; de heftruck (src/ui/scene/forklift.ts) is het voorbeeld.
- Strakke, ronde vormen in een paar effen materialen. Geen textures, normal maps of afbeeldingen op modellen: het detail zit in de vorm (afgeronde hoeken, afschuiningen, losse onderdelen zoals velgen, cilinders en beugels).
- Alles is mat: weinig glans, weinig metaal. Geen model mag meer glimmen dan een ander; pas glans alleen aan in `STYLE`, zodat het voor alles tegelijk verandert.
- Elk onderdeel heeft het materiaal dat erbij hoort (banden en wielen helemaal rubber, geen lak die doorloopt op een wiel).
- Materialen komen uit `STYLE` in src/ui/scene/style.ts (rode lak, donkergrijs, zwart, blank staal, rubber, bekleding). Geen eigen kleuren per model verzinnen; ontbreekt er een materiaal, voeg het dan daar toe.
- Bij voorkeur opgebouwd in code (zie de hulpjes `profile`, `tube` en `RoundedBoxGeometry` in forklift.ts), op ware grootte in meters, voorkant naar +Z.
- Ingeladen modellen (.glb in src/ui/assets) leveren alleen de vorm: textures eruit halen vóór het toevoegen, en na het laden `restyle()` uit style.ts aanroepen voor de materialen en egale vlakken. Altijd een eenvoudige reservevorm als het laden mislukt.
- Uitzondering: stickers, schermen en borden met tekst mogen een (canvas)texture hebben.
- Alles werpt en ontvangt schaduw; lampjes zijn `MeshBasicMaterial` of emissive.

## Vlakken op vlakken (laag +1)
Een plat vlak dat op een ander vlak ligt, flikkert zodra je er wat verder vanaf staat, hoe dun de spleet ertussen ook is. Dit geldt voor alles in en om de hal.
- Elk vlak dat óp iets ligt (sticker, label, bord, logo, scherm, vloermarkering, vloerplaat) krijgt `onTop(materiaal)` uit src/ui/scene/style.ts: laag +1 boven zijn ondergrond.
- Ligt het op iets dat zelf al een laag is, dan een laag meer: `onTop(materiaal, 2)`. Voorbeeld: vloer 0, vloerverf +1, het gekleurde baanvlak daarover +2.
- Geen losse `polygonOffset`-waarden in de code en niet oplossen door het vlak een stukje op te tillen; een kleine afstand (enkele mm) mag blijven, de laag doet het werk.
- Twee massieve onderdelen liggen nooit precies in hetzelfde vlak: laat het ene minstens 3 mm uitsteken of verzinken.
