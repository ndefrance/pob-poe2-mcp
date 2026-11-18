/**
 * poe.ninja API Client
 *
 * Fetches real-time currency rates and item prices from poe.ninja
 */

export interface CurrencyRate {
  currencyTypeName: string;
  chaosEquivalent: number;
  pay?: {
    value: number;
    count: number;
    listing_count: number;
  };
  receive?: {
    value: number;
    count: number;
    listing_count: number;
  };
  detailsId: string;
}

// New API format (poe1/api/economy/exchange/current)
export interface NewCurrencyLine {
  id: string;
  primaryValue: number;
  volumePrimaryValue?: number;
  maxVolumeCurrency?: string;
  maxVolumeRate?: number;
  sparkline?: {
    totalChange: number;
    data: number[];
  };
}

export interface NewCurrencyItem {
  id: string;
  name: string;
  image: string;
  category: string;
  detailsId: string;
}

export interface NewCurrencyOverview {
  core: {
    items: NewCurrencyItem[];
    rates: any;
    primary: string;
    secondary: string;
  };
  lines: NewCurrencyLine[];
  items: NewCurrencyItem[];
}

export interface CurrencyOverview {
  lines: CurrencyRate[];
  currencyDetails: Array<{
    id: number;
    name: string;
    tradeId?: string;
  }>;
}

export interface ArbitrageOpportunity {
  chain: string[];
  profitPercent: number;
  startAmount: number;
  endAmount: number;
  steps: Array<{
    from: string;
    to: string;
    rate: number;
    amount: number;
  }>;
}

/**
 * Client for fetching data from poe.ninja API
 */
export class PoeNinjaClient {
  // poe.ninja has separate PoE1 and PoE2 economy data (poe.ninja/poe2/economy/)
  private baseUrl = process.env.POE2_MODE !== 'false'
    ? 'https://poe.ninja/poe2/api/economy/exchange/current'
    : 'https://poe.ninja/poe1/api/economy/exchange/current';
  private cache = new Map<string, { data: any; timestamp: number }>();
  private cacheTTL = 300000; // 5 minutes

  /**
   * Get currency rates for a league
   */
  async getCurrencyRates(league: string): Promise<CurrencyOverview> {
    const cacheKey = `currency:${league}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return cached;
    }

    const url = `${this.baseUrl}/overview?league=${encodeURIComponent(league)}&type=Currency`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'pob-mcp-server/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`poe.ninja API request failed (${response.status}): ${await response.text()}`);
    }

    const data = await response.json();
    this.putInCache(cacheKey, data);
    return data;
  }

  /**
   * Get fragment rates for a league
   */
  async getFragmentRates(league: string): Promise<CurrencyOverview> {
    const cacheKey = `fragment:${league}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return cached;
    }

    const url = `${this.baseUrl}/overview?league=${encodeURIComponent(league)}&type=Fragment`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'pob-mcp-server/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`poe.ninja API request failed (${response.status}): ${await response.text()}`);
    }

    const data = await response.json();
    this.putInCache(cacheKey, data);
    return data;
  }

  /**
   * Build a currency exchange rate map (all rates in chaos equivalent).
   *
   * Handles BOTH response shapes:
   *   - Legacy: `lines[].currencyTypeName` + `lines[].chaosEquivalent`
   *   - Current (poe.ninja PoE2 0.5+): `core.rates` (units per 1 primary currency)
   *     + `core.items[]` (id→name lookup) + `lines[].primaryValue` (price in primary).
   *     The primary currency is `core.primary` (typically "divine" for PoE2).
   *
   * For the new shape:
   *   primaryChaosValue = core.rates.chaos (chaos per 1 primary)
   *   for each currency X:
   *     chaosEquivalent = lines[X].primaryValue * primaryChaosValue
   */
  async getCurrencyExchangeMap(league: string): Promise<Map<string, number>> {
    const data: any = await this.getCurrencyRates(league);
    const rateMap = new Map<string, number>();
    rateMap.set('Chaos Orb', 1.0);

    // Legacy path
    if (Array.isArray(data.lines) && data.lines.length > 0 && data.lines[0]?.currencyTypeName) {
      for (const line of data.lines) {
        if (line.currencyTypeName && line.chaosEquivalent > 0) {
          rateMap.set(line.currencyTypeName, line.chaosEquivalent);
        }
      }
      return rateMap;
    }

    // New shape: derive everything from core.rates + lines[].primaryValue
    const primaryChaosValue = Number(data.core?.rates?.chaos);
    if (!primaryChaosValue || primaryChaosValue <= 0) {
      // Can't anchor to chaos — leave rateMap with only the Chaos Orb base entry,
      // caller will fall back to hardcoded rates for everything else.
      return rateMap;
    }

    // Build id → display name lookup from both core.items and items
    const idToName: Record<string, string> = {};
    for (const item of (data.core?.items ?? [])) {
      if (item?.id && item?.name) idToName[item.id] = item.name;
    }
    for (const item of (data.items ?? [])) {
      if (item?.id && item?.name) idToName[item.id] = item.name;
    }

    // Primary currency (typically "divine") — chaosEq = primaryChaosValue
    const primaryId = data.core?.primary;
    if (primaryId) {
      const primaryName = idToName[primaryId] ?? primaryId;
      rateMap.set(primaryName, primaryChaosValue);
    }

    // Per-line currencies: chaosEq = primaryValue × primaryChaosValue
    for (const line of (data.lines ?? [])) {
      if (!line?.id || typeof line.primaryValue !== 'number' || line.primaryValue <= 0) continue;
      const name = idToName[line.id] ?? line.id;
      if (rateMap.has(name)) continue; // already set (primary or Chaos Orb)
      rateMap.set(name, line.primaryValue * primaryChaosValue);
    }

    return rateMap;
  }

  /**
   * Find arbitrage opportunities using bid/ask spread from currency exchange rates.
   *
   * Real arbitrage requires separate buy and sell rates. poe.ninja provides:
   *   receive.value = chaos received per unit sold (sell/ask rate)
   *   pay.value     = chaos paid per unit bought (buy/bid rate)
   *
   * For a round-trip A→chaos→B→chaos→A to be profitable:
   *   (sellRate[A] / buyRate[B]) * (sellRate[B] / buyRate[A]) > 1
   *
   * When buy==sell (no spread data), round-trips always return exactly 1 (0% profit).
   */
  async findArbitrageOpportunities(league: string, minProfitPercent: number = 1.0): Promise<ArbitrageOpportunity[]> {
    const overview = await this.getCurrencyRates(league);
    const opportunities: ArbitrageOpportunity[] = [];

    // Build separate buy-rate and sell-rate maps (all in chaos per unit).
    // sell = chaos you receive per unit when selling
    // buy  = chaos you pay per unit when buying
    // Fall back to chaosEquivalent for both when pay/receive unavailable.
    const sellRate = new Map<string, number>(); // chaos received when selling 1 unit
    const buyRate  = new Map<string, number>(); // chaos spent when buying  1 unit

    sellRate.set('Chaos Orb', 1.0);
    buyRate.set('Chaos Orb', 1.0);

    for (const line of overview.lines) {
      const name = line.currencyTypeName;
      if (!name || line.chaosEquivalent <= 0) continue;

      // receive.value: chaos per unit of this currency (sell side)
      const sell = line.receive?.value ?? line.chaosEquivalent;
      // pay.value: chaos per unit of this currency when buying (buy side)
      // poe.ninja pay.value is expressed as [units-of-currency per chaos], so invert it.
      const buy = line.pay?.value
        ? 1 / line.pay.value          // convert [currency/chaos] → [chaos/currency]
        : line.chaosEquivalent;       // fallback: assume no spread

      if (sell > 0 && buy > 0) {
        sellRate.set(name, sell);
        buyRate.set(name, buy);
      }
    }

    const currencies = Array.from(sellRate.keys());

    // 2-step: A → chaos → B → chaos → A
    for (let i = 0; i < currencies.length; i++) {
      const A = currencies[i];
      const sA = sellRate.get(A)!;
      const bA = buyRate.get(A)!;

      for (let j = 0; j < currencies.length; j++) {
        if (i === j) continue;
        const B = currencies[j];
        const sB = sellRate.get(B)!;
        const bB = buyRate.get(B)!;

        // Sell A → chaos, buy B, sell B → chaos, buy A back
        const chaosAfterSellA = sA;               // sell 1 A
        const unitsB         = chaosAfterSellA / bB; // buy B
        const chaosAfterSellB = unitsB * sB;      // sell B
        const finalA         = chaosAfterSellB / bA; // buy A back

        const profitPercent = (finalA - 1) * 100;
        if (profitPercent >= minProfitPercent) {
          opportunities.push({
            chain: [A, B, A],
            profitPercent,
            startAmount: 1,
            endAmount: finalA,
            steps: [
              { from: A,           to: 'Chaos Orb', rate: sA,       amount: chaosAfterSellA },
              { from: 'Chaos Orb', to: B,           rate: 1 / bB,   amount: unitsB },
              { from: B,           to: 'Chaos Orb', rate: sB,       amount: chaosAfterSellB },
              { from: 'Chaos Orb', to: A,           rate: 1 / bA,   amount: finalA },
            ],
          });
        }
      }
    }

    // 3-step: A → chaos → B → chaos → C → chaos → A (limit iterations for performance)
    const limit = Math.min(currencies.length, 20);
    for (let i = 0; i < limit; i++) {
      const A = currencies[i];
      const sA = sellRate.get(A)!;
      const bA = buyRate.get(A)!;

      for (let j = 0; j < limit; j++) {
        if (j === i) continue;
        const B = currencies[j];
        const sB = sellRate.get(B)!;
        const bB = buyRate.get(B)!;

        for (let k = 0; k < limit; k++) {
          if (k === i || k === j) continue;
          const C = currencies[k];
          const sC = sellRate.get(C)!;
          const bC = buyRate.get(C)!;

          const chaosA  = sA;
          const unitsB  = chaosA  / bB;
          const chaosB  = unitsB  * sB;
          const unitsC  = chaosB  / bC;
          const chaosC  = unitsC  * sC;
          const finalA  = chaosC  / bA;

          const profitPercent = (finalA - 1) * 100;
          if (profitPercent >= minProfitPercent) {
            opportunities.push({
              chain: [A, B, C, A],
              profitPercent,
              startAmount: 1,
              endAmount: finalA,
              steps: [
                { from: A,           to: 'Chaos Orb', rate: sA,     amount: chaosA },
                { from: 'Chaos Orb', to: B,           rate: 1 / bB, amount: unitsB },
                { from: B,           to: 'Chaos Orb', rate: sB,     amount: chaosB },
                { from: 'Chaos Orb', to: C,           rate: 1 / bC, amount: unitsC },
                { from: C,           to: 'Chaos Orb', rate: sC,     amount: chaosC },
                { from: 'Chaos Orb', to: A,           rate: 1 / bA, amount: finalA },
              ],
            });
          }
        }
      }
    }

    opportunities.sort((a, b) => b.profitPercent - a.profitPercent);

    // De-duplicate chains with the same set of currencies
    const seen = new Set<string>();
    const unique = opportunities.filter(opp => {
      const key = [...opp.chain].sort().join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return unique.slice(0, 20);
  }

  /**
   * Get from cache if not expired
   */
  private getFromCache(key: string): any | null {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data;
    }
    return null;
  }

  /**
   * Put data in cache
   */
  private putInCache(key: string, data: any): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}
