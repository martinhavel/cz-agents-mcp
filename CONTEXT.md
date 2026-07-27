# CONTEXT — doménový jazyk cz-agents-mcp

Tenhle soubor dává **jména dobrým seamům**. Není to popis architektury ani changelog;
je to slovník, aby se o téhle codebase dalo mluvit bez přejmenovávání. Když termín
níž existuje, používej ho přesně tak — vlastní synonymum stojí čtenáře převod.

Technický slovník návrhu (module, interface, depth, seam, adapter, leverage,
locality) žije v skillu `codebase-design` a tady se nezdvojuje.

## Co tenhle repozitář je

Kolekce MCP serverů nad **oficiálními** českými a EU registry. Každý balíček
v `packages/` je jeden zdroj dat nebo jedna služba; `shared` je společná
infrastruktura (billing, entitlements, HTTP, rate limit).

Repo je **veřejné**. Placené nadstavby (`ddplus`, `realestate-pro`) žijí jinde a
sem nepatří — stejně jako Stripe price ID a jakýkoli secret.

## Doménové pojmy

**IČO** — osmimístný identifikátor české firmy, nulami zleva doplněný. Vstup skoro
každého nástroje. Validuje se modulo 11; „vyčištěné IČO" znamená po normalizaci.

**ARES** — registr ekonomických subjektů (MF ČR). Zdroj základních faktů o firmě.
**ISIR** — insolvenční rejstřík. **ADIS** — registr plátců DPH a nespolehlivých
plátců. **VR** — veřejný rejstřík (obchodní rejstřík), zdroj vlastnictví a
statutárů. **GLEIF/LEI** — mezinárodní identifikátory pro EU pokrytí.

**DD report** — složený výstup nad jednou firmou: fakta, insolvence, sankce,
spolehlivost DPH, rizikové skóre 0–100, statutární řetězec. Neprodáváme cizí data
(žádný Cribis ani Bisnode), skládáme státní registry.

**Sankce** — EU FSF + OFAC. Screening jmen, ne rozhodnutí; výstup je podezření
s doložením, ne verdikt.

## Entitlements — nejhustší část domény

Přístup se rozhoduje ve **dvou nezávislých osách**. Zaměnit je je nejčastější chyba
v úvahách o tomhle kódu:

- **coverage** (`core` | `extended`) — *na kterou zemi* smíš. CZ/SK/PL/NL/GB jsou
  core, zbytek EU extended.
- **depth** (`basic` | `ddplus`) — *jak hluboko* smíš. Vlastnická síť, detekce
  nominee/phoenix, riziková osa jsou ddplus.

Jedna osa může povolit a druhá zamítnout. `dimension` v rozhodnutí říká, **která
osa** to zařízla — a report bez ní neumí odlišit „nikdo nepřišel" od „přišli, ale
na jinou bránu".

**mode** (`off` | `observe` | `enforce`) — jestli se brána jen měří, nebo skutečně
zavírá. `observe` zapisuje `wouldGate`, ale pouští dál. Fail-closed: neznámá hodnota
znamená `off`, a `off` znamená, že entitlement store vůbec nevznikne.

**account pseudonym** — sůl + hash účtu. Do telemetrie nikdy nejde `stripe_customer_id`,
token ani IP; pseudonym je jediná identita, kterou události nesou.

**identity class** (`anonymous` | `identified`) — má volající identitu, kterou lze
spálit? Identified = uložený odvolatelný token se stabilním account id. Token bez
account id má pseudonym odvozený z IP, takže **identitou není** — umře s IP.

**offer / intent** — dvojice událostí x402 preview experimentu. Nabídka je něco, co
jsme poslali; intent je deklarace zájmu. Ani jedno není platba a žádná platba se
nepřijímá.

## Seamy, které v téhle codebase existují

- **`DdLookupAuthorizer`** — seam mezi MCP nástrojem a rozhodnutím o přístupu.
  Nástroj neví nic o tierech, jen se ptá „smím?" a dostane `upstreamAllowed`
  plus `record()`, kterým se výsledek zapíše. Adaptéry: hostovaná entitlement
  brána a `undefined` (režim off).
- **`EntitlementStore`** — seam mezi rozhodováním a úložištěm. Za malým rozhraním
  je SQLite se schématem, migracemi, telemetrií a reportem.
- **`TokenStore`** — seam nad billing tokeny. Sdílí **stejný soubor** jako
  `EntitlementStore`, ale jinou tabulku.
- **klienti registrů** (`AresClient`, `IsirClient`, `AdisClient`, `vrClient`) —
  seam mezi doménou a cizím API. Za ním leží retry, parsování a degradace, když
  registr neodpovídá.
- **`buildReport`** — seam mezi surovými zdroji a jedním výstupem. Sem patří
  rozhodnutí, co dělat s chybějícím zdrojem: report vzniká i tehdy, když jeden
  registr mlčí.

## Kde jsou hranice, které nejsou v kódu vidět

- **`tokens.db` má dva zapisovatele**: tenhle repozitář a `cz-agents-webapp`
  (jiné repo, sdílený docker volume `cz-agents-mcp_tokens-data`). Webapp píše jen
  do tabulky `tokens`. Hranice repa **není** hranicí zapisovatelů.
- **`www/` v tomhle repu je mrtvá kopie.** Živý web `cz-agents.dev` se deployuje
  z repozitáře `cz-agents-web`.
- **Deploy workflow tu není.** MCP servery nasazuje privátní workflow v
  `cz-agents-webapp`.

## Jak se tu čtou testy

Test jde přes stejné rozhraní jako volající. Testy nad SQLite používají skutečnou
databázi v dočasném adresáři, ne mock — schéma a migrace jsou součástí chování,
které se testuje. Když test čte, co se zapsalo, dělá to **druhým, nezávislým
připojením**: report, který souhlasí sám se sebou, nedokazuje nic.
