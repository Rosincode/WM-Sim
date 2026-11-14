# 13 — De WMS gelijktrekken met de hal

De hal (de game) is de fysieke wereld en ligt vast; waar de WMS afwijkt, moet de WMS worden
aangepast. Op 2026-11-14 zijn alle gegevens van de WMS (via de API-client van de game) naast de hal
gelegd. Dit document zegt wat er klopt, wat er in de WMS-app moet worden rechtgezet en wat de game
sindsdien zelf doet.

## 1. Wat klopt

- **Locaties:** alle 366 locaties van de hal staan in de WMS, met de juiste code, het juiste type en
  niveau; de WMS heeft geen locaties die de hal niet heeft.
- **Artikelen:** 10 (`SKU-001` … `SKU-010`); de hal neemt ze over uit de WMS.
- **Orders:** de 20 open orders zijn aan beide kanten dezelfde.
- **Pallets in de stellingen:** 68 van de 74 staan op dezelfde locatie met hetzelfde aantal.

## 2. Recht te zetten in de WMS-app

### 2.1 `pos_y` van de stellingen (315 locaties)

**Vervallen:** de hal heeft sinds 2026-11-14 tien paden; de juiste posities staan in
[14](14-vaste-stelling-per-artikel.md).

De codes kloppen, de positie niet: de WMS heeft de rijen op hele meters, de hal niet. `pos_x`,
`level` en `location_type` zijn goed. Alleen `R6B` (12) staat al goed.

| Stelling | `pos_y` nu | `pos_y` moet zijn |
|---|---|---|
| `R1A` | -26 | -24.5 |
| `R1B` | -23 | -19.5 |
| `R2A` | -19 | -18.2 |
| `R2B` | -16 | -13.2 |
| `R3A` | -12 | -11.9 |
| `R3B` | -9 | -6.9 |
| `R4A` | -5 | -5.6 |
| `R4B` | -2 | -0.6 |
| `R5A` | 2 | 0.7 |
| `R5B` | 5 | 5.7 |
| `R6A` | 9 | 7 |
| `R6B` | 12 | 12 |
| `R7A` | 16 | 13.3 |
| `R7B` | 19 | 18.3 |
| `R8A` | 23 | 19.6 |
| `R8B` | 26 | 24.6 |

Geldt voor alle 21 locaties van de stelling (7 secties × 3 niveaus). De game biedt de juiste
gegevens ook als CSV aan: WMS-paneel (toets K) → *download de juiste gegevens (CSV)*, kolommen
`location_id;location_type;pos_x;pos_y;level;blocked`. Werk daarmee de bestaande locaties bij; maak
geen nieuwe aan.

### 2.2 Robots (gedaan)

**Stand 2026-11-14, later op de dag:** de WMS heeft nu alle 20 robots; dit punt is afgehandeld.

Wat er ontbrak:

De hal heeft per pad een tilrobot én een robot-heftruck. De WMS kent er per pad één. Toevoegen:

| `robot_id` | `robot_type` | Omschrijving |
|---|---|---|
| `GKP-02`, `GKP-04`, `GKP-06`, `GKP-08` | `tilrobot` | Tilrobot pad 2, 4, 6, 8 |
| `GKF-01`, `GKF-03`, `GKF-05`, `GKF-07` | `heftruck` | Robot-heftruck pad 1, 3, 5, 7 |

Tot dan krijgen in de hal alleen de acht robots die de WMS kent een opdracht; de andere acht staan
stil. De API-beschrijving noemt nog "Padrobots GKP-01, GKF-02 … GKF-08 (nummer = pad)": dat wordt
`GKP-01` … `GKP-08` en `GKF-01` … `GKF-08`.

### 2.3 Ontvangsten van `simulatie_tick` hebben geen pallet

Alle 10 ontvangsten van de flow (`PAL-SIM-IN-2611131925` … `-2611132010`) hebben wel een `pallet_id`
maar het veld `pallet` is leeg, en er bestaat geen pallet met dat nummer. De voorraad ligt daardoor
los op de dockdeur (`stock.los` = 2, `op_pallet` = 0). De API-beschrijving zegt dat een ontvangst met
`pallet_id` een actieve pallet op `DOCK-NN` oplevert.

Gevolg: `unload` weigert (`Ontvangst heeft geen pallet.`), `count` en `pallet_move` kunnen niet, en
de WMS maakt voor deze pallets geen robotopdracht. De ontvangst blijft op `received` staan, ook
nadat de vrachtwagen is afgemeld.

- **Rechtzetten:** `goods_receipt` met een `pallet_id` maakt altijd de pallet aan (status `active`,
  op de dockdeur) en vult `pallet`.
- **Opruimen:** de tien bestaande ontvangsten, zie 2.4.

### 2.4 Voorraad die in de WMS op een dock is blijven staan

Zeven van deze leveringen zijn in de hal al gelost; de wagens zijn afgemeld. In de WMS staat de
voorraad nog op de dockdeur. Waar de pallets in de hal staan (stand 2026-11-14):

| Pallet | Artikel | Aantal | In de WMS | In de hal |
|---|---|---|---|---|
| `PAL-SIM-IN-2611131940` | `SKU-003` | 2 | los op `DOCK-03` | `R3A-02-1` |
| `PAL-SIM-IN-2611131935` | `SKU-006` | 2 | los op `DOCK-06` | `R5A-02-1` |
| `PAL-SIM-IN-2611131950` | `SKU-007` | 2 | los op `DOCK-07` | `R6B-01-1` |
| `PAL-SIM-IN-2611131925` | `SKU-002` | 2 | los op `DOCK-02` | onderweg naar `R2A-03-1` |
| `PAL-SIM-IN-2611132000` | `SKU-001` | 2 | los op `DOCK-01` | `DOCK-01-IN`, geteld |
| `PAL-SIM-IN-2611131955` | `SKU-004` | 2 | los op `DOCK-04` | `DOCK-04-IN` |
| `PAL-SIM-IN-2611131930` | `SKU-009` | 2 | los op `DOCK-09` | onderweg naar `R7A-01-1` |

`PAL-SIM-IN-2611132010` staat aan beide kanten al op `R4B-01-1`; alleen de ontvangst (op `DOCK-05`)
staat nog op `received` en hoort op `put_away`.

Op `DOCK-10-IN` staan twee ontvangsten zonder `pallet_id` (30 × `SKU-004` en 10 × `SKU-002`) die de
game heeft geboekt met `dock_id` = `DOCK-10-IN`; de WMS toont daar `inslag_code` = `DOCK-10-IN-IN`.
De afleiding van de inslaglocatie moet een `dock_id` die al op `-IN` eindigt laten staan.

### 2.5 Een correctie-actie voor aantallen (nieuw)

De game kan via de API een pallet verplaatsen, maar geen aantal rechtzetten: `stock` en `pallet` zijn
alleen te lezen. Nu wijkt af:

| Pallet | Locatie | Hal | WMS |
|---|---|---|---|
| `PAL-0062` | `R5B-04-1` | 6 × `SKU-005` | 9 × `SKU-005` |

Voorstel: een actie `correct_pallet` op `pallet`, invoer `counted_qty` (0 = de pallet is leeg). De WMS
boekt het verschil als `stock_mutation` van het soort `correctie`. Geweigerd met `409` als het aantal
negatief is. Zodra die actie er is, zet de game ook aantallen recht (hoofdstuk 3).

### 2.6 Schrijven vanuit de game (nieuw)

De wens is dat de game alles wat hierboven staat zelf naar de WMS kan schrijven. Nu geeft de API
`403` op `POST`/`PATCH` van `location`, `item` en `stock`. Nodig voor de API-client van de game:

| Wat | Aanroep | Nu |
|---|---|---|
| Positie van een locatie bijwerken | `PATCH location/<id> {pos_x, pos_y}` | `403` |
| Een locatie toevoegen die de hal heeft en de WMS niet | `POST location {location_id, location_type, pos_x, pos_y, level}` | `403` |
| Aantal op een pallet rechtzetten | actie `correct_pallet` op `pallet` (2.5) | bestaat niet |
| Een pallet die alleen in de hal staat alsnog aanmaken | actie op `location`, invoer `pallet_id`, `sku`, `qty`: boekt de voorraad bij als correctie en maakt de pallet aan | bestaat niet |
| Een pallet die alleen in de WMS staat laten vervallen | `correct_pallet` met `counted_qty` = 0 | bestaat niet |

`location_id`, `location_type` en `level` hoeft de game niet te kunnen wijzigen. Meld terug welke van
deze er komen en onder welke naam; de game gebruikt ze dan in *WMS bijwerken naar de hal*.

## 3. Wat de game sinds 2026-11-14 doet

- **Pallets vergelijken.** Elke 30 s leest de game `GET pallet?status=active` en legt die naast de
  pallets in de stellingen van de hal. De verschillen staan in het WMS-paneel (K): andere locatie,
  andere inhoud, alleen in de hal, alleen in de WMS. Pallets die onderweg zijn (dock, vrachtwagen,
  robot, vorken) tellen niet mee.
- **WMS bijwerken naar de hal.** Een knop in hetzelfde paneel verplaatst elke pallet die in de WMS
  op een andere locatie staat naar de locatie in de hal: `POST pallet_move {pallet_id,
  to_location_id}`. Weigert de WMS met `… is nog niet geteld.`, dan boekt de game eerst `unload` en
  `count` (zie 12). Op 2026-11-14 gaat het om `PAL-0005` (hal `R1A-04-1`, WMS `R1A-04-2`) en
  `PAL-0036` (hal `R3A-03-1`, WMS `R3A-03-3`).
- **Ontvangst zonder pallet.** Weigert `unload` of `count` met `Ontvangst heeft geen pallet.`, dan
  gaat het lossen en tellen in de hal door zonder boeking in de WMS; anders komt de vrachtwagen nooit
  leeg. De pallet blijft daarna in de WMS op de dockdeur staan tot 2.3 is rechtgezet.

## 4. Robotopdrachten die niet meer kloppen

Er staan 34 opdrachten open (`RT-000001` … `RT-000036`, `aanleiding` = `aanvullen`). Twee daarvan
gaan over een pallet die in de hal al beneden staat (`RT-000026` voor `PAL-0005`, `RT-000017` voor
`PAL-0036`): de game meldt die af als mislukt. Na *WMS bijwerken naar de hal* staan de pallets in de
WMS ook beneden; een open opdracht waarvan de pallet niet meer op `from_code` staat kan de WMS dan
zelf laten vervallen.

## Terug te melden

- Dat `pos_y` (2.1) en de acht robots (2.2) zijn bijgewerkt.
- Of `goods_receipt` met `pallet_id` nu altijd een pallet aanmaakt (2.3), en dat de tien oude
  ontvangsten zijn opgeruimd (2.4).
- Of de correctie-actie (2.5) wordt gebouwd, en onder welke naam.
