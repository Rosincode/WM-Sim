# 09 — Aansluiting op het realistische datamodel

De WMS heeft een nieuw datamodel: pallets, palletverplaatsingen, vrachtwagenbezoeken, een scanlog en
acties per record (`_flows`). De oude actietabellen (`putaway`, `register_pallet`, `start_picking`, …)
en het aanmaken van locaties via de API zijn vervallen. De game is hierop aangepast. Dit document
beschrijft wat de game nu aanroept, wat er in de WMS-app nog moet gebeuren en wat nog openstaat.

De beschrijving van de API zelf staat in de WMS: `GET {basis}/_openapi`. Die is leidend; 01 t/m 08
gelden alleen nog waar ze daar niet mee botsen.

---

## 1. Wat de game aanroept

| Handeling in de hal | Aanroep |
|---|---|
| Vrachtwagen aanmelden | `POST truck_visit {truck_id, direction, dock_id}` |
| Pallet lossen | `POST goods_receipt {sku, qty, dock_id}` (zonder `pallet_id`: de voorraad ligt los op `DOCK-NN-IN`) |
| Sticker plakken | `POST stock/<id>/_flows/register_pallet`, invoer `pallet_id`, `pallet_qty` |
| Pallet met sticker wegzetten of verplaatsen (speler of robot) | `POST pallet_move {pallet_id, to_location_id}` |
| Pallet zonder sticker wegzetten | `POST stock/<id>/_flows/putaway`, invoer `putaway_qty`, `to_location_id` |
| Order starten | `POST customer_order/<id>/_flows/start_picking` |
| Pick op een locatie | `POST order_line/<id>/_flows/confirm_pick_line`, invoer `pick_qty`, `location_id` |
| Order afronden | `POST customer_order/<id>/_flows/confirm_pick` |
| Klaarzetten op `DOCK-NN-UIT` | `POST customer_order/<id>/_flows/stage_order`, invoer `dock_id` |
| Inladen | `POST customer_order/<id>/_flows/load_order`, invoer `truck_visit_id` |
| Vrachtwagen afmelden | `POST truck_visit/<id>/_flows/truck_check_out` |
| Elke scan, ook een foute | `POST scan_log {kind, barcode, ok, location_id?}` |

Lezen: `location`, `item`, `stock`, `pallet?status=active`, `customer_order?te_picken=true`,
`order_line`, en `truck_visit?truck_id=…` om na een herstart het lopende bezoek terug te vinden.

- **Pallet of losse voorraad.** Bij wegzetten kijkt de game eerst of de WMS de sticker kent
  (`GET pallet?pallet_id=…`, status `active`). Zo ja: `pallet_move`. Zo nee: `putaway` op de
  voorraadregel van de van-locatie.
- **Palletnummers.** Bij de eerste start en bij 'Hal resetten' neemt de hal de pallets uit de WMS
  over, met hun nummer. Voorraad die in de WMS los ligt krijgt in de hal een pallet zonder sticker;
  de speler plakt die (`register_pallet`).
- **Vrachtwagennummers** beginnen elke spelsessie bij `IN-001` / `UIT-001`. Meldt de WMS
  `… is al aangemeld`, dan gaat de game verder met het bezoek dat er al staat.
- **Locaties** maakt de game niet meer aan. Ontbreekt er een, dan biedt het WMS-paneel (K) een CSV.

## 2. Te doen in de WMS-app

De API-client van de game (Instellingen → Koppelingen → API) mist nog rechten. Op dit moment geeft
hij `403` op alles wat nieuw is. Aanvinken:

- **Lezen:** `pallet`, `truck_visit` (naast `location`, `item`, `stock`, `customer_order`, `order_line`).
- **Schrijven:** `pallet_move`, `truck_visit`, `scan_log` (naast `goods_receipt`, `customer_order`, `order_line`).
- **Acties:** `start_picking`, `confirm_pick`, `confirm_pick_line`, `stage_order`, `load_order`,
  `truck_check_out`, `putaway`, `register_pallet`.

## 3. Open punten

1. **Beginvoorraad en pallets.** De API-beschrijving zegt dat de beginvoorraad pallets heeft
   (`PAL-0001` t/m `PAL-0070`), maar `stock.op_pallet` is op elke regel 0 en `los` is gelijk aan `qty`.
   Klopt een van beide niet, dan weigert `pallet_move` of `putaway` op die voorraad.
2. **`pallet_id` bij `putaway`.** De game stuurt het niet mee, omdat niet vastligt wat de WMS ermee doet.
3. **Robotopdrachten (08).** `robot` en `robot_task` bestaan niet in de API. De game bedenkt de
   opdrachten nog zelf en boekt het afronden als `pallet_move`.
4. **Uitgaande vrachtwagen zonder orders.** `truck_check_out` weigert die
   (`… heeft geen geladen orders`); in de hal kan de speler hem dan niet afmelden.

## Terug te melden

- Dat de rechten uit hoofdstuk 2 zijn aangevinkt.
- Antwoord op de open punten 1 en 2.
