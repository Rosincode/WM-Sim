# 06 — De WMS beslist: scanner en magazijn werken via de API

De game bevat geen WMS-logica. Hij is de fysieke wereld: vrachtwagens, pallets, rolcontainers,
robots en de speler met een scanner. Bij **elke handeling vraagt de game eerst de WMS** en wacht op
het antwoord:

- zegt de WMS ja, dan gebeurt de handeling in de hal;
- zegt de WMS nee, dan gebeurt er niets en ziet de speler de melding van de WMS op zijn scanner.

Wat de speler moet weten om zijn werk te doen, moet dus **in de WMS-app** te vinden zijn.

---

## 1. Wie doet wat

| Onderwerp | De WMS | De game |
|---|---|---|
| Orders | Maakt ze aan (in de app, of met de flow uit 10) | Leest de orders met status `open` of `picking` en zet daar werk voor klaar. Bedenkt zelf geen orders. |
| Wegzetten | Bepaalt of een locatie mag (`pallet_move`, `putaway`) | De speler of robot kiest en scant een locatie |
| Picken | Bepaalt of de pick klopt (`confirm_pick_line`) en of de order compleet is (`confirm_pick`) | De speler zoekt de locatie op in de WMS-app of op de afgedrukte picklijst en scant hem |
| Voorraadcontrole | Controleert of er genoeg ligt | Controleert niets |
| Voorraad | Is de administratie | Heeft zijn eigen, fysieke voorraad (zie hieronder) |

**De hal heeft zijn eigen voorraad.** Die is voor alle spelers dezelfde en mag afwijken van de WMS,
zoals in het echt: de WMS hoort alleen wat er gebeurt doordat er gescand wordt. Een pallet die met
de heftruck is verzet staat fysiek op de nieuwe plek, en in de WMS pas na de scan van de sticker
(07). De voorraad uit de WMS komt alleen in de hal bij de allereerste start en met de knop
'Hal resetten naar de WMS-voorraad' in het menu. Een correctie in de WMS-app verandert de hal dus
niet.

De game laat in zijn menu (toets I) zien wat de WMS aan voorraad en orders heeft, en in het API-log
(toets L) elke aanroep met het antwoord.

## 2. Schermen in de WMS-app

De speler opent de app op `https://<host>/t/wm_sim/` en logt in met een gebruikersaccount met rol
`speler`. Dat staat los van de API-sleutel van de game (02).

| Scherm | Stand |
|---|---|
| **Order invoeren:** Orders → Nieuw, regels in de tabel Orderregels | aanwezig |
| **Picklijst:** Orders → Te picken → order; artikel aanklikken voor de locaties | aanwezig |
| **Voorraadoverzicht:** Voorraad, filter op locatie en artikel | aanwezig |
| **Palletverplaatsingen:** lijst in menu Speler | aanwezig |
| **Wegzetadvies:** welke stellinglocaties zijn vrij of bevatten hetzelfde artikel | nog niet |

De game heeft daarnaast een printer bij de pc die de picklijst van een order afdrukt, met de
locaties volgens de voorraad die de WMS op dat moment meldt.

## 3. Antwoorden van de acties

De speler staat te wachten op het antwoord. Daarom:

- **Snel.** Een actie antwoordt bij voorkeur binnen een seconde. Tijdens het wachten kan de speler
  geen volgende handeling doen.
- **Duidelijke melding.** Een geweigerde actie geeft `409` met `{ "error": "…" }`. De game toont die
  tekst letterlijk op de scanner, na de woorden "WMS weigert:". Kort, één zin, Nederlands,
  bijvoorbeeld `Locatie R3B-02-1 is geblokkeerd.` of
  `Onvoldoende voorraad SKU-003: nodig 4, aanwezig 2.`
- **Geen half werk.** Een geweigerde actie wijzigt niets in de WMS.

## 4. Bijzonderheden

- **Heftruck en pompwagen.** Een pallet verzetten is alleen fysiek. De WMS hoort het pas als de
  speler (of de voorraadteller, 08) de palletsticker op de nieuwe locatie scant. Weigert de WMS, dan
  blijft de pallet staan waar hij staat en ziet de speler de melding.
- **Order die al op `picking` staat.** Staat een order in de WMS op `picking` terwijl niemand in de
  hal hem bij zich heeft (de game is herstart, of de speler zette de rolcontainer terug), dan biedt
  de game hem opnieuw aan en roept hij `start_picking` niet nog een keer aan.
- **Rolcontainer terugzetten** kan alleen zolang de WMS nog geen pick van die order heeft geboekt.
- **Samen spelen.** Spelers delen één hal. Eén van hen (de host) haalt de orders en leveringen uit
  de WMS; de anderen krijgen ze via de gedeelde wereld. Elke speler roept de WMS aan met zijn eigen
  API-sleutel voor zijn eigen handelingen.

## 5. De app in een iframe

De pc en de tablet in de hal laden de WMS-app in een iframe, met een adresbalk waarin de speler het
adres van de app invult. **Dat werkt nog niet:** het platform staat insluiten niet toe en de
sessiecookie werkt niet in een iframe van een andere site. Tot dat is opgelost opent de speler de
app in een eigen tabblad of venster naast de game.

Wat ervoor nodig is:

- **Insluiten toestaan** voor de origins van de game: `Content-Security-Policy: frame-ancestors
  https://rosincode.github.io http://localhost:5173` (en geen `X-Frame-Options: DENY/SAMEORIGIN`).
- **Inloggen binnen het iframe.** De app draait daar als "third party". Een sessiecookie moet
  `SameSite=None; Secure` hebben, anders blijft de speler na het inloggen op het inlogscherm hangen.
- De schermen moeten bruikbaar zijn op het formaat van de pc (1920 × 1080) en de tablet (1024 × 640).
