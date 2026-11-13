# 04 — Procesacties: aanmelden, scannen, picken per regel, klaarzetten, inladen en uitmelden

## Context

De game speelt het hele magazijnproces:

1. **Inbound:** een vrachtwagen komt aan op een van de tien docks. Hij wordt **aangemeld**, de
   pallets worden **gelost** op de inslaglocatie van dat dock (`DOCK-NN-IN`), krijgen een sticker,
   worden **weggezet** in de stelling en de vrachtwagen wordt **uitgemeld**.
2. **Outbound:** de speler pakt een rolcontainer voor een order (**picken starten**), **pickt** per
   regel op een locatie, **zet de order klaar** op een uitslaglocatie (`DOCK-NN-UIT`), **laadt** hem
   in een vrachtwagen en **meldt die vrachtwagen uit**.

Elke stap wordt gedaan door een speler met een scanner of door een robot (zie 08); de aanroepen
naar de WMS zijn dezelfde. Dit document beschrijft de entiteiten en acties voor vrachtwagens, het
scanlog en het uitgaande proces. De basis staat in 01, pallets in 07, alle aanroepen in 09.

---

## 1. Entiteiten

### 1.1 Vrachtwagenbezoek (`truck_visit`)

Eén record per bezoek van een vrachtwagen aan een dock. Aanmelden = een record aanmaken.

| Veld | Type | Toelichting |
|---|---|---|
| `truck_id` | tekst, max 20 | Het nummer van de wagen, bijvoorbeeld `IN-001` of `UIT-003` |
| `direction` | domein `truck_direction` | `in` of `out` |
| `dock_id` | verwijzing naar `location` | De dockdeur zelf (`DOCK-NN`), type `dock` |
| `status` | domein `truck_status` | `checked_in` of `checked_out` |

- De game nummert zijn vrachtwagens elke spelsessie opnieuw vanaf `IN-001` / `UIT-001`. Meldt de WMS
  `Vrachtwagen … is al aangemeld.`, dan gaat de game verder met het bezoek dat er al staat.
- De WMS kan ook zelf inkomende vrachtwagens aanmelden (leveringen, zie 10).

### 1.2 Scanlog (`scan_log`)

Elke scan in de game, ook een foute. Dit is alleen een logboek: er gebeurt niets met de voorraad, de
speler wacht er niet op en een fout houdt niets tegen.

| Veld | Type | Toelichting |
|---|---|---|
| `kind` | domein `scan_kind` | `truck`, `pallet`, `location` of `order` |
| `barcode` | tekst, max 40 | Wat er gescand is: een truck-, pallet-, locatie- of ordernummer |
| `ok` | ja/nee | Nee = verkeerde locatie gescand, of de handeling werd geweigerd |
| `location_id` | tekst, max 20 | Waar de scan gebeurde, als tekst (geen verwijzing) |

### 1.3 Order (`customer_order`): statussen

| Waarde | Betekenis | Gezet door |
|---|---|---|
| `open` | Aangemaakt, nog niet gestart | `POST customer_order` |
| `picking` | Er wordt gepickt | `start_picking` |
| `done` | Compleet gepickt | `confirm_pick` |
| `staged` | Klaargezet op een uitslaglocatie | `stage_order` |
| `loaded` | In een vrachtwagen geladen | `load_order` |
| `shipped` | Vrachtwagen is vertrokken | `truck_check_out` |

Velden daarbij: `staged_dock_id` (gezet door `stage_order`) en `truck_id` (gezet door `load_order`).
Op `order_line` houdt `picked_qty` bij wat er per regel is gepickt.

---

## 2. Acties

Acties op een record: `POST {entiteit}/<id>/_flows/{actie}` (zie 02). De meldingen komen uit de
WMS; de game toont ze letterlijk.

| Stap in de hal | Aanroep | Geweigerd als |
|---|---|---|
| Vrachtwagen aanmelden | `POST truck_visit {truck_id, direction, dock_id}` | De wagen al is aangemeld; het dock bezet is; `dock_id` geen dock is |
| Eén greep uit een locatie | `order_line/<id>/_flows/confirm_pick_line`, invoer `pick_qty`, `location_id` | De order niet op `picking` staat; de regel niet genoeg open heeft; er op de locatie te weinig ligt |
| Order klaarzetten | `customer_order/<id>/_flows/stage_order`, invoer `dock_id` (`DOCK-NN-UIT`) | De order niet compleet gepickt is; `dock_id` geen docklocatie is |
| Order inladen | `customer_order/<id>/_flows/load_order`, invoer `truck_visit_id` | De order niet `done` of `staged` is; het bezoek geen aangemelde uitgaande vrachtwagen is |
| Vrachtwagen uitmelden | `truck_visit/<id>/_flows/truck_check_out` | De wagen niet is aangemeld; een uitgaande wagen geen geladen orders heeft |
| Scan vastleggen | `POST scan_log {kind, barcode, ok, location_id?}` | Nooit (geen controles) |

Toelichting:

- **Picken per regel.** `confirm_pick_line` boekt `pick_qty` af van de gescande locatie en hoogt
  `picked_qty` op. Eén orderregel kan over meer locaties verdeeld zijn; staat een artikel op meer
  regels van de order, dan verdeelt de game de greep over die regels.
- **Order afronden.** Als alle regels fysiek gepickt zijn roept de game `confirm_pick` aan (01). Die
  boekt alleen nog af wat niet per regel is gepickt.
- **Inladen zonder klaarzetten** mag: `load_order` werkt ook vanuit `done`.
- **Uitmelden** van een uitgaande wagen zet alle orders met status `loaded` van dat bezoek op
  `shipped`.

---

## 3. Uitlezen

- Orders waar nog aan gewerkt moet worden: `GET customer_order?te_picken=true` (status `open` of
  `picking` in één aanroep; filters met `or` kent de API niet).
- `truck_visit?truck_id=…` om na een herstart van de game het lopende bezoek terug te vinden, en
  `truck_visit?status=checked_in` voor de leveringen (10).
- `scan_log` leest de game niet; het is bedoeld om in de WMS-app te bekijken.

---

## 4. Open punten

- **Inkomende vrachtwagen uitmelden.** `truck_check_out` moet een inkomend bezoek ook zonder geladen
  orders kunnen afmelden (zie 10).
- **Uitgaande vrachtwagen zonder orders.** `truck_check_out` weigert die
  (`… heeft geen geladen orders.`); in de hal kan de speler hem dan niet uitmelden.
- Een historie per vrachtwagen over meer bezoeken heen gebruikt de game niet.
