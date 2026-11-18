---
name: poe2-crafting
description: Price a PoE2 craft path (odds, expected cost, engine-valued EV) and decide buy-a-base vs finish vs buy-finished. Use for "should I exalt/chaos/essence this", "what are the odds of X", "is crafting cheaper than buying", "EV of slamming this bow", omen/fracture/vaal questions, or before recommending any craft step.
---

# PoE2 crafting odds and EV

Rules + sources: `notes/crafting-reference.md` (section 0 first: corrupted/sanctified = frozen, socket limits, omen texts; 10.7 = what the tools model and how sure each piece is).

1. **Check what is still craftable** on the item (open prefix/suffix slots, corrupted, sanctified, fractured, desecrated). Get the full item text (Ctrl+Alt+C), not a screenshot.
2. **Odds / expected cost** (no engine): `python -I tools/craftcost.py <recipe.json> [--trials N] [--weights coe]` (recipe format + ops in the docstring; examples `tools/craft-recipes/*.json`). Expected cost = cost per attempt / P(success), restarting from a fresh start item. `max_base_price_to_beat_buying_div` < 0 means crafting never beats buying.
3. **Is it worth it for the build** (engine): write a job like `tools/craft-recipes/ev_woe_twine.json` (item text with `{prefix}`/`{suffix}` tags, `steps` = craftcost ops, `base_price`), then `python -I tools/craftev.py <build.xml> <job.json>`. Gives EV vs live and vs as-bought, P(DPS gain >= t%), cost per attempt and expected cost to reach each target. One engine process: check `tasklist | grep -ci luajit` first. Without `steps` it is the exact one-Exalt mode (`side`, `min`).
4. **Decide**: crafting wins only when 1-2 open slots remain on an otherwise finished item and the target pool share is big (e.g. an open prefix on a weapon). Compare expected cost to target with the trade price of a finished item of that DPS (Instant Buyout search). Report P and cost, not only EV.
5. **Caveats to state**: weights are craftofexile's (+-2x, server-side in game; `python -I tools/craftcost.py --xcheck` lists poe2db disagreements, usable as `weights_override`); Vaal odds and Homogenising/Alchemy-omen details are [U]; Catalysing Exaltation is not modelled; prices come from the newest `tools/prices.py` snapshot (date in `stamp`). Engine numbers are DPS/EHP only: run the CLAUDE.md joint check (res, attributes, Spirit) before recommending the crafted item.
6. **Patch day**: `python -I tools/gd_build.py` rebuilds `.work/gamedata/item_mods.json` (needs `tools/gd-extract.sh` output); `tools/patch-day.sh` runs `craftcost --selftest`, `gd_mods --check` (fails if a test base has game mods without a CoE weight) and `craftev --check`. After a CoE update: `python -I tools/craftcost.py --refresh`, then `--xcheck`.
