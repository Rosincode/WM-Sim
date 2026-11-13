# 10 — Dubbele stellingen: 16 rijen rug-aan-rug

De stellingen in de hal staan nu rug-aan-rug, zoals in een echt magazijn: rij 1 staat alleen, daarna
komt een pad, rij 2 en 3 staan met de ruggen tegen elkaar, weer een pad, rij 4 en 5, enzovoort. Elke
rij is daardoor nog maar vanaf één pad te bereiken. Op dezelfde vloer passen zo 16 rijen in plaats
van 11.

Het datamodel en de acties veranderen niet. Alleen de **locaties** en de **robots** wijzigen. Dit
document vervangt paragraaf 3 van `05-grotere-hal-locaties.md`; de docklocaties (paragraaf 2 daar)
blijven gelijk.

## 1. Wat er verandert

| | Oud | Nieuw |
|---|---|---|
| Stellingrijen | 11 (`R1` … `R11`) | 16 (`R1` … `R16`) |
| Stellinglocaties | 11 × 7 × 3 = 231 | 16 × 7 × 3 = 336 |
| Totaal locaties (met de 30 docklocaties) | 261 | 366 |
| Paden tussen de stellingen | 10 | 8 |
| Robots | 10 | 8 |

- De bestaande codes `R1-01-1` t/m `R11-07-3` blijven geldig; alleen hun `pos_y` wijzigt. Voorraad
  en pallets op die locaties kunnen blijven staan.
- Er komen 105 locaties bij: `R12-01-1` t/m `R16-07-3`.
- `pos_x`, `level` en `location_type` blijven zoals in 05: sectie 01 t/m 07 op `pos_x` -8, -4, 0, 4,
  8, 12, 16; niveau 1 is `pick`, niveau 2 en 3 zijn `rack`.

## 2. Stellinglocaties (336)

`location_id` = `R{rij}-{sectie:2 cijfers}-{niveau}`, het rijnummer zonder voorloopnul (`R1` … `R16`).

`pos_y` per rij:

| Rij | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| pos_y | -24.5 | -19.5 | -18.2 | -13.2 | -11.9 | -6.9 | -5.6 | -0.6 |

| Rij | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 |
|---|---|---|---|---|---|---|---|---|
| pos_y | 0.7 | 5.7 | 7 | 12 | 13.3 | 18.3 | 19.6 | 24.6 |

Als formule, met `n` = rij − 1: `pos_y` = -24.5 + ⌊n / 2⌋ × 6.3 + (n oneven ? 5 : 0).

De game vergelijkt zijn locaties met die van de WMS (WMS-paneel in het menu): ontbrekende locaties
kunnen daar met één knop worden aangemaakt of als CSV worden gedownload, en locaties met een andere
positie worden als afwijkend gemeld. De posities van `R1` … `R11` moeten in de WMS zelf worden
bijgewerkt.

## 3. Paden

Voor wie in de WMS met looproutes of padnummers wil werken: pad `p` (1 t/m 8) ligt tussen rij
2p − 1 en rij 2p, op `pos_y` = -22 + (p − 1) × 6.3.

| Pad | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Rijen | 1 en 2 | 3 en 4 | 5 en 6 | 7 en 8 | 9 en 10 | 11 en 12 | 13 en 14 | 15 en 16 |
| pos_y | -22 | -15.7 | -9.4 | -3.1 | 3.2 | 9.5 | 15.8 | 22.1 |

Twee locaties in hetzelfde pad liggen dus tegenover elkaar; een picker of robot hoeft voor beide
niet van pad te wisselen. De game gebruikt de padnummers niet in de aanroepen naar de WMS.

## 4. Robots

Elk pad heeft zijn eigen robot, om en om een tilrobot (`GKP`, alleen niveau 1) en een robot-heftruck
(`GKF`, alle niveaus). Met 8 paden zijn dat er nu 8:

`GKP-01`, `GKF-02`, `GKP-03`, `GKF-04`, `GKP-05`, `GKF-06`, `GKP-07`, `GKF-08`

`GKP-09` en `GKF-10` bestaan niet meer in de hal. Staan ze in de entiteit `robot` (zie 08), zet ze
dan op niet-actief of verwijder ze; lopende opdrachten horen er niet meer op te staan.

## 5. Gevolgen voor de acties

Geen nieuwe acties of velden. De tekstsortering van `location_id` (zie 05, paragraaf 4) blijft
gelden: `R10` … `R16` komen vóór `R2`.
