# 01 — Basisdatamodel en kernacties

## Context

WM-Sim is een 3D-game die een magazijn simuleert. De game is de **fysieke wereld**: vrachtwagens
komen aan, heftrucks en robots rijden, medewerkers picken. De WMS-app is het **systeem**: die legt
vast welke locaties en artikelen er zijn, waar voorraad ligt en welke orders er zijn.

De game roept de WMS aan via de API die het platform op entiteiten en acties genereert. Bij elke
handeling vraagt de game eerst de WMS; pas na akkoord gebeurt de handeling in de hal (zie 06).

Dit document beschrijft de basis: locaties, artikelen, voorraad en orders. Vrachtwagens en het
scanlog staan in 04, pallets in 07. Alle aanroepen op een rij staan in 09.

---

## 1. Entiteiten

Elk record heeft een platform-`id` (uuid). **Verwijzingen tussen entiteiten zijn die uuid**, niet de
tekstsleutel: `stock.sku` is de `id` van het artikel, `stock.location_id` de `id` van de locatie. De
game kent alleen de tekstsleutels (`SKU-001`, `DOCK-01`, `ORD-…`) en vertaalt zelf.

### 1.1 Locatie (`location`)

| Veld | Type | Toelichting |
|---|---|---|
| `location_id` | tekst, uniek, max 20 | Bijvoorbeeld `DOCK-01-IN` of `R3B-07-2` |
| `location_type` | domein | `dock`, `rack` of `pick` |
| `pos_x` | decimaal | X-positie op de plattegrond, in meters (x in de game) |
| `pos_y` | decimaal | Y-positie op de plattegrond, in meters (z in de game) |
| `level` | geheel getal | 0 = docklocatie, 1 t/m 3 = stellingniveau (1 staat op de vloer) |
| `blocked` | ja/nee | Een geblokkeerde locatie mag niet gebruikt worden |

Locaties zijn via de API alleen te lezen; ze worden in de WMS-app beheerd.

### 1.2 Artikel (`item`)

| Veld | Type | Toelichting |
|---|---|---|
| `sku` | tekst, uniek, max 20 | Bijvoorbeeld `SKU-001` |
| `description` | tekst, max 100 | |
| `category` | domein `robot_category` | Zie 03 |

Alleen te lezen. De WMS bepaalt welke artikelen er bestaan: de game leest de lijst en laat alleen
die artikelen in de hal voorkomen.

### 1.3 Voorraad (`stock`)

Hoeveel er van een artikel op een locatie ligt. `qty` = het aantal dozen.

| Veld | Type | Toelichting |
|---|---|---|
| `sku` | verwijzing naar `item` | |
| `location_id` | verwijzing naar `location` | |
| `qty` | geheel getal ≥ 0 | |
| `op_pallet` | geheel getal | Het deel dat op actieve pallets staat (zie 07) |
| `los` | geheel getal | `qty − op_pallet`: voorraad zonder pallet |

De combinatie `sku` + `location_id` is uniek. Alleen te lezen; voorraad verandert door de acties.

### 1.4 Order (`customer_order`)

| Veld | Type | Toelichting |
|---|---|---|
| `order_id` | tekst, uniek, max 20 | Bijvoorbeeld `ORD-0001`. Zonder waarde geeft de WMS een nummer uit. |
| `status` | domein | `open`, `picking`, `done`, `staged`, `loaded`, `shipped` (zie 04) |
| `te_picken` | ja/nee (afgeleid) | Waar als de status `open` of `picking` is; de game filtert hierop |

### 1.5 Orderregel (`order_line`)

| Veld | Type | Toelichting |
|---|---|---|
| `order_id` | verwijzing naar `customer_order` | |
| `line_no` | geheel getal | Uniek binnen de order |
| `sku` | verwijzing naar `item` | |
| `qty` | geheel getal > 0 | |
| `picked_qty` | geheel getal | Opgehoogd door `confirm_pick_line` (zie 04) |

Regels toevoegen kan alleen zolang de order `open` is.

---

## 2. Kernacties

Een actie is een `POST` die een record aanmaakt, of een actie op één record
(`POST {entiteit}/{id}/_flows/{actie}`). De vorm van de aanroepen staat in 02 en 09. Een geweigerde
actie wijzigt niets en geeft een korte Nederlandse melding terug; de game toont die aan de speler.

| Stap | Aanroep | Controles | Effect |
|---|---|---|---|
| Ontvangst boeken | `POST goods_receipt {sku, qty, dock_id, pallet_id?}` | `dock_id` is een docklocatie; `qty` ≥ 1 | Voorraad van `sku` op `dock_id` omhoog met `qty` |
| Losse voorraad wegzetten | `stock/<id>/_flows/putaway`, invoer `putaway_qty`, `to_location_id` | Genoeg voorraad zonder pallet; de naar-locatie is een stellinglocatie en niet geblokkeerd | Voorraad omlaag op de van-locatie, omhoog op de naar-locatie |
| Order aanmaken | `POST customer_order {order_id?}`, daarna per regel `POST order_line {order_id, line_no, sku, qty}` | `order_id` is uniek | Order met status `open` |
| Picken starten | `customer_order/<id>/_flows/start_picking` | Status is `open`; de order heeft regels | Status `picking` |
| Order afronden | `customer_order/<id>/_flows/confirm_pick` | Status is `picking`; genoeg voorraad voor wat nog open staat | Boekt het restant af (wat nog niet per regel is gepickt) en zet de status op `done` |

Pallets met een sticker verhuizen met `pallet_move` in plaats van `putaway` (zie 07).

`confirm_pick` boekt het restant eerst af van losse voorraad en dan van pallets; de overige stappen
van het proces (picken per regel, klaarzetten, inladen) staan in 04.

---

## 3. Uitlezen

De game leest:

- `location` en `item`, alle records: bij het aanmelden en daarna elke 30 seconden.
- `customer_order?te_picken=true` met alle `order_line`, elke 3 seconden: de orders waar nog aan
  gewerkt moet worden.
- `stock`, elke 3 seconden: om in het menu te tonen wat de WMS heeft. De hal neemt die voorraad
  alleen over bij de allereerste start en bij de knop 'Hal resetten naar de WMS-voorraad' (dan
  samen met `pallet`, zie 07). Daarna houdt de hal zijn eigen voorraad bij (zie 06).
- De leveringen (`truck_visit`, `goods_receipt`), elke 3 seconden: zie 10.

---

## 4. Seed-data

Deze data moet overeenkomen met de indeling van de hal.

- **Locaties (366):** 30 docklocaties (zie 05) en 336 stellinglocaties (zie 11).
- **Artikelen:** zie 03.
- **Beginvoorraad:** ongeveer 70 voorraadregels, willekeurig verdeeld over de stellinglocaties, 5 tot
  50 stuks per regel, elk op een eigen pallet (`PAL-0001` t/m `PAL-0070`, zie 07).

De game vergelijkt zijn locaties met die van de WMS en meldt de verschillen in het WMS-paneel
(toets K): ontbrekende locaties zijn daar als CSV te downloaden.

---

## 5. Toegang

Zie 02: de game meldt zich aan met de API-sleutel van een API-client en roept de WMS rechtstreeks
vanuit de browser aan.
