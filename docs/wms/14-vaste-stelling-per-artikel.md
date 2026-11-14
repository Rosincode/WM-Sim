# 14 — Tien paden: elk dock zijn eigen pad, elk pad zijn eigen artikel

De hal is opnieuw ingedeeld (2026-11-14). Er zijn nu **10 stellingpaden**, één recht voor elk dock, en
elk pad heeft één eigen robot (artikel): pad 1 (`R1A` en `R1B`) ligt voor `DOCK-01` en is van
`SKU-001`, pad 2 voor `DOCK-02` is van `SKU-002`, enzovoort. Op de kop van elke stelling hangt een
postertje met de robot van dat pad.

Dit vervangt de indeling met 8 paden uit 11 en de `pos_y`-tabel in 13 (2.1).

## 1. Wat er verandert

| | Was | Nu |
|---|---|---|
| Paden | 8 | 10 |
| Stellingen | 16 (`R1A` … `R8B`) | 20 (`R1A` … `R10B`) |
| Stellinglocaties | 336 | 420 (84 erbij: `R9A`, `R9B`, `R10A`, `R10B`, elk 7 secties × 3 niveaus) |
| Totaal locaties | 366 | 450 |
| Afstand tussen twee docks | 5 m | 6,3 m (gelijk aan de afstand tussen twee paden) |
| Diepte van de hal | 72 m | 84 m |
| Padrobots | 16 | 20 (`GKP-09`, `GKP-10`, `GKF-09`, `GKF-10` erbij) |

De codes van de bestaande locaties blijven gelijk; alleen hun `pos_y` verandert. `pos_x`, `level` en
`location_type` blijven zoals ze zijn (docklocaties: `pos_x` -28 voor de deur, -20.3 voor `-IN` en
`-UIT`).

## 2. De indeling, met `pos_y`

| Pad | Artikel | Robot | Stelling A | Stelling B | Dock | `-IN` | `-UIT` |
|---|---|---|---|---|---|---|---|
| 1 | `SKU-001` | Stofzuigrobot Dusty | `R1A` -30.85 | `R1B` -25.85 | `DOCK-01` -28.35 | -29.65 | -27.05 |
| 2 | `SKU-002` | Wasvouwrobot Foldy | `R2A` -24.55 | `R2B` -19.55 | `DOCK-02` -22.05 | -23.35 | -20.75 |
| 3 | `SKU-003` | Robothond Bolt | `R3A` -18.25 | `R3B` -13.25 | `DOCK-03` -15.75 | -17.05 | -14.45 |
| 4 | `SKU-004` | Robotkat Miso | `R4A` -11.95 | `R4B` -6.95 | `DOCK-04` -9.45 | -10.75 | -8.15 |
| 5 | `SKU-005` | Dansrobot Groove | `R5A` -5.65 | `R5B` -0.65 | `DOCK-05` -3.15 | -4.45 | -1.85 |
| 6 | `SKU-006` | Ramenwasrobot Clearo | `R6A` 0.65 | `R6B` 5.65 | `DOCK-06` 3.15 | 1.85 | 4.45 |
| 7 | `SKU-007` | Robotvogel Pip | `R7A` 6.95 | `R7B` 11.95 | `DOCK-07` 9.45 | 8.15 | 10.75 |
| 8 | `SKU-008` | Muziekrobot Beat | `R8A` 13.25 | `R8B` 18.25 | `DOCK-08` 15.75 | 14.45 | 17.05 |
| 9 | `SKU-009` | Robotkonijn Hop | `R9A` 19.55 | `R9B` 24.55 | `DOCK-09` 22.05 | 20.75 | 23.35 |
| 10 | `SKU-010` | Goochelrobot Magix | `R10A` 25.85 | `R10B` 30.85 | `DOCK-10` 28.35 | 27.05 | 29.65 |

Als formule, voor pad en dock `n` (1 t/m 10): het pad en `DOCK-NN` liggen op `pos_y` = -28.35 +
(n − 1) × 6.3; stelling A 2.5 lager, stelling B 2.5 hoger; `DOCK-NN-IN` 1.3 lager, `DOCK-NN-UIT` 1.3
hoger. Nieuwe stellinglocaties: sectie 01 t/m 07 op `pos_x` -8, -4, 0, 4, 8, 12, 16; niveau 1 is
`pick`, niveau 2 en 3 zijn `rack`.

De game biedt alles als CSV aan in het WMS-paneel (toets K): de 84 ontbrekende locaties (*Lijst
(CSV)*) en de bestaande locaties met hun nieuwe positie (*download de juiste gegevens (CSV)*).

Het artikel van een pad is het artikel met dat `volgnr`, gelijk aan `vast_dock`. De game leidt het af
uit de artikellijst (op `sku` gesorteerd); een veld is niet nodig.

## 3. Te doen in de WMS-app

1. **84 locaties toevoegen** (`R9A-01-1` … `R10B-07-3`) en **`pos_y` van alle locaties bijwerken**
   (hoofdstuk 2). Tot de locaties er zijn weigert de WMS elke boeking in pad 9 en 10.
2. **Vier robots toevoegen:** `GKP-09`, `GKP-10` (tilrobot) en `GKF-09`, `GKF-10` (heftruck).
3. **Doellocatie van een robotopdracht.** Bij `wegzetten` kiest de WMS een vrije locatie in het pad
   van het artikel (eerst niveau 1). Alleen als het pad vol is: een ander pad.
4. **De bestaande voorraad herverdelen.** Nu liggen vijf artikelen door elkaar in `R1A` t/m `R6A`.
   Verplaats elke pallet naar het pad van zijn artikel: als robotopdrachten (dan rijden de robots
   in de hal ze om), of in één keer in de gegevens gevolgd door *Hal resetten* in de game.
5. **Capaciteit.** Een pad heeft 42 locaties × 3 pallets = 126 palletplekken.
6. **API-beschrijving bijwerken** (aantal locaties, `pos_y`-formule, robots).

## 4. Wat de game doet

- Zonder WMS-login (mock) zetten de robots een pallet weg in het pad van zijn artikel, en pas
  elders als dat vol is. Met de WMS bepaalt de WMS de doellocatie (punt 3).
- Een speler die met de hand wegzet wordt niet tegengehouden: dat beslist de WMS.
- De ingebouwde mock-WMS kent alleen `SKU-001` t/m `SKU-005`; de postertjes van pad 6 t/m 10 hangen
  er wel.

## Terug te melden

- Dat de locaties, posities en robots zijn bijgewerkt.
- Hoe de bestaande voorraad wordt herverdeeld.
