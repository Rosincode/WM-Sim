# 15 — Automatisch gelijk lopen: voorraad op peil, robots doen alles, de WMS is leidend

De wens (2026-11-15): de hal draait zonder handwerk. De robots handelen alle leveringen en orders af
en melden elke stap terug; de WMS houdt de voorraad zelf op peil; en de WMS en de hal lopen gelijk,
ook als er een tijd niemand in de game is ingelogd. Een speler kan een order van een robot overnemen
als hij zelf iets wil doen.

Dit document zegt wat de game daarvoor sinds 2026-11-15 doet (hoofdstuk 1) en wat de WMS-app nog
nodig heeft (hoofdstuk 2). `GET {basis}/_openapi` is leidend.

## 1. Wat de game nu doet

### 1.1 Al gedaan is geen fout

De game liep vast op stappen die in de WMS al waren gezet: door een eerdere sessie, na een herstart
of door de WMS zelf. Zo'n weigering telt nu als gelukt; de hal gaat door.

| Aanroep | Weigering | Wat de game doet |
|---|---|---|
| `start_picking` | de order staat al op `picking` | verder met picken |
| `confirm_pick_line` | de regel heeft minder open dan de pick | boekt alleen wat in de WMS nog open staat; staat er niets meer open, dan niets |
| `confirm_pick` | de order staat al op `done`, `staged`, `loaded` of `shipped` | door naar klaarzetten |
| `stage_order` | de order staat al op `staged`, `loaded` of `shipped` | de order staat klaar |
| `load_order` | de order staat al op `loaded` of `shipped` | de order staat in de wagen |
| `truck_check_out` | `… is niet aangemeld.` | de wagen rijdt weg |

Na een geweigerde orderactie leest de game de status met `GET customer_order?order_id=<nummer>`.

### 1.2 De game leest wat er al gepickt is

`GET order_line` geeft `picked_qty`. De game pickt van een order alleen nog `qty − picked_qty`. Tot nu
toe begon de hal na een herstart bij elke order op `picking` opnieuw, en weigerde de WMS elke pick
(`Regel … heeft geen … meer open`). Op 2026-11-15 stonden zo 7 orders vast, waaronder `ORD-0216`.

### 1.3 Bij het inloggen neemt de hal de WMS over

Logt een speler in bij de WMS (of start de game met een bewaarde login), dan vergelijkt de game de
pallets in de stellingen met `GET pallet?status=active`. Is er een verschil, dan zet de game de hele
hal gelijk met de WMS: voorraad, pallets en open orders. Dat gebeurt één keer per login, alleen bij
de speler die de hal laat draaien (de host). Wat onderweg was (op een robot, op een inslagbaan)
vervalt in de hal; een robotopdracht die in de WMS nog op `in_progress` stond meldt de game af met
`fail_robot_task`, `draagt_pallet` = nee (zie 12).

Zonder login speelt de game op zijn ingebouwde mock; de WMS hoort dan niets. Bij de volgende login
geldt weer de stand van de WMS.

### 1.4 Een order overnemen van een pickrobot

Staat een speler bij een pickrobot die een order heeft, dan neemt hij die met E over. De pallet van de
order gaat naar de speler, met wat er al op ligt. In de WMS verandert daarbij niets: de order staat al
op `picking` en de speler maakt hem af met dezelfde acties (`confirm_pick_line`, `confirm_pick`,
`stage_order`). Zet de speler de pallet terug bij de lege pallets, dan pakt een pickrobot de order
weer op en gaat verder waar de speler ophield.

Een pallet met een open robotopdracht zet een speler gewoon met de hand weg (`pallet_move`); de WMS
laat de opdracht dan vervallen. Dat werkte al.

### 1.5 Aantallen rechtzetten

*WMS bijwerken naar de hal* (WMS-paneel, toets K) zet nu ook een afwijkend aantal recht: `GET
pallet?pallet_id=<nummer>` en dan `pallet/<id>/_flows/correct_pallet {counted_qty}`. Alleen voor een
pallet die aan beide kanten bestaat met hetzelfde artikel. Een pallet die maar aan één kant bestaat
zet de game niet recht; daarvoor is er *Hal resetten*.

### 1.6 Meldingen

Weigert de WMS een stap van een robot, een chauffeur of de telrobot, dan staat dat in het API-log van
de game en niet meer rood in beeld: zij proberen het zelf opnieuw. Rood in beeld komt alleen nog wat
een speler zelf doet.

## 2. Te doen in de WMS-app

### 2.1 Voorraad herverdelen (nu uitvoeren)

Stand 2026-11-15: 65 van de 109 actieve pallets staan buiten het pad van hun artikel, en er staat geen
enkele robotopdracht open.

| Artikel | Eigen pad | Ander pad | Stuks totaal |
|---|---|---|---|
| `SKU-001` | 10 | 11 | 411 |
| `SKU-002` | 6 | 11 | 271 |
| `SKU-003` | 4 | 13 | 313 |
| `SKU-004` | 6 | 14 | 348 |
| `SKU-005` | 6 | 14 | 368 |
| `SKU-006` | 1 | 0 | 3 |
| `SKU-007` | 0 | 0 | 2 |
| `SKU-008` | 0 | 0 | 2 |
| `SKU-009` | 1 | 0 | 3 |
| `SKU-010` | 2 | 2 | 10 |

Voer *Voorraad herverdelen* uit. Kies één van de twee:

- **Als robotopdrachten** (`herverdelen`): de robots in de hal rijden de pallets om. Duurt even, maar
  de hal en de WMS blijven gelijk.
- **In één keer in de gegevens**: daarna logt een speler opnieuw in, of drukt op *Hal resetten*; de
  hal neemt de nieuwe indeling over.

### 2.2 Meer beginvoorraad

`SKU-006` t/m `SKU-010` hebben 2 tot 10 stuks; daar valt niets te picken. Gewenst per artikel:

- elke locatie van het eigen pad één volle pallet: 14 picklocaties (niveau 1) en 28 racklocaties, dus
  42 pallets per artikel, 420 in totaal. Een pad heeft 126 palletplekken; er blijft dus ruimte voor
  leveringen.
- een volle pallet is 20 stuks (zo rekent de hal; een ander aantal mag, de hal toont wat de WMS
  geeft).
- pallets met sticker (`pallet`, status `active`), genummerd in de reeks van de beginvoorraad.

### 2.3 Leveringen van `simulatie_tick`: volle pallets

De ontvangsten van de flow zijn nu 2 stuks per pallet. Maak er volle pallets van (20 stuks), en
hooguit 6 pallets per vrachtwagen: zoveel plekken heeft een inslagbaan.

### 2.4 Aanvullen op minimumvoorraad en verwachte vraag (MRP)

Nu bepaalt alleen `sim_max_open_regels` wat de flow doet. Gewenst: de flow bestelt wat nodig is.

Velden op `item`:

| Veld | Type | Toelichting |
|---|---|---|
| `min_voorraad` | geheel getal | Bestelpunt in stuks. Voorstel: 200 |
| `max_voorraad` | geheel getal | Tot hier vult een levering aan. Voorstel: 840 (42 pallets) |
| `stuks_per_pallet` | geheel getal | Voorstel: 20 |
| `levertijd_min` | geheel getal | Minuten tussen bestellen en voorrijden. Voorstel: 5 |

Berekend per artikel (alleen lezen, ook zichtbaar via de API):

| Veld | Berekening |
|---|---|
| `vrije_voorraad` | voorraad op alle locaties − open orderregels (`open_qty` van orders op `open` en `picking`) |
| `onderweg` | stuks van ontvangsten die nog niet op `put_away` staan, plus bestelde leveringen die nog niet zijn voorgereden |
| `verbruik_per_uur` | gepickte stuks van de laatste 60 minuten (`stock_mutation`, soort `pick`) |
| `bestelpunt` | het grootste van `min_voorraad` en `verbruik_per_uur` × `levertijd_min` / 60 + `min_voorraad` / 2 |

Regel in `simulatie_tick`, per artikel dat meedoet (`in_simulatie`):

1. Is `vrije_voorraad` + `onderweg` kleiner dan `bestelpunt`, dan bestelt de flow een levering.
2. Aantal pallets: (`max_voorraad` − `vrije_voorraad` − `onderweg`) / `stuks_per_pallet`, naar boven
   afgerond, hooguit 6 per vrachtwagen. Is er meer nodig, dan volgt bij een latere tick de volgende
   wagen.
3. De wagen komt aan het dock van het artikel (`vast_dock`), na `levertijd_min`. Is dat dock bezet,
   dan wacht de levering tot het vrij is (bestaande regel: één aangemelde wagen per dock).
4. Veel orders op een artikel verhogen `verbruik_per_uur` en daarmee het bestelpunt: dat is de MRP.

De flow maakt orders zoals nu, maar alleen voor artikelen met `vrije_voorraad` groter dan 0. Zo komt
er geen order die niet te picken is.

### 2.5 Picklocaties aanvullen op een minimum

De opdracht `aanvullen` komt nu als een picklocatie leeg is. Gewenst: ook als de pickvoorraad van een
artikel (`voorraad_pick`) onder een minimum komt (voorstel: 40 stuks, instelbaar per artikel), zolang
er in de racks van het pad nog een pallet staat. Eén opdracht tegelijk per picklocatie.

### 2.6 Tien vrachtwagens staan sinds 14 november aangemeld

Alle tien docks zijn bezet (`SIM-IN-2611140925` … `SIM-IN-2611141615`), dus er komt geen nieuwe
levering bij. De game handelt ze af zodra een speler is ingelogd met de robots aan. Hebben hun
ontvangsten geen pallet (13, 2.3), meld ze dan in de WMS-app af en boek de voorraad recht; de game
kan zulke ontvangsten niet lossen of tellen.

### 2.7 Doorlopen als de game niet is ingelogd (nieuw)

De game draait in de browser van een speler. Is er niemand ingelogd, dan lost, telt en pickt er
niemand, en loopt de WMS vol met aangemelde wagens en open orders (zie 2.6). Gewenst: de WMS handelt
het werk dan zelf af.

**Aanwezigheid.** De game meldt zich elke 30 seconden. Voorstel: entiteit `game_sessie` met één
record per API-client en een actie `ping` (geen invoer) die `laatst_gezien` op nu zet. De game is
aanwezig als `laatst_gezien` jonger is dan 2 minuten.

**Is de game afwezig**, dan doet `simulatie_tick` per tick een stap per onderdeel, in het tempo van
de hal (ruwweg één handeling per minuut per robot):

| Onderdeel | Stap |
|---|---|
| Robotopdracht op `in_progress` | eerst afmelden als mislukt, `draagt_pallet` = nee: de robot in de hal bestaat niet meer |
| Ontvangst `received` | `unload`, bij de volgende tick `count` met het aantal van de ontvangst |
| Robotopdracht `open` | starten en afronden met de robot van het pad (de pallet verhuist) |
| Inkomende wagen waarvan alles is weggezet | `truck_check_out` |
| Order `open` | `start_picking`, de regels picken van de picklocaties, `confirm_pick`, `stage_order` op het `-UIT` van een vrij dock |
| Orders op `staged` | een uitgaande wagen aanmelden, `load_order`, `truck_check_out` |

**Komt de game terug** (er komt weer een `ping`), dan stopt de WMS hier direct mee. De game neemt bij
het inloggen de stand van de WMS over (1.3), dus er hoeft niets te worden teruggedraaid.

Zodra de naam van de entiteit en de actie vaststaan, bouwt de game de `ping` in.

### 2.8 Zien wie een order pickt (wens, niet nodig voor de game)

Veld `uitvoerder` op `customer_order` (tekst: `PCK-01`, `PCK-02` of de naam van de speler), mee te
geven als optionele invoer van `start_picking`. Dan toont de WMS-app wie de order heeft, en na het
overnemen (1.4) de nieuwe naam. Meld terug of dit er komt; de game geeft het dan mee.

## Terug te melden

- Dat de voorraad is herverdeeld (2.1) en hoe: als robotopdrachten of in de gegevens.
- De nieuwe beginvoorraad (2.2) en het aantal stuks per pallet van een levering (2.3).
- De namen van de velden en de regel voor het bestellen (2.4) en het aanvullen (2.5).
- Wat er met de tien aangemelde wagens is gedaan (2.6).
- De naam van de entiteit en de actie voor de aanwezigheid (2.7), en wat de WMS zelf afhandelt als de
  game afwezig is.
