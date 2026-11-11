# WMS-instructie 02 — Toegang vanuit de browser (Basic auth, HTTPS en CORS)

## Context

De game draait als statische website op **https://rosincode.github.io/WM-Sim/**. Lokaal draait hij op `http://localhost:5173`.

De speler logt in de game in met een WMS-gebruiker. De browser roept daarna de WMS-API **rechtstreeks** aan, met Basic auth. Er zit geen server tussen.

Deze instructie vervangt de regel "CORS niet nodig" uit instructie 01.

---

## 1. Basic auth

- De API accepteert `Authorization: Basic <base64(gebruiker:wachtwoord)>` op alle entiteiten en acties uit instructie 01.
- Een verkeerde login geeft **401** terug. Ontbrekende rechten geven **403**.
- **Specifiek:** geef bij een 401 **geen** `WWW-Authenticate: Basic`-header mee. Anders opent de browser zijn eigen inlogvenster bovenop de game. Kan dat niet uitgezet worden, meld het dan.

## 2. HTTPS

De API moet bereikbaar zijn via **HTTPS** met een geldig certificaat. Een HTTPS-pagina mag geen HTTP-API aanroepen.

## 3. CORS

Sta de volgende origins toe:

| Origin | Waarvoor |
|---|---|
| `https://rosincode.github.io` | De online versie |
| `http://localhost:5173` | Lokaal ontwikkelen |

De API moet daarvoor het volgende doen:

| Instelling | Waarde |
|---|---|
| Methoden | `GET`, `POST`, `PATCH`, `DELETE`, `OPTIONS` |
| Toegestane request-headers | `Authorization`, `Content-Type`, `Accept` |
| Preflight | Een `OPTIONS`-preflight beantwoorden **zonder** authenticatie, met status 200 of 204 |
| `Access-Control-Allow-Origin` | De exacte origin van het verzoek, niet `*` |

## 4. Game-gebruiker

- Maak een gebruiker per speler of tester, bijvoorbeeld `wmsim-kevin` en `wmsim-collega`.
- Geef die gebruikers alleen rechten op de entiteiten en acties uit instructie 01. Ze krijgen geen beheerrechten.

## 5. Formaat van de API

Hiervan gaat de game nu uit. Meld de afwijkingen, dan past de game zich aan.

| Wat | Verwachte vorm |
|---|---|
| Lijst opvragen | `GET {basis-URL}/location` geeft een JSON-array, of `{ "value": [...] }` |
| Filteren | `GET {basis-URL}/order?$filter=status ne 'done'` (OData-syntax) |
| Actie aanroepen | `POST {basis-URL}/register_goods_received` met de parameters als JSON-body, bijvoorbeeld `{ "sku": "SKU-001", "qty": 10, "dock_id": "DOCK-01" }` |
| Antwoord van `create_order` | Bevat het `order_id`, bijvoorbeeld `{ "order_id": "ORD-0001" }` |

## Terug te melden

- De **basis-URL**, zoals de speler die in de game invult.
- Bevestiging dat de origins uit hoofdstuk 3 zijn toegestaan.
- Afwijkingen op hoofdstuk 5.
