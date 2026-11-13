# 08 — Robots in de hal en robotopdrachten uit de WMS

In de hal rijden robots die pallets lossen, tellen, wegzetten en aanvullen, en die orders picken. De
bedoeling is dat de WMS ze aanstuurt met **robotopdrachten** en dat de game elke stap terugmeldt.

**Stand:** de WMS heeft `robot`, `robot_task` en de drie acties gebouwd en de game gebruikt ze: zie
[12](12-robotkoppeling.md). Hoofdstuk 2 geldt alleen nog zonder WMS-login (de mock): dan bedenkt de
game de opdrachten zelf. De hoofdstukken 3 t/m 6 zijn het oorspronkelijke voorstel; de API is leidend.

De rolverdeling in dat voorstel:

- **De WMS** beslist welke pallet waarheen moet en maakt daar een robotopdracht van.
- **De game** speelt de vlootsturing en de robots zelf: hij kiest een vrije robot, laat die rijden en
  meldt terug dat de opdracht is gestart, afgerond of mislukt.

---

## 1. De robots

| Soort | Nummers | Wat hij doet |
|---|---|---|
| Tilrobot | `GKP-01`, `GKP-03`, `GKP-05`, `GKP-07` | Rijdt onder een pallet en tilt hem op. Komt alleen bij de vloer: de vrachtwagen aan het dock, de inslaglocaties en niveau 1 van de stellingen. |
| Robot-heftruck | `GKF-02`, `GKF-04`, `GKF-06`, `GKF-08` | Onbemande stapelaar met een mast. Pakt een pallet vanuit het pad en komt bij alle niveaus. |
| Pickrobot | `PCK-01`, `PCK-02` | Pickt een order zonder mens: pakt dozen van een pallet op elk niveau en zet de order klaar op een uitslaglocatie. |
| Voorraadteller | `INV-01` | Rijdt door de paden en scant de palletstickers op alle niveaus. |
| Telrobot | `TEL-01` | Telt elke pallet die op een inslaglocatie is neergezet en plakt er zo nodig een sticker op. |

- Elk pad tussen de stellingen heeft zijn eigen til- of heftruckrobot; het nummer is dat van het pad
  (zie 11). Er rijdt één robot tegelijk in een pad.
- Een stelling is alleen vanaf zijn eigen pad te bereiken.
- Robots pakken alleen pallets **met sticker** op (behalve bij het lossen uit de vrachtwagen).
- De speler kan de robots uitzetten in het menu van de game (onderdeel Robots); dan doet hij het
  werk met de hand.

## 2. Wat de game nu doet (zonder robotopdrachten uit de WMS)

De game bedenkt de opdrachten zelf en roept voor het boeken de bestaande acties aan:

| Wat er gebeurt | Aanroep naar de WMS |
|---|---|
| Een pallet staat in een aangemelde vrachtwagen: een tilrobot lost hem naar de inslaglocatie van dat dock, zolang daar plek is | `POST scan_log` (zie 10); bij een vrachtwagen van de game zelf `POST goods_receipt` |
| De telrobot telt de pallet op de inslaglocatie; zonder sticker plakt hij die | `POST scan_log`; `register_pallet` als er nog geen sticker op zat |
| Een getelde pallet gaat naar een vrije stellinglocatie: zo dicht mogelijk bij het dock, eerst de vloer, bij voorkeur bij hetzelfde artikel | `POST pallet_move` op het moment dat de robot met de pallet op de doellocatie staat |
| Een lege vloerlocatie (niveau 1) met voorraad erboven: een robot-heftruck haalt die pallet naar beneden | `POST pallet_move` |
| Een pickrobot neemt een open order | `start_picking`, per greep `confirm_pick_line`, dan `confirm_pick` en `stage_order` |
| De voorraadteller scant een pallet die is verzet en nog niet geboekt | `POST pallet_move` (boekt hem op de plek waar hij staat) |

- **Eerst de WMS, dan fysiek.** De robot zet een pallet pas neer als de WMS de verplaatsing heeft
  geaccepteerd. Weigert de WMS, dan rijdt de robot met de pallet naar zijn laadstation en probeert de
  game een andere locatie.
- De game kiest alleen locaties die niet geblokkeerd zijn, waar geen ander artikel staat en waar nog
  een palletplek vrij is.

---

## 3. Voorstel: entiteit `robot`

De vloot, om in de WMS-app te zien wat de robots doen. De game hoeft deze lijst niet te lezen.

| Veld | Type | Toelichting |
|---|---|---|
| `robot_id` | tekst, uniek, max 20 | De nummers uit hoofdstuk 1 |
| `description` | tekst | Bijvoorbeeld `Tilrobot pad 1` |
| `status` | domein `robot_status` | `idle` of `busy` |
| `task_id` | verwijzing naar `robot_task` | De opdracht waar de robot mee bezig is |

## 4. Voorstel: entiteit `robot_task`

Eén record per opdracht: breng deze pallet van de ene locatie naar de andere.

| Veld | Type | Toelichting |
|---|---|---|
| `task_id` | tekst, uniek, max 20 | Door de WMS uitgegeven, bijvoorbeeld `RT-000123` |
| `pallet_id` | tekst | Het nummer op de palletsticker |
| `from_location_id` | verwijzing naar `location` | Waar de pallet staat |
| `to_location_id` | verwijzing naar `location` | Waar hij heen moet |
| `status` | domein `robot_task_status` | `open` → `in_progress` → `done` of `failed` |
| `robot_id` | verwijzing naar `robot` | Gezet door `start_robot_task` |
| `fail_reason` | tekst | Gezet door `fail_robot_task` |

Controles bij het aanmaken:

- `from_location_id` is een docklocatie of een stellinglocatie waar de pallet staat.
- `to_location_id` is een stellinglocatie die niet geblokkeerd is, waar geen ander artikel ligt en
  waar (samen met de opdrachten die er al naartoe onderweg zijn) minder dan drie pallets staan.
- Er is geen andere opdracht met status `open` of `in_progress` voor dezelfde `pallet_id`.

Een opdracht van of naar niveau 2 of 3 gaat naar een robot-heftruck; werk op de vloer gaat bij
voorkeur naar een tilrobot.

## 5. Voorstel: acties voor de terugmelding

### 5.1 `start_robot_task`: een robot begint

- **Invoer:** `task_id`, `robot_id`
- **Controles:** de opdracht heeft status `open`; de robot heeft status `idle`.
- **Effect:** de opdracht wordt `in_progress` met `robot_id`; de robot wordt `busy`.
- Weigert de WMS, dan rijdt de robot niet en laat de game de opdracht liggen.

### 5.2 `complete_robot_task`: de pallet staat op de doellocatie

De game roept deze actie aan als de robot met de pallet **op** de doellocatie staat. Pas als de WMS
akkoord is, zet de robot de pallet neer.

- **Invoer:** `task_id`, `robot_id`
- **Controles:** de opdracht heeft status `in_progress` en hoort bij deze robot; verder dezelfde
  controles als `pallet_move`.
- **Effect:** de pallet verhuist naar `to_location_id`, net als bij `pallet_move`. De opdracht wordt
  `done`; de robot wordt `idle`.
- Weigert de WMS, dan zet de robot de pallet **niet** neer en volgt `fail_robot_task` met
  `pallet_on_robot` = ja.

### 5.3 `fail_robot_task`: de opdracht is mislukt

- **Invoer:** `task_id`, `robot_id` (leeg als er nog geen robot aan begonnen was), `reason` (tekst),
  `pallet_on_robot` (ja/nee)
- **Controles:** de opdracht heeft status `open` of `in_progress`.
- **Effect:** de opdracht wordt `failed` met `fail_reason`; de robot wordt `idle`. De voorraad
  verandert **niet**: de pallet staat in de WMS nog op `from_location_id`.
- **`pallet_on_robot` = ja** betekent: de robot had de pallet al opgetild en wacht er nu mee bij zijn
  laadstation. De WMS maakt dan een **nieuwe opdracht** voor dezelfde `pallet_id`, met een andere
  `to_location_id`. De game geeft die aan de robot die de pallet al draagt. Draagt een tilrobot de
  pallet, dan moet de nieuwe locatie op niveau 1 liggen.

Redenen die de game meldt, bijvoorbeeld:

| Reden | Wanneer |
|---|---|
| `PAL-… staat niet (meer) op DOCK-01-IN` | Een medewerker heeft de pallet intussen zelf weggezet |
| `R3B-02-1 is vol` / `op R3B-02-1 staat al een ander artikel` | De doellocatie is fysiek bezet |
| `R3B-02-2 ligt niet op de vloer: daar kan alleen een robot-heftruck bij` | Een tilrobot draagt de pallet en de opdracht gaat naar een hoger niveau |
| `op de pallet op DOCK-01-IN zit nog geen sticker` | De pallet is nog niet geteld |
| `PAL-… is verplaatst en nog niet geboekt` | De pallet staat fysiek ergens anders dan in de WMS |
| `de WMS weigert: …` | `complete_robot_task` werd geweigerd |

## 6. Voorstel: uitlezen

De game haalt elke 2 seconden de opdrachten met status `open` op en heeft per opdracht nodig:
`task_id`, `pallet_id`, `from_location_id`, `to_location_id`. Een opdracht die de WMS niet meer
aanbiedt en nog geen robot heeft, vervalt.

## 7. Nog niet gebouwd in de game

- Positie en accustand van de robots doorgeven aan de WMS. De game houdt die bij en toont ze in zijn
  eigen menu.
- Opdrachten voor de pickrobots, de voorraadteller en de telrobot uit de WMS: die kiezen hun werk
  zelf (open orders, de paden, de inslaglocaties).
- Een opdracht annuleren terwijl een robot al rijdt.

## Terug te melden als dit wordt gebouwd

- De namen van de entiteiten, velden en acties zoals ze in de WMS zijn gebouwd, en hoe de game ze
  aanroept (record aanmaken of actie op een record).
- Hoe de WMS opdrachten aanmaakt: automatisch na het tellen of stickeren, met de hand, of allebei.
