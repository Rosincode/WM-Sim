# WMS-instructie 01 — Basisdatamodel en kernacties

## Context

WM-Sim is een 3D-game die een magazijn simuleert. De game is de **fysieke wereld**: vrachtwagens komen aan, heftrucks rijden, medewerkers picken. De WMS-app is het **systeem**: die bepaalt welke locaties er zijn, waar voorraad ligt en welke orders er zijn.

De game praat met de WMS via de automatisch gegenereerde API op entiteiten en acties. Elke gebeurtenis in de game roept een actie in de WMS aan.

Gebruik de namen in deze instructie letterlijk, of meld de afwijkingen. De game wordt er één-op-één op gemapt.

---

## 1. Entiteiten

### 1.1 Locatie (`location`)

| Veld | Type | Verplicht | Toelichting |
|---|---|---|---|
| `location_id` | tekst (PK), max 20 | ja | Bijvoorbeeld `DOCK-01` of `R1-03-2` |
| `location_type` | domein | ja | `dock`, `rack` of `pick` |
| `pos_x` | decimaal | ja | X-positie op de plattegrond, in meters |
| `pos_y` | decimaal | ja | Y-positie op de plattegrond, in meters |
| `level` | geheel getal | ja | Hoogte in de stelling: 0 = vloer, 1 t/m 3 = stellingniveau |
| `blocked` | ja/nee | ja | Standaard nee. Een geblokkeerde locatie mag niet gebruikt worden. |

### 1.2 Artikel (`item`)

| Veld | Type | Verplicht | Toelichting |
|---|---|---|---|
| `sku` | tekst (PK), max 20 | ja | Bijvoorbeeld `SKU-001` |
| `description` | tekst, max 100 | ja | |

### 1.3 Voorraad (`stock`)

Hoeveel er van een artikel op een locatie ligt.

| Veld | Type | Verplicht | Toelichting |
|---|---|---|---|
| `stock_id` | geheel getal (PK, identity) | ja | |
| `sku` | FK → `item` | ja | |
| `location_id` | FK → `location` | ja | |
| `qty` | geheel getal | ja | Moet ≥ 0 zijn |

De combinatie `sku` + `location_id` is uniek.

### 1.4 Order (`order`)

| Veld | Type | Verplicht | Toelichting |
|---|---|---|---|
| `order_id` | tekst (PK), max 20 | ja | Bijvoorbeeld `ORD-0001`. Mag een automatisch nummer zijn. |
| `status` | domein | ja | `open`, `picking` of `done`. Standaard `open`. |
| `created_at` | datum/tijd | ja | Standaard het moment van aanmaken |

### 1.5 Orderregel (`order_line`)

| Veld | Type | Verplicht | Toelichting |
|---|---|---|---|
| `order_id` | FK → `order` (PK, deel 1) | ja | |
| `line_no` | geheel getal (PK, deel 2) | ja | |
| `sku` | FK → `item` | ja | |
| `qty` | geheel getal | ja | Moet > 0 zijn |

---

## 2. Acties

Elke actie wordt een API-endpoint. De game roept ze aan met de genoemde parameters. Een fout moet een duidelijke foutmelding teruggeven, zodat de game die kan tonen.

### 2.1 `register_goods_received`: ontvangst registreren

De game roept deze actie aan als een vrachtwagen aan het dock is gelost.

- **Parameters:** `sku`, `qty`, `dock_id`
- **Controles:**
  - `dock_id` bestaat en is van type `dock`.
  - `sku` bestaat.
  - `qty` is groter dan 0.
- **Effect:** de voorraad van `sku` op `dock_id` gaat omhoog met `qty`. Bestaat er nog geen voorraadregel, maak die dan aan.

### 2.2 `confirm_putaway`: wegzetten bevestigen

De game roept deze actie aan als een heftruck goederen van het dock naar een stellinglocatie heeft gebracht.

- **Parameters:** `sku`, `qty`, `from_location_id`, `to_location_id`
- **Controles:**
  - Op de van-locatie ligt genoeg voorraad.
  - De naar-locatie is van type `rack` of `pick` en is niet geblokkeerd.
- **Effect:** de voorraad gaat omlaag op de van-locatie en omhoog op de naar-locatie. Verwijder een voorraadregel die op 0 uitkomt.

### 2.3 `create_order`: order aanmaken

- **Parameters:** `order_id` (optioneel: zonder waarde genereert de WMS een nummer) en `lines`, een lijst van `{ sku, qty }`
- **Effect:** de WMS maakt een order met status `open` en de bijbehorende orderregels.
- **Teruggeven:** het `order_id`.
- **Specifiek:** deze actie krijgt een lijst van regels mee. Kan het framework geen lijst als parameter ontvangen, dan mag de game de order ook in twee stappen aanmaken:
  1. een POST op `order`;
  2. daarna een POST per regel op `order_line`.

  Meld welke van de twee varianten het wordt.

### 2.4 `start_picking`: picken starten

- **Parameters:** `order_id`
- **Controle:** de status is `open`.
- **Effect:** de status wordt `picking`.

### 2.5 `confirm_pick`: pick bevestigen

De game roept deze actie aan als een medewerker een complete order heeft gepickt.

- **Parameters:** `order_id`
- **Controles:**
  - De status is `picking`.
  - Voor elke orderregel ligt genoeg voorraad.
- **Effect:**
  - Per orderregel boekt de WMS `qty` af van voorraad op een locatie van type `pick`. Ligt daar niet genoeg, dan van type `rack`. Neem de locaties in volgorde van `location_id`.
  - Daarna wordt de status `done`.

---

## 3. Uitlezen (GET) die de game nodig heeft

De standaard-GET-endpoints op de entiteiten volstaan. De game gebruikt:

- `location`: alle locaties, om het magazijn op te bouwen.
- `stock`: alle voorraad, om pallets in de stellingen te tekenen.
- `order` met filter `status = open` of `status = picking`, plus de bijbehorende `order_line`.

**Specifiek:** de API moet kunnen **filteren** op `status`.

---

## 4. Seed-data

Deze data moet precies overeenkomen met de layout in de game.

### 4.1 Locaties (62 in totaal)

**Docks:** type `dock`, `level` = 0.

| location_id | pos_x | pos_y |
|---|---|---|
| `DOCK-01` | -18 | -3 |
| `DOCK-02` | -18 | 3 |

**Stellinglocaties:**

- Er zijn 4 rijen × 5 secties × 3 niveaus = 60 locaties.
- `location_id` = `R{rij}-{sectie:2 cijfers}-{niveau}`, bijvoorbeeld `R2-04-3`.
- `pos_x` hangt af van de sectie:

  | Sectie | 01 | 02 | 03 | 04 | 05 |
  |---|---|---|---|---|---|
  | pos_x | -4 | 0 | 4 | 8 | 12 |

- `pos_y` hangt af van de rij:

  | Rij | 1 | 2 | 3 | 4 |
  |---|---|---|---|---|
  | pos_y | -9 | -4 | 1 | 6 |

- `level` is 1, 2 of 3.
- **Type:** niveau 1 is `pick` (de picklocatie), niveau 2 en 3 zijn `rack` (bulk).

### 4.2 Artikelen

| sku | description |
|---|---|
| `SKU-001` | Doos schroeven |
| `SKU-002` | Pallet tegels |
| `SKU-003` | Rol isolatie |
| `SKU-004` | Kist gereedschap |
| `SKU-005` | Zak cement |

### 4.3 Beginvoorraad

Leg op ongeveer 25 willekeurige stellinglocaties een voorraad van tussen de 5 en 50 stuks van een willekeurig artikel.

---

## 5. Toegang en techniek

- **API-gebruiker:** maak één gebruiker voor de game, met lees- en schrijfrechten op alle bovenstaande entiteiten en acties.
- **CORS en inloggen:** zie [instructie 02](02-toegang-basic-auth-cors.md). De game roept de WMS rechtstreeks vanuit de browser aan.
- **Terug te melden:**
  1. de basis-URL van de API;
  2. hoe je inlogt (Basic auth, token of OAuth);
  3. een voorbeeld-URL van één GET en één actie-aanroep.
