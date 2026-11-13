# 09 — Alle aanroepen van de game op een rij

De WMS heeft pallets, palletverplaatsingen, vrachtwagenbezoeken, een scanlog en acties per record
(`_flows`). Dit document zet alles wat de game aanroept bij elkaar, met de rechten die de API-client
daarvoor nodig heeft en de punten die nog openstaan.

De beschrijving van de API zelf staat in de WMS: `GET {basis}/_openapi`. Die is leidend.

---

## 1. Wat de game aanroept

| Handeling in de hal | Aanroep |
|---|---|
| Vrachtwagen aanmelden | `POST truck_visit {truck_id, direction, dock_id}` |
| Pallet lossen | `POST goods_receipt {sku, qty, dock_id}` (zonder `pallet_id`: de voorraad ligt los op `DOCK-NN-IN`) |
| Sticker plakken | `POST stock/<id>/_flows/register_pallet`, invoer `pallet_id`, `pallet_qty` |
| Pallet met sticker wegzetten of verplaatsen (speler of robot) | `POST pallet_move {pallet_id, to_location_id}` |
| Pallet wegzetten die de WMS niet als pallet kent | `POST stock/<id>/_flows/putaway`, invoer `putaway_qty`, `to_location_id` |
| Order starten | `POST customer_order/<id>/_flows/start_picking` |
| Pick op een locatie | `POST order_line/<id>/_flows/confirm_pick_line`, invoer `pick_qty`, `location_id` |
| Order afronden | `POST customer_order/<id>/_flows/confirm_pick` |
| Klaarzetten op `DOCK-NN-UIT` | `POST customer_order/<id>/_flows/stage_order`, invoer `dock_id` |
| Inladen | `POST customer_order/<id>/_flows/load_order`, invoer `truck_visit_id` |
| Vrachtwagen afmelden | `POST truck_visit/<id>/_flows/truck_check_out` |
| Elke scan, ook een foute | `POST scan_log {kind, barcode, ok, location_id?}` |
| Testorder (alleen de mock-WMS, zonder aanmelden) | `POST customer_order {order_id}` en per regel `POST order_line` |

Lezen: `location`, `item`, `stock`, `pallet?status=active`, `customer_order?te_picken=true`,
`order_line`, `truck_visit?status=checked_in` met `goods_receipt?dock_id=…` voor de leveringen (10),
en `truck_visit?truck_id=…` om na een herstart het lopende bezoek terug te vinden.

- **Verwijzingen** in de aanroepen zijn de platform-`id` (uuid) van het record; de game zoekt die op
  bij de tekstsleutel (`GET item?sku=…`, `GET location?location_id=…`, `GET customer_order?order_id=…`).
- **Pallet of losse voorraad.** Voor elke verplaatsing kijkt de game eerst of de WMS de sticker kent
  (`GET pallet?pallet_id=…`, status `active`). Zo ja: `pallet_move`. Zo nee: `putaway` op de
  voorraadregel van de van-locatie.
- **Palletnummers.** Bij de allereerste start en bij 'Hal resetten' neemt de hal de pallets uit de
  WMS over, met hun nummer. Voorraad die in de WMS los ligt krijgt in de hal een pallet zonder
  sticker; de speler of de telrobot plakt die (`register_pallet`).
- **Vrachtwagennummers** van de game beginnen elke spelsessie bij `IN-001` / `UIT-001`. Meldt de WMS
  `… is al aangemeld`, dan gaat de game verder met het bezoek dat er al staat.
- **Locaties** maakt de game niet aan. Ontbreekt er een, dan biedt het WMS-paneel (K) een CSV.

## 2. Rechten van de API-client

Scopes en acties worden per client aangevinkt (Instellingen → Koppelingen → API); zonder vinkje
geeft de API `403`. De volledige lijst staat in 02.

Gecontroleerd met de API-client van de game op 2026-11-13:

| Aanroep | Antwoord |
|---|---|
| `GET location`, `item`, `stock`, `customer_order`, `order_line`, `goods_receipt` | `200` |
| `GET pallet` | `403` |
| `GET truck_visit` | `403` |

Zonder `pallet` lezen kan de game niet nagaan of de WMS een sticker kent: het wegzetten of
verplaatsen van een pallet met sticker mislukt dan met de melding `Geen rechten`. Zonder
`truck_visit` lezen komen er geen leveringen (10). Het schrijven op `pallet_move`, `truck_visit` en
`scan_log` en de acties zijn niet apart gecontroleerd.

## 3. Open punten

1. **Stellinglocaties.** De WMS heeft nog de 231 oude stellingcodes; de hal heeft er 336 met nieuwe
   codes. Zie 11.
2. **`pallet_id` bij `putaway`.** De game stuurt het niet mee, omdat niet vastligt wat de WMS ermee
   doet.
3. **Robotopdrachten (08).** `robot` en `robot_task` bestaan niet in de API. De game bedenkt de
   opdrachten zelf en boekt het afronden als `pallet_move`.
4. **Uitgaande vrachtwagen zonder orders.** `truck_check_out` weigert die
   (`… heeft geen geladen orders`); in de hal kan de speler hem dan niet afmelden.

## Terug te melden

- Dat de rechten uit hoofdstuk 2 zijn aangevinkt.
- Antwoord op open punt 2.
