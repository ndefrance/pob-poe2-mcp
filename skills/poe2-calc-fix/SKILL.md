---
name: poe2-calc-fix
description: Fix a PoB-PoE2 calculation bug (a skill, item, passive or mechanic computes wrong or not at all) in a verifiable, upstream-friendly way and merge it into the lab's live engine. Use when engine numbers disagree with game text or the in-game tooltip.
---

# Calculator fix

1. **Pin the mechanic.** Quote the exact text and its source: PoB `Data/*`, game data via `tools/gd_dat.py`, poe2db (dated), or an in-game tooltip from the user. If none confirms it, mark the fix unverified and say what in-game check would settle it.
2. **Check upstream first.** `git -C PathOfBuilding-PoE2 fetch`, then `git log origin/dev -- <file>`. If upstream already fixed it, merge that instead.
3. **Never edit the live engine directly.** Other runs use it. Work in a worktree:
   - `git -C PathOfBuilding-PoE2 worktree add ../PathOfBuilding-PoE2-fix<X> -b fix-<X> dev`.
   - Copy the uncommitted API, HeadlessWrapper and Item.lua patches and `runtime/luajit.exe` into it. Pattern: `.work/fix_setup.sh`.
   - Point a check at it with `POB_DIR=...` (`POB_DIR=<worktree> node tools/pob.mjs ...`).
4. **Fix it data-driven, the way upstream would.** Use stat ids in SkillStatMap/ModParser, data rows, or exporter fixes in `src/Export`. No build-specific hacks.
   - One small commit per fix.
   - Parser changes: regenerate `Data/ModCache.lua` (`REGENERATE_MOD_CACHE=1`) and commit it.
5. **Add a regression check** `tools/checks/calc/<X>_<name>.lua`. It must `assert` the specific number with a tolerance and a clear message; report-only checks are not allowed. `tools/check-calc.sh` picks it up; non-Monk builds are mapped in its `case`.
6. **Write it up** in `notes/fixes/<X>.md`: quoted text and source, stat ids, before/after numbers, check name, which answers need re-baselining after a data regen, and what is unverified.
7. **Back up the branch:** `git format-patch dev..fix-<X>`, written to `_calcfix<X>_<date>.diff`.
8. **Merge** only when no engine process is running (`tasklist | grep -i luajit` shows nothing):
   - Save the local Item.lua hunk: `git diff src/Classes/Item.lua > _local_item_patch_<date>.diff`.
   - `git checkout -- src/Classes/Item.lua`.
   - `git merge --no-ff fix-<X>`.
   - `git apply _local_item_patch_<date>.diff`.
   - Run `bash tools/check-calc.sh`; every check must pass.
   - Update the CLAUDE.md Layout line (branch list, backups, check count).
9. **Re-run the user's affected numbers** and report before/after.
