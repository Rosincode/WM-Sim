# 07 — Palletstickers: voorraad per pallet en palletverplaatsing

In de hal heeft elke pallet een eigen nummer, op een sticker met barcode. Een pallet wordt met de
heftruck, de pompwagen of een robot verplaatst; de scan van de sticker op de nieuwe locatie boekt de
verplaatsing in de WMS. De WMS beheert de pallets: de entiteit `pallet`, de actie `register_pallet`
en de palletverplaatsing `pallet_move`.

---

## 1. Entiteit `pallet`

Alleen te lezen. Aanmaken gaat via `register_pallet`, verplaatsen via `pallet_move`.

| Veld | Type | Toelichting |
|---|---|---|
| `pallet_id` | tekst, uniek | Het nummer op de sticker (de barcode) |
| `sku` | verwijzing naar `item` | Eén artikel per pallet |
| `qty` | geheel getal | Aantal stuks op de pallet |
| `location_id` | verwijzing naar `location` | Waar de pallet staat |
| `status` | `active` / `empty` | `empty` zodra het laatste stuk eraf is gepickt |

Regels:

- De voorraad op een locatie (`stock.qty`) is de som van de actieve pallets daar (`op_pallet`) plus
  de voorraad zonder pallet (`los`).
- Een pick verlaagt eerst de losse voorraad en dan de pallets, de kleinste eerst. In de hal wordt
  bij een pick de buitenste pallet op die locatie kleiner.
- Een stellinglocatie heeft drie palletplekken; de WMS weigert een vierde pallet
  (`Op <loc> staan al 3 pallets.`). Een inslaglocatie heeft er zes.
- Op een locatie staat in de hal één artikel.

## 2. Palletnummers

| Waar het nummer vandaan komt | Vorm |
|---|---|
| Beginvoorraad van de WMS | `PAL-0001` t/m `PAL-0070` |
| Levering die de WMS zelf aanmaakt (10) | `PAL-<truck_id>` |
| Pallet die in de game ontstaat (gelost door een speler, of voorraad die in de WMS los ligt) | `PAL-<4 tekens>-<volgnummer>`, bijvoorbeeld `PAL-K3F9-0012`; de vier tekens zijn per spelsessie anders |

Bij de allereerste start en bij 'Hal resetten' neemt de hal de actieve pallets uit de WMS over, met
hun nummer. Voorraad die in de WMS los ligt krijgt in de hal een pallet **zonder sticker**.

## 3. Wat de game aanroept

| Handeling in de hal | Aanroep |
|---|---|
| Sticker plakken op een pallet zonder sticker | `stock/<id>/_flows/register_pallet`, invoer `pallet_id`, `pallet_qty`, op de voorraadregel van dat artikel op die locatie |
| Pallet met sticker wegzetten vanaf een inslaglocatie (speler of robot) | `POST pallet_move {pallet_id, to_location_id}` |
| Pallet met heftruck of pompwagen op een andere stellinglocatie zetten | geen: de pallet staat er alleen fysiek |
| De sticker van die pallet scannen op de nieuwe locatie | `POST pallet_move {pallet_id, to_location_id}` |
| Pallet wegzetten die de WMS niet als actieve pallet kent | `stock/<id>/_flows/putaway`, invoer `putaway_qty`, `to_location_id` (losse voorraad) |

- **Pallet of losse voorraad.** Voor elke verplaatsing kijkt de game eerst of de WMS de sticker kent
  (`GET pallet?pallet_id=…`, status `active`). Zo ja: `pallet_move`. Zo nee: `putaway` op de
  voorraadregel van de van-locatie.
- **`register_pallet` wijzigt de voorraad niet:** de stuks lagen er al. De WMS weigert als het nummer
  al bestaat of als er op de locatie minder losse voorraad ligt dan `pallet_qty`.
- **`pallet_move`:** de WMS weet zelf waar de pallet stond en wat erop staat. Hij weigert als de
  pallet niet bestaat of leeg is, als de doellocatie geen stellinglocatie is, geblokkeerd is of al
  drie pallets heeft, en als de pallet er al staat.
- **Zonder sticker geen scan.** Een pallet zonder sticker kan niet gescand en niet door een robot
  opgepakt worden. De speler plakt de sticker (E bij de pallet); op een inslaglocatie doet de
  telrobot dat (08).
- **Weigert de WMS een verplaatsing**, dan blijft de pallet fysiek staan en ziet de speler de
  melding. Hij zet de pallet ergens anders neer en scant opnieuw. Zet hij hem terug op de locatie
  waar de WMS hem heeft, dan valt er niets te boeken.
- **Nog niet geboekt.** Een verplaatste pallet waarvan de sticker nog niet is gescand heeft in de
  hal een oranje sticker. Van die locatie kan niet gepickt worden tot de pallet is geboekt.

## 4. Nog niet gebouwd

- **Stickers afdrukken vanuit de WMS.** Het idee: de WMS geeft het palletnummer uit en drukt de
  sticker af op een printer in de hal. Nu geeft de game het nummer uit.
- **`pallet_id` meegeven bij `putaway`.** De actie kent het als optionele invoer; de game stuurt het
  niet mee.
