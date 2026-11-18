import { wrapHandler } from '../utils/errorHandling.js';
import { TradeApiClient } from '../services/tradeClient.js';
import { TradeQueryBuilder } from '../services/tradeQueryBuilder.js';
import { StatMapper } from '../services/statMapper.js';
import { ItemRecommendationEngine, UpgradeContext } from '../services/itemRecommendationEngine.js';
import { ItemListing, SearchOptions, ItemRecommendation, ResistanceRequirements, BudgetConstraints } from '../types/tradeTypes.js';
import { CostBenefitAnalyzer } from '../services/costBenefitAnalyzer.js';
import { PoeNinjaClient } from '../services/poeNinjaClient.js';

interface TradeContext {
  tradeClient: TradeApiClient;
  statMapper?: StatMapper;
  recommendationEngine?: ItemRecommendationEngine;
  ninjaClient?: PoeNinjaClient;
}

// ========================================
// Trade Site URL Helpers
// ========================================

function tradeSiteBase(): string {
  return (process.env.POE2_MODE ?? 'true').toLowerCase() !== 'false'
    ? 'https://www.pathofexile.com/trade2/search'
    : 'https://www.pathofexile.com/trade/search';
}

function getTradeSearchUrl(league: string, searchId: string): string {
  return `${tradeSiteBase()}/${encodeURIComponent(league)}/${searchId}`;
}

function getTradeItemUrl(league: string, searchId: string, itemId: string): string {
  return `${tradeSiteBase()}/${encodeURIComponent(league)}/${searchId}#${itemId}`;
}

/**
 * Search the Path of Exile trade site for items
 */
export async function handleSearchTradeItems(
  context: TradeContext,
  args: {
    league: string;
    item_name?: string;
    item_type?: string;
    min_price?: number;
    max_price?: number;
    price_currency?: string;
    online_only?: boolean;
    buyout_only?: boolean;
    trade_mode?: 'instant' | 'instant_or_inperson' | 'inperson_online' | 'inperson_onlineleague' | 'any';
    rarity?: 'normal' | 'magic' | 'rare' | 'unique' | 'any';
    item_rarity?: 'normal' | 'magic' | 'rare' | 'unique' | 'any';
    min_links?: number;
    stats?: Array<{ id: string; min?: number; max?: number }>;
    mods?: Array<{ stat_id: string; min?: number; max?: number }>;
    corrupted?: boolean;
    identified?: boolean;
    sort?: 'price_asc' | 'price_desc';
    limit?: number;
  }
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('search trade items', async () => {
    const {
      league,
      item_name,
      item_type,
      min_price,
      max_price,
      price_currency = 'chaos',
      online_only = true,
      buyout_only = false,
      trade_mode,
      // Accept BOTH schema-aligned names (item_rarity, mods, stat_id) and legacy
      // handler names (rarity, stats, id) so neither shape silently drops.
      rarity,
      item_rarity,
      min_links,
      stats,
      mods,
      corrupted,
      identified,
      sort = 'price_asc',
      limit = 5,
    } = args;

    // Build the query
    const builder = new TradeQueryBuilder();

    if (item_name) {
      builder.withName(item_name);
    }

    if (item_type) {
      builder.withType(item_type);
    }

    const effectiveRarity = item_rarity ?? rarity;
    if (effectiveRarity) {
      builder.withRarity(effectiveRarity);
    }

    if (min_links) {
      builder.withLinks(min_links);
    }

    // Normalize mods → stats shape: schema uses {stat_id, min, max}, builder wants {id, min, max}
    const normalizedStats: Array<{ id: string; min?: number; max?: number }> = [];
    if (mods && mods.length > 0) {
      for (const m of mods) {
        if (m && m.stat_id) normalizedStats.push({ id: m.stat_id, min: m.min, max: m.max });
      }
    }
    if (stats && stats.length > 0) {
      for (const s of stats) {
        if (s && s.id) normalizedStats.push(s);
      }
    }
    if (normalizedStats.length > 0) {
      builder.withStats(normalizedStats);
    }

    // corrupted/identified are accepted in the schema but the builder doesn't
    // expose dedicated methods for them yet — silently no-op rather than fail.
    void corrupted;
    void identified;

    // Map trade_mode aliases. 'inperson_onlineleague' is the default for the
    // legacy online_only=true path; 'instant' selects PoE2 0.5 Instant Buyout.
    let mappedMode = trade_mode;
    if (trade_mode === 'inperson_onlineleague') mappedMode = undefined; // falls through to default
    builder.applyOptions({
      league,
      onlineOnly: online_only,
      buyoutOnly: buyout_only,
      minPrice: min_price,
      maxPrice: max_price,
      priceCurrency: price_currency,
      sort,
      limit,
      tradeMode: mappedMode,
    } as any);

    const query = builder.build();

    // Execute search
    const searchResult = await context.tradeClient.searchItems(league, query);

    if (!searchResult.result || searchResult.result.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No items found matching your search criteria in ${league} league.`,
          },
        ],
      };
    }

    // Fetch first batch of items (up to limit)
    const itemIdsToFetch = searchResult.result.slice(0, Math.min(limit, 10));
    const items = await context.tradeClient.fetchItems(itemIdsToFetch, searchResult.id);

    // Format results with real-time currency rates
    const output = await formatSearchResults(items, searchResult.total, league, searchResult.id, context.ninjaClient);

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  });
}

/**
 * Get current market price for an item
 */
export async function handleGetItemPrice(
  context: TradeContext,
  args: {
    item_name: string;
    league?: string;
    item_type?: string;
    rarity?: 'unique' | 'rare' | 'magic' | 'normal';
  }
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('get item price', async () => {
    const { item_name, league = 'Standard', item_type, rarity } = args;

    // Build query
    const builder = new TradeQueryBuilder()
      .withName(item_name)
      .withOnlineStatus('available');

    if (item_type) {
      builder.withType(item_type);
    }

    if (rarity) {
      builder.withRarity(rarity);
    }

    builder.withSort('price', 'asc');

    const query = builder.build();

    // Search
    const searchResult = await context.tradeClient.searchItems(league, query);

    if (!searchResult.result || searchResult.result.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No price data found for "${item_name}" in ${league}.`,
          },
        ],
      };
    }

    // Fetch first 10 items to get price range
    const itemIdsToFetch = searchResult.result.slice(0, Math.min(10, searchResult.result.length));
    const items = await context.tradeClient.fetchItems(itemIdsToFetch, searchResult.id);

    // Calculate price statistics
    const prices = items
      .map(item => item.listing.price)
      .filter(price => price !== undefined)
      .map(price => ({
        amount: price!.amount,
        currency: price!.currency,
      }));

    if (prices.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No priced listings found for "${item_name}" in ${league}.`,
          },
        ],
      };
    }

    // Group by currency
    const byCurrency = new Map<string, number[]>();
    for (const price of prices) {
      if (!byCurrency.has(price.currency)) {
        byCurrency.set(price.currency, []);
      }
      byCurrency.get(price.currency)!.push(price.amount);
    }

    // Format output
    let output = `=== Price Check: ${item_name} ===\n`;
    output += `League: ${league}\n`;
    output += `Total Listings: ${searchResult.total}\n\n`;

    for (const [currency, amounts] of byCurrency.entries()) {
      amounts.sort((a, b) => a - b);
      const min = amounts[0];
      const max = amounts[amounts.length - 1];
      const median = amounts[Math.floor(amounts.length / 2)];
      const avg = amounts.reduce((sum, val) => sum + val, 0) / amounts.length;

      output += `${currency}:\n`;
      output += `  Low: ${min.toFixed(1)} ${currency}\n`;
      output += `  Median: ${median.toFixed(1)} ${currency}\n`;
      output += `  Average: ${avg.toFixed(1)} ${currency}\n`;
      output += `  High: ${max.toFixed(1)} ${currency}\n`;
      output += `  Sample Size: ${amounts.length} listings\n\n`;
    }

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  });
}

/**
 * Get available leagues
 */
export async function handleGetLeagues(
  context: TradeContext
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('get leagues', async () => {
    const leagueData = await context.tradeClient.getLeagues();

    if (!leagueData.result || leagueData.result.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No leagues found.',
          },
        ],
      };
    }

    let output = '=== Available Leagues ===\n\n';

    for (const league of leagueData.result) {
      output += `- ${league.id}`;
      if (league.text) {
        output += ` (${league.text})`;
      }
      if (league.realm) {
        output += ` [${league.realm}]`;
      }
      output += '\n';
    }

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  });
}

// ========================================
// Helper Functions
// ========================================

/**
 * Fetch and map currency rates from poe.ninja
 * Maps full currency names to short names used by trade API
 */
async function getCurrencyRatesMap(ninjaClient: PoeNinjaClient | undefined, league: string): Promise<Map<string, number>> {
  if (!ninjaClient) {
    return new Map();
  }

  try {
    const rates = await ninjaClient.getCurrencyExchangeMap(league);
    const mappedRates = new Map<string, number>();

    const isPoE2 = (process.env.POE2_MODE ?? 'true').toLowerCase() !== 'false';

    // PoE2 currency display name → trade-API code aliases.
    // Trade listings come back with short codes ('exalted', 'chaos', 'divine', 'annul',
    // 'mirror-shard', etc.). poe.ninja returns full display names ('Exalted Orb',
    // 'Chaos Orb', etc.). We need both in the rate map so price conversion catches
    // every listing currency, regardless of which side names it.
    const poe2NameMap: Record<string, string[]> = {
      'Exalted Orb': ['exalted', 'exa', 'ex'],
      'Chaos Orb': ['chaos', 'c'],
      'Divine Orb': ['divine', 'div'],
      'Orb of Annulment': ['annul', 'annulment'],
      'Regal Orb': ['regal'],
      'Vaal Orb': ['vaal'],
      'Orb of Alchemy': ['alch', 'alchemy'],
      'Orb of Augmentation': ['aug', 'augmentation'],
      'Orb of Transmutation': ['transmute', 'transmutation'],
      'Orb of Chance': ['chance'],
      'Mirror of Kalandra': ['mirror'],
      'Mirror Shard': ['mirror-shard'],
      'Gemcutter\'s Prism': ['gcp', 'gemcutters-prism'],
      'Artificer\'s Orb': ['artificers-orb', 'artificer'],
      'Blacksmith\'s Whetstone': ['blacksmiths-whetstone', 'whetstone'],
      'Arcanist\'s Etcher': ['arcanists-etcher', 'etcher'],
      'Armourer\'s Scrap': ['armourers-scrap'],
      'Fracturing Orb': ['fracturing'],
      'Orb of Extraction': ['extraction'],
      // PoE2 tier-prefixed currencies (Perfect/Greater)
      'Perfect Exalted Orb': ['perfect-exalted', 'perfect-exa'],
      'Perfect Chaos Orb': ['perfect-chaos'],
      'Perfect Regal Orb': ['perfect-regal'],
      'Greater Exalted Orb': ['greater-exalted'],
      'Greater Chaos Orb': ['greater-chaos'],
      'Greater Regal Orb': ['greater-regal'],
      'Greater Jeweller\'s Orb': ['greater-jewellers'],
      'Perfect Jeweller\'s Orb': ['perfect-jewellers'],
      'Lesser Jeweller\'s Orb': ['lesser-jewellers', 'jewellers'],
      'Vaal Cultivation Orb': ['vaal-cultivation'],
      'Scroll of Wisdom': ['wisdom'],
      // Boss / pinnacle drops sometimes used as trade currency
      'Distilled Suffering': ['distilled-suffering'],
      'Distilled Despair': ['distilled-despair'],
      'Distilled Isolation': ['distilled-isolation'],
    };

    const poe1NameMap: Record<string, string[]> = {
      'Divine Orb': ['divine', 'div'],
      'Chaos Orb': ['chaos', 'c'],
      'Exalted Orb': ['exalted', 'exa', 'ex'],
      'Mirror of Kalandra': ['mirror'],
      'Orb of Alchemy': ['alchemy', 'alch'],
      'Orb of Fusing': ['fusing', 'fuse'],
      'Orb of Regret': ['regret'],
      'Gemcutter\'s Prism': ['gcp'],
      'Chromatic Orb': ['chrome', 'chromatic'],
      'Jeweller\'s Orb': ['jewellers', 'jew'],
      'Orb of Alteration': ['alt', 'alteration'],
      'Vaal Orb': ['vaal'],
      'Cartographer\'s Chisel': ['chisel'],
      'Blessed Orb': ['blessed'],
      'Orb of Scouring': ['scouring', 'scour'],
    };

    const nameMap = isPoE2 ? poe2NameMap : poe1NameMap;

    for (const [fullName, chaosValue] of rates.entries()) {
      mappedRates.set(fullName, chaosValue);
      for (const [key, aliases] of Object.entries(nameMap)) {
        if (fullName === key) {
          for (const alias of aliases) {
            mappedRates.set(alias, chaosValue);
          }
        }
      }
    }

    return mappedRates;
  } catch (error) {
    console.error('[Trade] Failed to fetch currency rates from poe.ninja:', error);
    return new Map();
  }
}

async function formatSearchResults(items: ItemListing[], totalResults: number, league: string, searchId: string, ninjaClient?: PoeNinjaClient): Promise<string> {
  let output = `=== Trade Search (${league}) ===\n`;
  output += `Found: ${totalResults} | Showing: ${items.length}\n`;
  output += `🔗 ${getTradeSearchUrl(league, searchId)}\n\n`;

  // Fetch real-time currency rates from poe.ninja
  const currencyRates = await getCurrencyRatesMap(ninjaClient, league);

  // Analyze items for cost/benefit with real rates
  const analyzer = new CostBenefitAnalyzer();
  const analyses = analyzer.analyzeAndRank(items, currencyRates);

  for (let i = 0; i < analyses.length; i++) {
    const analysis = analyses[i];
    const listing = analysis.listing;
    const item = listing.item;
    const price = listing.listing.price;
    const seller = listing.listing.account;
    const metrics = analysis.metrics;

    // Rank by value, not by search order
    const valueRank = analysis.rank || (i + 1);
    const searchRank = items.indexOf(listing) + 1;

    output += `${searchRank}. ${item.name || item.typeLine}`;

    // Show value indicator
    const tierEmoji = {
      'excellent': ' 💎',
      'good': ' ✨',
      'average': '',
      'poor': ' ⚠️'
    }[metrics.valueTier];
    output += tierEmoji;

    if (metrics.isBudgetPick) {
      output += ' 💰';
    }

    output += `\n`;

    if (item.name && item.typeLine && item.name !== item.typeLine) {
      output += `   Base: ${item.typeLine}\n`;
    }

    if (price) {
      output += `   Price: ${price.amount} ${price.currency}`;
      // Always surface the chaos-equivalent so anti-manipulation is one glance away.
      // PoE2 traders sometimes list in unusual currencies (annul/regal/perfect-orbs)
      // hoping buyers don't realize the conversion. The live poe.ninja rate makes
      // the actual value explicit regardless of headline currency.
      if (analysis.priceInChaos > 0) {
        const chaos = analysis.priceInChaos;
        // Show in chaos if reasonable, otherwise convert to divine for readability
        const divineRate = currencyRates.get('Divine Orb') || currencyRates.get('divine') || 50;
        if (chaos >= divineRate * 0.5) {
          const inDivine = chaos / divineRate;
          output += `  →  ${inDivine.toFixed(2)} div  (${chaos.toFixed(0)} chaos)`;
        } else {
          output += `  →  ${chaos.toFixed(1)} chaos`;
        }
        // Flag if the listed currency isn't a common one — possible mispricing
        const listingCurr = (price.currency || '').toLowerCase();
        const commonCurrs = new Set(['chaos','divine','exalted','mirror']);
        if (!commonCurrs.has(listingCurr)) {
          output += `  ⚠️ (verify rate of '${price.currency}' before buying)`;
        }
      }
      output += `\n`;
    } else {
      output += `   Price: Not listed\n`;
    }

    // Show value score
    output += `   Value: ${metrics.valueScore.toFixed(0)}/100 (${metrics.valueTier})`;
    if (valueRank <= 3) {
      output += ` - #${valueRank} best value`;
    }
    output += `\n`;

    output += `   ilvl: ${item.ilvl}`;

    if (item.corrupted) {
      output += ' (Corrupted)';
    }

    output += '\n';

    // Links
    if (item.sockets && item.sockets.length > 0) {
      const maxLinks = getMaxLinks(item.sockets);
      if (maxLinks > 1) {
        output += `   Links: ${maxLinks}L\n`;
      }
    }

    // Show key stats in condensed format
    const stats = analysis.stats;
    const statParts: string[] = [];
    if (stats.life > 0) statParts.push(`+${stats.life} Life`);
    if (stats.es > 0) statParts.push(`+${stats.es} ES`);
    if (stats.fireResist) statParts.push(`+${stats.fireResist}% Fire`);
    if (stats.coldResist) statParts.push(`+${stats.coldResist}% Cold`);
    if (stats.lightningResist) statParts.push(`+${stats.lightningResist}% Lightning`);
    if (stats.chaosResist) statParts.push(`+${stats.chaosResist}% Chaos`);
    if (statParts.length > 0) {
      output += `   Key stats: ${statParts.join(', ')}\n`;
    }

    // Show full mod text (implicit + explicit + rune) so the LLM sees what's
    // actually on the item, not just the headline stats.
    const allMods: string[] = [];
    if (item.implicitMods && item.implicitMods.length) {
      allMods.push(...item.implicitMods.map((m: string) => `  [implicit] ${m}`));
    }
    if ((item as any).runeMods && (item as any).runeMods.length) {
      allMods.push(...(item as any).runeMods.map((m: string) => `  [rune] ${m}`));
    }
    if (item.explicitMods && item.explicitMods.length) {
      allMods.push(...item.explicitMods.map((m: string) => `  ${m}`));
    }
    if ((item as any).craftedMods && (item as any).craftedMods.length) {
      allMods.push(...(item as any).craftedMods.map((m: string) => `  [crafted] ${m}`));
    }
    if (allMods.length > 0) {
      output += `   Mods:\n${allMods.join('\n')}\n`;
    }

    output += `   ${seller.online ? '🟢' : '🔴'} ${seller.name}\n`;
    output += `   🔗 ${getTradeItemUrl(league, searchId, listing.id)}\n\n`;
  }

  output += `\n💎=excellent ✨=good ⚠️=poor 💰=budget 🟢=online 🔴=offline`;
  return output;
}

function getMaxLinks(sockets: Array<{ group: number }>): number {
  const groups = new Map<number, number>();
  for (const socket of sockets) {
    const count = groups.get(socket.group) || 0;
    groups.set(socket.group, count + 1);
  }
  return Math.max(...groups.values());
}

/**
 * Search for stat IDs by name (fuzzy matching)
 */
export async function handleSearchStats(
  context: TradeContext,
  args: {
    query: string;
    limit?: number;
  }
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('search stats', async () => {
    const { query, limit = 10 } = args;

    if (!context.statMapper) {
      return {
        content: [
          {
            type: 'text',
            text: 'Stat mapper not available.',
          },
        ],
      };
    }

    const results = context.statMapper.fuzzySearch(query, limit);

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No stats found matching "${query}".`,
          },
        ],
      };
    }

    let output = `=== Stat Search Results for "${query}" ===\n\n`;
    output += `Found ${results.length} matching stats:\n\n`;

    for (let i = 0; i < results.length; i++) {
      const stat = results[i];
      output += `${i + 1}. ${stat.pobName}\n`;
      output += `   Trade ID: ${stat.tradeId}\n`;
      output += `   Category: ${stat.category}\n`;

      if (stat.description) {
        output += `   Description: ${stat.description}\n`;
      }

      if (stat.aliases.length > 0) {
        output += `   Aliases: ${stat.aliases.slice(0, 3).join(', ')}`;
        if (stat.aliases.length > 3) {
          output += ` (+${stat.aliases.length - 3} more)`;
        }
        output += '\n';
      }

      output += '\n';
    }

    output += `\nTo use in searches, reference the Trade ID in the stats parameter.`;

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  });
}

// Phase 3: Recommendation Engine Handlers

export async function handleFindItemUpgrades(
  context: TradeContext,
  args: any
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return wrapHandler('find item upgrades', async () => {
    const {
      slot,
      league,
      build_needs,
      current_item,
      max_price = 100,
      currency = 'chaos',
      limit = 5,
    } = args;

    if (!context.recommendationEngine) {
      return {
        content: [{ type: 'text', text: 'Recommendation engine not available.' }],
      };
    }

    const upgradeContext: UpgradeContext = {
      currentItem: current_item ? {
        name: current_item.name || 'Current Item',
        slot,
        life: current_item.life,
        es: current_item.es,
        resistances: {
          fire: current_item.fire_resist,
          cold: current_item.cold_resist,
          lightning: current_item.lightning_resist,
          chaos: current_item.chaos_resist,
        },
      } : undefined,
      buildNeeds: {
        lifeNeeded: build_needs?.life,
        esNeeded: build_needs?.es,
        dpsTarget: build_needs?.dps,
        resistanceGaps: (build_needs && (build_needs.fire_resist || build_needs.cold_resist || build_needs.lightning_resist)) ? {
          fire: build_needs.fire_resist || 0,
          cold: build_needs.cold_resist || 0,
          lightning: build_needs.lightning_resist || 0,
          chaos: build_needs.chaos_resist || 0,
        } : undefined,
      },
      budget: {
        maxPricePerItem: max_price,
        totalBudget: max_price * 2,
        currency,
      },
      league,
    };

    const recommendations = await context.recommendationEngine.findUpgrades(slot, upgradeContext);

    if (recommendations.length === 0) {
      return {
        content: [{ type: 'text', text: `No upgrade recommendations found for ${slot} in ${league} within budget.` }],
      };
    }

    const output = formatItemRecommendations(recommendations.slice(0, limit), slot, league);
    return { content: [{ type: 'text', text: output }] };
  });
}

export async function handleFindResistanceGear(
  context: TradeContext,
  args: any
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return wrapHandler('find resistance gear', async () => {
    const {
      league,
      fire_resist_needed = 0,
      cold_resist_needed = 0,
      lightning_resist_needed = 0,
      chaos_resist_needed = 0,
      max_price_per_item = 50,
      total_budget = 200,
      currency = 'chaos',
      slots,
      limit = 8,
    } = args;

    if (!context.recommendationEngine) {
      return {
        content: [{ type: 'text', text: 'Recommendation engine not available.' }],
      };
    }

    const resistanceGaps: ResistanceRequirements = {
      fire: fire_resist_needed,
      cold: cold_resist_needed,
      lightning: lightning_resist_needed,
      chaos: chaos_resist_needed,
    };

    const budget: BudgetConstraints = {
      maxPricePerItem: max_price_per_item,
      totalBudget: total_budget,
      currency,
    };

    const recommendations = await context.recommendationEngine.findResistanceGear(
      resistanceGaps,
      budget,
      league,
      slots
    );

    if (recommendations.length === 0) {
      return {
        content: [{ type: 'text', text: `No resistance gear found in ${league} that matches your requirements within budget.` }],
      };
    }

    const output = formatResistanceRecommendations(recommendations.slice(0, limit), resistanceGaps, league, true);
    return { content: [{ type: 'text', text: output }] };
  });
}

function formatItemRecommendations(
  recommendations: ItemRecommendation[],
  slot: string,
  league: string,
  includeLinks: boolean = false
): string {
  let output = `=== ${slot} Upgrades (${league}) ===\n`;
  output += `${recommendations.length} found\n\n`;

  for (const rec of recommendations) {
    const item = rec.listing.item;
    const price = rec.listing.listing.price;

    output += `${rec.rank}. ${item.name || item.typeLine}`;
    if (rec.priority === 'high') output += ' ⭐';
    output += `\n`;

    if (item.name && item.typeLine && item.name !== item.typeLine) {
      output += `   Base: ${item.typeLine}\n`;
    }

    output += `   Score: ${rec.score.toFixed(1)}/100 (${rec.priority} priority)\n`;

    if (price) {
      output += `   Price: ${price.amount} ${price.currency}\n`;
    }

    if (rec.costBenefit) {
      const cb = rec.costBenefit;
      if (cb.lifeGain && cb.lifeGain > 0) {
        output += `   Life Gain: +${cb.lifeGain}\n`;
      }
      if (cb.esGain && cb.esGain > 0) {
        output += `   ES Gain: +${cb.esGain}\n`;
      }
      if (cb.efficiency) {
        output += `   Efficiency: ${cb.efficiency.toFixed(2)} points per ${cb.currency}\n`;
      }
    }

    if (rec.reasons.length > 0) {
      output += `   Why:\n`;
      for (const reason of rec.reasons.slice(0, 3)) {
        output += `     - ${reason}\n`;
      }
    }

    output += `   ${rec.listing.listing.account.online ? '🟢' : '🔴'} ${rec.listing.listing.account.name}\n`;
    output += `   🔗 ${getTradeItemUrl(league, rec.searchId, rec.listing.id)}\n\n`;
  }

  return output;
}

function formatResistanceRecommendations(
  recommendations: ItemRecommendation[],
  resistanceGaps: ResistanceRequirements,
  league: string,
  includeLinks: boolean = false
): string {
  const targets = [];
  if (resistanceGaps.fire > 0) targets.push(`${resistanceGaps.fire}% Fire`);
  if (resistanceGaps.cold > 0) targets.push(`${resistanceGaps.cold}% Cold`);
  if (resistanceGaps.lightning > 0) targets.push(`${resistanceGaps.lightning}% Lightning`);
  if (resistanceGaps.chaos && resistanceGaps.chaos > 0) targets.push(`${resistanceGaps.chaos}% Chaos`);

  let output = `=== Resistance Gear (${league}) ===\n`;
  output += `Need: ${targets.join(', ')}\n`;
  output += `${recommendations.length} found\n\n`;

  for (const rec of recommendations) {
    const item = rec.listing.item;
    const price = rec.listing.listing.price;

    output += `${rec.rank}. ${item.name || item.typeLine}`;
    if (rec.priority === 'high') output += ' ⭐';
    output += `\n`;

    if (item.typeLine && item.name !== item.typeLine) {
      output += `   Type: ${item.typeLine}\n`;
    }

    output += `   Score: ${rec.score.toFixed(1)}/100 (${rec.priority} priority)\n`;

    if (price) {
      output += `   Price: ${price.amount} ${price.currency}\n`;
    }

    if (rec.costBenefit.resistGain) {
      const gains = [];
      const rg = rec.costBenefit.resistGain;
      if (rg.fire) gains.push(`${rg.fire}% Fire`);
      if (rg.cold) gains.push(`${rg.cold}% Cold`);
      if (rg.lightning) gains.push(`${rg.lightning}% Lightning`);
      if (rg.chaos) gains.push(`${rg.chaos}% Chaos`);

      if (gains.length > 0) {
        output += `   Provides: ${gains.join(', ')}\n`;
      }
    }

    if (rec.costBenefit.efficiency) {
      output += `   Efficiency: ${rec.costBenefit.efficiency.toFixed(2)} resist per ${rec.costBenefit.currency}\n`;
    }

    if (rec.reasons.length > 0) {
      output += `   Why:\n`;
      for (const reason of rec.reasons.slice(0, 2)) {
        output += `     - ${reason}\n`;
      }
    }

    output += `   ${rec.listing.listing.account.online ? '🟢' : '🔴'} ${rec.listing.listing.account.name}\n`;
    output += `   🔗 ${getTradeItemUrl(league, rec.searchId, rec.listing.id)}\n\n`;
  }

  return output;
}

/**
 * Compare multiple trade items side-by-side
 */
export async function handleCompareTradeItems(
  context: TradeContext,
  args: {
    item_ids: string[];
    build_context?: {
      life_needed?: number;
      es_needed?: number;
      dps_target?: number;
      fire_resist_needed?: number;
      cold_resist_needed?: number;
      lightning_resist_needed?: number;
    };
  }
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('compare trade items', async () => {
    const { item_ids, build_context } = args;

    if (!item_ids || item_ids.length === 0) {
      return {
        content: [{ type: 'text', text: 'No item IDs provided for comparison.' }],
      };
    }

    if (item_ids.length > 5) {
      return {
        content: [{ type: 'text', text: 'Can only compare up to 5 items at once.' }],
      };
    }

    const items = await context.tradeClient.fetchItems(item_ids);

    if (items.length === 0) {
      return {
        content: [{ type: 'text', text: 'No items found with the provided IDs.' }],
      };
    }

    const output = formatItemComparison(items, build_context);
    return { content: [{ type: 'text', text: output }] };
  });
}

function formatItemComparison(
  items: ItemListing[],
  buildContext?: {
    life_needed?: number;
    es_needed?: number;
    dps_target?: number;
    fire_resist_needed?: number;
    cold_resist_needed?: number;
    lightning_resist_needed?: number;
  }
): string {
  let output = `=== Item Comparison (${items.length}) ===\n\n`;

  const itemStats = items.map(listing => {
    const item = listing.item;
    const price = listing.listing.price;

    return {
      name: item.name || item.typeLine,
      typeLine: item.typeLine,
      price: price ? price.amount + ' ' + price.currency : 'No price',
      priceAmount: price?.amount || 0,
      ilvl: item.ilvl,
      corrupted: item.corrupted || false,
      links: item.sockets ? getMaxLinks(item.sockets) : 0,
      life: extractStatValue(item, 'life'),
      es: extractStatValue(item, 'energy shield'),
      armour: extractStatValue(item, 'armour'),
      evasion: extractStatValue(item, 'evasion'),
      fireResist: extractResistValue(item, 'fire'),
      coldResist: extractResistValue(item, 'cold'),
      lightningResist: extractResistValue(item, 'lightning'),
      chaosResist: extractResistValue(item, 'chaos'),
      seller: listing.listing.account.name,
      online: listing.listing.account.online,
    };
  });

  const maxLife = Math.max(...itemStats.map(i => i.life));
  const maxES = Math.max(...itemStats.map(i => i.es));
  const minPrice = Math.min(...itemStats.filter(i => i.priceAmount > 0).map(i => i.priceAmount));

  for (let i = 0; i < itemStats.length; i++) {
    const stats = itemStats[i];
    output += (i + 1) + '. ' + stats.name + '\n';

    if (stats.name !== stats.typeLine) {
      output += '   Base: ' + stats.typeLine + '\n';
    }

    output += '   Price: ' + stats.price;
    if (stats.priceAmount === minPrice && minPrice > 0) {
      output += ' 💰 (Best Value)';
    }
    output += '\n';

    output += '   ilvl: ' + stats.ilvl;
    if (stats.corrupted) output += ' (Corrupted)';
    output += '\n';

    if (stats.links > 0) {
      output += '   Links: ' + stats.links + 'L\n';
    }

    if (stats.life > 0) {
      output += '   Life: +' + stats.life;
      if (stats.life === maxLife) output += ' ⭐';
      if (buildContext?.life_needed && stats.life >= buildContext.life_needed) {
        output += ' ✓';
      }
      output += '\n';
    }

    if (stats.es > 0) {
      output += '   ES: +' + stats.es;
      if (stats.es === maxES) output += ' ⭐';
      if (buildContext?.es_needed && stats.es >= buildContext.es_needed) {
        output += ' ✓';
      }
      output += '\n';
    }

    if (stats.armour > 0) {
      output += '   Armour: ' + stats.armour + '\n';
    }

    if (stats.evasion > 0) {
      output += '   Evasion: ' + stats.evasion + '\n';
    }

    const resists = [];
    if (stats.fireResist > 0) {
      let resistStr = stats.fireResist + '% Fire';
      if (buildContext?.fire_resist_needed && stats.fireResist >= buildContext.fire_resist_needed) {
        resistStr += ' ✓';
      }
      resists.push(resistStr);
    }
    if (stats.coldResist > 0) {
      let resistStr = stats.coldResist + '% Cold';
      if (buildContext?.cold_resist_needed && stats.coldResist >= buildContext.cold_resist_needed) {
        resistStr += ' ✓';
      }
      resists.push(resistStr);
    }
    if (stats.lightningResist > 0) {
      let resistStr = stats.lightningResist + '% Lightning';
      if (buildContext?.lightning_resist_needed && stats.lightningResist >= buildContext.lightning_resist_needed) {
        resistStr += ' ✓';
      }
      resists.push(resistStr);
    }
    if (stats.chaosResist > 0) {
      resists.push(stats.chaosResist + '% Chaos');
    }

    if (resists.length > 0) {
      output += '   Resistances: ' + resists.join(', ') + '\n';
    }

    output += '   Seller: ' + stats.seller;
    if (stats.online) output += ' (Online)';
    output += '\n\n';
  }

  output += '=== Summary ===\n';
  output += '⭐ = Best value for that stat\n';
  output += '✓ = Meets build requirement\n';
  output += '💰 = Cheapest option\n';

  return output;
}

function extractStatValue(item: any, statName: string): number {
  const allMods = [
    ...(item.explicitMods || []),
    ...(item.implicitMods || []),
    ...(item.craftedMods || []),
  ];

  for (const mod of allMods) {
    if (mod.toLowerCase().includes(statName.toLowerCase())) {
      const match = mod.match(/(\d+)/);
      if (match) {
        return parseInt(match[1], 10);
      }
    }
  }

  return 0;
}

function extractResistValue(item: any, element: string): number {
  const allMods = [
    ...(item.explicitMods || []),
    ...(item.implicitMods || []),
    ...(item.craftedMods || []),
  ];

  let total = 0;

  for (const mod of allMods) {
    const lowerMod = mod.toLowerCase();

    if (lowerMod.includes(element + ' resistance')) {
      const match = mod.match(/\+?(\d+)%/);
      if (match) total += parseInt(match[1], 10);
    }

    if ((element === 'fire' || element === 'cold' || element === 'lightning') &&
        (lowerMod.includes('all elemental resistances') || lowerMod.includes('to all resistances'))) {
      const match = mod.match(/\+?(\d+)%/);
      if (match) total += parseInt(match[1], 10);
    }
  }

  return total;
}
