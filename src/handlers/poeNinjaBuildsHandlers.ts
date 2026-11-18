/**
 * Handlers for poe.ninja PoE2 build/character endpoints.
 *
 * Wraps PoeNinjaBuildsClient and surfaces the results as MCP tool responses.
 */

import { PoeNinjaBuildsClient } from '../services/poeNinjaBuildsClient.js';

export interface PoeNinjaBuildsContext {
  buildsClient?: PoeNinjaBuildsClient;
}

/**
 * Fetch a single character's full build data (gear, gems, jewels, tree, stats,
 * PoB code) from poe.ninja. Accepts either a poe.ninja URL or explicit
 * (league, account, character) inputs.
 */
export async function handleFetchPoeNinjaCharacter(
  context: PoeNinjaBuildsContext,
  args: {
    url?: string;
    league?: string;       // slug like "runesofaldur"
    account?: string;
    character?: string;
    include_pob_code?: boolean;
  }
) {
  const client = context.buildsClient;
  if (!client) {
    throw new Error('poe.ninja builds client not initialized');
  }

  // Resolve inputs (URL takes priority over individual args)
  let league: string | undefined = args.league;
  let account: string | undefined = args.account;
  let character: string | undefined = args.character;

  if (args.url) {
    const parsed = PoeNinjaBuildsClient.parseCharacterUrl(args.url);
    league = parsed.leagueSlug ?? league;
    account = parsed.account;
    character = parsed.character;
  }

  if (!league || !account || !character) {
    throw new Error(
      'fetch_poe_ninja_character requires either `url` OR all of (`league`, `account`, `character`)'
    );
  }

  const full = await client.getCharacterFull(league, account, character);
  let pobCode: string | undefined;
  if (args.include_pob_code) {
    try {
      pobCode = await client.getPoBImport(league, account, character);
    } catch (err) {
      // Non-fatal — surface the character data even if PoB import fails.
      pobCode = undefined;
    }
  }

  const summary = formatCharacterSummary(full, pobCode);
  return {
    content: [
      { type: 'text', text: summary },
    ],
  };
}

function formatCharacterSummary(c: any, pobCode?: string): string {
  const ds = c.defensiveStats ?? {};
  const lines: string[] = [];

  lines.push(`=== ${c.name ?? '?'} (${c.account ?? '?'}) ===`);
  lines.push(`Class: ${c.class ?? '?'}    Level: ${c.level ?? '?'}    League: ${c.league ?? '?'}`);
  lines.push('');

  lines.push('--- Defensive ---');
  lines.push(
    `Life: ${ds.life ?? '?'}  Mana: ${ds.mana ?? '?'}  Spirit: ${ds.spirit ?? '?'}  ES: ${ds.energyShield ?? '?'}  Evasion: ${ds.evasionRating ?? '?'}  Armour: ${ds.armour ?? '?'}`
  );
  lines.push(
    `Resists: F${ds.fireResistance ?? '?'}%${ds.fireResistanceOverCap ? ` (+${ds.fireResistanceOverCap})` : ''} ` +
      `C${ds.coldResistance ?? '?'}%${ds.coldResistanceOverCap ? ` (+${ds.coldResistanceOverCap})` : ''} ` +
      `L${ds.lightningResistance ?? '?'}%${ds.lightningResistanceOverCap ? ` (+${ds.lightningResistanceOverCap})` : ''} ` +
      `Ch${ds.chaosResistance ?? '?'}%${ds.chaosResistanceOverCap ? ` (+${ds.chaosResistanceOverCap})` : ''}`
  );
  lines.push(`EHP: ${ds.effectiveHealthPool ?? '?'}    Movement: ${ds.movementSpeed ?? '?'}`);
  lines.push('');

  if (Array.isArray(c.items) && c.items.length) {
    lines.push('--- Equipped Items ---');
    for (const it of c.items) {
      const corrupt = it.corrupted ? ' (corrupted)' : '';
      const rarity = ['NORMAL', 'MAGIC', 'RARE', 'UNIQUE'][it.frameType] ?? '?';
      lines.push(`  [${it.inventoryId}] ${rarity} ${it.name || '?'} ${it.typeLine || it.baseType || ''}${corrupt} (ilvl ${it.ilvl})`);
      const mods = [
        ...(it.implicitMods ?? []),
        ...(it.enchantMods ?? []),
        ...(it.explicitMods ?? []),
        ...(it.craftedMods ?? []),
      ];
      for (const m of mods.slice(0, 8)) {
        lines.push(`      ${m}`);
      }
    }
    lines.push('');
  }

  if (Array.isArray(c.skills) && c.skills.length) {
    lines.push('--- Skills (DPS-bearing) ---');
    for (const skillGroup of c.skills) {
      const dpsEntries = skillGroup?.dps ?? [];
      for (const d of dpsEntries) {
        const dt = Array.isArray(d.damageTypes) ? ` [F${d.damageTypes[0]??0}/C${d.damageTypes[1]??0}/L${d.damageTypes[2]??0}/Ph${d.damageTypes[3]??0}/Ch${d.damageTypes[4]??0}]` : '';
        lines.push(`  ${d.name ?? '?'}: ${Math.round(d.dps ?? 0).toLocaleString()} DPS${d.dotDps ? ` + ${Math.round(d.dotDps).toLocaleString()} DoT` : ''}${dt}`);
      }
    }
    lines.push('');
  }

  if (Array.isArray(c.jewels) && c.jewels.length) {
    lines.push('--- Jewels ---');
    for (const j of c.jewels) {
      const mods = [...(j.explicitMods ?? []), ...(j.craftedMods ?? [])];
      lines.push(`  ${j.name || j.typeLine || j.baseType || '?'}`);
      for (const m of mods.slice(0, 5)) {
        lines.push(`      ${m}`);
      }
    }
    lines.push('');
  }

  if (pobCode) {
    lines.push('--- PoB Import Code ---');
    lines.push('(paste into PoB → Import → "Import from code")');
    lines.push(pobCode.slice(0, 200) + (pobCode.length > 200 ? `... (${pobCode.length} chars total)` : ''));
  } else if (c.pathOfBuildingExport) {
    lines.push('--- PoB Import Code (from character payload) ---');
    lines.push(c.pathOfBuildingExport.slice(0, 200) + '...');
  }

  return lines.join('\n');
}
