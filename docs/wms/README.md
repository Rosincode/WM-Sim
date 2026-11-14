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
| [08](08-geekplus-robots.md) | Robots en robotopdrachten | het voorstel; gebouwd, zie 12 |
| [09](09-realistisch-datamodel.md) | Alle aanroepen van de game op een rij, rechten, open punten | actueel |
| [10](10-leveringen-uit-de-wms.md) | Leveringen uit de WMS, robots lossen en tellen | actueel |
| [11](11-dubbele-stellingen.md) | 16 stellingen rug-aan-rug, codes `R1A` … `R8B` | gedaan in de WMS, op `pos_y` na (zie 13) |
| [12](12-robotkoppeling.md) | Robotopdrachten uit de WMS, lossen en tellen | de game gebruikt het; **nog te doen in de WMS**: 8 robots, `pos_y`, limiet |
| [13](13-wms-gelijk-met-de-hal.md) | Vergelijking hal en WMS van 2026-11-14; de game werkt palletlocaties in de WMS bij | **nog te doen in de WMS**: `pos_y`, 8 robots, ontvangsten zonder pallet, correctie-actie |
| [14](14-vaste-stelling-per-artikel.md) | Elk pad zijn eigen artikel (R1 = `SKU-001`, …); bord met de robot op de kop | **nog te doen in de WMS**: doellocatie van robotopdrachten, voorraad herverdelen |

## Wat er in de WMS nog moet gebeuren

Gecontroleerd met de API-client van de game op 2026-11-14; de details staan in [13](13-wms-gelijk-met-de-hal.md).

1. **`pos_y` van de stellingen** (13, 2.1). De 366 locaties bestaan met de juiste codes; van 315
   stellinglocaties wijkt alleen `pos_y` af.
2. **Acht robots toevoegen** (13, 2.2): `GKP-02`, `-04`, `-06`, `-08` en `GKF-01`, `-03`, `-05`, `-07`.
3. **Ontvangsten van `simulatie_tick` krijgen geen pallet** (13, 2.3 en 2.4): lossen, tellen en
   wegzetten kunnen daardoor niet in de WMS worden geboekt.
4. **Correctie-actie voor aantallen** (13, 2.5): nieuw voorstel.
5. **Insluiten in een iframe** (06) werkt nog niet.
