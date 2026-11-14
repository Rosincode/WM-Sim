# 14 — Elk pad zijn eigen artikel

In de hal heeft elk stellingpad één eigen robot (artikel): pad 1 (`R1A` en `R1B`) is `SKU-001`, pad 2
is `SKU-002`, enzovoort. Op de kop van elke stelling hangt een bord met de afbeelding van die robot,
zodat je vanaf het looppad ziet wat er in het pad ligt. De WMS moet dezelfde indeling aanhouden,
anders klopt het bord niet met wat er ligt.

**Stand 2026-11-14:** in de WMS liggen de vijf artikelen met voorraad door elkaar in `R1A` t/m `R6A`.
De game toont dat op het bord als *Ligt hier ook: …*.

## 1. De indeling

Het artikel met `volgnr` n ligt in pad n, in stelling A en B (dezelfde volgorde als `vast_dock`):

| Artikel | Robot | Pad | Stellingen | Vast dock |
|---|---|---|---|---|
| `SKU-001` | Stofzuigrobot Dusty | 1 | `R1A`, `R1B` | `DOCK-01` |
| `SKU-002` | Wasvouwrobot Foldy | 2 | `R2A`, `R2B` | `DOCK-02` |
| `SKU-003` | Robothond Bolt | 3 | `R3A`, `R3B` | `DOCK-03` |
| `SKU-004` | Robotkat Miso | 4 | `R4A`, `R4B` | `DOCK-04` |
| `SKU-005` | Dansrobot Groove | 5 | `R5A`, `R5B` | `DOCK-05` |
| `SKU-006` | Ramenwasrobot Clearo | 6 | `R6A`, `R6B` | `DOCK-06` |
| `SKU-007` | Robotvogel Pip | 7 | `R7A`, `R7B` | `DOCK-07` |
| `SKU-008` | Muziekrobot Beat | 8 | `R8A`, `R8B` | `DOCK-08` |
| `SKU-009` | Robotkonijn Hop | geen | | `DOCK-09` |
| `SKU-010` | Goochelrobot Magix | geen | | `DOCK-10` |

**Open punt:** de hal heeft 8 paden en er zijn 10 artikelen. `SKU-009` en `SKU-010` hebben geen eigen
pad. Tot de hal twee paden groter is (dan komen er 84 locaties bij: `R9A` t/m `R10B`) kan de WMS ze
het beste niet laten leveren, of ze wegzetten waar plek is.

De game leidt de indeling af uit de artikellijst: artikelen op `sku` gesorteerd, het n-de artikel in
pad n. Een veld is daarvoor niet nodig; komt er in de WMS een veld `vast_pad` op `item`, meld dat
dan, dan neemt de game dat over.

## 2. Te doen in de WMS-app

1. **Doellocatie van een robotopdracht.** Bij `wegzetten` kiest de WMS een vrije locatie in het pad
   van het artikel (eerst niveau 1). Alleen als het pad vol is: een ander pad.
2. **Aanvullen** blijft binnen dezelfde stelling (van niveau 2 of 3 naar niveau 1); dat is al zo.
3. **De bestaande voorraad herverdelen.** De pallets die nu in een ander pad staan naar het pad van
   hun artikel verplaatsen: als robotopdrachten (`aanleiding` = `hand` of een nieuwe waarde
   `herindelen`), dan rijden de robots in de hal ze om, of in één keer in de gegevens gevolgd door
   *Hal resetten* in de game.
4. **Capaciteit.** Een pad heeft 42 locaties × 3 pallets = 126 palletplekken. De beginvoorraad per
   artikel moet daarin passen.

## 3. Wat de game doet

- Het bord op de kop van elke stelling toont de robot van het pad. Ligt er iets anders, dan staat
  dat klein onderaan.
- Zonder WMS-login (mock) zetten de robots een pallet weg in het pad van zijn artikel, en pas
  elders als dat vol is. Met de WMS bepaalt de WMS de doellocatie (punt 1).
- Een speler die met de hand wegzet wordt niet tegengehouden: dat beslist de WMS.

## Terug te melden

- Of de WMS de indeling uit hoofdstuk 1 overneemt, en hoe de bestaande voorraad wordt herverdeeld.
- Wat er met `SKU-009` en `SKU-010` gebeurt.
