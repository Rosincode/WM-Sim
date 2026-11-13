# 03 — Robotassortiment

## Context

Het magazijn uit WM-Sim is van een bedrijf dat **robots** verkoopt. Het speelt een stukje in de
toekomst. Er zijn drie soorten robots:

- **huishouden**: robots die klusjes in huis doen, zoals stofzuigen en was vouwen;
- **huisdier**: robots die je als huisdier hebt, zoals een robothond;
- **vermaak**: robots voor de lol, zoals een robot die met je danst.

Elke robot zit in een eigen doos. Voor de WMS is een robot gewoon een artikel: `qty` = het aantal
dozen. (De robots die in de hal zelf rondrijden zijn iets anders: zie 08.)

---

## 1. Entiteit `item`

| Veld | Type | Toelichting |
|---|---|---|
| `sku` | tekst, uniek | Zie 01 |
| `description` | tekst | De naam van de robot |
| `category` | domein `robot_category` | De soort robot |

## 2. Domein `robot_category`

| Waarde | Omschrijving |
|---|---|
| `huishouden` | Huishoudrobot |
| `huisdier` | Robothuisdier |
| `vermaak` | Vermaakrobot |

## 3. Artikelen

De WMS bepaalt welke artikelen er zijn en hoe ze heten: de game leest de lijst en gebruikt de
omschrijving uit de WMS. In de WMS staan er nu tien:

| sku | description | category |
|---|---|---|
| `SKU-001` | Stofzuigrobot Dusty | `huishouden` |
| `SKU-002` | Wasvouwrobot Foldy | `huishouden` |
| `SKU-003` | Robothond Bolt | `huisdier` |
| `SKU-004` | Robotkat Miso | `huisdier` |
| `SKU-005` | Dansrobot Groove | `vermaak` |
| `SKU-006` | Ramenwasrobot Clearo | `huishouden` |
| `SKU-007` | Robotvogel Pip | `huisdier` |
| `SKU-008` | Muziekrobot Beat | `vermaak` |
| `SKU-009` | Robotkonijn Hop | `huisdier` |
| `SKU-010` | Goochelrobot Magix | `vermaak` |

De ingebouwde mock-WMS van de game (zonder aanmelden) kent alleen `SKU-001` t/m `SKU-005`.

Een artikel toevoegen in de WMS is genoeg om het in de hal te krijgen: de game geeft het een eigen
doosmaat en kleur, afgeleid van de `sku`.

## 4. Nog niet gebouwd

- serienummers per robot;
- klanten en verzendadressen op orders;
- retouren, reparatie en accu's opladen;
- prijzen.
