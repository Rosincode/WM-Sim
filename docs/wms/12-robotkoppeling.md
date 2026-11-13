# 12 — Robotkoppeling: de game werkt met de robotopdrachten van de WMS

De WMS heeft nu `robot`, `robot_task` en de acties `start_robot_task`, `complete_robot_task` en
`fail_robot_task`, plus `unload` en `count` op `goods_receipt`. De game gebruikt ze sinds 2026-11-14.
Dit document zegt wat de game doet en wat er in de WMS-app nog nodig is. Het voorstel in 08 is
hiermee gebouwd; waar 08 en de API (`GET _openapi`) verschillen, geldt de API.

## 1. Wat de game doet

| Moment in de hal | Aanroep |
|---|---|
| Elke 5 s | `GET robot_task?status=open` |
| Elke 30 s | ook `GET robot_task?status=in_progress` en (één keer) `GET robot` |
| Een vrije robot krijgt een opdracht | `robot_task/<id>/_flows/start_robot_task {robot}` |
| De robot staat met de pallet op de doellocatie | `robot_task/<id>/_flows/complete_robot_task {robot}`; pas na akkoord zet hij de pallet neer |
| Het lukt niet, of `complete` wordt geweigerd | `robot_task/<id>/_flows/fail_robot_task {robot?, reason, draagt_pallet}` |
| Een pallet uit een levering van de WMS wordt gelost (chauffeur, speler of robot) | `goods_receipt/<id>/_flows/unload` |
| De telrobot telt die pallet op de inslagbaan | `goods_receipt/<id>/_flows/count {counted_qty}` |

- De ontvangst zoekt de game op met `GET goods_receipt?pallet_id=<stickernummer>`. Een ontvangst
  zonder `pallet_id` kan de game niet lossen of tellen in de WMS.
- Zet een speler een pallet met de hand weg en weigert `pallet_move` met `… is nog niet geteld.`,
  dan boekt de game eerst `count` (en zo nodig `unload`) met het aantal op de pallet en probeert het
  opnieuw.
- Staat een opdracht in de WMS op `in_progress` terwijl geen robot in de hal hem heeft (de game is
  herstart, de hal is gereset), dan meldt de game hem af met `fail_robot_task`, `draagt_pallet`
  = nee. Anders blijft de robot in de WMS bezet.
- De game speelt de robotsturing niet meer zelf na zodra hij met de WMS is verbonden: zonder
  opdracht uit de WMS zet geen robot een pallet weg of vult hij een pickplek aan.
- De pickrobots, de voorraadteller en de telrobot kiezen hun werk nog zelf (zie 08, hoofdstuk 7).

## 2. Nodig in de WMS-app

1. **Rechten van de API-client** (Instellingen → Koppelingen → API): Robots **lezen**,
   Robotopdrachten **lezen** en de drie acties *Robotopdracht starten*, *mislukt* en *afronden*;
   bij Ontvangsten de acties *Lossen* en *Tellen*.
2. **Acht robots toevoegen.** De hal heeft per pad een tilrobot én een robot-heftruck: `GKP-01` …
   `GKP-08` en `GKF-01` … `GKF-08`. De WMS kent er acht: `GKP-01`, `-03`, `-05`, `-07` en `GKF-02`,
   `-04`, `-06`, `-08`. Toe te voegen: `GKP-02`, `GKP-04`, `GKP-06`, `GKP-08` (tilrobot) en
   `GKF-01`, `GKF-03`, `GKF-05`, `GKF-07` (heftruck). Tot dan geeft de game alleen opdrachten aan
   de robots die de WMS kent; de andere acht staan stil.
3. **`pos_y` van de stellingen rechtzetten.** De WMS heeft de rijen op -26, -23, -19, -16, … 23,
   26; de hal en de API-beschrijving zeggen A = -24.5 + (pad−1) × 6.3 en B = A + 5. Voor de game
   maakt het niets uit (die gebruikt zijn eigen posities), wel voor wat de WMS-app toont.
4. **Limiet van 120 aanroepen per minuut.** De game zit er met voorraad, orders en leveringen
   elke 3 s al dicht tegenaan; de robotopdrachten komen daar ongeveer 14 per minuut bij, plus de
   terugmeldingen. Een ruimere limiet voor deze API-client voorkomt vertraging (de game wacht bij
   `429` de `Retry-After` af en probeert het opnieuw).

## 3. Goed om te weten

- De hal heeft zijn eigen voorraad. Staat een pallet daar niet op de plek die de opdracht noemt,
  dan meldt de game de opdracht af als mislukt (redenen: zie 08, 5.3). Na *Hal resetten* in de game
  staat de hal weer gelijk met de WMS.
- De WMS maakt opdrachten automatisch om de 5 minuten: een getelde pallet kan dus even op de
  inslagbaan blijven staan.
