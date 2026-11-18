import type { PoBLuaApiClient } from "../pobLuaBridge.js";
import { handleGetBuildIssues } from "./buildGoalsHandlers.js";
import fs from "fs/promises";
import path from "path";
import { wrapHandler } from "../utils/errorHandling.js";
import { sanitizeBuildName } from "../utils/pathSanitizer.js";

export interface LuaHandlerContext {
  pobDirectory: string;
  luaEnabled: boolean;
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
  stopLuaClient: () => Promise<void>;
}

export async function handleLuaStart(context: LuaHandlerContext) {
  return wrapHandler('start Lua bridge', async () => {
    await context.ensureLuaClient();

    return {
      content: [
        {
          type: "text" as const,
          text: `PoB Lua Bridge started successfully.\n\nThe PoB calculation engine is now ready to load builds and compute stats.`,
        },
      ],
    };
  });
}

export async function handleLuaStop(context: LuaHandlerContext) {
  return wrapHandler('stop Lua bridge', async () => {
    await context.stopLuaClient();

    return {
      content: [
        {
          type: "text" as const,
          text: "PoB Lua Bridge stopped successfully.",
        },
      ],
    };
  });
}

export async function handleLuaNewBuild(context: LuaHandlerContext, className?: string, ascendancy?: string) {
  return wrapHandler('create new build', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized');
    }

    await luaClient.newBuild(className || ascendancy ? { className, ascendancy } : undefined);

    const classDesc = className ? ` (${className}${ascendancy ? `/${ascendancy}` : ''})` : '';
    return {
      content: [
        {
          type: "text" as const,
          text: `✅ New empty build created${classDesc}.`,
        },
      ],
    };
  });
}

export async function handleLuaSaveBuild(context: LuaHandlerContext, buildName: string) {
  return wrapHandler('save build', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized');
    }

    if (!buildName || !buildName.trim()) {
      throw new Error('build_name is required');
    }

    const fileName = buildName.endsWith('.xml') ? buildName : `${buildName}.xml`;
    const filePath = sanitizeBuildName(fileName, context.pobDirectory);
    const result = await luaClient.saveBuild(filePath);

    return {
      content: [
        {
          type: "text" as const,
          text: `✅ Build saved to "${fileName}" (${result?.size ?? '?'} bytes). File-based tools can now use this build.`,
        },
      ],
    };
  });
}

export async function handleLuaLoadBuild(
  context: LuaHandlerContext,
  buildName?: string,
  buildXml?: string,
  name?: string
) {
  return wrapHandler('load build', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized');
    }

    // If build_name is provided, read the file
    let xml = buildXml;
    if (buildName) {
      const buildPath = sanitizeBuildName(buildName, context.pobDirectory);
      xml = await fs.readFile(buildPath, 'utf-8');
      // Use the build filename as the name if not specified
      if (!name) {
        name = buildName.replace(/\.xml$/i, '');
      }
    } else if (!xml) {
      throw new Error('Either build_name or build_xml must be provided');
    }

    await luaClient.loadBuildXml(xml, name);

    // Check for multiple specs / item sets and inform the user (sequential — bridge is single-request)
    const extraLines: string[] = [];
    try {
      const specsResult = await luaClient.listSpecs();
      const itemSetsResult = await luaClient.listItemSets();
      if (specsResult?.specs?.length > 1) {
        extraLines.push('');
        extraLines.push(`📋 This build has ${specsResult.specs.length} passive tree specs:`);
        const maxNodes = Math.max(...specsResult.specs.map((s: any) => s.nodeCount ?? 0));
        for (const s of specsResult.specs) {
          const isEndgame = s.nodeCount === maxNodes && !s.active ? ' ← likely endgame' : '';
          extraLines.push(`  ${s.active ? '▶' : ' '} [${s.index}] ${s.title} — ${s.className}/${s.ascendClassName}, ${s.nodeCount} nodes${isEndgame}`);
        }
        // Warn if active spec is not the one with the most nodes
        const activeSpec = specsResult.specs.find((s: any) => s.active);
        if (activeSpec && activeSpec.nodeCount < maxNodes) {
          const endgameSpec = specsResult.specs.find((s: any) => s.nodeCount === maxNodes);
          extraLines.push(`⚠️  Active spec is a leveling tree (${activeSpec.nodeCount} nodes). For endgame analysis, run: select_spec(${endgameSpec?.index})`);
        }
        extraLines.push('Use select_spec to switch specs.');
      }
      if (itemSetsResult?.itemSets?.length > 1) {
        extraLines.push('');
        extraLines.push(`🎒 This build has ${itemSetsResult.itemSets.length} item sets:`);
        for (const s of itemSetsResult.itemSets) {
          extraLines.push(`  ${s.active ? '▶' : ' '} [${s.id}] ${s.title}`);
        }
        extraLines.push('Use select_item_set to switch item sets.');
      }
    } catch {
      // Non-fatal: spec/item set info is advisory only
    }
    const extra = extraLines.length > 0 ? '\n' + extraLines.join('\n') : '';

    // Auto-context: fetch stats + top issues after successful load (sequential — bridge is single-request)
    const summaryLines: string[] = [];
    try {
      const info = await luaClient.getBuildInfo().catch(() => null);
      if (info) {
        summaryLines.push(`**${info.name || name}** | Level ${info.level} ${info.className ?? ''}${info.ascendClassName ? ` (${info.ascendClassName})` : ''}`);
      }

      const s = await luaClient.getStats(['Life', 'Spirit', 'TotalDPS', 'CombinedDPS', 'FullDPS', 'MinionTotalDPS',
        'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist', 'TotalEHP']).catch(() => null);
      if (s) {
        const dps = Number(s.FullDPS || s.CombinedDPS || s.TotalDPS || s.MinionTotalDPS || 0);
        const dpsLabel = (s.MinionTotalDPS && !s.TotalDPS && !s.FullDPS) ? 'Minion DPS' : 'DPS';
        const spiritStr = s.Spirit ? ` | Spirit: ${Number(s.Spirit).toLocaleString()}` : '';
        summaryLines.push(`Life: ${Number(s.Life ?? 0).toLocaleString()}${spiritStr} | ${dpsLabel}: ${Math.round(dps).toLocaleString()} | EHP: ${Number(s.TotalEHP ?? 0).toLocaleString()}`);
        summaryLines.push(`Resists: F${s.FireResist}% C${s.ColdResist}% L${s.LightningResist}% Ch${s.ChaosResist}%`);
      }

      const issuesResult = await handleGetBuildIssues({ getLuaClient: context.getLuaClient, ensureLuaClient: async () => {} }).catch(() => null);
      if (issuesResult) {
        const { issues } = issuesResult;
        const topIssues = issues.filter((i: any) => i.severity === 'error' || i.severity === 'warning').slice(0, 3);
        if (topIssues.length > 0) {
          summaryLines.push('');
          summaryLines.push('**Top Issues:**');
          for (const issue of topIssues) {
            const icon = issue.severity === 'error' ? '🔴' : '🟡';
            summaryLines.push(`  ${icon} ${issue.message}`);
          }
        } else {
          summaryLines.push('');
          summaryLines.push('✅ No critical issues detected.');
        }
      }
    } catch { /* auto-context is best-effort */ }
    const summary = summaryLines.join('\n');

    const loadText = `✅ Build "${name || 'MCP Build'}" loaded.${extra}` + (summary ? '\n---\n' + summary : '');

    return {
      content: [
        {
          type: "text" as const,
          text: loadText,
        },
      ],
    };
  });
}

export async function handleLuaGetStats(context: LuaHandlerContext, category?: string) {
  return wrapHandler('get stats', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized');
    }

    // Map category to specific fields
    let fields: string[] | undefined;
    if (category === 'offense') {
      fields = [
        'TotalDPS', 'CombinedDPS', 'FullDPS', 'TotalDot', 'TotalDotDPS', 'FullDotDPS',
        'WithBleedDPS', 'WithIgniteDPS', 'WithPoisonDPS', 'IgniteDPS', 'BleedDPS', 'PoisonDPS',
        'AverageDamage', 'AverageBurstDamage',
        'Speed', 'HitChance', 'CritChance', 'CritMultiplier', 'PreEffectiveCritChance',
        'EffectiveCritChance', 'MainHandAccuracy', 'OffHandAccuracy', 'ManaCost', 'ManaPerSecondCost',
        'ManaPercentCost', 'ManaPercentPerSecondCost',
        'LifeCost', 'LifePerSecondCost', 'LifePercentCost', 'LifePercentPerSecondCost',
        'ESCost', 'ESPerSecondCost', 'ESPercentPerSecondCost',
        'RageCost', 'SoulCost', 'CullingDPS', 'ReservationDPS',
        // Minion stats (populated for summoner builds)
        'MinionTotalDPS', 'MinionCombinedDPS', 'MinionAverageDamage', 'MinionSpeed',
        'MinionLife', 'MinionArmour', 'MinionEnergyShield',
        'MinionFireResist', 'MinionColdResist', 'MinionLightningResist', 'MinionChaosResist',
      ];
    } else if (category === 'defense') {
      fields = [
        'Life', 'LifeRegen', 'LifeRegenRecovery', 'LifeLeechGainRate', 'LifeUnreserved',
        'LifeUnreservedPercent', 'LifeRecoverable',
        'Mana', 'ManaRegen', 'ManaRegenRecovery', 'ManaLeechGainRate', 'ManaUnreserved',
        'ManaUnreservedPercent',
        // PoE2 resources
        'Spirit', 'SpiritUnreserved', 'SpiritUnreservedPercent',
        'Rage', 'RageRegenRecovery',
        'EnergyShield', 'EnergyShieldRegen', 'EnergyShieldRegenRecovery', 'EnergyShieldLeechGainRate',
        'EnergyShieldRecoveryCap',
        'Ward', 'Armour', 'Evasion', 'EvasionChance', 'PhysicalDamageReduction',
        'MeleeEvadeChance', 'ProjectileEvadeChance',
        'BlockChance', 'SpellBlockChance', 'EffectiveBlockChance', 'EffectiveSpellBlockChance',
        'AttackDodgeChance', 'SpellDodgeChance',
        'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
        'FireResistOverCap', 'ColdResistOverCap', 'LightningResistOverCap', 'ChaosResistOverCap',
        'TotalEHP', 'PhysicalMaximumHitTaken', 'FireMaximumHitTaken', 'ColdMaximumHitTaken',
        'LightningMaximumHitTaken', 'ChaosMaximumHitTaken', 'EffectiveSpellSuppressionChance',
        'PowerCharges', 'PowerChargesMax', 'FrenzyCharges', 'FrenzyChargesMax',
        'EnduranceCharges', 'EnduranceChargesMax',
      ];
    }
    // If category is 'all' or undefined, get all stats (fields = undefined)

    const stats = await luaClient.getStats(fields);

    const textLines: string[] = ['=== PoB Calculated Stats ===', ''];

    if (stats && typeof stats === 'object') {
      // Filter out zero/null/undefined values to reduce noise
      const nonZero = (v: unknown) => v != null && v !== 0 && v !== '0';
      const entries = Object.entries(stats).filter(([, v]) => nonZero(v));

      // Group by offense/defense if showing all
      if (!category || category === 'all') {
        const offenseKeys = ['DPS', 'Damage', 'Speed', 'Crit', 'Hit', 'Accuracy', 'Cost', 'Charges'];
        const defenseKeys = ['Life', 'Mana', 'Energy', 'Shield', 'Resist', 'Block', 'Dodge', 'Evasion', 'Armour', 'Ward', 'EHP', 'Maximum', 'Regen', 'Leech', 'Recovery',
          // PoE2 resources
          'Spirit', 'Rage', 'Suppression', 'Reduction'];

        // Sort offense so DPS metrics appear first, then apply cap
        const offenseAll = entries.filter(([key]) => offenseKeys.some(ok => key.includes(ok)));
        offenseAll.sort(([keyA], [keyB]) => {
          const isDpsA = keyA.includes('TotalDPS') || keyA.includes('CombinedDPS') || keyA.includes('MinionTotalDPS') ? -1 : 0;
          const isDpsB = keyB.includes('TotalDPS') || keyB.includes('CombinedDPS') || keyB.includes('MinionTotalDPS') ? -1 : 0;
          return isDpsA - isDpsB;
        });
        const offense = offenseAll.slice(0, 15);
        const defenseAll = entries.filter(([key]) => defenseKeys.some(dk => key.includes(dk)));
        const defense = defenseAll.slice(0, 15);
        const other = entries.filter(([key]) => !offenseAll.some(([ok]) => ok === key) && !defenseAll.some(([dk]) => dk === key));

        if (offense.length > 0) {
          textLines.push('**Offense:**');
          for (const [key, value] of offense) {
            textLines.push(`${key}: ${value}`);
          }
          if (offenseAll.length > 15) {
            textLines.push(`  ... use category='offense' for full list (+${offenseAll.length - 15} more)`);
          }
          textLines.push('');
        }

        if (defense.length > 0) {
          textLines.push('**Defense:**');
          for (const [key, value] of defense) {
            textLines.push(`${key}: ${value}`);
          }
          if (defenseAll.length > 15) {
            textLines.push(`  ... use category='defense' for full list (+${defenseAll.length - 15} more)`);
          }
          textLines.push('');
        }

        if (other.length > 0) {
          textLines.push('**Other:**');
          const otherCap = 20;
          for (const [key, value] of other.slice(0, otherCap)) {
            textLines.push(`${key}: ${value}`);
          }
          if (other.length > otherCap) {
            textLines.push(`  ... +${other.length - otherCap} more`);
          }
        }
      } else {
        // Just show the requested category, skip zeros
        const maxStats = 50;
        let shown = 0;
        for (const [key, value] of entries) {
          if (shown >= maxStats) break;
          textLines.push(`${key}: ${value}`);
          shown++;
        }

        if (entries.length > maxStats) {
          textLines.push('');
          textLines.push(`... and ${entries.length - maxStats} more stats`);
        }
      }
    } else {
      textLines.push('No stats available.');
    }
    const text = textLines.join('\n');

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

// Class/ascendancy names are resolved live from PoB2's tree data via the bridge's
// get_tree response (which now includes className/ascendClassName) instead of being
// hardcoded — PoB2 has different classes per tree version and they change with updates.

export async function handleLuaGetTree(context: LuaHandlerContext, includeNodeIds?: boolean) {
  return wrapHandler('get passive tree', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized');
    }

    const tree = await luaClient.getTree();

    const textLines: string[] = ['=== PoB Passive Tree ===', ''];

    if (tree && typeof tree === 'object') {
      textLines.push(`Tree Version: ${tree.treeVersion ?? 'Unknown'}`);
      const classId = tree.classId != null ? tree.classId : undefined;
      const className = tree.className as string | undefined;
      textLines.push(`Class: ${className ?? 'Unknown'} (ID: ${classId ?? 'Unknown'})`);
      const ascId = tree.ascendClassId != null ? tree.ascendClassId : undefined;
      const ascName = tree.ascendClassName as string | undefined;
      textLines.push(`Ascendancy: ${ascName ?? (ascId === 0 ? 'None' : 'Unknown')} (ID: ${ascId ?? 'Unknown'})`);

      if (tree.secondaryAscendClassId) {
        textLines.push(`Secondary Ascendancy ID: ${tree.secondaryAscendClassId}`);
      }

      if (tree.nodes && Array.isArray(tree.nodes)) {
        textLines.push(`\nAllocated Nodes: ${tree.nodes.length} nodes`);
        if (includeNodeIds) {
          textLines.push(`Node IDs: ${tree.nodes.join(', ')}`);
        } else {
          textLines.push(`Node IDs: [omitted — use include_node_ids=true to see full list]`);
        }
      }

      if (tree.masteryEffects && typeof tree.masteryEffects === 'object') {
        const effectCount = Object.keys(tree.masteryEffects).length;
        textLines.push(`\nMastery Effects: ${effectCount} selected`);
      }
    } else {
      textLines.push('No tree data available.');
    }
    const text = textLines.join('\n');

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleLuaSetTree(context: LuaHandlerContext, args: any) {
  return wrapHandler('set passive tree', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized');
    }

    if (!Array.isArray(args.nodes)) {
      throw new Error('nodes must be an array');
    }

    // If classId/ascendClassId not provided, read them from current build to preserve class
    let classId = args.classId;
    let ascendClassId = args.ascendClassId;
    let secondaryAscendClassId = args.secondaryAscendClassId;
    let treeVersion = args.treeVersion;

    if (classId === undefined || ascendClassId === undefined) {
      const currentTree = await luaClient.getTree();
      classId = classId ?? (currentTree?.classId || 0);
      ascendClassId = ascendClassId ?? (currentTree?.ascendClassId || 0);
      secondaryAscendClassId = secondaryAscendClassId ?? (currentTree?.secondaryAscendClassId || 0);
      treeVersion = treeVersion ?? currentTree?.treeVersion;
    }

    const tree = await luaClient.setTree({
      classId,
      ascendClassId,
      secondaryAscendClassId,
      nodes: (args.nodes as string[]).map(Number),
      masteryEffects: args.masteryEffects,
      treeVersion,
    });

    const actualCount = (tree && Array.isArray(tree.nodes)) ? tree.nodes.length : args.nodes.length;
    const requested = args.nodes.length;
    const dropped = requested - actualCount;
    let text = `✅ Passive tree updated. Allocated ${actualCount} nodes.`;
    if (dropped > 0) {
      text += `\n⚠️  ${dropped} of ${requested} requested nodes were dropped (not connected to start or invalid IDs).`;
      text += `\nTip: Ensure the class is set correctly and nodes form a valid connected path from the starting node.`;
    }

    const ascUsed = tree?.ascendancyPointsUsed ?? 0;
    if (ascUsed > 8) {
      text += `\n🔴 ERROR: ${ascUsed} ascendancy points used (max 8). Remove ${ascUsed - 8} ascendancy node(s).`;
    }

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleLuaGetBuildInfo(context: LuaHandlerContext) {
  return wrapHandler('get build info', async () => {
    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error('Lua client not initialized');

    const info = await luaClient.getBuildInfo();

    if (!info) {
      return {
        content: [{ type: "text" as const, text: "No build currently loaded. Use lua_load_build or lua_new_build first." }],
      };
    }

    const text = [
      '=== Build Info ===',
      '',
      `Name: ${info.name || 'Unnamed'}`,
      `Level: ${info.level ?? 'Unknown'}`,
      `Class: ${info.className || 'Unknown'}`,
      `Ascendancy: ${info.ascendClassName || 'None'}`,
      `Tree Version: ${info.treeVersion || 'Unknown'}`,
    ].join('\n');

    return {
      content: [{ type: "text" as const, text }],
    };
  });
}

export async function handleLuaGetDpsBreakdown(context: LuaHandlerContext) {
  return wrapHandler('get DPS breakdown', async () => {
    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error('Lua client not initialized');

    const b = await luaClient.getDpsBreakdown();
    if (!b) {
      return { content: [{ type: 'text' as const, text: 'No DPS data — load a build first.' }] };
    }

    const lines: string[] = ['=== DPS Breakdown ==='];
    if (b.meta) {
      lines.push(`Build: ${b.meta.build_name ?? 'Unnamed'} | L${b.meta.level ?? '?'} ${b.meta.class_name ?? ''}${b.meta.ascend_class ? ` (${b.meta.ascend_class})` : ''} | tree ${b.meta.tree_version ?? '?'}`);
    }

    const fmt = (v: any) => v == null ? '-' : (typeof v === 'number' ? Math.round(v * 100) / 100 : String(v));
    const T = b.totals || {};
    lines.push('', '**Totals**');
    if (T.AverageHit != null) lines.push(`  Average Hit:        ${fmt(T.AverageHit)}`);
    if (T.AverageDamage != null && T.AverageDamage !== T.AverageHit) lines.push(`  Average Damage:     ${fmt(T.AverageDamage)}`);
    if (T.AverageBurstDamage != null) lines.push(`  Average Burst:      ${fmt(T.AverageBurstDamage)}`);
    if (T.TotalDPS != null) lines.push(`  Total DPS:          ${fmt(T.TotalDPS)}`);
    if (T.CombinedDPS != null && T.CombinedDPS !== T.TotalDPS) lines.push(`  Combined DPS:       ${fmt(T.CombinedDPS)}  (active skill + dots)`);
    if (T.FullDPS != null) lines.push(`  Full DPS:           ${fmt(T.FullDPS)}  (sum of all flagged groups)`);
    if (T.TotalDot != null && T.TotalDot !== 0) lines.push(`  Total DoT:          ${fmt(T.TotalDot)}`);
    if (T.WithPoisonDPS && T.WithPoisonDPS !== T.TotalDPS) lines.push(`  With Poison DPS:    ${fmt(T.WithPoisonDPS)}`);
    if (T.WithBleedDPS  && T.WithBleedDPS  !== T.TotalDPS) lines.push(`  With Bleed DPS:     ${fmt(T.WithBleedDPS)}`);
    if (T.WithIgniteDPS && T.WithIgniteDPS !== T.TotalDPS) lines.push(`  With Ignite DPS:    ${fmt(T.WithIgniteDPS)}`);

    if (b.crit) {
      lines.push('', '**Crit**');
      lines.push(`  Crit Chance:        ${fmt(b.crit.chance)}%${b.crit.effective_chance != null ? ` (effective ${fmt(b.crit.effective_chance)}%)` : ''}`);
      lines.push(`  Crit Multi:         ${fmt(b.crit.multiplier)}x`);
      if (b.crit.by_type_avg && Object.keys(b.crit.by_type_avg).length) {
        const parts = Object.entries(b.crit.by_type_avg).map(([k, v]) => `${k}=${fmt(v)}`);
        lines.push(`  Crit avg by type:   ${parts.join(', ')}`);
      }
    }

    if (b.damage_by_type && Object.keys(b.damage_by_type).length) {
      lines.push('', '**Damage by Type (avg hit)**');
      for (const [k, v] of Object.entries(b.damage_by_type)) lines.push(`  ${k.padEnd(10)} ${fmt(v)}`);
    }

    const dotEntries: string[] = [];
    if (b.poison_dot_dps) dotEntries.push(`Poison ${fmt(b.poison_dot_dps)}`);
    if (b.bleed_dot_dps)  dotEntries.push(`Bleed ${fmt(b.bleed_dot_dps)}`);
    if (b.ignite_dot_dps) dotEntries.push(`Ignite ${fmt(b.ignite_dot_dps)}`);
    if (b.decay_dot_dps)  dotEntries.push(`Decay ${fmt(b.decay_dot_dps)}`);
    if (dotEntries.length) lines.push('', '**DoT DPS**', '  ' + dotEntries.join(' | '));

    if (b.hit) {
      lines.push('', '**Hit / Accuracy**');
      if (b.hit.hit_chance != null) lines.push(`  Hit Chance:         ${fmt(b.hit.hit_chance)}%`);
      if (b.hit.main_hand_accuracy != null) lines.push(`  Main Hand Accuracy: ${fmt(b.hit.main_hand_accuracy)}`);
      if (b.hit.off_hand_accuracy != null) lines.push(`  Off Hand Accuracy:  ${fmt(b.hit.off_hand_accuracy)}`);
    }

    if (b.speed) {
      lines.push('', '**Speed**');
      if (b.speed.speed != null)              lines.push(`  Skill Use Rate:     ${fmt(b.speed.speed)}/sec`);
      if (b.speed.effective_movement != null) lines.push(`  Movement Speed:     ${fmt(b.speed.effective_movement)}x`);
    }

    if (b.costs) {
      const costLines: string[] = [];
      const C = b.costs;
      if (C.mana)            costLines.push(`Mana ${fmt(C.mana)}/cast`);
      if (C.mana_per_second) costLines.push(`Mana ${fmt(C.mana_per_second)}/sec`);
      if (C.life)            costLines.push(`Life ${fmt(C.life)}/cast`);
      if (C.es)              costLines.push(`ES ${fmt(C.es)}/cast`);
      if (C.rage)            costLines.push(`Rage ${fmt(C.rage)}`);
      if (C.soul)            costLines.push(`Soul ${fmt(C.soul)}`);
      if (costLines.length) lines.push('', '**Costs**', '  ' + costLines.join(' | '));
    }

    if (b.penetration && Object.values(b.penetration).some((v: any) => v)) {
      lines.push('', '**Penetration**');
      for (const [k, v] of Object.entries(b.penetration)) if (v) lines.push(`  ${k.padEnd(10)} ${fmt(v)}%`);
    }

    if (b.charges_active) {
      const active = Object.entries(b.charges_active)
        .filter(([k, v]) => !k.endsWith('_max') && v && v !== 0);
      if (active.length) {
        lines.push('', '**Active Charges**');
        for (const [k, v] of active) {
          const max = (b.charges_active as any)[`${k}_max`];
          lines.push(`  ${k.padEnd(12)} ${fmt(v)}${max ? `/${max}` : ''}`);
        }
      }
    }

    if (b.enemy_status) {
      const E = b.enemy_status;
      const parts: string[] = [];
      if (E.enemy_is_boss) parts.push('boss=true');
      if (E.enemy_level) parts.push(`level=${E.enemy_level}`);
      if (E.enemy_phys_reduction) parts.push(`phys_reduction=${E.enemy_phys_reduction}%`);
      if (parts.length) lines.push('', `**Enemy config:** ${parts.join(', ')}`);
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  });
}

export async function handleLuaSetFullCombatState(context: LuaHandlerContext, args: { enable?: boolean }) {
  return wrapHandler('set full combat state', async () => {
    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error('Lua client not initialized');

    const enable = args.enable !== false; // default true
    const applied = await luaClient.setFullCombatState(enable);

    const lines: string[] = [
      `=== Full Combat State ${enable ? 'ENABLED' : 'DISABLED'} ===`,
      '',
      `Buff mode: ${applied?.buff_mode ?? '?'}`,
      `Flasks toggled: ${applied?.flasks_toggled?.length ? applied.flasks_toggled.join(', ') : 'none'}`,
      `Charge usage flags set: ${applied?.charges_set ?? 0}`,
      `Combat conditions set: ${applied?.conditions_set ?? 0}`,
      `Buffs set: ${applied?.buffs_set ?? 0}`,
      '',
      enable
        ? 'Calc now treats all flasks active, all charges available, and combat-only buffs (Onslaught, Innervate, etc.) as active. Re-run lua_get_stats or lua_get_dps_breakdown to see GUI-equivalent DPS.'
        : 'Calc reset to passive state (no flasks active, no charges, no combat buffs).',
    ];

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  });
}

export async function handleLuaSimulateChange(context: LuaHandlerContext, args: {
  add_nodes?: number[];
  remove_nodes?: number[];
  use_full_dps?: boolean;
}) {
  return wrapHandler('simulate change', async () => {
    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error('Lua client not initialized');

    const diff = await luaClient.simulateChange({
      addNodes: args.add_nodes,
      removeNodes: args.remove_nodes,
      useFullDPS: args.use_full_dps,
    });

    if (!diff || Object.keys(diff).length === 0) {
      return { content: [{ type: 'text' as const, text: 'No change calculated — verify node IDs and current build state.' }] };
    }

    const fmt = (v: any) => v == null ? '-' : (typeof v === 'number' ? Math.round(v * 100) / 100 : String(v));
    const lines: string[] = ['=== Simulated Change ===', ''];
    const adds = args.add_nodes?.length ? `+${args.add_nodes.join(', +')}` : '';
    const rems = args.remove_nodes?.length ? `-${args.remove_nodes.join(', -')}` : '';
    if (adds || rems) lines.push(`Hypothetical: ${[adds, rems].filter(Boolean).join(', ')}`);
    lines.push('', '| Stat | Before | After | Δ |', '|------|--------|-------|----|');
    for (const [stat, vals] of Object.entries(diff)) {
      const v = vals as any;
      const deltaStr = v.delta != null ? (v.delta > 0 ? `+${fmt(v.delta)}` : fmt(v.delta)) : '-';
      lines.push(`| ${stat} | ${fmt(v.before)} | ${fmt(v.after)} | ${deltaStr} |`);
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  });
}

export async function handleLuaReloadBuild(context: LuaHandlerContext, buildName?: string) {
  return wrapHandler('reload build', async () => {
    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error('Lua client not initialized');

    let targetName: string = buildName ?? '';

    // If no name provided, get it from the currently loaded build
    if (!targetName) {
      const info = await luaClient.getBuildInfo();
      if (!info?.name) {
        throw new Error('No build is currently loaded and no build_name was provided. Use lua_load_build first.');
      }
      targetName = String(info.name);
    }

    const fileName = targetName.endsWith('.xml') ? targetName : `${targetName}.xml`;
    const buildPath = sanitizeBuildName(fileName, context.pobDirectory);
    const xml = await fs.readFile(buildPath, 'utf-8');
    const name = fileName.replace(/\.xml$/i, '');
    await luaClient.loadBuildXml(xml, name);

    return {
      content: [{ type: "text" as const, text: `✅ Build "${fileName}" reloaded from disk.` }],
    };
  });
}

export async function handleUpdateTreeDelta(context: LuaHandlerContext, addNodes?: string[], removeNodes?: string[]) {
  return wrapHandler('update tree delta', async () => {
    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error('Lua client not initialized');

    if (!addNodes?.length && !removeNodes?.length) {
      throw new Error('At least one of add_nodes or remove_nodes must be provided.');
    }

    const params: { addNodes?: number[]; removeNodes?: number[] } = {};
    if (addNodes?.length)    params.addNodes    = addNodes.map(Number);
    if (removeNodes?.length) params.removeNodes = removeNodes.map(Number);

    const result = await luaClient.updateTreeDelta(params);
    const tree = result?.tree;
    const autoPathedNodes = result?.autoPathedNodes;
    const skippedAsc = result?.skippedAscendancyNodes;

    const actualCount = Array.isArray(tree?.nodes) ? tree.nodes.length : '?';
    const addedCount  = addNodes?.length ?? 0;
    const removedCount = removeNodes?.length ?? 0;

    let text = `✅ Tree delta applied.\n`;
    if (addedCount)    text += `  Added: ${addedCount} node(s)\n`;
    if (removedCount)  text += `  Removed: ${removedCount} node(s)\n`;
    text += `  Total allocated: ${actualCount} nodes\n`;

    if (autoPathedNodes && autoPathedNodes.length > 0) {
      text += `\n🔗 Auto-pathed ${autoPathedNodes.length} intermediate node(s) to maintain connectivity.`;
    }

    if (skippedAsc && skippedAsc.length > 0) {
      text += `\n🔴 BLOCKED: ${skippedAsc.length} ascendancy node(s) skipped — would exceed 8-point ascendancy cap (IDs: ${skippedAsc.join(', ')}).`;
    }

    if (addedCount > 0 && !autoPathedNodes?.length && !skippedAsc?.length) {
      text += `\n⚠️  If total count is lower than expected, some nodes may have been dropped (not connected or invalid IDs).`;
    }

    const ascUsed = tree?.ascendancyPointsUsed ?? 0;
    if (ascUsed > 8) {
      text += `\n🔴 ERROR: ${ascUsed} ascendancy points used (max 8). Remove ${ascUsed - 8} ascendancy node(s).`;
    }

    return {
      content: [{ type: "text" as const, text }],
    };
  });
}

export async function handleSearchTreeNodes(
  context: LuaHandlerContext,
  keyword: string,
  nodeType?: string,
  maxResults?: number,
  includeAllocated?: boolean
) {
  return wrapHandler('search tree nodes', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (!keyword || String(keyword).trim().length === 0) {
      throw new Error(`keyword/query cannot be empty (received: ${JSON.stringify(keyword)})`);
    }

    // Limit results to prevent large responses
    const effectiveMaxResults = Math.min(maxResults || 20, 30); // Default 20, max 30

    const results = await luaClient.searchNodes({
      keyword: keyword.trim(),
      nodeType,
      maxResults: effectiveMaxResults,
      includeAllocated,
    });

    const textLines: string[] = ['=== Passive Tree Node Search ===', ''];
    textLines.push(`Searching for: "${keyword}"`);
    if (nodeType) {
      textLines.push(`Node type filter: ${nodeType}`);
    }
    textLines.push('');

    if (!results.nodes || results.nodes.length === 0) {
      textLines.push('No matching nodes found.', '');
      textLines.push('Tips:');
      textLines.push('- Try a shorter or more general keyword');
      textLines.push('- Check spelling');
      textLines.push('- Remove the node type filter to see more results');
    } else {
      let countLine = `Found ${results.count} matching node${results.count === 1 ? '' : 's'}`;
      if (results.count >= effectiveMaxResults) {
        countLine += ` (showing top ${effectiveMaxResults})`;
      }
      countLine += ':';
      textLines.push(countLine, '');

      for (const node of results.nodes) {
        const allocatedTag = node.allocated ? " [ALLOCATED]" : "";
        const typeTag = node.type !== 'normal' ? ` [${node.type.toUpperCase()}]` : "";

        textLines.push(`**${node.name}**${typeTag}${allocatedTag}`);
        textLines.push(`  Node ID: ${node.id}`);

        if (node.ascendancyName) {
          textLines.push(`  Ascendancy: ${node.ascendancyName}`);
        }

        if (node.stats && node.stats.length > 0) {
          // Limit to first 3 stats to reduce response size
          const statsToShow = node.stats.slice(0, 3);
          textLines.push('  Stats:');
          for (const stat of statsToShow) {
            textLines.push(`    - ${stat}`);
          }
          if (node.stats.length > 3) {
            textLines.push(`    - ... and ${node.stats.length - 3} more`);
          }
        }

        textLines.push('');
      }
    }
    const text = textLines.join('\n');

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleCreateSpec(context: LuaHandlerContext, title?: string, copyFrom?: number, activate?: boolean) {
  return wrapHandler('create spec', async () => {
    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error('Lua client not initialized');
    const params: { title?: string; copyFrom?: number; activate?: boolean } = {};
    if (title != null) params.title = title;
    if (copyFrom != null) params.copyFrom = copyFrom;
    if (activate != null) params.activate = activate;
    const result = await luaClient.createSpec(params);
    if (!result?.specs?.length) {
      return { content: [{ type: "text" as const, text: "Failed to create spec." }] };
    }
    const newSpec = result.specs[result.specs.length - 1];
    let text = `✅ Created new spec [${newSpec.index}] "${newSpec.title}" (${newSpec.className}/${newSpec.ascendClassName}, ${newSpec.nodeCount} nodes).`;
    if (newSpec.active) text += '\nThis spec is now active.';
    text += `\n\nTotal specs: ${result.specs.length}. Use list_specs to see all, select_spec to switch.`;
    return { content: [{ type: "text" as const, text }] };
  });
}

export async function handleListSpecs(context: LuaHandlerContext) {
  return wrapHandler('list specs', async () => {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua client not initialized');
  const result = await luaClient.listSpecs();
  if (!result?.specs?.length) {
    return { content: [{ type: "text" as const, text: `No specs found. Load a build first.` }] };
  }
  const textLines: string[] = [`=== Passive Tree Specs (${result.specs.length} total) ===`, ''];
  for (const s of result.specs) {
    textLines.push(`${s.active ? '▶' : ' '} [${s.index}] ${s.title}`);
    textLines.push(`      Class: ${s.className || 'Unknown'} / ${s.ascendClassName || 'None'}`);
    textLines.push(`      Nodes: ${s.nodeCount}  |  Tree: ${s.treeVersion || 'Unknown'}`);
  }
  textLines.push(`\nActive: Spec ${result.activeSpec}. Use select_spec to switch.`);
  const text = textLines.join('\n');
  return { content: [{ type: "text" as const, text }] };
  });
}

export async function handleSelectSpec(context: LuaHandlerContext, index: number) {
  return wrapHandler('select spec', async () => {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua client not initialized');
  const result = await luaClient.selectSpec(index);
  const active = result?.specs?.find((s: any) => s.active);
  let text = `✅ Switched to Spec ${index}`;
  if (active) text += ` — ${active.title} (${active.className}/${active.ascendClassName}, ${active.nodeCount} nodes)`;
  text += `.\n\nStats have been recalculated for this spec.`;
  return { content: [{ type: "text" as const, text }] };
  });
}

export async function handleDeleteSpec(context: LuaHandlerContext, index: number) {
  return wrapHandler('delete spec', async () => {
    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error('Lua client not initialized');
    const result = await luaClient.deleteSpec(index);
    if (!result?.specs?.length) {
      return { content: [{ type: "text" as const, text: "Failed to delete spec." }] };
    }
    let text = `✅ Deleted spec ${index}. ${result.specs.length} spec(s) remaining.`;
    text += `\n\nActive: Spec ${result.activeSpec}. Use list_specs to see all.`;
    return { content: [{ type: "text" as const, text }] };
  });
}

export async function handleRenameSpec(context: LuaHandlerContext, index: number, title: string) {
  return wrapHandler('rename spec', async () => {
    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error('Lua client not initialized');
    const result = await luaClient.renameSpec(index, title);
    if (!result?.specs?.length) {
      return { content: [{ type: "text" as const, text: "Failed to rename spec." }] };
    }
    const renamed = result.specs.find((s: any) => s.index === index);
    let text = `✅ Spec ${index} renamed to "${renamed?.title ?? title}".`;
    return { content: [{ type: "text" as const, text }] };
  });
}

export async function handleListItemSets(context: LuaHandlerContext) {
  return wrapHandler('list item sets', async () => {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua client not initialized');
  const result = await luaClient.listItemSets();
  if (!result?.itemSets?.length) {
    return { content: [{ type: "text" as const, text: "No item sets found. Load a build first." }] };
  }
  const textLines: string[] = [`=== Item Sets (${result.itemSets.length} total) ===`, ''];
  for (const s of result.itemSets) {
    let line = `${s.active ? '▶' : ' '} [${s.id}] ${s.title}`;
    if (s.useSecondWeaponSet) line += ` (swap weapon set)`;
    textLines.push(line);
  }
  textLines.push(`\nActive: Item Set ${result.activeItemSetId}. Use select_item_set to switch.`);
  const text = textLines.join('\n');
  return { content: [{ type: "text" as const, text }] };
  });
}

export async function handleSelectItemSet(context: LuaHandlerContext, id: number) {
  return wrapHandler('select item set', async () => {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua client not initialized');
  const result = await luaClient.selectItemSet(id);
  const active = result?.itemSets?.find((s: any) => s.active);
  let text = `✅ Switched to Item Set ${id}`;
  if (active) text += ` — ${active.title}`;
  text += `.\n\nStats have been recalculated for this item set.`;
  return { content: [{ type: "text" as const, text }] };
  });
}
