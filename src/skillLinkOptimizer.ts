/**
 * Skill Link Optimization and Analysis
 *
 * Analyzes skill gem setups and suggests improvements for optimal damage/utility.
 */

export interface SkillGem {
  name: string;
  level?: number;
  quality?: number;
  qualityType?: string;
  enabled?: boolean;
}

export interface SkillGroup {
  index: number;
  label?: string;
  slot?: string;
  enabled: boolean;
  isMainSkill: boolean;
  gems: SkillGem[];
  includeInFullDPS?: boolean;
}

export interface SkillLinkIssue {
  type: 'missing_link' | 'suboptimal_gem' | 'low_level' | 'no_quality' | 'link_order' | 'wrong_support' | 'no_more_multiplier' | 'no_penetration';
  severity: 'high' | 'medium' | 'low';
  message: string;
  suggestion: string;
}

export interface SkillGroupAnalysis {
  group: SkillGroup;
  isValid: boolean;
  linkCount: number;
  moreMultiplierCount: number;
  hasPenetration: boolean;
  issues: SkillLinkIssue[];
  suggestions: string[];
  expectedDamageBoost?: string;
}

export interface SkillOptimizationResult {
  summary: string;
  buildType: string;
  groupAnalyses: SkillGroupAnalysis[];
  generalSuggestions: string[];
}

/**
 * Common PoE2 support gem recommendations by skill type.
 * PoE2 supports work via the support panel — each support is unique across the build
 * (can only be used on one active skill at a time). Damage scaling is per-support.
 */
// PoE2 0.5 supports verified present in the upstream PoB2 fork (post v0.16.0 / 0.5 patch).
// 0.5 consolidated the support catalog from ~547 entries down to ~283. Several 0.4-era
// names were removed (Inspiration, Martial Tempo, Scattershot, Lightning/Fire/Cold Infusion)
// or renamed (Persistence → Persistent Ground, Primal Armament → Primal Strikes).
// Tiered supports (I/II/III) resolve via add_gem's tier-fallback to the highest tier.
const SUPPORT_RECOMMENDATIONS: Record<string, string[]> = {
  'physical-attack': [
    'Heft',                  // verified +10% on Plant man Group 2 (still in 0.5)
    'Brutality',             // tiered — auto-resolves to III
    'Close Combat',          // more dmg to nearby
    'Ambush',                // more dmg on first hits
    'Bonebreaker',           // armour-break support
    'Primal Strikes',        // 0.5 — replaces former "Primal Armament"
  ],
  'elemental-attack': [
    'Conduction',            // shock-enable support
    'Glaciation',             // chill / cold exposure
    'Ignition',              // ignite / fire exposure
    'Cold Penetration',
    'Fire Penetration',
    'Lightning Penetration',
    'Ice-Tipped Arrows',     // 0.5 — cold conversion for bow/spear projectiles (used in Twister builds)
  ],
  'spell': [
    'Concentrated Area',     // verified +30.5% on Plant man — top spell DPS support
    'Magnified Area',        // larger AoE (PoE2 calls it Area, not Effect)
    'Spell Cascade',         // additional cast locations
    'Spell Echo',            // repeat cast
    'Hourglass',             // faster cast
  ],
  'dot': [
    'Withering Touch',       // chaos amp (verified -25% on Plant man — watch for build conflicts)
    'Persistent Ground',     // 0.5 — replaces former "Persistence"; longer ground-DoT duration
    'Glaciation',
    'Brutality',
  ],
  'minion': [
    // PoE2 minions scale through Spirit reservation + gem level primarily.
    'Heft',
    'Brutality',
    'Premeditation',
  ],
  'projectile': [
    'Fork',                  // verified in user builds
    'Chain',                 // tiered I/II/III
    'Pierce',                // tiered
    'Longshot',              // more dmg at range
    'Ambush',                // bonus first-hit damage
    'Ice-Tipped Arrows',     // 0.5 cold-conversion projectile support
  ],
  'crit': [
    'Premeditation',         // verified — more crit chance
    'Blazing Critical',      // crit-themed support
  ],
  'aura': [
    'Heft',
    'Concentrated Area',
  ],
};

/**
 * PoE2 support gems that provide multiplicative ("more") damage bonuses.
 * These are the strongest DPS-per-slot supports — a well-built skill setup should
 * have 2-3 of these in its support panel.
 */
const MORE_MULTIPLIER_GEMS = new Set([
  'heft',
  'brutality',
  'concentrated effect',
  'inspiration',
  'magnified effect',
  'martial tempo',
  'close combat',
  'longshot',
  'ambush',
  'persistent ground',
  'lethal skill',
  'premeditation',
  'fire infusion',
  'cold infusion',
  'lightning infusion',
  'withering touch',
  'primal strikes',
  'minion damage',
]);

/**
 * PoE2 support gems that reduce enemy resistances or provide elemental penetration.
 * Penetration is critical against PoE2 pinnacle bosses with overcapped resistances.
 */
const PENETRATION_GEMS = new Set([
  'fire penetration',
  'cold penetration',
  'lightning penetration',
  'elemental penetration',
  'fire exposure',
  'cold exposure',
  'lightning exposure',
  'conduction',          // shock applies lightning exposure
  'glaciation',          // chill/freeze applies cold exposure
  'ignition',            // ignite applies fire exposure
  'lightning mastery',
]);

/**
 * PoE2 supports primarily useful for clear speed (AoE / projectile proliferation).
 */
const CLEAR_SPEED_GEMS = new Set([
  'scattershot',
  'chain',
  'fork',
  'pierce',
  'magnified effect',
  'spell cascade',
  'far shot',          // ranger keystone, not support — included for archetype detection
]);

/**
 * PoE2 supports primarily useful for single-target / bossing DPS.
 */
const BOSSING_GEMS = new Set([
  'concentrated effect',
  'heft',
  'brutality',
  'inspiration',
  'premeditation',
  'lethal skill',
  'persistent ground',
  'ambush',
  'longshot',
]);

/**
 * Detect skill type from gem name
 */
function detectSkillType(gemName: string): string[] {
  const name = gemName.toLowerCase();
  const types: string[] = [];

  // Active skill indicators
  if (name.includes('strike') || name.includes('slam') || name.includes('smite')) {
    types.push('attack', 'melee');
  }
  if (name.includes('shot') || name.includes('arrow') || name.includes('barrage')) {
    types.push('attack', 'projectile', 'bow');
  }
  if (name.includes('spectral') || name.includes('ethereal')) {
    types.push('attack', 'projectile');
  }
  if (name.includes('blade') && !name.includes('vortex')) {
    types.push('spell', 'projectile');
  }
  if (name.includes('arc') || name.includes('ball') || name.includes('nova')) {
    types.push('spell');
  }
  if (name.includes('aura') || name.includes('purity') || name.includes('grace')) {
    types.push('aura');
  }
  if (name.includes('curse') || name.includes('mark') || name.includes('hex')) {
    types.push('curse');
  }
  if (name.includes('golem') || name.includes('zombie') || name.includes('spectre')) {
    types.push('minion');
  }
  if (name.includes('totem')) {
    types.push('totem');
  }
  if (name.includes('trap') || name.includes('mine')) {
    types.push('trap-mine');
  }

  // Damage type
  if (name.includes('fire') || name.includes('flame') || name.includes('burn')) {
    types.push('fire');
  }
  if (name.includes('cold') || name.includes('ice') || name.includes('frost')) {
    types.push('cold');
  }
  if (name.includes('lightning') || name.includes('shock')) {
    types.push('lightning');
  }
  if (name.includes('chaos') || name.includes('poison') || name.includes('venom')) {
    types.push('chaos');
  }
  if (name.includes('physical')) {
    types.push('physical');
  }

  // Special mechanics
  if (name.includes('crit')) {
    types.push('crit');
  }
  if (name.includes('bleed') || name.includes('poison') || name.includes('ignite')) {
    types.push('dot');
  }

  return types;
}

/**
 * Check if a gem is a support gem
 */
function isSupportGem(gemName: string): boolean {
  return gemName.toLowerCase().includes('support');
}

/**
 * Analyze a single skill group
 */
function analyzeSkillGroup(
  group: SkillGroup,
  buildArchetype: string
): SkillGroupAnalysis {
  const analysis: SkillGroupAnalysis = {
    group,
    isValid: true,
    linkCount: group.gems.length,
    moreMultiplierCount: 0,
    hasPenetration: false,
    issues: [],
    suggestions: [],
  };

  if (group.gems.length === 0) {
    analysis.isValid = false;
    analysis.issues.push({
      type: 'missing_link',
      severity: 'high',
      message: 'Socket group is empty',
      suggestion: 'Add skill gems to this socket group',
    });
    return analysis;
  }

  // Find the active skill (first non-support gem)
  const activeSkill = group.gems.find((g) => !isSupportGem(g.name));
  if (!activeSkill) {
    analysis.isValid = false;
    analysis.issues.push({
      type: 'wrong_support',
      severity: 'high',
      message: 'No active skill gem found - only support gems',
      suggestion: 'Add an active skill gem to this socket group',
    });
    return analysis;
  }

  const activeSkillName = activeSkill.name;
  const skillTypes = detectSkillType(activeSkillName);
  const supports = group.gems.filter((g) => isSupportGem(g.name));
  const supportNames = supports.map((s) => s.name.toLowerCase());

  // Count "more" multiplier supports
  const moreMultiplierCount = supports.filter((s) => MORE_MULTIPLIER_GEMS.has(s.name.toLowerCase())).length;
  analysis.moreMultiplierCount = moreMultiplierCount;

  // Detect penetration
  const hasPenetration = supports.some((s) => PENETRATION_GEMS.has(s.name.toLowerCase()));
  analysis.hasPenetration = hasPenetration;

  // Detect clear speed vs bossing balance
  const hasClearGem = supports.some((s) => CLEAR_SPEED_GEMS.has(s.name.toLowerCase()));
  const hasBossingGem = supports.some((s) => BOSSING_GEMS.has(s.name.toLowerCase()));

  // Flag missing "more" multipliers on main skill — this is the #1 DPS lever in PoE
  if (group.isMainSkill && supports.length >= 2 && moreMultiplierCount === 0) {
    analysis.issues.push({
      type: 'no_more_multiplier',
      severity: 'high',
      message: 'No "more" damage multiplier supports on main skill',
      suggestion:
        'Add at least 1–2 "more" multipliers from PoE2 0.5 supports: Heft, Brutality, Concentrated Area, Magnified Area, Premeditation, Persistent Ground, Primal Strikes, etc.',
    });
  } else if (group.isMainSkill && analysis.linkCount >= 5 && moreMultiplierCount < 2) {
    analysis.issues.push({
      type: 'no_more_multiplier',
      severity: 'medium',
      message: `Only ${moreMultiplierCount} "more" multiplier support on a ${analysis.linkCount}-link`,
      suggestion:
        `A ${analysis.linkCount}-link can support 2–3 "more" multiplier supports. Each one multiplicatively scales total damage.`,
    });
  }

  // Flag no penetration for elemental builds (critical vs endgame bosses with 40%+ resists)
  const isElemental = skillTypes.some((t) => ['fire', 'cold', 'lightning'].includes(t));
  if (group.isMainSkill && isElemental && !hasPenetration && supports.length >= 3) {
    analysis.issues.push({
      type: 'no_penetration',
      severity: 'medium',
      message: 'No penetration support on elemental main skill',
      suggestion:
        'Fire/Cold/Lightning Penetration Support is a large effective DPS gain against bosses with 40%+ resists. Combustion Support also reduces enemy fire resistance.',
    });
  }

  // Check link count
  if (group.isMainSkill && analysis.linkCount < 6) {
    analysis.issues.push({
      type: 'missing_link',
      severity: analysis.linkCount < 4 ? 'high' : 'medium',
      message: `Main skill only has ${analysis.linkCount} links (optimal is 6)`,
      suggestion: 'Upgrade to a 6-link for maximum damage',
    });
  }

  // Check gem levels
  for (const gem of group.gems) {
    const level = gem.level || 1;
    // PoE2 doesn't have Empower/Enlighten/Enhance equivalents — level 20 is the
    // de-facto cap for most gems and players upgrade via gem quality / cutting.
    if (level < 20) {
      analysis.issues.push({
        type: 'low_level',
        severity: level < 15 ? 'medium' : 'low',
        message: `${gem.name} is only level ${level}`,
        suggestion: `Level ${gem.name} to 20 for maximum effect`,
      });
    }
  }

  // Check gem quality
  for (const gem of group.gems) {
    const quality = gem.quality || 0;
    if (quality < 20 && group.isMainSkill) {
      analysis.issues.push({
        type: 'no_quality',
        severity: 'low',
        message: `${gem.name} has ${quality}% quality`,
        suggestion: `Use Gemcutter's Prisms to get 20% quality`,
      });
    }
  }

  // Suggest support gems based on skill type
  // (supportNames is already defined above)

  if (skillTypes.includes('attack')) {
    if (!supportNames.some((s) => s.includes('multistrike') || s.includes('faster attacks'))) {
      analysis.suggestions.push('Consider Primal Strikes (more attack damage) or a tiered speed support for PoE2 0.5 attack builds');
    }
  }

  if (skillTypes.includes('spell')) {
    if (!supportNames.some((s) => s.includes('spell echo') || s.includes('faster casting'))) {
      analysis.suggestions.push('Consider Hourglass (faster cast) or Concentrated Area (more damage) for PoE2 0.5 spell builds');
    }
  }

  if (skillTypes.includes('projectile')) {
    if (!supportNames.some((s) => s.includes('gmp') || s.includes('volley') || s.includes('chain'))) {
      analysis.suggestions.push('Consider GMP, Volley, or Chain Support for clear speed');
    }
  }

  if (skillTypes.includes('crit')) {
    if (!supportNames.some((s) => s.includes('critical'))) {
      analysis.suggestions.push('Consider Increased Critical Strikes/Damage Support');
    }
  }

  if (skillTypes.includes('dot')) {
    if (!supportNames.some((s) => s.includes('efficacy') || s.includes('swift affliction'))) {
      analysis.suggestions.push('Consider Persistent Ground (longer ground-DoT duration) or Magnified Area for PoE2 0.5 DoT builds');
    }
  }

  if (skillTypes.includes('minion')) {
    if (!supportNames.some((s) => s.includes('minion damage'))) {
      analysis.suggestions.push('Add Minion Damage Support for significant DPS increase');
    }
  }

  // Check for common anti-synergies
  const hasElementalFocus = supportNames.some((s) => s.includes('elemental focus'));
  const hasAilmentSupport = supportNames.some((s) =>
    s.includes('ignite') || s.includes('freeze') || s.includes('shock') || s.includes('chill')
  );

  if (hasElementalFocus && hasAilmentSupport) {
    analysis.issues.push({
      type: 'wrong_support',
      severity: 'high',
      message: 'PoE2: some elemental damage supports suppress ailments — verify Conduction/Glaciation/Ignition pairings if you rely on shock/freeze/ignite for damage',
      suggestion: 'Choose between dedicated hit-damage supports (Concentrated Area, Magnified Area) OR ailment supports (Conduction, Glaciation, Ignition, Persistent Ground) — they have different scaling profiles',
    });
  }

  // Clear speed vs bossing balance note (for main 6-link only)
  if (group.isMainSkill && analysis.linkCount >= 5) {
    if (hasClearGem && !hasBossingGem) {
      analysis.suggestions.push(
        'Setup is optimised for clear speed. For bossing swap a clear support (Chain/Fork) for Concentrated Area or a "more" multiplier.'
      );
    } else if (!hasClearGem && !hasBossingGem) {
      analysis.suggestions.push(
        'PoE2 0.5 clear speed: Chain/Fork/Pierce for projectiles, Spell Cascade/Magnified Area for spells. Bossing: Concentrated Area, Heft, Premeditation.'
      );
    }
  }

  return analysis;
}

/**
 * Analyze all skill groups
 */
export function analyzeSkillSetup(
  groups: SkillGroup[],
  buildArchetype: string
): SkillOptimizationResult {
  const groupAnalyses: SkillGroupAnalysis[] = [];
  const generalSuggestions: string[] = [];

  for (const group of groups) {
    if (group.gems.length === 0 && !group.isMainSkill) {
      continue; // Skip empty non-main groups
    }
    const analysis = analyzeSkillGroup(group, buildArchetype);
    groupAnalyses.push(analysis);
  }

  // General suggestions
  const mainSkill = groupAnalyses.find((g) => g.group.isMainSkill);
  if (!mainSkill) {
    generalSuggestions.push('⚠️ No main skill selected - set a main skill for accurate DPS calculations');
  } else {
    if (mainSkill.linkCount < 6) {
      generalSuggestions.push(
        `Main skill has ${mainSkill.linkCount} links — upgrade to 6-link for maximum damage output`
      );
    }
    if (mainSkill.moreMultiplierCount < 2) {
      generalSuggestions.push(
        `Main skill has only ${mainSkill.moreMultiplierCount} "more" multiplier support(s). ` +
        `PoE2 0.5 "more" multiplier supports (Heft, Brutality, Concentrated Area, Magnified Area, etc.) are multiplicative — ` +
        `a second "more" multiplier at ×1.4 added to an existing ×1.4 gives ×1.96 total, which is far stronger than any "increased" node.`
      );
    }
    if (!mainSkill.hasPenetration) {
      generalSuggestions.push(
        `Main skill has no penetration support. Against endgame bosses (40% resists), ` +
        `penetration typically accounts for a 20–35% effective DPS increase.`
      );
    }
  }

  // Check for auras
  const hasAuras = groups.some((g) =>
    g.gems.some((gem) => {
      const types = detectSkillType(gem.name);
      return types.includes('aura');
    })
  );
  if (!hasAuras && !buildArchetype.includes('minion')) {
    generalSuggestions.push('Consider adding auras for permanent buffs (e.g., Determination, Grace, Precision)');
  }

  const totalIssues = groupAnalyses.reduce((sum, g) => sum + g.issues.length, 0);

  return {
    summary: `Analyzed ${groupAnalyses.length} skill groups with ${totalIssues} issue${
      totalIssues !== 1 ? 's' : ''
    }`,
    buildType: buildArchetype,
    groupAnalyses,
    generalSuggestions,
  };
}

/**
 * Format skill optimization results
 */
export function formatSkillOptimization(result: SkillOptimizationResult): string {
  let output = '=== Skill Link Optimization ===\n\n';

  output += `Build Type: ${result.buildType}\n`;
  output += `${result.summary}\n\n`;

  // General suggestions
  if (result.generalSuggestions.length > 0) {
    output += '=== General Recommendations ===\n';
    for (const suggestion of result.generalSuggestions) {
      output += `${suggestion}\n`;
    }
    output += '\n';
  }

  // Analyze each group
  for (const analysis of result.groupAnalyses) {
    const group = analysis.group;
    output += `**Group ${group.index}${group.isMainSkill ? ' (MAIN)' : ''}**\n`;
    if (group.label) {
      output += `  Label: ${group.label}\n`;
    }
    output += `  Links: ${analysis.linkCount}\n`;
    if (group.isMainSkill) {
      output += `  "More" multipliers: ${analysis.moreMultiplierCount} | Penetration: ${analysis.hasPenetration ? 'yes' : 'no'}\n`;
    }
    output += `  Gems: ${group.gems.map((g) => g.name).join(', ')}\n`;

    if (analysis.issues.length > 0) {
      output += `  Issues:\n`;
      for (const issue of analysis.issues) {
        const icon = issue.severity === 'high' ? '⚠️' : issue.severity === 'medium' ? '⚡' : 'ℹ️';
        output += `    ${icon} ${issue.message}\n`;
        output += `       → ${issue.suggestion}\n`;
      }
    }

    if (analysis.suggestions.length > 0) {
      output += `  Suggestions:\n`;
      for (const suggestion of analysis.suggestions) {
        output += `    → ${suggestion}\n`;
      }
    }

    output += '\n';
  }

  return output;
}
