# WMS-instructie 04 — Procesacties: aanmelden, scannen, picken per regel, klaarzetten, inladen en uitmelden

## Context

De game speelt nu het hele magazijnproces:

1. **Inbound:** een vrachtwagen komt aan op `DOCK-01`. De speler **meldt hem aan**, **lost** de pallets (elke pallet wordt gescand), **zet ze weg** in de stelling (locatie scannen) en **meldt de vrachtwagen uit**.
2. **Outbound:** de speler **start een order** bij de orderterminal, **pickt** per regel op een locatie (locatie scannen), **zet de order klaar** in de uitgaande baan bij `DOCK-02`, **laadt** hem in een vrachtwagen en **meldt die vrachtwagen uit**.

Elke stap roept een WMS-actie aan. Instructie 01 dekt de ontvangst, het wegzetten, het aanmaken van orders en het bevestigen van een pick. Deze instructie voegt de rest toe.

Alles uit 01 t/m 03 blijft gelden, behalve wat hieronder expliciet wordt gewijzigd.

---

## 1. Nieuwe entiteiten

### 1.1 Vrachtwagenbezoek (`truck_visit`)

Eén regel per vrachtwagen die aan een dock staat.

| Veld | Type | Verplicht | Toelichting |
|---|---|---|---|
| `truck_id` | tekst (PK), max 20 | ja | De game stuurt het nummer mee, bijvoorbeeld `IN-001` of `UIT-003` |
| `direction` | domein `truck_direction` | ja | `in` of `out` |
| `dock_id` | FK → `location` | ja | Moet van type `dock` zijn |
| `status` | domein `truck_status` | ja | `checked_in` of `checked_out` |
| `checked_in_at` | datum/tijd | ja | Moment van aanmelden |
| `checked_out_at` | datum/tijd | nee | Moment van uitmelden |

**Specifiek:** de nummers beginnen elke spelsessie opnieuw bij `001`. Bestaat het `truck_id` al met status `checked_out`, dan **overschrijft** `truck_check_in` die regel (nieuw bezoek). Een historie per bezoek is nu nog niet nodig.

### 1.2 Scanlog (`scan_log`)

Elke scan in de game, ook een foute. Dit is alleen een logboek. Er gebeurt niets met de voorraad.

| Veld | Type | Verplicht | Toelichting |
|---|---|---|---|
| `scan_id` | geheel getal (PK, identity) | ja | |
| `scanned_at` | datum/tijd | ja | Standaard het moment van aanmaken |
| `kind` | domein `scan_kind` | ja | `truck`, `pallet`, `location` of `order` |
| `barcode` | tekst, max 40 | ja | Wat er gescand is: een truck-, pallet-, locatie- of ordernummer |
| `ok` | ja/nee | ja | Nee = verkeerde locatie gescand, of de scan werd geweigerd |
| `location_id` | tekst, max 20 | nee | Waar de scan gebeurde. Gebruik **geen** FK. |

### 1.3 Nieuwe domeinen

| Domein | Waarden |
|---|---|
| `truck_direction` | `in`, `out` |
| `truck_status` | `checked_in`, `checked_out` |
| `scan_kind` | `truck`, `pallet`, `location`, `order` |

---

## 2. Wijzigingen op bestaande entiteiten

### 2.1 `order`

**Domein `status`:** vul het aan tot de volgende waarden, in deze volgorde:

| Waarde | Betekenis | Gezet door |
|---|---|---|
| `open` | Aangemaakt, nog niet gestart | `create_order` |
| `picking` | Medewerker is aan het picken | `start_picking` |
| `done` | Compleet gepickt | `confirm_pick` |
| `staged` | Klaargezet in de uitgaande baan | `stage_order` (nieuw) |
| `loaded` | In een vrachtwagen geladen | `load_order` (nieuw) |
| `shipped` | Vrachtwagen is vertrokken | `truck_check_out` (nieuw) |

**Nieuwe velden:**

| Veld | Type | Verplicht | Toelichting |
|---|---|---|---|
| `staged_dock_id` | FK → `location` | nee | Gezet door `stage_order` |
| `truck_id` | FK → `truck_visit` | nee | Gezet door `load_order` |

### 2.2 `order_line`

| Veld | Type | Verplicht | Toelichting |
|---|---|---|---|
| `picked_qty` | geheel getal | ja | Standaard 0. Wordt opgehoogd door `confirm_pick_line`. |

---

## 3. Nieuwe acties

Alle acties geven bij een fout een duidelijke foutmelding terug. De game toont die aan de speler.

### 3.1 `truck_check_in`: vrachtwagen aanmelden

- **Parameters:** `truck_id`, `direction` (`in`/`out`), `dock_id`
- **Controles:**
  - `dock_id` is van type `dock`.
  - Er staat geen andere vrachtwagen met status `checked_in` op dat dock.
- **Effect:** de actie maakt een `truck_visit` met status `checked_in` (of overschrijft die, zie 1.1).

### 3.2 `truck_check_out`: vrachtwagen uitmelden

- **Parameters:** `truck_id`, `order_ids` (lijst, mag leeg zijn: dit is ter controle, de WMS gebruikt zijn eigen koppeling via `order.truck_id`)
- **Controles:**
  - De status is `checked_in`.
  - Bij `direction` = `out`: er hangt minstens één order aan met status `loaded`.
- **Effect:**
  - De status wordt `checked_out` en `checked_out_at` wordt gezet.
  - Bij `out`: alle orders met deze `truck_id` en status `loaded` krijgen status `shipped`.

### 3.3 `register_scan`: scan vastleggen

- **Parameters:** `kind`, `barcode`, `ok`, `location_id` (optioneel)
- **Effect:** de actie maakt een regel in `scan_log`. Er zijn geen controles.

### 3.4 `confirm_pick_line`: één pick bevestigen

De game roept deze actie aan zodra de speler op een locatie heeft gepickt. Eén orderregel kan over meer locaties verdeeld zijn. Dan komt de actie meer keren voor dezelfde `sku`.

- **Parameters:** `order_id`, `sku`, `qty`, `location_id`
- **Controles:**
  - De orderstatus is `picking`.
  - De order heeft een regel met deze `sku` waarvoor `qty − picked_qty` ≥ de opgegeven `qty`.
  - Op `location_id` ligt minstens `qty` van deze `sku`.
- **Effect:**
  - De voorraad op `location_id` gaat omlaag met `qty`. Een voorraadregel die op 0 uitkomt, wordt verwijderd.
  - `picked_qty` van de orderregel gaat omhoog met `qty`.

### 3.5 `stage_order`: order klaarzetten

- **Parameters:** `order_id`, `dock_id`
- **Controles:**
  - De status is `done`.
  - `dock_id` is van type `dock`.
- **Effect:** de status wordt `staged` en `staged_dock_id` wordt gezet.

### 3.6 `load_order`: order inladen

- **Parameters:** `order_id`, `truck_id`, `dock_id`
- **Controles:**
  - De orderstatus is `done` of `staged`. De speler mag een order ook direct inladen zonder hem eerst klaar te zetten.
  - De `truck_visit` heeft status `checked_in` en `direction` = `out`.
- **Effect:** de status wordt `loaded` en `truck_id` wordt gezet.

---

## 4. Wijziging op bestaande actie `confirm_pick` (uit 01, 2.5)

Omdat de voorraad nu al per regel wordt afgeboekt via `confirm_pick_line`, boekt `confirm_pick` alleen nog het **restant** af:

- Per orderregel boekt de actie `qty − picked_qty` af, met de regel uit 01 (eerst `pick`, dan `rack`, op volgorde van `location_id`). Is het restant 0, dan wordt er niets afgeboekt.
- Daarna wordt `picked_qty` = `qty` en wordt de status `done`.

Zo blijft de actie werken voor clients die `confirm_pick_line` niet gebruiken.

---

## 5. Uitlezen (GET)

- **Wijziging:** de game haalt open orders voortaan op met `status eq 'open' or status eq 'picking'`. Het oude filter `status ne 'done'` zou nu ook orders met de status `staged`, `loaded` en `shipped` teruggeven.
- `truck_visit` en `scan_log` krijgen de standaard-GET. De game leest ze nu nog niet. Ze zijn bedoeld om in de WMS-app te bekijken.

---

## 6. Nog niet bouwen

- **Een entiteit voor pallets.** De game stuurt bij `register_goods_received` en `confirm_putaway` later een `pallet_id` mee, bijvoorbeeld `PAL-K3F9-0001`. Accepteer die parameter als optioneel en negeer hem voor nu.
- Een historie van vrachtwagenbezoeken (zie 1.1).

---

## Terug te melden

- Bevestiging van de nieuwe entiteiten, domeinen en acties uit hoofdstuk 1 t/m 3.
- Bevestiging dat `confirm_pick` het restant afboekt (hoofdstuk 4).
- Of het filter met `or` werkt (hoofdstuk 5). Werkt het niet, meld dan de syntax die wel werkt.
