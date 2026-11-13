# 11 — Dubbele stellingen: 8 paden met een stelling A en B

De stellingen in de hal staan nu rug-aan-rug, zoals in een echt magazijn. Tussen de stellingen
liggen 8 paden; aan elk pad staan twee stellingen tegenover elkaar: **stelling A** links en
**stelling B** rechts (gezien als je vanaf de dockkant het pad in loopt). Elke stelling is alleen
vanaf zijn eigen pad te bereiken.

De stellingcodes volgen daarom het pad: `R1A` en `R1B` zijn de twee stellingen van pad 1, `R2A` en
`R2B` die van pad 2, enzovoort. Op dezelfde vloer staan nu 16 stellingen in plaats van 11.

Het datamodel en de acties veranderen niet. Alleen de **locaties** en de **robots** wijzigen. De
docklocaties (zie 05) blijven gelijk.

**Stand 2026-11-13:** dit is in de WMS nog niet doorgevoerd. De WMS heeft nog de 261 oude locaties
(`R1-01-1` … `R11-07-3`) en noemt die ook zo in zijn API-beschrijving. Tot de stellinglocaties zijn
hernoemd weigert de WMS elke scan en boeking op een stellinglocatie.

## 1. Wat er verandert

| | Oud | Nieuw |
|---|---|---|
| Stellingen | 11 rijen (`R1` … `R11`) | 8 paden × 2 stellingen (`R1A`, `R1B` … `R8A`, `R8B`) |
| Stellinglocaties | 11 × 7 × 3 = 231 | 16 × 7 × 3 = 336 |
| Totaal locaties (met de 30 docklocaties) | 261 | 366 |
| Padrobots (tilrobots en robot-heftrucks) | 10 | 8 |

- **Alle stellingcodes wijzigen.** De 231 bestaande locaties krijgen een nieuwe `location_id` en een
  nieuwe `pos_y` (paragraaf 2); er komen 105 locaties bij (`R6B` t/m `R8B`).
- Hernoem de bestaande locaties in plaats van ze te verwijderen en opnieuw aan te maken: voorraad,
  pallets en historie blijven dan op dezelfde fysieke stelling staan.
- `pos_x`, `level` en `location_type` blijven gelijk: sectie 01 t/m 07 op `pos_x` -8, -4, 0, 4,
  8, 12, 16; niveau 1 is `pick`, niveau 2 en 3 zijn `rack`.
- `location_id` = `R{pad}{A of B}-{sectie:2 cijfers}-{niveau}`, bijvoorbeeld `R3B-07-2`. Het
  padnummer heeft geen voorloopnul.

## 2. Van oude naar nieuwe code

Alleen het deel vóór het eerste streepje verandert; sectie en niveau blijven gelijk
(`R4-05-2` wordt `R2B-05-2`).

| Oud | Nieuw | pos_y |
|---|---|---|
| `R1` | `R1A` | -24.5 |
| `R2` | `R1B` | -19.5 |
| `R3` | `R2A` | -18.2 |
| `R4` | `R2B` | -13.2 |
| `R5` | `R3A` | -11.9 |
| `R6` | `R3B` | -6.9 |
| `R7` | `R4A` | -5.6 |
| `R8` | `R4B` | -0.6 |
| `R9` | `R5A` | 0.7 |
| `R10` | `R5B` | 5.7 |
| `R11` | `R6A` | 7 |
| nieuw | `R6B` | 12 |
| nieuw | `R7A` | 13.3 |
| nieuw | `R7B` | 18.3 |
| nieuw | `R8A` | 19.6 |
| nieuw | `R8B` | 24.6 |

Als formule, voor pad `p` (1 t/m 8): stelling A ligt op `pos_y` = -24.5 + (p − 1) × 6.3, stelling B
5 hoger. Het pad zelf ligt er middenin: `pos_y` = -22 + (p − 1) × 6.3.

De oude en de nieuwe codes overlappen niet (de nieuwe hebben altijd een letter), dus de volgorde
van hernoemen maakt niet uit.

De game vergelijkt zijn locaties met die van de WMS (WMS-paneel, toets K) en biedt de locaties die
de WMS niet kent als CSV aan. Zonder hernoemen ziet de game alle 336 stellinglocaties als ontbrekend
en de 231 oude als onbekend in de hal. Importeer die CSV dan niet zomaar: de voorraad en de pallets
blijven anders op de oude codes staan.

De hal zelf zet voorraad die nog onder een oude code staat automatisch om naar de nieuwe.

## 3. Paden en looproutes

Twee stellingen met hetzelfde nummer liggen tegenover elkaar in hetzelfde pad: een picker of robot
hoeft voor `R3A` en `R3B` niet van pad te wisselen. Het padnummer is dus af te leiden uit de
`location_id` en hoeft geen apart veld te zijn. Sorteren op `location_id` geeft nu ook een logische
looproute (pad voor pad); met 8 paden is er geen `R10` meer die vóór `R2` sorteert.

## 4. Robots

Elk pad heeft zijn eigen robot, om en om een tilrobot (`GKP`, alleen niveau 1) en een robot-heftruck
(`GKF`, alle niveaus), zie 08. Met 8 paden zijn dat er nu 8:

`GKP-01`, `GKF-02`, `GKP-03`, `GKF-04`, `GKP-05`, `GKF-06`, `GKP-07`, `GKF-08`

Het nummer van de robot is het nummer van zijn pad. `GKP-09` en `GKF-10` bestaan niet meer in de
hal. De robots zonder eigen pad (`PCK-01`, `PCK-02`, `INV-01`, `TEL-01`) wijzigen niet. De WMS heeft
nog geen entiteit `robot` (zie 08); als die er komt, zijn dit de nummers.

## 5. Gevolgen voor de acties

Geen nieuwe acties of velden. Controles op het formaat van `location_id` (als die er zijn) moeten
de letter na het padnummer toestaan.
