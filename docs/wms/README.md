# WMS-instructies voor WM-Sim

WM-Sim (de game) is de **fysieke wereld** van een magazijn; de WMS-app is het **systeem**. Deze map
beschrijft wat de WMS-app nodig heeft om met de game samen te werken. De documenten zijn in de loop
van de bouw ontstaan en op 2026-11-13 bijgewerkt naar de stand van dat moment.

De beschrijving van de API zelf staat in de WMS: `GET {basis-URL}/_openapi`. Die is leidend. De
URL-opbouw in de game staat alleen in `src/integrations/wms/live.ts`.

| Nr | Onderwerp | Stand |
|---|---|---|
| [01](01-basis-datamodel.md) | Entiteiten en kernacties | actueel |
| [02](02-toegang-api-sleutel-cors.md) | Aanmelden met een API-sleutel, HTTPS, CORS, vorm van de API | actueel |
| [03](03-robotassortiment.md) | Artikelen: de robots die het bedrijf verkoopt | actueel |
| [04](04-procesacties.md) | Vrachtwagens, scanlog, picken per regel, klaarzetten, inladen | actueel |
| [05](05-grotere-hal-locaties.md) | De 30 docklocaties | actueel; de stellingen staan in 11 |
| [06](06-wms-leidend-scanner.md) | De WMS beslist; schermen in de WMS-app; iframe | actueel; het iframe werkt nog niet |
| [07](07-palletstickers.md) | Pallets met een sticker, palletverplaatsing | actueel |
| [08](08-geekplus-robots.md) | Robots en robotopdrachten | voorstel: `robot` en `robot_task` bestaan nog niet in de WMS |
| [09](09-realistisch-datamodel.md) | Alle aanroepen van de game op een rij, rechten, open punten | actueel |
| [10](10-leveringen-uit-de-wms.md) | Leveringen uit de WMS, robots lossen en tellen | actueel |
| [11](11-dubbele-stellingen.md) | 16 stellingen rug-aan-rug, codes `R1A` … `R8B` | **nog te doen in de WMS** |

## Wat er in de WMS nog moet gebeuren

Gecontroleerd met de API-client van de game op 2026-11-13:

1. **Stellinglocaties hernoemen en aanvullen** (11). De WMS heeft nog de 231 oude codes
   (`R1-01-1` … `R11-07-3`); de hal heeft er 336 met nieuwe codes (`R1A-01-1` … `R8B-07-3`). Tot dat
   is gedaan weigert de WMS elke scan en boeking op een stellinglocatie.
2. **Rechten van de API-client** (09, 10). `GET pallet` en `GET truck_visit` geven `403`.
3. **Robotopdrachten** (08) bestaan niet in de WMS; de game speelt ze zelf na.
4. **Insluiten in een iframe** (06) werkt nog niet.
