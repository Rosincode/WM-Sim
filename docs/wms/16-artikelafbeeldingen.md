# 16 — Afbeeldingen van artikelen uploaden vanuit de game

De WMS heeft sinds 2026-11-15 een afbeelding per artikel (`item.afbeelding`) met een uploadroute. De
game stuurt daar de tekening van elke robot naartoe: dezelfde die op de postertjes aan de stellingen
hangt. Dit document zegt wat de game doet en wat er in de WMS nog voor nodig is.

## 1. Wat de game doet

In het WMS-paneel (toets K) staat het blok *Afbeeldingen van de artikelen*:

- De game leest `GET item` en telt de artikelen waarvan `afbeelding` leeg is.
- *Tekening uploaden voor n artikelen* stuurt voor elk artikel zonder afbeelding de tekening op;
  *Alle afbeeldingen vervangen door de tekening* doet het voor elk artikel.
- Per artikel één aanroep:

  ```
  PUT item/<id>/_files/afbeelding
  Authorization: Bearer <API-sleutel>
  Content-Type: application/octet-stream
  X-File-Name: SKU-001.png
  <de png: 512 × 512 pixels, ongeveer 20 kB>
  ```

- Een artikel waarvoor de game geen eigen tekening heeft (een nieuw artikel in de WMS) krijgt een
  eenvoudige standaardrobot.

De game toont de afbeelding uit de WMS zelf niet; de postertjes in de hal blijven de tekening.

## 2. Te doen in de WMS-app

### 2.1 CORS: de header `X-File-Name` toestaan

De uploadroute vraagt de header `X-File-Name`. Het antwoord op de preflight
(`OPTIONS item/<id>/_files/afbeelding`) noemt nu alleen `Authorization, Content-Type` in
`Access-Control-Allow-Headers`. Een browser stuurt de upload daardoor niet door: de knop in de game
meldt dan `WMS niet bereikbaar`. Gecontroleerd op 2026-11-15 met `Origin: https://rosincode.github.io`.

- **Rechtzetten:** `X-File-Name` toevoegen aan `Access-Control-Allow-Headers`.

Met de CORS-controle van de browser uitgezet werkt de route: zo zijn op 2026-11-15 de tekeningen van de
tien artikelen met de knop in de game geüpload en teruggelezen.

### 2.2 CORS: `http://localhost:5173` is niet meer toegestaan

De API-beschrijving noemt bij CORS `https://rosincode.github.io` en `http://localhost:5173`. In de
praktijk krijgt alleen de eerste een `Access-Control-Allow-Origin`; een preflight met
`Origin: http://localhost:5173` geeft `404`. De game op een ontwikkel-pc kan de WMS daardoor niet
bereiken.

- **Rechtzetten:** `http://localhost:5173` weer toestaan, of uit de API-beschrijving halen als het
  bewust is.

### 2.3 Rechten

Bij de API-client van de game: schrijven op `item` (voor de upload). Lezen van het bestand
(`GET item/<id>/_files/afbeelding`) gebruikt de game niet.

## Terug te melden

- Dat `X-File-Name` is toegestaan (2.1).
- Of `http://localhost:5173` weer mag (2.2).
