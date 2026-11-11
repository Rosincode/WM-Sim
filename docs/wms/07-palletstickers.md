# 07 — Palletstickers: voorraad per pallet en palletverplaatsing

In de hal heeft elke pallet nu een eigen nummer, op een sticker met barcode (bijvoorbeeld
`PAL-K3F9-0012`). De speler verplaatst een pallet met de heftruck of pompwagen en scant daarna de
sticker op de nieuwe locatie. Die scan moet in de WMS een voorraadmutatie geven: de pallet gaat van de
oude naar de nieuwe locatie.

De WMS kent nog geen pallets, alleen aantallen per artikel per locatie. De game houdt de palletnummers
daarom voorlopig zelf bij en boekt een verplaatsing met de bestaande actie `confirm_putaway`. Dit
document beschrijft wat de WMS-app nodig heeft om pallets zelf te gaan beheren.

Alles uit 01 t/m 06 blijft gelden.

---

## 1. Wat de game nu doet

| Handeling in de hal | Aanroep naar de WMS | Nu al aangeroepen |
|---|---|---|
| Pallet met heftruck of pompwagen op een andere stellinglocatie zetten | geen: de pallet staat er alleen fysiek | n.v.t. |
| Palletsticker scannen op de nieuwe locatie | `confirm_putaway` (`sku`, `qty`, van de oude naar de nieuwe locatie) | ja |
| Sticker plakken op een pallet zonder sticker | `register_pallet` (zie 3) | nog niet |

- **Niet meer automatisch.** Tot en met 06 riep de game `confirm_putaway` aan zodra de heftruck een
  pallet neerzette. Dat gebeurt nu pas bij de scan van de palletsticker. Tot die scan staat de pallet
  in de WMS nog op de oude locatie.
- **Weigert de WMS de verplaatsing**, dan blijft de pallet fysiek staan en ziet de speler de
  foutmelding op de scanner. Hij moet de pallet dan ergens anders neerzetten en opnieuw scannen.
- **Welke pallets een sticker hebben.** De voorraad waarmee de hal start krijgt van de game een
  palletnummer en een sticker. Elke pallet die er later bij komt (uit een vrachtwagen, of voorraad die
  in de WMS-app is bijgeboekt) heeft geen sticker: de speler plakt er zelf een op. Pas daarna kan de
  pallet gescand worden.

## 2. Entiteit `pallet`

| Veld | Type | Toelichting |
|---|---|---|
| `id` | tekst, uniek | Het nummer op de sticker (de barcode). Door de game aangeleverd, of door de WMS uitgegeven (zie 5). |
| `sku` | verwijzing naar `item` | Eén artikel per pallet. |
| `qty` | geheel getal > 0 | Aantal stuks op de pallet. |
| `location_id` | verwijzing naar `location` | Waar de pallet staat. |
| `status` | `active` / `empty` | `empty` zodra het laatste stuk eraf is gepickt. |

Regels:

- De voorraad op een locatie (`stock`) is gelijk aan de som van de pallets met status `active` op die
  locatie, plus eventuele voorraad zonder pallet. De game leest `stock` zoals nu en gaat daarnaast de
  lijst `pallet` lezen.
- Een pick (`confirm_pick`, `confirm_pick_line`) verlaagt `qty` van een pallet op de picklocatie.
- Een stellinglocatie heeft in de hal drie palletplekken. Meer dan drie pallets op één locatie kan de
  hal niet tonen.

## 3. Actie `register_pallet` (sticker plakken)

Legt de voorraad op een pallet vast onder een barcode.

| Parameter | Toelichting |
|---|---|
| `pallet_id` | Het nummer op de sticker. |
| `sku`, `qty` | Wat er op de pallet staat. |
| `location_id` | Waar de pallet staat: een inslaglocatie (`DOCK-NN-IN`) of een stellinglocatie. |

- Weigeren als `pallet_id` al bestaat, of als er op `location_id` minder dan `qty` van dit artikel
  ligt dat nog niet aan een pallet hangt.
- De actie wijzigt de voorraad niet: de stuks lagen er al (ontvangen met `register_goods_received`).

## 4. Actie `move_pallet` (palletverplaatsing)

Vervangt `confirm_putaway` voor pallets met een sticker.

| Parameter | Toelichting |
|---|---|
| `pallet_id` | De gescande sticker. |
| `to_location_id` | De locatie waar de pallet nu staat. |

- De WMS weet zelf waar de pallet stond en hoeveel erop staat: de voorraad gaat in één mutatie van de
  oude naar de nieuwe locatie en `pallet.location_id` wordt bijgewerkt.
- Weigeren als de pallet niet bestaat, de doellocatie geblokkeerd is of een dock is. De melding kort en
  in het Nederlands, zoals in 06 hoofdstuk 3.
- Leg de mutatie vast (wie, wanneer, van, naar), zodat de verplaatsing in de WMS-app terug te zien is.

Zodra `move_pallet` bestaat roept de game die aan in plaats van `confirm_putaway`.

## 5. Later: stickers afdrukken vanuit de WMS

Het plan is dat de WMS de sticker afdrukt op een printer in de hal: de WMS geeft dan het palletnummer
uit en de speler haalt de sticker bij de printer op. Dat is nog niet gebouwd in de game. Houd er in het
ontwerp rekening mee dat `pallet.id` dan uit de WMS komt in plaats van uit de game.

## Terug te melden

1. Of de entiteit `pallet` er is, en het adres waarop de game de lijst kan lezen.
2. Of `register_pallet` en `move_pallet` gebouwd zijn, met de namen van de parameters.
3. Of bestaande voorraad bij de eerste keer automatisch pallets krijgt, of dat de game de pallets van
   de beginvoorraad moet aanmelden.
