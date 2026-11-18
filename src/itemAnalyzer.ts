/**
 * Item Analysis and Upgrade Recommendations
 *
 * Analyzes equipped items and suggests upgrades based on build goals.
 * Works with both XML builds and Lua bridge for more accurate analysis.
 */

export interface ItemSlotAnalysis {
  slot: string;
  currentItem: {
    name: string;
    baseName?: string;
    rarity?: string;
    itemLevel?: number;
  } | null;
  issues: string[];
  suggestions: string[];
  priority: 'high' | 'medium' | 'low';
}

export interface ItemUpgradeRecommendation {
  summary: string;
  buildType: string;
  totalIssues: number;
  slotAnalysis: ItemSlotAnalysis[];
  generalSuggestions: string[];
}

export interface BuildStats {
  life?: number;
  energyShield?: number;
  evasion?: number;
  armour?: number;
  dps?: number;
  fireRes?: number;
  coldRes?: number;
  lightningRes?: number;
  chaosRes?: number;
  [key: string]: number | undefined;
}

/**
 * Analyze build archetype from class and stats
 */
export function inferBuildArchetype(
  className?: string,
  ascendClassName?: string,
  stats?: BuildStats
): string {
  if (!className) return 'unknown';

  // PoE2 has lower absolute Life pools than PoE1 — endgame Life is often 1500-3000
  // with ES doing the heavy lifting. Adjust thresholds accordingly.
  const hasES = (stats?.energyShield || 0) > 300;
  const hasLife = (stats?.life || 0) > 1200;
  const isLowLife = hasLife && (stats?.life || 0) < 1500 && hasES;

  const evasion = stats?.evasion || 0;
  const armour = stats?.armour || 0;
  let defenseType = '';
  if (evasion > armour * 1.5) defenseType = 'evasion';
  else if (armour > evasion * 1.5) defenseType = 'armour';
  else if (evasion > 800 && armour > 800) defenseType = 'hybrid';

  const ascend = ascendClassName?.toLowerCase() || '';
  const cls = className.toLowerCase();

  // PoE2 ascendancy → archetype mapping
  // Witch: Infernalist (fire/minion), Blood Mage (spell/sacrifice), Lich (dot/curse), Abyssal Lich (chaos/dot)
  if (ascend.includes('infernalist'))    return 'minion-fire-spell';
  if (ascend.includes('blood mage'))     return 'spell-sacrifice';
  if (ascend.includes('lich') || ascend.includes('abyssal lich')) return 'chaos-dot-spell';
  // Sorceress: Stormweaver (lightning crit), Chronomancer (time/cooldown)
  if (ascend.includes('stormweaver'))    return 'crit-spell';
  if (ascend.includes('chronomancer'))   return 'cooldown-spell';
  // Ranger: Deadeye (projectile attack), Pathfinder (flask/poison)
  if (ascend.includes('deadeye'))        return 'projectile-attack';
  if (ascend.includes('pathfinder'))     return 'flask-poison-attack';
  // Warrior: Titan (slam armour), Warbringer (warcry stun), Smith of Kitava (weapon crafting tank)
  if (ascend.includes('titan'))          return 'slam-armour-tank';
  if (ascend.includes('warbringer'))     return 'warcry-stun-tank';
  if (ascend.includes('smith'))          return 'weapon-tank';
  // Mercenary: Witchhunter (crossbow chaos), Gemling Legionnaire (gem stacking), Tactician (party/grenade)
  if (ascend.includes('witchhunter'))    return 'crossbow-chaos-attack';
  if (ascend.includes('gemling'))        return 'gem-stack-attack';
  if (ascend.includes('tactician'))      return 'party-grenade-attack';
  // Monk: Invoker (elemental ele-bell), Acolyte of Chayula (chaos darkness)
  if (ascend.includes('invoker'))        return 'elemental-monk-attack';
  if (ascend.includes('acolyte'))        return 'chaos-monk-darkness';
  // Druid: Oracle (spell/totem), Shaman (storm/totem)
  if (ascend.includes('oracle'))         return 'spell-totem-druid';
  if (ascend.includes('shaman'))         return 'storm-totem-druid';
  // Huntress: Amazon (spear/javelin), Ritualist (spear/dot)
  if (ascend.includes('amazon'))         return 'spear-attack';
  if (ascend.includes('ritualist'))      return 'spear-dot-attack';
  // PoE1 ascendancy fallthroughs (when POE2_MODE=false)
  if (ascend.includes('necro'))          return 'minion';
  if (ascend.includes('occultist') && hasES) return 'chaos-dot-es';
  if (ascend.includes('assassin'))       return 'crit-attack';
  if (ascend.includes('berserker') || ascend.includes('juggernaut')) return 'melee-tank';
  if (ascend.includes('raider'))         return 'bow-attack';
  if (ascend.includes('chieftain'))      return 'fire-attack';
  if (ascend.includes('elementalist'))   return 'elemental-spell';

  // Class fallback (no ascendancy yet)
  if (cls === 'witch' || cls === 'sorceress') return 'spell';
  if (cls === 'ranger' || cls === 'huntress') return 'projectile-attack';
  if (cls === 'warrior') return 'melee-tank';
  if (cls === 'mercenary') return 'attack';
  if (cls === 'monk') return 'monk-attack';
  if (cls === 'druid') return 'spell-totem-druid';

  if (hasES && !hasLife) return 'ci-es';
  if (isLowLife) return 'lowlife-es';
  if (defenseType) return `${defenseType}-based`;

  return cls;
}

/**
 * Analyze a single item slot
 */
function analyzeItemSlot(
  slot: string,
  item: { name: string; baseName?: string; rarity?: string } | null,
  buildArchetype: string,
  stats: BuildStats
): ItemSlotAnalysis {
  const analysis: ItemSlotAnalysis = {
    slot,
    currentItem: item,
    issues: [],
    suggestions: [],
    priority: 'low',
  };

  if (!item || !item.name || item.name === '(empty)') {
    analysis.issues.push('Slot is empty');
    analysis.priority = 'high';
    analysis.suggestions.push(`Equip a ${slot.toLowerCase()} to gain defensive stats and offensive bonuses`);
    return analysis;
  }

  const itemName = item.name.toLowerCase();
  const rarity = item.rarity?.toLowerCase() || '';

  // Weapon slots
  if (slot.includes('Weapon')) {
    if (buildArchetype.includes('spell') && !itemName.includes('sceptre') && !itemName.includes('wand') && !itemName.includes('staff') && !itemName.includes('focus')) {
      analysis.suggestions.push('Consider a spell-scaling weapon: Wand (cast speed/spell levels), Sceptre (extra damage as element), or Staff (high spell damage). Pair with a Focus or another Wand for double-spec.');
    }
    if (buildArchetype.includes('attack') && (itemName.includes('white') || rarity === 'normal')) {
      analysis.issues.push('Using a normal/white weapon significantly reduces damage');
      analysis.priority = 'high';
      analysis.suggestions.push('Upgrade to a rare weapon — for PoE2: Crossbow (mercenary), Bow/Spear (ranger/huntress), Quarterstaff (monk), Two-Handed Mace/Axe (warrior). Look for tier-prefixed bases (Advanced/Expert).');
    }
    if (buildArchetype.includes('crit') && !itemName.includes('staff') && !itemName.includes('wand') && !itemName.includes('crossbow')) {
      analysis.suggestions.push('For PoE2 crit scaling, look for high base crit chance items and weapons with +# to Critical Hit Chance affixes; Wands, Crossbows, and Staves are common crit bases.');
    }
  }

  // Body Armour (PoE2 thresholds — life pools are lower than PoE1)
  if (slot === 'Body Armour') {
    const lowLife = (stats.life || 0) < 1500;
    const lowES = (stats.energyShield || 0) < 800;

    if (buildArchetype.includes('es') && lowES) {
      analysis.issues.push('Energy shield is low for an ES-based build');
      analysis.priority = 'high';
      analysis.suggestions.push('Upgrade to a high ES body armour. PoE2 endgame ES chests roll 400-800+ base ES; combine with %ES affixes and rune slots.');
    }
    if (!buildArchetype.includes('es') && lowLife) {
      analysis.issues.push('Life is low for an endgame build');
      analysis.priority = 'high';
      analysis.suggestions.push('Look for body armour with +# maximum life affixes (typically T1-T2 rolls: 80-120 life). Also consider Spirit affixes if you reserve.');
    }
    if (!buildArchetype.includes('unique') && rarity === 'unique') {
      analysis.suggestions.push('Verify the unique synergizes with your build — PoE2 uniques typically come with strong trade-offs.');
    }
  }

  // Boots
  if (slot === 'Boots') {
    const lowMovementSpeed = true; // We can't detect this from current data easily
    analysis.suggestions.push('Ensure boots have 25-30% movement speed for mapping comfort');

    if (buildArchetype.includes('es') && (stats.energyShield || 0) < 1500) {
      analysis.suggestions.push('Look for boots with ES and relevant resistances');
    } else if ((stats.life || 0) < 4000) {
      analysis.suggestions.push('Look for boots with life and relevant resistances');
    }
  }

  // Helmet
  if (slot === 'Helmet') {
    if (buildArchetype.includes('es') && (stats.energyShield || 0) < 1500) {
      analysis.suggestions.push('Consider a helmet with 250+ ES');
    }
    if (buildArchetype.includes('minion')) {
      analysis.suggestions.push('Look for helmet with minion damage/life mods');
    }
  }

  // Rings and Amulet
  if (slot.includes('Ring') || slot === 'Amulet') {
    const lowRes = (stats.fireRes || 0) < 75 || (stats.coldRes || 0) < 75 || (stats.lightningRes || 0) < 75;

    if (lowRes) {
      analysis.issues.push('Resistances may not be capped');
      analysis.priority = 'medium';
      analysis.suggestions.push('Ensure jewelry provides resistances to cap at 75%');
    }

    if ((stats.life || 0) < 4000 && buildArchetype.includes('life')) {
      analysis.suggestions.push('Look for life rolls on jewelry');
    }
  }

  // Belt
  if (slot === 'Belt') {
    if ((stats.life || 0) < 1500 && !buildArchetype.includes('es')) {
      analysis.suggestions.push('Belt is a major life slot in PoE2 — look for Utility Belt or Heavy Belt with +# maximum life prefix and +charm slots');
    }
    if (buildArchetype.includes('flask') || buildArchetype.includes('poison')) {
      analysis.suggestions.push('Look for +charm slots, charm effect duration, and charm charges affixes on belt');
    }
    if (buildArchetype.includes('spirit') || (stats as any).spirit > 100) {
      analysis.suggestions.push('Belt can roll +# to Spirit — significant for reservation-heavy builds');
    }
  }

  // Gloves
  if (slot === 'Gloves') {
    if (buildArchetype.includes('attack')) {
      analysis.suggestions.push('Ensure gloves have attack speed or accuracy mods');
    }
    if (buildArchetype.includes('spell')) {
      analysis.suggestions.push('Look for spell suppression or cast speed on gloves');
    }
  }

  // Flask slots
  if (slot.includes('Flask')) {
    if (!item.name || item.name.includes('empty')) {
      analysis.issues.push('Flask slot is empty');
      analysis.priority = 'medium';
      analysis.suggestions.push('Use utility flasks for damage/defense boosts');
    }
  }

  // Set priority based on issues
  if (analysis.issues.length > 0 && analysis.priority === 'low') {
    analysis.priority = 'medium';
  }

  return analysis;
}

/**
 * Check resistance caps
 */
function checkResistances(stats: BuildStats): {
  capped: boolean;
  missing: string[];
  recommendations: string[];
} {
  const result = {
    capped: true,
    missing: [] as string[],
    recommendations: [] as string[],
  };

  const fireRes = stats.fireRes || 0;
  const coldRes = stats.coldRes || 0;
  const lightningRes = stats.lightningRes || 0;
  const chaosRes = stats.chaosRes || 0;

  if (fireRes < 75) {
    result.capped = false;
    result.missing.push(`Fire Resistance: ${fireRes}% (need ${75 - fireRes}% more)`);
  }
  if (coldRes < 75) {
    result.capped = false;
    result.missing.push(`Cold Resistance: ${coldRes}% (need ${75 - coldRes}% more)`);
  }
  if (lightningRes < 75) {
    result.capped = false;
    result.missing.push(`Lightning Resistance: ${lightningRes}% (need ${75 - lightningRes}% more)`);
  }

  if (!result.capped) {
    result.recommendations.push('Priority: Cap elemental resistances at 75% for all content');
    result.recommendations.push('Craft resistances on gear using bench, or use resistance jewels');
  }

  if (chaosRes < 0) {
    result.recommendations.push(`Chaos Resistance is ${chaosRes}% - consider getting positive chaos res for some content`);
  }

  return result;
}

/**
 * Analyze all equipped items and provide recommendations
 */
export function analyzeEquippedItems(
  items: Array<{ slot: string; name?: string; baseName?: string; rarity?: string }>,
  className?: string,
  ascendClassName?: string,
  stats?: BuildStats
): ItemUpgradeRecommendation {
  const buildArchetype = inferBuildArchetype(className, ascendClassName, stats);
  const buildStats = stats || {};

  const slotAnalysis: ItemSlotAnalysis[] = [];

  // Standard gear slots to check
  const expectedSlots = [
    'Weapon 1',
    'Weapon 2',
    'Helmet',
    'Body Armour',
    'Gloves',
    'Boots',
    'Amulet',
    'Ring 1',
    'Ring 2',
    'Belt',
    'Flask 1',
    'Flask 2',
    'Charm 1',
    'Charm 2',
    'Charm 3',
  ];

  // Analyze each slot
  for (const expectedSlot of expectedSlots) {
    const item = items.find((i) => i.slot === expectedSlot);
    const itemData = item
      ? { name: item.name || '', baseName: item.baseName, rarity: item.rarity }
      : null;

    const analysis = analyzeItemSlot(expectedSlot, itemData, buildArchetype, buildStats);
    slotAnalysis.push(analysis);
  }

  // General suggestions
  const generalSuggestions: string[] = [];

  // Resistance check
  const resCheck = checkResistances(buildStats);
  if (!resCheck.capped) {
    generalSuggestions.push('⚠️ Elemental resistances are not capped!');
    generalSuggestions.push(...resCheck.missing);
    generalSuggestions.push(...resCheck.recommendations);
  }

  // Life/ES check
  const life = buildStats.life || 0;
  const es = buildStats.energyShield || 0;

  // PoE2 thresholds — Life pools cap around 1500-3000 for most builds, ES can carry the rest
  if (!buildArchetype.includes('es') && life < 1500) {
    generalSuggestions.push(`⚠️ Life pool is low (${life}) — aim for 1800+ for mapping, 2500+ for pinnacle bosses. Stack +max life affixes on every gear slot.`);
  }
  if (buildArchetype.includes('es') && es < 2500) {
    generalSuggestions.push(`⚠️ Energy Shield is low (${es}) — aim for 4000+ for ES-stacking caster builds. Focus body armour, helmet, and %ES affixes.`);
  }

  // DPS check (very rough)
  const dps = buildStats.dps || 0;
  if (dps > 0 && dps < 100000) {
    generalSuggestions.push('⚠️ DPS seems low - consider upgrading weapons or adding damage jewels');
  }

  const totalIssues = slotAnalysis.reduce((sum, s) => sum + s.issues.length, 0);

  return {
    summary: `Found ${totalIssues} issue${totalIssues !== 1 ? 's' : ''} across ${slotAnalysis.length} equipment slots`,
    buildType: buildArchetype,
    totalIssues,
    slotAnalysis,
    generalSuggestions,
  };
}

/**
 * Format item analysis for display
 */
export function formatItemAnalysis(analysis: ItemUpgradeRecommendation): string {
  let output = '=== Item Upgrade Analysis ===\n\n';

  output += `Build Type: ${analysis.buildType}\n`;
  output += `${analysis.summary}\n\n`;

  // General suggestions first
  if (analysis.generalSuggestions.length > 0) {
    output += '=== General Recommendations ===\n';
    for (const suggestion of analysis.generalSuggestions) {
      output += `${suggestion}\n`;
    }
    output += '\n';
  }

  // High priority issues
  const highPriority = analysis.slotAnalysis.filter((s) => s.priority === 'high');
  if (highPriority.length > 0) {
    output += '=== High Priority Upgrades ===\n';
    for (const slot of highPriority) {
      output += `\n**${slot.slot}**\n`;
      if (slot.currentItem?.name) {
        output += `  Current: ${slot.currentItem.name}\n`;
      } else {
        output += `  Current: (empty)\n`;
      }
      for (const issue of slot.issues) {
        output += `  ⚠️ ${issue}\n`;
      }
      for (const suggestion of slot.suggestions) {
        output += `  → ${suggestion}\n`;
      }
    }
    output += '\n';
  }

  // Medium priority
  const mediumPriority = analysis.slotAnalysis.filter((s) => s.priority === 'medium');
  if (mediumPriority.length > 0) {
    output += '=== Medium Priority Upgrades ===\n';
    for (const slot of mediumPriority) {
      output += `\n**${slot.slot}**\n`;
      if (slot.currentItem?.name) {
        output += `  Current: ${slot.currentItem.name}\n`;
      }
      for (const issue of slot.issues) {
        output += `  ⚠️ ${issue}\n`;
      }
      for (const suggestion of slot.suggestions) {
        output += `  → ${suggestion}\n`;
      }
    }
    output += '\n';
  }

  // Low priority suggestions (collapsed)
  const lowPriority = analysis.slotAnalysis.filter(
    (s) => s.priority === 'low' && s.suggestions.length > 0
  );
  if (lowPriority.length > 0) {
    output += '=== Optional Optimizations ===\n';
    for (const slot of lowPriority) {
      if (slot.suggestions.length > 0) {
        output += `${slot.slot}: ${slot.suggestions.join('; ')}\n`;
      }
    }
  }

  return output;
}
