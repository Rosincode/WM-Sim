# 05 — De hal: 10 docks en 16 stellingen

De hal is 56 × 72 meter en heeft 10 dockdeuren in de westwand en 16 stellingen. Het datamodel is
dat van 01; dit document geeft de **locaties** die de WMS moet kennen.

De `location_id`'s moeten exact overeenkomen: de game stuurt ze mee bij elke scan en boeking. Een
locatie die de WMS niet kent, weigert hij.

## 1. Overzicht

| Soort | Aantal | Codes |
|---|---|---|
| Dockdeuren | 10 | `DOCK-01` … `DOCK-10` |
| Inslaglocaties | 10 | `DOCK-01-IN` … `DOCK-10-IN` |
| Uitslaglocaties | 10 | `DOCK-01-UIT` … `DOCK-10-UIT` |
| Stellinglocaties | 336 | `R1A-01-1` … `R8B-07-3` (zie 11) |
| **Totaal** | **366** | |

`location_id` blijft binnen de maximale lengte van 20 tekens (langste: `DOCK-10-UIT`).

## 2. Docklocaties (30)

Alle docklocaties: type `dock`, `level` = 0.

Per dockdeur `NN` (01 t/m 10) drie locaties:

- `DOCK-NN` — de deur zelf (`pos_x` = -28): hier meldt een vrachtwagen zich aan en af en wordt
  geladen. De WMS boekt hier ook de ontvangst van een levering die hij zelf aanmaakt (zie 10); die
  voorraad staat er tot de pallet is gelost.
- `DOCK-NN-IN` — inslaglocatie: hier staan geloste pallets tot ze zijn weggezet (zes plekken).
- `DOCK-NN-UIT` — uitslaglocatie: hier staan gepickte orders klaar voor de vrachtwagen (zes plekken).

De deur ligt op `pos_y` = -22.5 + (NN − 1) × 5. De inslag- en uitslaglocatie hebben `pos_x` = -20.3;
de inslaglocatie ligt 1.3 lager dan de deur, de uitslaglocatie 1.3 hoger:

| Dock | `DOCK-NN` pos_y | `DOCK-NN-IN` pos_y | `DOCK-NN-UIT` pos_y |
|---|---|---|---|
| 01 | -22.5 | -23.8 | -21.2 |
| 02 | -17.5 | -18.8 | -16.2 |
| 03 | -12.5 | -13.8 | -11.2 |
| 04 | -7.5 | -8.8 | -6.2 |
| 05 | -2.5 | -3.8 | -1.2 |
| 06 | 2.5 | 1.2 | 3.8 |
| 07 | 7.5 | 6.2 | 8.8 |
| 08 | 12.5 | 11.2 | 13.8 |
| 09 | 17.5 | 16.2 | 18.8 |
| 10 | 22.5 | 21.2 | 23.8 |

## 3. Stellinglocaties (336)

Zie 11: acht paden met aan elk pad een stelling A en een stelling B, elk 7 secties × 3 niveaus.
Niveau 1 is type `pick`, niveau 2 en 3 zijn type `rack`. Een stellinglocatie heeft drie
palletplekken naast elkaar.

## 4. Welke locatie bij welke aanroep

- `goods_receipt`: `dock_id` is de inslaglocatie (`DOCK-NN-IN`) als een speler lost. Bij een levering
  uit de WMS staat de ontvangst op de deur (`DOCK-NN`), zie 10.
- `pallet_move` en `putaway`: van een inslaglocatie of stellinglocatie naar een stellinglocatie.
- `stage_order`: `dock_id` is een uitslaglocatie (`DOCK-NN-UIT`).
- `truck_visit`: `dock_id` is de dockdeur zelf (`DOCK-NN`).

## 5. Indeling wijzigen

De indeling van de hal staat in de game in één bestand (`src/sim/warehouse.json`) en is in de game
te bewerken. De game vergelijkt zijn locaties bij het aanmelden met die van de WMS en meldt in het
WMS-paneel (toets K) wat er ontbreekt, wat de WMS extra heeft en wat een andere positie heeft; de
ontbrekende locaties zijn daar als CSV te downloaden (kolommen `location_id`, `location_type`,
`pos_x`, `pos_y`, `level`, `blocked`). Aanmaken via de API kan niet: locaties worden in de WMS-app
beheerd.
