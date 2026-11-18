/**
 * PoE2 Leveling Handlers
 *
 * Generates act-by-act leveling progression for PoE2's 3-acts-then-Cruel structure.
 * Replaces the prior PoE1 10-act version. Boss names, ascendancy trial gating, and
 * starter skill suggestions match PoE2 0.4 conventions.
 */

import type { PoBLuaApiClient } from "../pobLuaBridge.js";
import { wrapHandler } from "../utils/errorHandling.js";

export interface LevelingContext {
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

// PoE2 acts 1-3 + Cruel 1-3. Levels are rough mid-act targets for a normal-paced run.
const ACT_MILESTONES = [
  { phase: 'Act 1',        level: 22, boss: 'Count Geonor',                area: 'Ogham / Mawdun Quarry' },
  { phase: 'Act 2',        level: 35, boss: 'Jamanra the Abomination',     area: 'Vastiri Desert / Caravan Serai' },
  { phase: 'Act 3',        level: 45, boss: 'Doryani / King in the Mists', area: 'Sandswept Marsh / Apex of Filth' },
  { phase: 'Cruel Act 1',  level: 55, boss: 'Cruel Geonor',                area: '(re-run Act 1 zones)' },
  { phase: 'Cruel Act 2',  level: 65, boss: 'Cruel Jamanra',               area: '(re-run Act 2 zones)' },
  { phase: 'Cruel Act 3',  level: 70, boss: 'Cruel King in the Mists',     area: '(re-run Act 3 zones)' },
  { phase: 'Maps (T1-T5)', level: 78, boss: 'Map bosses',                  area: 'Atlas tier 1-5' },
  { phase: 'Maps (T6-T15)', level: 90, boss: 'Map bosses + Citadels',     area: 'Atlas tier 6-15, Citadels' },
  { phase: 'Pinnacle',     level: 95, boss: 'Arbiter / Xesht / King / etc.', area: 'Endgame bosses' },
];

// PoE2 ascendancy unlocks via Trial of Sekhema (Honor-based) and Trial of Chaos.
const ASCENDANCY_UNLOCK = {
  sekhema_floor2:   { level: 35, label: 'Trial of Sekhema (floor 2)', points: 2 },
  sekhema_floor3:   { level: 55, label: 'Trial of Sekhema (floor 3)', points: 2 },
  trial_of_chaos_1: { level: 65, label: 'Trial of Chaos (low tier)',  points: 2 },
  trial_of_chaos_2: { level: 80, label: 'Trial of Chaos (high tier)', points: 2 },
};

// PoE2 classes + their typical leveling skill chains.
// Each entry: starter skill (low-cost, low-requirement at lvl 1-5), then a main skill swap point.
const CLASS_STARTERS: Record<string, {
  early: string;
  earlyDescription: string;
  mainOptions: { skill: string; unlockLevel: number; note: string }[];
  supportPriority: string[];
}> = {
  Ranger: {
    early: 'Burning Arrow / Splitting Steel',
    earlyDescription: 'Both available from Act 1. Burning Arrow for safe single-target, Splitting Steel for clear.',
    mainOptions: [
      { skill: 'Whirling Slash + Twister',  unlockLevel: 24, note: '**0.5 meta — Twister Deadeye**: Whirling Slash creates the Twister, which eats projectiles and spits multiplied copies outward. Pair with Ice-Tipped Arrows for the cold-converted variant. Requires spear access (item or class-flex).' },
      { skill: 'Tornado Shot',  unlockLevel: 28, note: 'Pure bow attack, AoE via tornado mechanic — alternative single-skill archetype' },
      { skill: 'Ice Shot',      unlockLevel: 16, note: 'Bow attack, cold conversion. Strong with Cold Penetration / Glaciation' },
      { skill: 'Lightning Rod', unlockLevel: 24, note: 'Sets a rod that triggers when shocked, big boss damage' },
    ],
    supportPriority: ['Heft', 'Chain', 'Fork', 'Pierce', 'Cold Penetration', 'Lightning Penetration', 'Ice-Tipped Arrows', 'Primal Strikes'],
  },
  Witch: {
    early: 'Unearth or Flame Wall',
    earlyDescription: 'Unearth scales with minions for Infernalist; Flame Wall for spell-damage scaling',
    mainOptions: [
      { skill: 'Bonestorm',           unlockLevel: 18, note: 'Bone spell, scales with phys/chaos via conversion' },
      { skill: 'Essence Drain (Soulrend equiv)', unlockLevel: 24, note: 'Chaos DoT for Lich / Abyssal Lich path' },
      { skill: 'Summon Skeletal Warriors', unlockLevel: 14, note: 'Minion path for Infernalist' },
    ],
    supportPriority: ['Heft', 'Concentrated Area', 'Magnified Area', 'Spell Cascade', 'Withering Touch'],
  },
  Sorceress: {
    early: 'Frost Bolt / Spark / Eye of Winter',
    earlyDescription: 'Spark scales hardest with Stormweaver; Frost Bolt good for Chronomancer cooldown scaling',
    mainOptions: [
      { skill: 'Spark',         unlockLevel: 12, note: 'Lightning spell, scales with Stormweaver elemental conflux' },
      { skill: 'Comet',         unlockLevel: 28, note: 'Big single-target cold spell for Chronomancer' },
      { skill: 'Lightning Storm', unlockLevel: 24, note: 'Channeled lightning AoE' },
    ],
    supportPriority: ['Heft', 'Concentrated Area', 'Magnified Area', 'Spell Cascade', 'Spell Echo', 'Hourglass', 'Cold Penetration', 'Lightning Penetration'],
  },
  Warrior: {
    early: 'Boneshatter or Sunder',
    earlyDescription: 'Boneshatter for stun-stacking damage (Titan); Sunder for armour-break AoE',
    mainOptions: [
      { skill: 'Earthquake',     unlockLevel: 28, note: 'Slam, scales with Titan / Warbringer warcry stacks' },
      { skill: 'Stampede',       unlockLevel: 16, note: 'Movement skill that damages, fast clear' },
      { skill: 'Boneshatter',    unlockLevel: 10, note: 'Stun-stacking for stun-DPS builds' },
    ],
    supportPriority: ['Heft', 'Brutality', 'Close Combat', 'Bonebreaker', 'Ambush'],
  },
  Mercenary: {
    early: 'Galvanic Shards / Plasma Blast',
    earlyDescription: 'Crossbow-based. Galvanic Shards for lightning shotgun; Plasma Blast for AoE blast',
    mainOptions: [
      { skill: 'Galvanic Shards', unlockLevel: 12, note: 'Crossbow shotgun, scales with Witchhunter / Gemling' },
      { skill: 'Explosive Shot',  unlockLevel: 16, note: 'AoE explosion bolt' },
      { skill: 'Gas Grenade',     unlockLevel: 18, note: 'DoT grenade chain for Pathfinder-adjacent builds' },
    ],
    supportPriority: ['Heft', 'Chain', 'Fork', 'Concentrated Area', 'Lightning Penetration'],
  },
  Monk: {
    early: 'Tempest Flurry or Killing Palm',
    earlyDescription: 'Quarterstaff melee. Killing Palm executes low-life enemies, Flurry stacks hits',
    mainOptions: [
      { skill: 'Tempest Flurry', unlockLevel: 12, note: 'Channeled stack hit, scales with Invoker' },
      { skill: 'Falling Thunder', unlockLevel: 18, note: 'Lightning slam from monk staff' },
      { skill: 'Glacial Cascade', unlockLevel: 20, note: 'Cold AoE for Invoker elemental scaling' },
    ],
    supportPriority: ['Heft', 'Martial-tier supports', 'Concentrated Area', 'Close Combat'],
  },
  Druid: {
    early: 'Thrashing Vines / Sigil of Storms',
    earlyDescription: 'Plant skills for Oracle; storm skills for Shaman',
    mainOptions: [
      { skill: 'Thrashing Vines', unlockLevel: 12, note: 'Plant skill, ground-targeted DoT — Oracle plant scaling' },
      { skill: 'Sigil of Storms', unlockLevel: 18, note: 'Damage sigil placement, scales with Shaman storm' },
      { skill: 'Entangle',        unlockLevel: 14, note: 'Plant root for trigger setups (Cast on Critical chain)' },
    ],
    supportPriority: ['Concentrated Area', 'Heft', 'Magnified Area', 'Withering Touch'],
  },
  Huntress: {
    early: 'Spear Throw / Whirling Slash',
    earlyDescription: 'Spear-based melee + projectile',
    mainOptions: [
      { skill: 'Whirling Slash', unlockLevel: 12, note: 'Spear AoE attack for Ritualist / Amazon' },
      { skill: 'Spear Throw',    unlockLevel: 10, note: 'Ranged spear projectile' },
    ],
    supportPriority: ['Heft', 'Martial-tier supports', 'Brutality', 'Bonebreaker'],
  },
};

// Uncut Skill Gem tiers in PoE2:
//   Lesser  → max gem level 10  (campaign — Act 1-3 / early Cruel)
//   Greater → max gem level 15  (mid-game — Cruel acts / early maps)
//   Perfect → max gem level 20  (endgame — yellow/red maps and beyond)
// Support gem tiers I/II/III map to Lesser/Greater/Perfect uncut.
const GEM_BREAKPOINTS = [
  { gemLevel: 5,  charLevel: 18, tier: 'Lesser uncut',  significance: 'Skill gems usually become viable as main DPS around here' },
  { gemLevel: 10, charLevel: 35, tier: 'Lesser uncut max', significance: 'Lesser cap. Buy/cut Greater Uncuts to push past 10. Support I → upgrade to Support II' },
  { gemLevel: 15, charLevel: 60, tier: 'Greater uncut max', significance: 'Greater cap. Perfect Uncuts unlock 16-20. Support II → III' },
  { gemLevel: 20, charLevel: 85, tier: 'Perfect uncut',  significance: 'Natural max. +1 levels via gear/passives stack on top' },
];

export async function handlePlanLeveling(
  context: LevelingContext,
  args: {
    build_name?: string;
    class_name?: string;
    main_skill?: string;
    ascendancy?: string;
  }
) {
  return wrapHandler('plan leveling', async () => {
    let className = args.class_name;
    let mainSkill = args.main_skill;
    let ascendancy = args.ascendancy;

    const luaClient = context.getLuaClient();
    if (luaClient) {
      try {
        const info = await luaClient.getBuildInfo();
        className = className || info.className || info.class;
        ascendancy = ascendancy || info.ascendClassName || info.ascendancy;

        if (!mainSkill) {
          const skills = await luaClient.getSkills();
          if (skills?.groups?.length > 0) {
            const mainGroup =
              skills.groups.find((g: any) => g.index === skills.mainSocketGroup) ||
              skills.groups[0];
            mainSkill =
              mainGroup?.gems?.[0]?.name ||
              mainGroup?.skills?.[0] ||
              'your endgame main skill';
          }
        }
      } catch {
        // fall through
      }
    }

    className = className || 'Ranger';
    mainSkill = mainSkill || 'your endgame main skill';
    ascendancy = ascendancy || 'pick after Trial of Sekhema floor 2';

    const starter = CLASS_STARTERS[className] || CLASS_STARTERS['Ranger'];

    const lines: string[] = [];
    lines.push(`# PoE2 Leveling Guide: ${className}${ascendancy && ascendancy !== 'None' ? ` / ${ascendancy}` : ''}`);
    lines.push(`**Endgame target skill:** ${mainSkill}`);
    lines.push('');
    lines.push(`> PoE2 campaign is **3 acts run twice (normal + Cruel)** for a total of 6 act phases, then maps + pinnacles. Expect ~level 70-72 entering yellow maps, ~85+ for pinnacle bosses.`);
    lines.push('');

    // ---- Starter skills section ----
    lines.push('## Starter Skill (before main is online)');
    lines.push(`**Use:** ${starter.early}`);
    lines.push(`${starter.earlyDescription}`);
    lines.push('');
    lines.push('**Main skill swap candidates:**');
    for (const opt of starter.mainOptions) {
      lines.push(`- **${opt.skill}** (unlocks ~lvl ${opt.unlockLevel}) — ${opt.note}`);
    }
    lines.push('');
    lines.push(`**Support gem priority for ${className}:** ${starter.supportPriority.join(', ')}`);
    lines.push('');

    // ---- Act milestones ----
    lines.push('## Act Milestones');
    lines.push('');
    for (const m of ACT_MILESTONES) {
      lines.push(`### ${m.phase} (target lvl ~${m.level}) — ${m.boss}`);
      lines.push(`*Area: ${m.area}*`);
      lines.push('');

      // Skill progression by act
      if (m.level <= 15) {
        lines.push(`- Run **${starter.early}**, single-link or 2-link`);
        lines.push(`- Start collecting Uncut Skill Gems (Lesser) to cut your supports`);
      } else if (m.level <= 30) {
        lines.push(`- Transition toward **${mainSkill}** if available`);
        lines.push(`- 3-link target: main skill + 2 supports`);
        lines.push(`- Gem level cap ~lvl 10 (Lesser Uncuts only)`);
      } else if (m.level <= 50) {
        lines.push(`- **${mainSkill}** is your main DPS, 3-4 link`);
        lines.push(`- Push gems past lvl 10 via Greater Uncut Skill Gems`);
        lines.push(`- Upgrade Support I to Support II (e.g., Heft I → Heft II)`);
      } else if (m.level <= 70) {
        lines.push(`- 4-5 supports on **${mainSkill}**`);
        lines.push(`- Gem levels 11-15 via Greater Uncuts`);
        lines.push(`- Quality starts mattering — Gemcutter's Prisms for +20% quality`);
      } else if (m.level <= 85) {
        lines.push(`- Full 5+ support setup on **${mainSkill}**`);
        lines.push(`- Push key gems to level 20 via Perfect Uncuts`);
        lines.push(`- Support II → Support III for top-tier supports`);
      } else {
        lines.push(`- All gems at lvl 20 / 20% quality`);
        lines.push(`- +1 gem-level affixes on gear stack on top of the natural cap`);
        lines.push(`- Hunt unique gems / awakened equivalents if PoE2 patch adds them`);
      }

      // Ascendancy markers
      for (const [, unlock] of Object.entries(ASCENDANCY_UNLOCK)) {
        if (m.level >= unlock.level && m.level - 10 < unlock.level) {
          lines.push(`- 🏆 **Do ${unlock.label}** — unlocks +${unlock.points} ascendancy points`);
        }
      }

      // Resist checkpoints
      if (m.phase === 'Cruel Act 1') {
        lines.push(`- ⚠️ **Cruel transition: -20% to all resistances.** Cap Fire/Cold/Lightning to 75% before stepping into Cruel.`);
      }
      if (m.phase === 'Cruel Act 3') {
        lines.push(`- ⚠️ **Second resist penalty: -40% total.** Re-cap all resists before entering maps.`);
      }
      if (m.phase === 'Maps (T1-T5)') {
        lines.push(`- Add chaos resistance — PoE2 caps it at 75% like other elements. Pinnacles hit hard with chaos.`);
      }
      lines.push('');
    }

    // ---- Gem level breakpoints ----
    lines.push('## Gem Level Breakpoints');
    lines.push('');
    lines.push('| Gem Level | Char Level Needed | Uncut Tier | Significance |');
    lines.push('|---|---|---|---|');
    for (const bp of GEM_BREAKPOINTS) {
      lines.push(`| ${bp.gemLevel} | ${bp.charLevel} | ${bp.tier} | ${bp.significance} |`);
    }
    lines.push('');
    lines.push(`> Use \`get_gem_breakpoints\` with a specific gem name for the exact level→stat curve on that gem.`);
    lines.push('');

    // ---- Support tier progression ----
    lines.push('## Support Tier Progression');
    lines.push('');
    lines.push(`PoE2 supports come in three tiers (I/II/III) cut from Lesser/Greater/Perfect Uncuts respectively.`);
    lines.push('');
    lines.push('| Tier | Char Level | Cuts From | When to Use |');
    lines.push('|---|---|---|---|');
    lines.push(`| Support I   | 1-30  | Lesser Uncut Support Gem | Campaign through Act 3 |`);
    lines.push(`| Support II  | 30-60 | Greater Uncut Support Gem | Cruel + early maps |`);
    lines.push(`| Support III | 60+   | Perfect Uncut Support Gem | Yellow/red maps and pinnacles |`);
    lines.push('');
    lines.push(`**Important:** each support can only be used once per build across all skills. Pick carefully.`);
    lines.push('');

    // ---- Ascendancy summary ----
    lines.push('## Ascendancy Progression');
    lines.push('');
    lines.push(`PoE2 ascendancies come from two trial types: **Trial of Sekhema** (Honor-based, found in Act 2 area) and **Trial of Chaos** (Act 3 area + endgame).`);
    lines.push('');
    lines.push('| Trial | Char Level | Points |');
    lines.push('|---|---|---|');
    lines.push(`| Sekhema floor 2 | ~35 | +2 |`);
    lines.push(`| Sekhema floor 3 | ~55 | +2 |`);
    lines.push(`| Chaos low tier  | ~65 | +2 |`);
    lines.push(`| Chaos high tier | ~80 | +2 |`);
    lines.push(`| **Total** | **endgame** | **8 ascendancy points** |`);
    lines.push('');

    // ---- General tips ----
    lines.push('## Key Tips for PoE2 Leveling');
    lines.push(`- **Movement speed** — grab MS boots in Act 1 or 2. Single most-impactful early upgrade.`);
    lines.push(`- **Rune slots** — PoE2 gear has rune slots for adding resists / damage. Use Iron Runes early.`);
    lines.push(`- **Spirit reservation** — PoE2 has Spirit as a separate resource for Heralds/Auras/persistent buffs. Don't over-reserve.`);
    lines.push(`- **Charm slots** — belt + charm-equipping pattern (3 charm slots). Get freeze/poison removal charms early.`);
    lines.push(`- **Resistance penalties** at end of Act 3 (-20%) and end of Cruel Act 3 (-40%) — re-cap before progressing.`);
    lines.push(`- **Trial of Sekhema** is the first ascendancy unlock — prioritize once you hit lvl 30-35.`);
    lines.push(`- **Greater/Perfect Uncuts** drop from later content — don't waste Lesser Uncuts on supports you'll replace.`);
    lines.push(`- **Trade for cheap rares** in Cruel — exalted-tier rare jewelry with life + 2 resists is usually < 5 ex.`);
    lines.push('');

    // ---- Workflow pointers ----
    lines.push('## Iterative Refinement With the MCP');
    lines.push('');
    lines.push(`- Use \`lua_new_build\` + \`lua_set_tree\` to scaffold this build at specific levels`);
    lines.push(`- Use \`set_character_level\` to test DPS / EHP at each milestone`);
    lines.push(`- Use \`lua_simulate_change\` with candidate tree nodes to verify the next-best allocation per level range`);
    lines.push(`- Use \`search_trade_items\` with stage budgets (1-5 ex Acts 1-3, 5-50 ex Cruel, 50ex+ maps) for tier-appropriate gear`);
    lines.push(`- Use \`check_boss_readiness\` to test pinnacle readiness as you approach endgame`);
    lines.push(`- Use \`snapshot_build\` between milestones so you can roll back if a respec doesn't pan out`);

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  });
}

/**
 * For a specific skill gem, return the per-level data (req char level, mana cost, key stat curve).
 * Reads PoB2's live gem catalog via the bridge.
 */
export async function handleGetGemBreakpoints(
  context: LevelingContext,
  args: { gem_name: string }
) {
  return wrapHandler('get gem breakpoints', async () => {
    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua bridge not active. Use lua_start first.');
    }
    const data = await (luaClient as any).getGemBreakpoints({ gemName: args.gem_name });
    if (!data) {
      return { content: [{ type: 'text' as const, text: `No data for gem "${args.gem_name}". Verify name via add_gem on a throwaway group, or check that PoB2 has it in its catalog.` }] };
    }
    const lines: string[] = [];
    lines.push(`# ${data.name} — Level Curve`);
    if (data.description) lines.push(`> ${data.description}`);
    lines.push('');
    lines.push(`**Natural max level:** ${data.naturalMaxLevel ?? 20}`);
    lines.push('');
    lines.push(`| Gem Lvl | Char Lvl Req | Mana Cost | Notes |`);
    lines.push(`|---|---|---|---|`);
    for (const lvl of (data.levels || [])) {
      lines.push(`| ${lvl.gemLevel} | ${lvl.charLevel ?? '?'} | ${lvl.mana ?? '?'} | ${lvl.note ?? ''} |`);
    }
    lines.push('');
    lines.push('## Uncut Tier Crossover');
    lines.push(`- **Lvl 1-10** — Lesser Uncut (Tier I support equivalent)`);
    lines.push(`- **Lvl 11-15** — Greater Uncut required (Tier II)`);
    lines.push(`- **Lvl 16-20** — Perfect Uncut required (Tier III)`);
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  });
}
