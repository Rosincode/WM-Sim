# 10 — Leveringen uit de WMS: robots lossen, tellen en zetten weg

De WMS maakt met de flow `simulatie_tick` zelf leveringen en orders aan. De game sluit daarop aan: een
levering komt als vrachtwagen aanrijden en de robots handelen hem af. Dit document beschrijft wat de
game nu leest en aanroept, wat de API-client daarvoor nodig heeft en wat de WMS nog kan toevoegen om
de keten echt op statussen te laten lopen.

Alles uit 09 blijft gelden; `GET {basis}/_openapi` is leidend.

---

## 1. Wat de game nu doet

| Stap in de hal | Waar de game op reageert | Aanroep naar de WMS |
|---|---|---|
| Vrachtwagen rijdt voor | `GET truck_visit?status=checked_in`, `direction` = `in`; de wagen komt aan het dock uit `dock_id` | geen: de flow heeft hem al aangemeld |
| Wat erin staat | `GET goods_receipt?dock_id=<id van het dock>`: de ontvangsten met `pallet_id` = `PAL-<truck_id>`, of aangemaakt na het bezoek | geen: de flow heeft de ontvangst al geboekt |
| Robot lost de pallet naar `DOCK-NN-IN` | de pallet staat in de WMS nog op `DOCK-NN` | `POST scan_log` (pallet, op `DOCK-NN-IN`) |
| Telrobot telt de pallet op `DOCK-NN-IN` | de pallet staat fysiek op de inslagbaan | `POST scan_log` (pallet, op `DOCK-NN-IN`) |
| Robot zet de getelde pallet weg | de telling is klaar | `POST pallet_move {pallet_id, to_location_id}` |
| Vrachtwagen vertrekt | de wagen is leeg | `POST truck_visit/<id>/_flows/truck_check_out` |

- De game leest de leveringen elke 3 seconden, samen met de voorraad en de open orders.
- Een pallet komt alleen in de vrachtwagen als hij in de WMS nog op de dockdeur staat (`stock` op
  `DOCK-NN` van dat artikel, minstens het aantal van de ontvangst). Zo komt een pallet die al is
  weggezet na een herstart van de game niet opnieuw binnen.
- Orders uit de flow komen binnen zoals elke order: `GET customer_order?te_picken=true`.
- Staan de robots in de game uit (menu Robots), dan doet een speler dezelfde stappen met de hand.
- Zonder WMS-login (mock) laat de hal zelf vrachtwagens komen; de robots handelen die net zo af.

## 2. Te doen in de WMS-app

**Rechten van de API-client van de game** (Instellingen → Koppelingen → API). Gecontroleerd op
2026-11-13: `truck_visit` en `pallet` lezen geven `403`.

- **Lezen:** `truck_visit` (nieuw nodig voor de leveringen), `pallet`, `goods_receipt`.
- **Schrijven:** `pallet_move`, `scan_log`.
- **Acties:** `truck_check_out` (en de acties uit 09).

Zonder lezen op `truck_visit` komt er in de hal geen enkele vrachtwagen en meldt de game
`Leveringen ophalen uit de WMS mislukt`.

**Afmelden van een inkomende vrachtwagen.** `truck_check_out` moet een inkomend bezoek
(`direction` = `in`) altijd kunnen afmelden, ook zonder geladen orders. Weigert de WMS
(`… heeft geen geladen orders`), dan blijft het dock bezet en komt er op dat dock geen nieuwe levering.
De game probeert het afmelden elke 30 seconden opnieuw.

**Pallet van de dockdeur naar de stelling.** `pallet_move` moet een pallet die op `DOCK-NN` staat
(de plek waar de flow de ontvangst boekt) naar een stellinglocatie kunnen verplaatsen.

## 3. Voorstel: de keten op statussen (nog niet gebouwd in de game)

Lossen en tellen bestaan in de WMS nu niet: de game logt ze alleen als scan. Wil de WMS zelf zien en
sturen waar een levering in de keten is, dan is dit nodig:

| Toevoeging | Toelichting |
|---|---|
| Veld `status` op `goods_receipt` | `received` (geboekt op de dockdeur) → `unloaded` (op `DOCK-NN-IN`) → `counted` → `put_away` |
| Actie `unload` op `goods_receipt` | Zet de pallet van `DOCK-NN` naar `DOCK-NN-IN` en de status op `unloaded` |
| Actie `count` op `goods_receipt`, invoer `counted_qty` | Legt de telling vast; wijkt het aantal af, dan boekt de WMS het verschil. Status `counted` |
| `put_away` | Gezet door `pallet_move` van de pallet van deze ontvangst naar een stellinglocatie |
| Robotopdrachten (`robot_task`, zie 08) | De WMS kiest zelf de doellocatie; nu kiest de game die (dichtst bij het dock, eerst de vloer) |

Zodra deze er zijn, roept de game `unload` en `count` aan in plaats van alleen te scannen, en zet een
robot een pallet pas weg als de ontvangst op `counted` staat.

## Terug te melden

- Dat de rechten uit hoofdstuk 2 zijn aangevinkt.
- Of `truck_check_out` een inkomend bezoek zonder geladen orders afmeldt.
- Of `pallet_move` vanaf `DOCK-NN` werkt.
- Of de toevoegingen uit hoofdstuk 3 worden gebouwd, en onder welke namen.
