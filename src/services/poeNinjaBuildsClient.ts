/**
 * poe.ninja PoE2 Builds API Client
 *
 * Fetches character-level build data from poe.ninja's PoE2 build database.
 * Separate from PoeNinjaClient (currency) because the build endpoints have
 * different URL patterns, response shapes, and header requirements.
 *
 * Endpoints (verified 2026-06-03):
 *   GET /poe2/api/data/index-state                              → snapshot versions per league
 *   GET /poe2/api/builds/{version}/character?account=&name=&overview=  → full char JSON
 *   GET /poe2/api/builds/pob/import?accountName=&characterName=        → base64 PoB code
 *   GET /poe2/api/builds/{version}/search?overview=...                 → protobuf (deferred)
 *
 * Cloudflare-fronted. Requires a real User-Agent + Referer matching the
 * canonical builds page, otherwise the edge returns 404.
 */

export interface IndexStateResponse {
  snapshotVersions: Array<{
    url: string;
    name: string;
    version: string;
  }>;
}

export interface CharacterItem {
  inventoryId: string;
  name: string;
  typeLine: string;
  baseType: string;
  ilvl: number;
  frameType: number;
  corrupted?: boolean;
  icon?: string;
  implicitMods?: string[];
  explicitMods?: string[];
  craftedMods?: string[];
  enchantMods?: string[];
}

export interface CharacterFull {
  name: string;
  account: string;
  class: string;
  level: number;
  league: string;
  items: CharacterItem[];
  skills: Array<{ name?: string; dps?: Array<{ name: string; dps: number; dotDps?: number; damageTypes?: number[] }> }>;
  keystones?: any[];
  passiveSelection?: any[];
  passiveSelectionSet1?: any[];
  passiveSelectionSet2?: any[];
  jewels?: Array<{ position?: { x: number; y: number }; [k: string]: any }>;
  flasks?: CharacterItem[];
  defensiveStats?: {
    life?: number;
    energyShield?: number;
    mana?: number;
    spirit?: number;
    evasionRating?: number;
    armour?: number;
    fireResistance?: number;
    coldResistance?: number;
    lightningResistance?: number;
    chaosResistance?: number;
    fireResistanceOverCap?: number;
    coldResistanceOverCap?: number;
    lightningResistanceOverCap?: number;
    chaosResistanceOverCap?: number;
    effectiveHealthPool?: number;
    fireMaximumHitTaken?: number;
    coldMaximumHitTaken?: number;
    lightningMaximumHitTaken?: number;
    chaosMaximumHitTaken?: number;
    physicalMaximumHitTaken?: number;
    blockChance?: number;
    spellSuppressionChance?: number;
    movementSpeed?: number;
    itemRarity?: number;
    [k: string]: any;
  };
  pathOfBuildingExport?: string;
  useSecondWeaponSet?: boolean;
}

const DEFAULT_HEADERS = (leagueSlug: string) => ({
  'User-Agent': 'pob-poe2-mcp-server/1.0 (+https://github.com/anthropics/claude-code; build engineering)',
  'Accept': 'application/json',
  'Referer': `https://poe.ninja/poe2/builds/${leagueSlug}`,
});

export class PoeNinjaBuildsClient {
  private base = 'https://poe.ninja/poe2/api';
  private cache = new Map<string, { data: any; timestamp: number }>();
  private cacheTTL: { default: number; character: number; index: number } = {
    default: 600_000,    // 10 min
    character: 3600_000, // 1 hour
    index: 300_000,      // 5 min
  };

  private getFromCache(key: string, ttl: number): any | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > ttl) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  private putInCache(key: string, data: any): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * Fetch the league→snapshot-version map. Every other endpoint needs the
   * version for the league it's querying.
   */
  async getIndexState(): Promise<IndexStateResponse> {
    const cacheKey = 'index-state';
    const cached = this.getFromCache(cacheKey, this.cacheTTL.index);
    if (cached) return cached;

    const url = `${this.base}/data/index-state`;
    const response = await fetch(url, {
      headers: DEFAULT_HEADERS('runesofaldur'),
    });
    if (!response.ok) {
      throw new Error(`poe.ninja index-state failed (${response.status}): ${await response.text()}`);
    }
    const data = await response.json();
    this.putInCache(cacheKey, data);
    return data as IndexStateResponse;
  }

  /**
   * Resolve a league slug (e.g. "runesofaldur") to its current snapshot version.
   */
  async getVersionForLeague(leagueSlug: string): Promise<string> {
    const state = await this.getIndexState();
    const match = state.snapshotVersions.find(s =>
      s.name === leagueSlug ||
      s.url?.toLowerCase().includes(leagueSlug.toLowerCase()) ||
      s.version?.toLowerCase().includes(leagueSlug.toLowerCase())
    );
    if (!match) {
      throw new Error(`No snapshot version found for league slug "${leagueSlug}". Available: ${state.snapshotVersions.map(s => s.name ?? s.url).join(', ')}`);
    }
    return match.version;
  }

  /**
   * Fetch full character data (gear, gems, jewels, tree, defensive stats, PoB export).
   * Accepts either explicit account+character, or a poe.ninja character URL.
   *
   * URL formats accepted:
   *   https://poe.ninja/poe2/builds/runesofaldur/character/<account>/<character>
   *   https://poe.ninja/poe2/builds/character/<account>/<character>          (deep-link)
   */
  async getCharacterFull(
    leagueSlug: string,
    account: string,
    character: string
  ): Promise<CharacterFull> {
    const cacheKey = `char:${leagueSlug}:${account}:${character}`;
    const cached = this.getFromCache(cacheKey, this.cacheTTL.character);
    if (cached) return cached;

    const version = await this.getVersionForLeague(leagueSlug);
    const url = new URL(`${this.base}/builds/${version}/character`);
    url.searchParams.set('account', account);
    url.searchParams.set('name', character);
    url.searchParams.set('overview', leagueSlug);

    const response = await fetch(url.toString(), {
      headers: {
        ...DEFAULT_HEADERS(leagueSlug),
        'Referer': `https://poe.ninja/poe2/builds/${leagueSlug}/character/${encodeURIComponent(account)}/${encodeURIComponent(character)}`,
      },
    });
    if (!response.ok) {
      throw new Error(`poe.ninja character fetch failed (${response.status}): ${await response.text()}`);
    }
    const data = await response.json();
    this.putInCache(cacheKey, data);
    return data as CharacterFull;
  }

  /**
   * Fetch the base64-encoded PoB code for a character. This is the same code
   * the "Import from poe.ninja" button in PoB generates.
   */
  async getPoBImport(
    leagueSlug: string,
    account: string,
    character: string
  ): Promise<string> {
    const cacheKey = `pob:${leagueSlug}:${account}:${character}`;
    const cached = this.getFromCache(cacheKey, this.cacheTTL.character);
    if (cached) return cached;

    const url = new URL(`${this.base}/builds/pob/import`);
    url.searchParams.set('accountName', account);
    url.searchParams.set('characterName', character);

    const response = await fetch(url.toString(), {
      headers: {
        ...DEFAULT_HEADERS(leagueSlug),
        'Referer': `https://poe.ninja/poe2/builds/character/${encodeURIComponent(account)}/${encodeURIComponent(character)}`,
      },
    });
    if (!response.ok) {
      throw new Error(`poe.ninja PoB import failed (${response.status}): ${await response.text()}`);
    }

    // Response can be raw text or JSON with code/pob/build field
    const text = await response.text();
    let result: string;
    try {
      const parsed = JSON.parse(text);
      result = parsed.code ?? parsed.pob ?? parsed.build ?? text;
    } catch {
      result = text.trim();
    }
    this.putInCache(cacheKey, result);
    return result;
  }

  /**
   * Parse a poe.ninja character URL into {leagueSlug, account, character}.
   * Tolerates both deep-link (no league) and league-prefixed URLs.
   */
  static parseCharacterUrl(url: string): { leagueSlug?: string; account: string; character: string } {
    const m = url.match(/poe\.ninja\/poe2\/builds\/(?:([^/]+)\/)?character\/([^/?#]+)\/([^/?#]+)/);
    if (!m) {
      throw new Error(`Not a poe.ninja PoE2 character URL: ${url}`);
    }
    return {
      leagueSlug: m[1] || undefined,
      account: decodeURIComponent(m[2]),
      character: decodeURIComponent(m[3]),
    };
  }
}
