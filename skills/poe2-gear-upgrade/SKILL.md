---
name: poe2-gear-upgrade
description: Find engine-verified gear upgrades for the user's PoE2 build within a budget, from live Instant Buyout trade listings, with a joint res/attribute/Spirit/mana check and one-listing links. Use for "what should I buy", "best item for slot X", or "is item Y an upgrade".
---

# Gear upgrade search

Read CLAUDE.md "Rules" first. The trade API rules are hard limits:
- ≥ 6.5 s between calls;
- Instant Buyout only;
- run queries from the user's open trade2 tab in Claude in Chrome; never navigate that tab;
- divine-priced listings above the user's exalt stack.

1. **Targets first.** Run `poe2-theorycraft`: stat weights plus the best possible craft per slot. That shows which slots and stats can move the numbers at all.
2. **Search every slot over the WHOLE budget.** Use weighted (`weight2`) queries sorted by `statgroup.0`, with price bands up to the full budget. A cap below the budget hides the best items (the 2026-11-01 miss: the first screen stopped at about 50 div per slot).
   - Preferred: the bridge (`tools/trade-bridge.js` in the tab + `node tools/sink.mjs` + `node tools/trade.mjs batch <map.json> 40 --prefix hb_`): no long browser calls. Fallback page helper: `tools/trade-page.js`.
   - Long jobs: `T.batch({slot: query, ...}, 40, "hb_")` (not awaited), then poll `window._done`.
3. **Prepare listings as they would really be used:**
   - Re-rune 2-3 socket items with the build's runes, but keep socket-bound runes (`isSocketBound` in ModRunes.lua: Serle's, Katla's, Kolr's, ...).
   - Re-anoint amulets with the required anoint unless corrupted or sanctified.
   - Re-core boots with the build's soul cores.
   - Socketing a rune destroys the old one, so the user must buy new runes.
4. **Screen with the lite joint check.** `bash tools/lab/joint.sh <jobs.json> <out.json> [build.xml]` reports DPS, EHP, res, attributes, Spirit, net mana and `ok/why`.
   - Use `{"pre":[ops],"jobs":[...]}` to screen on top of a changed base, such as a new ring pair or Kalandra's Touch + ring.
   - Split big job lists into at most 3 parallel engine processes.
5. **Combine the winners**: rings × bow × helmet × boots etc. Kalandra's Touch reflects the opposite ring; test it as a pair.
   - Run `joint.sh ... full` with `BASE_EHP` set for the T16 EHP and death clock.
   - Select combos by item name, never by list index.
5b. **Also screen (2026-11-01 lessons):**
   - **Jewels, all types**: rare (Emerald/Sapphire/Ruby), Time-Lost radius, uniques (Prism of Belief "+N to Level of all <skill>", Megalomaniac notables, Heart of the Well, Against the Darkness...). `tools/lab/jewel_run.lua` (fast calculator; `N_SLOT` = socket to replace, `N_NEW` = unallocated socket node to add with its path). Unallocated sockets 1-2 points away count: price the point with treeopt `O.units(1)` + `O.scan` (zero-value nodes may be config gaps, check their text).
   - **Supports + gem levels**: swap every support in data (`.work/sg_screen.lua` pattern), then read the gem text of anything big: Glory/condition/minion-drain/distance/daze supports are fake engine gains. Lineage supports are often 0 Instant Buyout. **Gem levels raise mana cost** (Prism +3 / level 21) — check net mana jointly.
   - **Open-affix bases**: `python tools/lab/finish_jobs.py out.json <trade json...> --runes ...` + `tools/lab/finish_run.lua` (theory craft `keep`/`used`) = ceiling; `python tools/craftev.py <xml> job.json` = real odds of one exalt (spawn weights x engine value per outcome). Empty sockets get the build's runes (`tools/lab/trade_jobs.py rune_list`).
6. **Verify the final build file.** Save it via a job `"save"`, reload it fresh, and confirm the numbers match. Write it to the Builds folder as a NEW file only.
7. **Links**: `T.pin` gives one-listing searches (weapon/armour stats with `local:true`). Check that total = 1.
8. **Report:**
   - a table of cost / Map / Boss / rarity / T16 EHP / death clock vs live;
   - what each item loses (granted skills, anoint, runes, life on kill...);
   - budget left;
   - ask the user to paste the item's Ctrl+Alt+C text after buying, then re-verify.
