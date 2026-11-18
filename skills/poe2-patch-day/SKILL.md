---
name: poe2-patch-day
description: Update and re-verify the PoE2 build lab after a PoB-PoE2 update, a game patch, a new league or the 1.0 launch. Use when upstream PoB changed, Steam updated the game, the league changed, or any tool's numbers look off.
---

# Patch day

Order matters: engine first, then game data, then every tool's check. Nothing is "done" until `tools/patch-day.sh` prints ALL PASS.

1. **League** (new league / 1.0): edit `tools/league.txt` (one line). Trade JS reads the league from the open trade tab; poe.ninja tools and the filter updater read the file.
2. **Engine** (CLAUDE.md "Updating the engine"):
   - Save local uncommitted patches: `git -C PathOfBuilding-PoE2 diff > _local_engine_patch_<date>.diff`.
   - `git fetch` upstream, check whether our fixes are upstreamed (`git log origin/dev -- <file>`), then merge. Resolve conflicts with upstream names. `Data/ModCache.lua` conflicts: regenerate with `REGENERATE_MOD_CACHE=1`.
   - If `runtime/lua51.dll` changed: re-patch `runtime/luajit.exe`.
   - Re-apply the local patches. If upstream refactored, re-apply `_calcfix*.diff` per fix; write-ups are in `notes/fixes/*.md`.
3. **Game data**: `bash tools/gd-extract.sh`, `bash tools/gd-export.sh`, then `python -I tools/gd_build.py`. That also regenerates `tools/content_data.lua` and `.work/gamedata/atlas.json` with a new patch+hash stamp. Details: `notes/game-data-ingest.md`.
   - Diff the atlas, waystone and tablet data against the previous archive: `python -I tools/gd_atlas.py --diff data/gamedata-archive/atlas_<old patch>_<old hash>.json` (durable archive; current: atlas_0.5.5e_3e1c69011ede.json).
   - Copy changed `.work/export-run/src/Data` files into PoB only if upstream has not shipped the new patch data yet.
4. **Verify everything**: `bash tools/patch-day.sh [build.xml]`. It runs:
   - the smoke test;
   - `tools/check-calc.sh` (every `tools/checks/calc/*.lua`, asserting pinned numbers);
   - every `tools/checks/*.lua` known-answer check;
   - crafting: `craftcost.py --selftest`, `gd_mods.py --check` (game pool vs CoE weights), `craftev.py --check` (engine EV of the Woe Twine job) - see skill poe2-crafting.
5. **A check fails**: read its `why`. It names the renamed PoB internal or the changed number.
   - Renamed internal: fix the tool and update its `-- POB CONTRACT:` header.
   - Changed number: confirm the new game behaviour from a source (game data, skill text, poe2db) before re-baselining the known answer. Never re-baseline just to get green.
   - Re-baselining after a data regen: each `notes/fixes/*.md` and `tools/checks/*` header lists which answers are data-dependent.
6. **Re-import the user's character** and re-run their build numbers. Patch notes can change items and skills the build relies on.

Rules for any new tool (so it survives patches):
- Read game numbers from PoB `Data/*` or `.work/gamedata` at runtime.
- Unavoidable constants go in one table with source + patch.
- Ship a `-- POB CONTRACT:` header and a `tools/checks/<tool>_check.lua` that returns `{ok=true}` or `{ok=false,why=...}`.
- Stamp results with the PoB commit and data version.
