# WMS-instructie 03 — Robotassortiment

## Context

Het magazijn uit WM-Sim is van een bedrijf dat **robots** verkoopt. Het speelt een stukje in de toekomst. Er zijn drie soorten robots:

- **huishouden**: robots die klusjes in huis doen, zoals stofzuigen en was vouwen;
- **huisdier**: robots die je als huisdier hebt, zoals een robothond;
- **vermaak**: robots voor de lol, zoals een robot die met je danst.

We beginnen klein. Deze instructie bouwt voort op [instructie 01](01-basis-datamodel.md). Er komt één veld bij, er komt één domein bij en de artikelen krijgen andere omschrijvingen. Al het andere blijft zoals het is: locaties, voorraad, orders en alle acties.

Elke robot zit in een eigen doos. Voor het WMS is een robot gewoon een artikel: `qty` = het aantal dozen.

---

## 1. Wijziging op entiteit `item`

Voeg één veld toe:

| Veld | Type | Verplicht | Toelichting |
|---|---|---|---|
| `category` | domein `robot_category` | ja | De soort robot, zie hoofdstuk 2 |

De velden `sku` en `description` blijven zoals ze zijn.

## 2. Nieuw domein `robot_category`

| Waarde | Omschrijving |
|---|---|
| `huishouden` | Huishoudrobot |
| `huisdier` | Robothuisdier |
| `vermaak` | Vermaakrobot |

Gebruik de waarden letterlijk. De game kleurt de dozen op basis van deze waarde.

## 3. Seed-data artikelen (vervangt 4.2 uit instructie 01)

De `sku`-codes blijven hetzelfde. Alleen de omschrijving verandert en de categorie komt erbij. Bestaande voorraad en orders blijven daardoor geldig.

| sku | description | category |
|---|---|---|
| `SKU-001` | Stofzuigrobot Dusty | `huishouden` |
| `SKU-002` | Wasvouwrobot Foldy | `huishouden` |
| `SKU-003` | Robothond Bolt | `huisdier` |
| `SKU-004` | Robotkat Miso | `huisdier` |
| `SKU-005` | Dansrobot Groove | `vermaak` |

De beginvoorraad uit 4.3 van instructie 01 blijft gelijk.

## 4. Uitlezen (GET)

De game gaat `item` uitlezen, inclusief `category`. Daarvoor volstaat het standaard GET-endpoint, zie het formaat in [instructie 02](02-toegang-basic-auth-cors.md), hoofdstuk 5. Er is geen nieuw endpoint nodig.

## 5. Nog niet bouwen

Deze punten komen in een latere instructie. Bouw ze nu nog **niet**:

- serienummers per robot;
- klanten en verzendadressen op orders;
- retouren, reparatie en accu's opladen;
- prijzen.

---

## Terug te melden

- Bevestiging dat `item` het veld `category` heeft en dat de vijf artikelen zijn bijgewerkt.
- Een voorbeeld van het antwoord van `GET {basis-URL}/item`.
