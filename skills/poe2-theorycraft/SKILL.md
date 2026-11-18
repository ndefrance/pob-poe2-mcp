---
name: poe2-theorycraft
description: PoB custom-item theorycrafting for any PoE2 build. Covers what-if mod lines ("what if I had +1 projectile / more attack speed"), editing an equipped item, stat weights, and the best possible craft for a slot under res/attribute/Spirit/mana constraints, all engine-verified. Use before any item search or craft plan.
---

# Theorycraft

Tool: `tools/theory.lua` (engine side) + `tools/theory.mjs` (CLI). Full usage, mechanics and patch-day steps: `notes/theorycraft.md`.

```
node tools/theory.mjs <build.xml> what "<mod line>" ["<line>" ...]            # hypothetical global lines
node tools/theory.mjs <build.xml> item "<slot>" --add "<line>" --rm "<line>"  # edit the equipped item (local mods work)
node tools/theory.mjs <build.xml> weights ["<line>" ...]                      # per-line weights (default: every top-tier jewellery/belt/quiver line)
node tools/theory.mjs <build.xml> craft "<slot>" "<base>" <ilvl> --opts '<json>' # best 3P/3S craft on that base
node tools/theory.mjs <build.xml> craftall "<slot>" --opts '<json>'           # every base for the slot
node tools/theory.mjs <build.xml> check                                       # known-answer suite
```
Options (`--opts`):
- `skill`: main skill gem name. Always pass it; the default is the build's main group.
- `sets`: config sets.
- `w={dps=[...], ehp, rar}`: score weights.
- `resMin`: resistance floors.
- `manaMin`: default 0 (lab rule); `false` disables it.
- `minRar`, `minEhp`: rarity and EHP floors.
- `fixAttr`: re-point attribute nodes.
- `runes`, `keepEnchants`.

## Reading results
- `ok=false` + `why` = a constraint failed (res, attributes, Spirit, mana, rarity or EHP floor). Never recommend an `ok=false` result.
- `unparsed` lists lines PoB silently ignores. Their 0% means "not modelled", not "worthless".
- `ver` stamps the tool hash, PoB commit, tree and game patch. Quote it when reporting numbers.
- Crafts use max rolls and PoB has no real spawn weights, so a craft is possible, not likely. Price the odds with `tools/craftcost.py` and the rules in `notes/crafting-reference.md` (corrupted/sanctified, socket limits, socket-bound runes, desecrated/essence caps) before calling it a plan.
- Multi-projectile, pierce and chain score 0 in PoB. Never drop such mods on engine numbers alone.

## Then
- A "perfect craft" is a target. Search the trade API for near matches and run the joint check on the real listing. Never recommend on the theoretical item alone.
- After PoB updates: run `check` (also part of `tools/patch-day.sh`).
