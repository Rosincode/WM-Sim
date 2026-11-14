# 14 — Elk artikel zijn eigen stelling

In de hal heeft elke stelling één eigen robot (artikel). Op de kop van de stelling hangt een bord met
de afbeelding van die robot, zodat je vanaf het looppad ziet wat er in het pad links (A) en rechts
(B) ligt. De WMS moet dezelfde indeling aanhouden, anders klopt het bord niet met wat er ligt.

**Stand 2026-11-14:** in de WMS liggen de vijf artikelen met voorraad door elkaar in `R1A` t/m `R6A`.
De game toont dat op het bord als *Ligt hier ook: …*.

## 1. De indeling

Het artikel met `volgnr` n ligt in de n-de stelling (dezelfde volgorde als `vast_dock`):

| Artikel | Robot | Stelling | Vast dock |
|---|---|---|---|
| `SKU-001` | Stofzuigrobot Dusty | `R1A` | `DOCK-01` |
| `SKU-002` | Wasvouwrobot Foldy | `R1B` | `DOCK-02` |
| `SKU-003` | Robothond Bolt | `R2A` | `DOCK-03` |
| `SKU-004` | Robotkat Miso | `R2B` | `DOCK-04` |
| `SKU-005` | Dansrobot Groove | `R3A` | `DOCK-05` |
| `SKU-006` | Ramenwasrobot Clearo | `R3B` | `DOCK-06` |
| `SKU-007` | Robotvogel Pip | `R4A` | `DOCK-07` |
| `SKU-008` | Muziekrobot Beat | `R4B` | `DOCK-08` |
| `SKU-009` | Robotkonijn Hop | `R5A` | `DOCK-09` |
| `SKU-010` | Goochelrobot Magix | `R5B` | `DOCK-10` |

`R6A` t/m `R8B` (zes stellingen) hebben geen eigen artikel: vrije stellingen, voor overloop.

De game leidt de indeling af uit de artikellijst: artikelen op `sku` gesorteerd, het n-de artikel in
de n-de stelling (`R1A`, `R1B`, `R2A`, …). Een veld is daarvoor niet nodig; komt er in de WMS een
veld `vaste_stelling` op `item`, meld dat dan, dan neemt de game dat over.

## 2. Te doen in de WMS-app

1. **Doellocatie van een robotopdracht.** Bij `wegzetten` kiest de WMS een vrije locatie in de
   stelling van het artikel (eerst niveau 1). Alleen als die stelling vol is: een vrije stelling
   (`R6A` t/m `R8B`).
2. **Aanvullen** blijft binnen dezelfde stelling (van niveau 2 of 3 naar niveau 1); dat is al zo.
3. **De bestaande voorraad herverdelen.** De pallets die nu in een andere stelling staan naar de
   stelling van hun artikel verplaatsen: als robotopdrachten (`aanleiding` = `hand` of een nieuwe
   waarde `herindelen`), dan rijden de robots in de hal ze om, of in één keer in de gegevens gevolgd
   door *Hal resetten* in de game.
4. **Capaciteit.** Een stelling heeft 21 locaties × 3 pallets = 63 palletplekken. De beginvoorraad
   per artikel moet daarin passen.

## 3. Wat de game doet

- Het bord op de kop van elke stelling toont de robot van die stelling; een vrije stelling toont
  *Vrije stelling*. Ligt er iets anders, dan staat dat klein onderaan.
- Zonder WMS-login (mock) zetten de robots een pallet weg in de stelling van zijn artikel, en pas
  elders als die vol is. Met de WMS bepaalt de WMS de doellocatie (punt 1).
- Een speler die met de hand wegzet wordt niet tegengehouden: dat beslist de WMS.

## Terug te melden

- Of de WMS de indeling uit hoofdstuk 1 overneemt, en hoe de bestaande voorraad wordt herverdeeld.
