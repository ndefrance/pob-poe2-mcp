---
name: poe2-economy
description: Price PoE2 currency, omens, runes, essences, soul cores, lineage supports and uniques, and give the div/ex/chaos rate, with data age and confidence. Use for "what is X worth", "div to ex rate", "is X going up", "most valuable runes/omens", or before quoting any cost in a recommendation.
---

# PoE2 prices

Tool: `python -I tools/prices.py` (reads the league from `tools/league.txt`). Reference: `notes/economy.md`.

1. `rate`: always quote prices in **div and ex** with the rate and its timestamp. The user cannot convert div to ex (no gold).
2. `price "<name>"` (fuzzy; `--json` for scripts). Report conf and age with every number.
   - conf low = thin market. Run `trend "<name>"`, which shows each pair's rate. The user pays in ex, so for exchange goods use the ex-pair rate.
   - Unique prices come from listings and ignore rolls (Prism of Belief and Megalomaniac show the junk floor). Price rolled or real buys with an Instant Buyout trade search (CLAUDE.md Trade rules).
   - Not on poe.ninja: skill and support gems (e.g. Culling Strike II), base types, rares and waystones. Use a trade search.
3. `top <category|text> [n]` ranks by div. Ignore low-conf outliers.
4. Data is cached for 1 h. Never loop `refresh --force`, because poe.ninja blocks heavy users. Use `--offline` for repeated lookups.
5. After a patch or league change, update `tools/league.txt` and run `python -I tools/checks/prices_check.py` (patch-day runs it). If ninja renames fields or types, fix `parse()` and the type lists in prices.py, then regenerate the fixture from real responses.
