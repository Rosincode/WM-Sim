# 06 — De WMS beslist: scanner en magazijn werken via de API

De game bevat geen WMS-logica meer. Hij is alleen nog de fysieke wereld: vrachtwagens, pallets,
rolcontainers en de speler met een scanner. Bij **elke handeling vraagt de game eerst de WMS** (via de
actie-endpoints) en wacht op het antwoord:

- zegt de WMS ja, dan gebeurt de handeling in de hal;
- zegt de WMS nee, dan gebeurt er niets en ziet de speler de foutmelding van de WMS op zijn scanner.

De schermen in de hal (pc en tablet) tonen alleen nog de WMS-app zelf, in een iframe. Wat de speler moet
weten om zijn werk te doen, moet dus **in de WMS-app** te vinden zijn.

Alles uit 01 t/m 05 blijft gelden. Dit document beschrijft wat daardoor extra van de WMS-app nodig is.

---

## 1. Wat de game niet meer doet (en de WMS dus wel)

| Dit deed de game | Nu |
|---|---|
| Zelf orders bedenken | Orders komen alleen uit de WMS. De game leest de orders met status `open` of `picking` en zet daar werk voor klaar. |
| Een stellinglocatie kiezen bij het wegzetten | De speler scant zelf een locatie. `confirm_putaway` bepaalt of dat mag. |
| Bepalen van welke locatie een orderregel gepickt wordt | De speler zoekt de locatie op in de WMS-app en scant hem. `confirm_pick` bepaalt of de order compleet kan. |
| Controleren of er genoeg voorraad is | Alleen de WMS controleert dat. |
| De voorraad zelf bijhouden | De hal toont de voorraad uit de WMS. De game leest hem elke 3 seconden en direct na elke handeling. |

## 2. Schermen die de WMS-app nodig heeft

De speler bekijkt de app op de pc (1920 × 1080) en op de tablet (1024 × 640). Zorg dat deze schermen
op het kleine formaat bruikbaar zijn.

1. **Order invoeren.** Een order met regels (`sku`, `qty`) aanmaken, status `open`. Zonder orders in
   de WMS is er in de hal geen uitgaand werk.
2. **Picklijst per order.** Voor elke order met status `open` of `picking`: de regels, en per regel op
   welke locaties dat artikel ligt en hoeveel. De game wijst geen picklocatie meer aan; de speler leest
   hem hier af.
3. **Voorraadoverzicht.** Voorraad per locatie en per artikel, met zoeken op locatie en op artikel.
4. **Wegzetadvies (mag later).** Voor een artikel: welke stellinglocaties zijn vrij of bevatten
   hetzelfde artikel. De speler mag elke locatie scannen; dit scherm helpt hem kiezen.

## 3. Antwoorden van de acties

De speler staat te wachten op het antwoord. Daarom:

- **Snel.** Een actie antwoordt bij voorkeur binnen een seconde.
- **Duidelijke foutmelding.** De game toont de tekst letterlijk op het schermpje van de scanner, na de
  woorden "WMS weigert:". Houd de melding kort (één zin, Nederlands), bijvoorbeeld
  `Locatie R3-02-1 is geblokkeerd.` of `Onvoldoende voorraad SKU-003: nodig 4, aanwezig 2.`
- **Formaat.** Een geweigerde actie geeft een HTTP-status 4xx. De game toont nu de eerste 300 tekens
  van de response-body. Meld terug in welke vorm de foutmelding terugkomt (platte tekst, of JSON met
  in welk veld de melding staat), dan haalt de game precies die tekst eruit.
- **Geen half werk.** Een geweigerde actie wijzigt niets in de WMS.

## 4. Wanneer de game welke actie aanroept

| Handeling in de hal | Actie | Nu al aangeroepen |
|---|---|---|
| Pallet scannen en lossen uit de vrachtwagen | `register_goods_received` (`dock_id` = `DOCK-NN-IN`) | ja |
| Pallet in de hand, stellinglocatie scannen | `confirm_putaway` (van `DOCK-NN-IN` naar de gescande locatie) | ja |
| Pallet met de heftruck verplaatsen | `confirm_putaway` (van stellinglocatie naar stellinglocatie) | ja |
| Rolcontainer pakken voor de eerste open order | `start_picking` | ja |
| Laatste orderregel fysiek gepickt | `confirm_pick` | ja |
| Vrachtwagen aan- en uitmelden | `truck_check_in`, `truck_check_out` (04) | nog niet |
| Elke scan vastleggen | `register_scan` (04) | nog niet |
| Eén greep uit een locatie | `confirm_pick_line` (04) | nog niet |
| Order klaarzetten of inladen | `stage_order`, `load_order` (04) | nog niet |

De acties met "nog niet" doet de game nu alleen fysiek, zonder controle. Zodra ze in de WMS bestaan,
gaat de game ze op dezelfde manier eerst vragen. **Meld terug welke acties uit 04 klaar zijn.**

### Specifiek

- **Heftruck.** Bij een verplaatsing met de heftruck staat de pallet al op de nieuwe plek als
  `confirm_putaway` wordt aangeroepen. Weigert de WMS, dan neemt de game bij de volgende stand de
  voorraad uit de WMS weer over (de pallet staat dan terug op de oude locatie).
- **Picken zolang `confirm_pick_line` nog niet wordt aangeroepen.** De speler pakt fysiek van de
  locatie die hij scant. `confirm_pick` boekt daarna af volgens de regel uit 01 (eerst `pick`, dan
  `rack`). Dat kan een andere locatie zijn dan waar de speler stond; de game neemt dan de voorraad van
  de WMS over.
- **Order die al op `picking` staat.** Staat een order in de WMS op `picking` terwijl niemand in de hal
  hem bij zich heeft (de game is herstart, of de speler zette de rolcontainer terug), dan biedt de game
  hem opnieuw aan en roept hij `start_picking` niet nog een keer aan.
- **Orders ophalen.** De game gebruikt alleen orders met status `open` en `picking`. Het filter uit 04,
  hoofdstuk 5 (`status eq 'open' or status eq 'picking'`) blijft dus gewenst.

## 5. De app in een iframe

De pc en de tablet in de hal laden de WMS-app in een iframe. Daarvoor is nodig:

- **Insluiten toestaan** voor de origins van de game: `Content-Security-Policy: frame-ancestors
  https://rosincode.github.io http://localhost:5173` (en geen `X-Frame-Options: DENY/SAMEORIGIN`).
- **Inloggen binnen het iframe.** De app draait daar als "third party". Een sessiecookie moet
  `SameSite=None; Secure` hebben, anders blijft de speler na het inloggen op het inlogscherm hangen.
- De login van de app staat los van de API-login (Basic auth, zie 02) waarmee de game de acties
  aanroept.

## Terug te melden

1. Welke schermen uit hoofdstuk 2 er zijn, en het adres waarop de speler de app opent.
2. De vorm van een foutmelding (hoofdstuk 3).
3. Welke acties uit 04 gebouwd zijn (hoofdstuk 4).
4. Of insluiten en inloggen in een iframe werkt (hoofdstuk 5).
