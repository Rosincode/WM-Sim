# 08 — Geek+-robots: robotopdrachten uit de WMS en de terugmelding

In de hal rijden nu drie Geek+-robots (`GKP-01`, `GKP-02`, `GKP-03`). Het zijn lage robots die onder
een pallet rijden, hem optillen en naar een andere locatie brengen. De WMS stuurt ze aan met
**robotopdrachten**; de game voert die uit en meldt elke stap terug.

De rolverdeling:

- **De WMS** beslist welke pallet waarheen moet en maakt daar een robotopdracht van.
- **De game** speelt de vlootsturing (de rol van het Geek+ RMS) en de robots zelf: hij kiest een vrije
  robot, laat die rijden en meldt terug dat de opdracht is gestart, afgerond of mislukt.

Alles uit 01 t/m 07 blijft gelden.

---

## 1. Wat de game nu doet

De WMS geeft nog geen robotopdrachten uit. Tot dat zo is speelt de game die rol zelf na, zodat de
robots al werken:

| Wat er gebeurt | Aanroep naar de WMS | Nu al aangeroepen |
|---|---|---|
| Een pallet met sticker staat op een inslaglocatie (`DOCK-xx-IN`): de game bedenkt zelf een opdracht naar een vrije vloerlocatie | geen | n.v.t. |
| Een robot begint aan de opdracht | `start_robot_task` | nog niet |
| De robot staat met de pallet op de doellocatie | `confirm_putaway` (`sku`, `qty`, van de inslaglocatie naar de stellinglocatie) | ja |
| De opdracht mislukt | `fail_robot_task` | nog niet |

Zodra de WMS de entiteiten en acties hieronder heeft, vervalt het naspelen: de game haalt de
opdrachten dan uit de WMS en roept `complete_robot_task` aan in plaats van `confirm_putaway`.

**Wat een robot kan:**

- Ophalen van een **inslaglocatie** (`DOCK-xx-IN`) of van een stellinglocatie op **niveau 1** (de vloer).
- Wegzetten op een stellinglocatie op **niveau 1**. Hoger komt een robot niet: dat blijft werk voor de
  heftruck.
- Alleen pallets **met sticker**. Een pallet uit een vrachtwagen moet dus eerst door een medewerker
  gelost en gestickerd zijn (`register_pallet`, zie 07).
- Eén artikel per locatie, hooguit drie pallets per locatie (zie 07).

---

## 2. Entiteit `robot`

De vloot. De game leest deze lijst nu nog niet; hij is er om in de WMS-app te zien wat de robots doen.

| Veld | Type | Verplicht | Toelichting |
|---|---|---|---|
| `robot_id` | tekst (PK), max 20 | ja | `GKP-01`, `GKP-02`, `GKP-03` |
| `description` | tekst | nee | Bijvoorbeeld `Geek+ palletrobot` |
| `status` | domein `robot_status` | ja | `idle` of `busy`. Standaard `idle`. |
| `task_id` | FK → `robot_task` | nee | De opdracht waar de robot mee bezig is |

**Seed-data:** de drie robots hierboven, status `idle`.

## 3. Entiteit `robot_task`

Eén regel per opdracht: breng deze pallet van de ene locatie naar de andere.

| Veld | Type | Verplicht | Toelichting |
|---|---|---|---|
| `task_id` | tekst (PK), max 20 | ja | Door de WMS uitgegeven, bijvoorbeeld `RT-000123` |
| `pallet_id` | tekst, max 40 | ja | Het nummer op de palletsticker (FK → `pallet` zodra die entiteit uit 07 er is) |
| `sku` | FK → `item` | ja | Wat er op de pallet staat |
| `qty` | geheel getal > 0 | ja | Aantal stuks op de pallet |
| `from_location_id` | FK → `location` | ja | Waar de pallet staat |
| `to_location_id` | FK → `location` | ja | Waar hij heen moet |
| `status` | domein `robot_task_status` | ja | Zie hieronder. Standaard `open`. |
| `robot_id` | FK → `robot` | nee | Gezet door `start_robot_task` |
| `fail_reason` | tekst | nee | Gezet door `fail_robot_task` |
| `created_at`, `started_at`, `finished_at` | datum/tijd | nee | |

**Domein `robot_task_status`:**

| Waarde | Betekenis | Gezet door |
|---|---|---|
| `open` | Wacht op een robot | de WMS, bij het aanmaken |
| `in_progress` | Een robot is ermee bezig | `start_robot_task` |
| `done` | Pallet staat op de doellocatie | `complete_robot_task` |
| `failed` | Niet gelukt | `fail_robot_task` |

**Domein `robot_status`:** `idle`, `busy`.

---

## 4. Opdrachten aanmaken (in de WMS)

Hoe de WMS opdrachten aanmaakt is aan de WMS. Twee manieren die bij de game passen:

1. **Automatisch na het stickeren.** Zodra `register_pallet` een pallet op een inslaglocatie vastlegt,
   maakt de WMS een `robot_task` naar een locatie die hij zelf kiest.
2. **Met de hand.** Een taak of scherm in de WMS-app waarmee een gebruiker een opdracht aanmaakt.

Controles bij het aanmaken:

- `from_location_id` is van type `dock` (een inslaglocatie) of een stellinglocatie met `level` = 1.
- `to_location_id` is een stellinglocatie met `level` = 1 en is niet geblokkeerd.
- Op `to_location_id` ligt geen ander artikel, en er staan (samen met de opdrachten die er al naartoe
  onderweg zijn) minder dan drie pallets.
- Er is geen andere opdracht met status `open` of `in_progress` voor dezelfde `pallet_id`.

---

## 5. Acties voor de terugmelding

Alle acties geven bij een fout een duidelijke foutmelding terug. De game toont die in het API-log en
aan de speler.

### 5.1 `start_robot_task`: een robot begint

- **Parameters:** `task_id`, `robot_id`
- **Controles:** de opdracht heeft status `open`; de robot heeft status `idle`.
- **Effect:** de opdracht wordt `in_progress` met `robot_id` en `started_at`; de robot wordt `busy` met
  `task_id`.
- Weigert de WMS, dan rijdt de robot niet en laat de game de opdracht liggen.

### 5.2 `complete_robot_task`: de pallet staat op de doellocatie

De game roept deze actie aan als de robot met de pallet **op** de doellocatie staat. Pas als de WMS
akkoord is, zet de robot de pallet neer.

- **Parameters:** `task_id`, `robot_id`
- **Controles:** de opdracht heeft status `in_progress` en hoort bij deze robot. Verder dezelfde
  controles als `confirm_putaway` (voorraad aanwezig op de van-locatie, doellocatie niet geblokkeerd).
- **Effect:**
  - De voorraad (`sku`, `qty` van de opdracht) gaat van `from_location_id` naar `to_location_id`,
    net als bij `confirm_putaway`. Bestaat de entiteit `pallet`, dan krijgt de pallet de nieuwe
    `location_id`.
  - De opdracht wordt `done` met `finished_at`; de robot wordt `idle` en `task_id` leeg.
- Weigert de WMS, dan zet de robot de pallet **niet** neer en volgt `fail_robot_task` met
  `pallet_on_robot` = ja.

### 5.3 `fail_robot_task`: de opdracht is mislukt

- **Parameters:** `task_id`, `robot_id` (optioneel: leeg als er nog geen robot aan begonnen was),
  `reason` (tekst), `pallet_on_robot` (ja/nee)
- **Controles:** de opdracht heeft status `open` of `in_progress`.
- **Effect:** de opdracht wordt `failed` met `fail_reason` en `finished_at`; de robot (als die is
  meegegeven) wordt `idle`. De voorraad verandert **niet**: de pallet staat in de WMS nog op
  `from_location_id`.
- **`pallet_on_robot` = ja** betekent: de robot had de pallet al opgetild en wacht er nu mee bij zijn
  laadstation. De WMS moet dan een **nieuwe opdracht** maken voor dezelfde `pallet_id`, met dezelfde
  `from_location_id` en een andere `to_location_id`. De game geeft die opdracht aan de robot die de
  pallet al draagt; die rijdt dan meteen naar de nieuwe doellocatie.

Redenen die de game meldt, bijvoorbeeld:

| Reden | Wanneer |
|---|---|
| `PAL-… staat niet (meer) op DOCK-01-IN` | Een medewerker heeft de pallet intussen zelf weggezet |
| `R3-02-1 is vol` / `op R3-02-1 staat al een ander artikel` | De doellocatie is fysiek bezet |
| `R3-02-2 ligt niet op de vloer: daar kan een robot niet bij` | Opdracht naar een hoger niveau |
| `de WMS weigert: …` | `complete_robot_task` werd geweigerd |

---

## 6. Uitlezen (GET)

- De game haalt elke 2 seconden de opdrachten op met `status eq 'open'` en heeft per opdracht nodig:
  `task_id`, `pallet_id`, `from_location_id`, `to_location_id`.
- `robot` en de overige opdrachten krijgen de standaard-GET; de game leest ze nu nog niet.

---

## 7. Nog niet bouwen

- Positie en accustand van de robots in de WMS. De game houdt die bij en toont ze in zijn eigen menu
  (onderdeel Robots).
- Opdrachten voor rolcontainers of voor de hogere niveaus van de stellingen.
- Opdrachten annuleren vanuit de WMS terwijl een robot al rijdt. Een opdracht met status `open` kan
  wel worden verwijderd: de game biedt hem dan niet meer aan een robot aan.

---

## Terug te melden

- De namen van de entiteiten, velden en acties zoals ze in de WMS zijn gebouwd (als ze afwijken van
  hierboven), en de URL's van de drie acties en van de lijst met open opdrachten.
- Hoe de WMS opdrachten aanmaakt (hoofdstuk 4: automatisch, met de hand, of allebei).
- Of `complete_robot_task` de voorraad zelf omboekt, of dat de game daarnaast `confirm_putaway` moet
  blijven aanroepen.
