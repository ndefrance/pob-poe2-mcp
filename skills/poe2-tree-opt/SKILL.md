---
name: poe2-tree-opt
description: Fast, engine-verified PoE2 passive tree optimization covering best next points/paths, refund-and-respend respecs with gold cost, and survivability-first or damage weights, for any PoB build. Use for "where do I put my next point", "what should I respec", or tree changes after gear changes.
---

# Tree optimizer

Tool: `tools/treeopt.lua` (generic) + `tools/treeopt-monk.lua` (Monk wrapper: T16 EHP hook, weights, protected nodes, gold table). Commands, mechanics and results: `notes/tree-optimizer.md`. One engine process at a time.

```
node tools/pob.mjs <build.xml> "eval:local O=dofile('../../tools/treeopt.lua')({sets={map=1,boss=2}}) return O.next(5)"   # any build
node tools/pob.mjs builds/monk-cur-calc.xml "eval:local O=dofile('../../tools/treeopt-monk.lua') return O.next(10)"      # Monk
... O.next(8,{map=1,boss=1,ehp=0})          # damage-only weights
... O.respec(10)  /  O.respec(10,nil,{floor={map=0,boss=0}})   # respec, optionally with no DPS loss
```
To verify and save a respec, use `O.verify(...)` with `save=` (exact command in the note). Saved builds go to `builds/` as NEW files, never the user's OneDrive folder.

## Rules
- Every number reported must come from `O.verify`. The fast path skips Party-tab buffs and main-only side effects; see note section 3.
- Default weights are survivability-first (EHP ≥ DPS) for the user's Monk.
- Conditional nodes ("within 2m", "not Poisoned", Stand and Deliver, Low Tolerance) are excluded or flagged. List the conditions a path relies on and ask the user whether they hold in play.
- Each change must report:
  - what turns off: movement speed, projectile speed, ailments, and the 0-value nodes kept on purpose (poison immunity etc.);
  - gold cost (from game table `goldrespecprices`);
  - weapon-set 2 nodes, which are protected.
- The search is greedy: combinations that only pay off together can be missed. Say so when the answer is "no change".
- Check: `node tools/pob.mjs builds/monk-cur-calc.xml "eval:$(cat tools/checks/treeopt_check.lua)"`, also run by `tools/patch-day.sh`. On the 1.0 tree, re-baseline the known answers per note section 7.
