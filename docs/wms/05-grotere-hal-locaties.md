# 05 — Grotere hal: 10 docks en 11 stellingen

De game heeft een groter magazijn gekregen. Het datamodel en de acties veranderen niet; alleen de
**seed-data van de locaties** wordt vervangen. Dit document vervangt paragraaf 4.1 van
`01-basis-datamodel.md` (62 locaties) door de 261 locaties hieronder.

De `location_id`'s moeten exact overeenkomen: de game stuurt ze mee in `register_goods_received`,
`confirm_putaway` en de procesacties uit `04-procesacties.md`.

## 1. Wat er verandert

| | Oud | Nieuw |
|---|---|---|
| Docks | `DOCK-01` (inslag), `DOCK-02` (uitslag) | 10 dockdeuren, elk met de deur zelf plus een eigen inslag- en uitslaglocatie (30 locaties) |
| Stellingen | 4 rijen × 5 secties × 3 niveaus = 60 | 11 rijen × 7 secties × 3 niveaus = 231 |
| Totaal | 62 locaties | 261 locaties |

- `DOCK-01` en `DOCK-02` blijven bestaan, maar zijn nu alleen nog de deur: er hoort geen voorraad
  meer op te staan. Staat die er nog, verplaats die dan naar `DOCK-01-IN`.
- De bestaande stellingcodes (`R1-01-1` t/m `R4-05-3`) blijven geldig, maar hun `pos_x`/`pos_y`
  wijzigen. Voorraad op die locaties kan blijven staan.
- `location_id` blijft binnen de maximale lengte van 20 tekens (langste: `DOCK-10-UIT`).

## 2. Docklocaties (30)

Alle docklocaties: type `dock`, `level` = 0.

Per dockdeur `NN` (01 t/m 10) drie locaties:

- `DOCK-NN` — de deur zelf (`pos_x` = -28): hier meldt een vrachtwagen zich aan en af en wordt
  geladen. Er staat nooit voorraad op.
- `DOCK-NN-IN` — inslaglocatie: hier staan geloste pallets tot ze zijn weggezet.
- `DOCK-NN-UIT` — uitslaglocatie: hier staan gepickte orders klaar voor de vrachtwagen.

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

## 3. Stellinglocaties (231)

- `location_id` = `R{rij}-{sectie:2 cijfers}-{niveau}`, bijvoorbeeld `R11-07-3`. Het rijnummer heeft
  geen voorloopnul (`R1` … `R11`).
- `pos_x` hangt af van de sectie:

  | Sectie | 01 | 02 | 03 | 04 | 05 | 06 | 07 |
  |---|---|---|---|---|---|---|---|
  | pos_x | -8 | -4 | 0 | 4 | 8 | 12 | 16 |

- `pos_y` hangt af van de rij: `pos_y` = -25 + (rij − 1) × 5.

  | Rij | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
  |---|---|---|---|---|---|---|---|---|---|---|---|
  | pos_y | -25 | -20 | -15 | -10 | -5 | 0 | 5 | 10 | 15 | 20 | 25 |

- `level` is 1, 2 of 3. Niveau 1 is type `pick`, niveau 2 en 3 zijn type `rack` (ongewijzigd).

## 4. Gevolgen voor de acties

Geen nieuwe acties of velden. Wel goed om te weten:

- `register_goods_received`: `dock_id` is nu altijd een inslaglocatie (`DOCK-NN-IN`). De controle
  "bestaat en is van type `dock`" blijft gelijk.
- `confirm_putaway`: `from_location_id` is de inslaglocatie waar de pallet stond.
- `stage_order` (zie 04): `dock_id` is een uitslaglocatie (`DOCK-NN-UIT`).
- `truck_check_in`, `truck_check_out` en `load_order` (zie 04): `dock_id` is de dockdeur zelf
  (`DOCK-NN`, zonder `-IN`/`-UIT`). De controle "is van type `dock`" blijft dus kloppen.
- `confirm_pick`: de bronvolgorde (eerst `pick`, dan `rack`, daarna op `location_id`) sorteert als
  tekst, dus `R10` en `R11` komen vóór `R2`. De game gebruikt dezelfde tekstsortering; houd dat zo.

## 5. Beginvoorraad

Optioneel: met 231 stellinglocaties oogt de hal leeg bij de 25 voorraadregels uit 01. Ongeveer 70
regels, willekeurig verdeeld over de stellinglocaties (5 tot 50 stuks per regel), vult de hal beter.
