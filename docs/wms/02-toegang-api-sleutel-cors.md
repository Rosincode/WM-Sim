# 02 — Toegang vanuit de browser: API-sleutel, HTTPS en CORS

## Context

De game draait als statische website op **https://rosincode.github.io/WM-Sim/**. Lokaal draait hij
op `http://localhost:5173`.

De speler vult in het WMS-paneel van de game (toets K) het basisadres van de API en een API-sleutel
in. De browser roept daarna de WMS-API **rechtstreeks** aan; er zit geen server tussen. De gegevens
staan alleen in de sessionStorage van die browser en zijn weg zodra het tabblad sluit. Zonder
aanmelden draait de game op een ingebouwde mock-WMS.

---

## 1. Aanmelden

- De game stuurt `Authorization: Bearer <API-sleutel>` mee. De sleutel (`amk_…`) hoort bij een
  **API-client** met rol `game` in de WMS (Instellingen → Koppelingen → API).
- Basic auth werkt niet. De WMS kent daarnaast een OAuth2-token (client credentials); de game
  gebruikt dat niet.
- Een foute, verlopen of ingetrokken sleutel geeft **401**. Ontbrekende rechten geven **403**.
- Maak per speler of tester een eigen API-client, zodat een sleutel los kan worden ingetrokken.

## 2. Rechten van de API-client

Scopes en acties worden per client aangevinkt. Wat de game nodig heeft:

| Soort | Nodig |
|---|---|
| Lezen | `location`, `item`, `stock`, `pallet`, `customer_order`, `order_line`, `goods_receipt`, `truck_visit` |
| Schrijven (aanmaken) | `goods_receipt`, `pallet_move`, `customer_order`, `order_line`, `truck_visit`, `scan_log` |
| Acties | `start_picking`, `confirm_pick`, `confirm_pick_line`, `stage_order`, `load_order`, `truck_check_out`, `putaway`, `register_pallet` |

De client krijgt geen beheerrechten: locaties, artikelen en voorraad zijn via de API alleen te lezen.
Mag de client het scanlog niet schrijven, dan stopt de game met loggen; al het andere werkt door.

## 3. HTTPS

De API moet bereikbaar zijn via **HTTPS** met een geldig certificaat. Een HTTPS-pagina mag geen
HTTP-API aanroepen.

## 4. CORS

| Origin | Waarvoor |
|---|---|
| `https://rosincode.github.io` | De online versie |
| `http://localhost:5173` | Lokaal ontwikkelen |

| Instelling | Waarde |
|---|---|
| Methoden | `GET`, `POST`, `OPTIONS` |
| Toegestane request-headers | `Authorization`, `Content-Type`, `Accept` |
| Preflight | Een `OPTIONS`-preflight beantwoorden **zonder** authenticatie, met status 200 of 204 |
| Leesbare response-header | `Retry-After` (bij 429) |

## 5. Vorm van de API

Basisadres: `https://<host>/t/wm_sim/api`. De volledige beschrijving staat op
`GET {basis}/_openapi`.

| Wat | Vorm |
|---|---|
| Lijst opvragen | `GET {basis}/location` geeft `{ "data": [...], "limit", "offset" }` |
| Pagina's | Standaard 50 records, hooguit 200 per aanroep: `?limit=200&offset=200`. De game haalt alle pagina's op. |
| Filteren | Eén waarde per veld: `GET {basis}/customer_order?te_picken=true`. Geen `or`, geen OData-`$filter`. |
| Record aanmaken | `POST {basis}/goods_receipt` met de velden als JSON-body; gelukt = `201` met het record |
| Actie op een record | `POST {basis}/customer_order/<id>/_flows/start_picking`. Met invoer: `{ "choice": "bevestigen", "input": {...} }`; zonder invoer: `{}`. Gelukt = `200`. |
| Verwijzingen | De uuid uit veld `id`, niet de tekstsleutel. Tekst blijven `pallet_id`, `truck_id` en `location_id` bij `scan_log`. |

Foutcodes:

| Code | Betekenis | Wat de game doet |
|---|---|---|
| `409` | Geweigerd, met `{ "error": "…" }` | Toont de melding aan de speler, na "WMS weigert:" |
| `400` | Ongeldige invoer, met `error` en `details` | Toont `error` |
| `401` | Sleutel fout, verlopen of ingetrokken | Meldt dat het inloggen is geweigerd |
| `403` | Scope of actie niet aangevinkt | Meldt welk recht ontbreekt |
| `429` | Te veel aanroepen | Wacht het aantal seconden uit `Retry-After` (hooguit 30) en probeert het tot drie keer opnieuw |
