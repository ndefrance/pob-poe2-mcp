#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { XMLParser } from "fast-xml-parser";
// Import services
import { BuildService } from "./services/buildService.js";
import { TreeService } from "./services/treeService.js";
import { WatchService } from "./services/watchService.js";
import { ValidationService } from "./services/validationService.js";
import { BuildExportService } from "./services/buildExportService.js";
import { SkillGemService } from "./services/skillGemService.js";
import { TradeApiClient } from "./services/tradeClient.js";
import { StatMapper } from "./services/statMapper.js";
import { PoeNinjaClient } from "./services/poeNinjaClient.js";
import { PoeNinjaBuildsClient } from "./services/poeNinjaBuildsClient.js";
import { ItemRecommendationEngine } from "./services/itemRecommendationEngine.js";

// Import types
import type {
  PassiveTreeData,
  PoBBuild,
  TreeAnalysisResult,
} from "./types.js";

// Import utilities
import { ContextBuilder } from "./utils/contextBuilder.js";

// Import server modules
import { ToolGate } from "./server/toolGate.js";
import { LuaClientManager } from "./server/luaClientManager.js";
import { getToolSchemas, getLuaToolSchemas, getOptimizationToolSchemas, getConfigToolSchemas, getValidationToolSchemas, getExportToolSchemas, getSkillGemToolSchemas, getTradeToolSchemas, getPoeNinjaToolSchemas, getBuildGoalsToolSchemas } from "./server/toolSchemas.js";
import { routeToolCall, type ToolRouterDependencies } from "./server/toolRouter.js";
import { wrapWithTruncation } from "./server/responseUtils.js";

class PoBMCPServer {
  private server: Server;
  private pobDirectory: string;
  private parser: XMLParser;

  // Services
  private buildService: BuildService;
  private treeService: TreeService;
  private watchService: WatchService;
  private validationService: ValidationService;
  private exportService: BuildExportService;
  private skillGemService: SkillGemService;
  private tradeClient: TradeApiClient | null = null;
  private statMapper: StatMapper | null = null;
  private recommendationEngine: ItemRecommendationEngine | null = null;
  private ninjaClient: PoeNinjaClient;
  private buildsClient: PoeNinjaBuildsClient;

  // Context builder
  private contextBuilder: ContextBuilder;

  // Server modules
  private toolGate: ToolGate;
  private luaClientManager: LuaClientManager;

  constructor() {
    this.server = new Server(
      {
        name: "pob-mcp-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    // Initialize XML parser
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
    });

    // Default Path of Building directory (can be customized)
    // Auto-detect based on platform
    const defaultPoBPath = process.platform === 'darwin'
      ? path.join(os.homedir(), "Path of Building", "Builds")  // macOS
      : path.join(os.homedir(), "Documents", "Path of Building", "Builds");  // Windows/Linux

    this.pobDirectory = process.env.POB_DIRECTORY || defaultPoBPath;

    // Initialize services
    this.buildService = new BuildService(this.pobDirectory);
    this.treeService = new TreeService(this.buildService);
    this.watchService = new WatchService(this.pobDirectory, this.buildService);
    this.validationService = new ValidationService();
    this.exportService = new BuildExportService(this.pobDirectory);
    this.skillGemService = new SkillGemService();

    // Initialize poe.ninja clients (always available)
    this.ninjaClient = new PoeNinjaClient();
    this.buildsClient = new PoeNinjaBuildsClient();
    console.error('[poe.ninja API] Currency + Builds clients initialized');

    // Initialize Trade API client (if enabled)
    const tradeEnabled = process.env.POE_TRADE_ENABLED === 'true';
    if (tradeEnabled) {
      const requestsPerSecond = parseInt(process.env.POE_RATE_LIMIT_PER_SECOND || '4', 10);
      const cacheTTL = parseInt(process.env.POE_CACHE_TTL || '300', 10);
      this.tradeClient = new TradeApiClient({
        requestsPerSecond,
        cacheTTL,
      });
      this.statMapper = new StatMapper();
      this.recommendationEngine = new ItemRecommendationEngine(this.tradeClient, this.statMapper);
      console.error('[Trade API] Enabled with rate limit:', requestsPerSecond, 'req/s');
      // Best-effort: pull live PoE2 stat IDs at startup so trade queries match
      // current catalog instead of hardcoded PoE1 IDs. Don't await — the static
      // pseudo mappings already cover the most-used queries.
      this.statMapper.loadLivePoE2Stats().catch(() => {});
    } else {
      console.error('[Trade API] Disabled (set POE_TRADE_ENABLED=true to enable)');
    }

    // Initialize server modules
    this.toolGate = new ToolGate();

    const luaEnabled = process.env.POB_LUA_ENABLED === 'true';
    this.luaClientManager = new LuaClientManager(luaEnabled);

    // Initialize context builder
    this.contextBuilder = new ContextBuilder({
      buildService: this.buildService,
      treeService: this.treeService,
      watchService: this.watchService,
      validationService: this.validationService,
      exportService: this.exportService,
      skillGemService: this.skillGemService,
      pobDirectory: this.pobDirectory,
      luaEnabled: luaEnabled,
      getLuaClient: () => this.luaClientManager.getClient(),
      ensureLuaClient: () => this.luaClientManager.ensureClient(),
      stopLuaClient: () => this.luaClientManager.stopClient(),
    });

    if (luaEnabled) {
      console.error('[MCP Server] PoB Lua Bridge enabled (stdio mode)');
    }

    this.setupHandlers();

    // Error handling
    this.server.onerror = (error) => {
      console.error("[MCP Error]", error);
    };

    // Handle EPIPE errors (broken pipe) gracefully
    process.stdout.on('error', (err: any) => {
      if (err.code === 'EPIPE') {
        // Client disconnected, exit gracefully
        process.exit(0);
      } else {
        console.error('stdout error:', err);
      }
    });

    process.stderr.on('error', (err: any) => {
      if (err.code === 'EPIPE') {
        // Client disconnected, exit gracefully
        process.exit(0);
      }
    });

    const shutdown = async () => {
      await this.watchService.stopWatching();
      await this.luaClientManager.stopClient();
      await this.server.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  // Delegate to tool gate module
  private checkToolGate(toolName: string): void {
    this.toolGate.checkGate(toolName);
  }

  private unlockToolGate(): void {
    this.toolGate.unlock();
  }

  // Tree Data Fetching
  private async getTreeData(version: string = "3_26"): Promise<PassiveTreeData> {
    // Delegate to TreeService
    return await this.treeService.getTreeData(version);
  }

  // Tree Analysis Methods
  private getActiveSpec(build: PoBBuild): any {
    // Delegate to BuildService
    return this.buildService.getActiveSpec(build);
  }

  private parseAllocatedNodes(build: PoBBuild): string[] {
    // Delegate to BuildService
    return this.buildService.parseAllocatedNodes(build);
  }

  private extractBuildVersion(build: PoBBuild): string {
    // Delegate to BuildService
    return this.buildService.extractBuildVersion(build);
  }


  private async analyzePassiveTree(build: PoBBuild): Promise<TreeAnalysisResult | null> {
    // Delegate to TreeService
    return await this.treeService.analyzePassiveTree(build);
  }

  private setupHandlers() {
    // List available resources (build files)
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      try {
        const builds = await this.buildService.listBuilds();
        return {
          resources: builds.map((build) => ({
            uri: `pob://build/${encodeURIComponent(build)}`,
            name: build,
            mimeType: "application/xml",
            description: `Path of Building build: ${build}`,
          })),
        };
      } catch (error) {
        console.error("Error listing resources:", error);
        return { resources: [] };
      }
    });

    // Read a specific build file
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const match = uri.match(/^pob:\/\/build\/(.+)$/);

      if (!match) {
        throw new Error(`Invalid URI: ${uri}`);
      }

      const buildName = decodeURIComponent(match[1]);

      try {
        const build = await this.buildService.readBuild(buildName);
        const summary = this.buildService.generateBuildSummary(build);

        return {
          contents: [
            {
              uri,
              mimeType: "text/plain",
              text: summary,
            },
          ],
        };
      } catch (error) {
        throw new Error(`Failed to read build: ${error}`);
      }
    });

    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Get base tools
      const tools: any[] = getToolSchemas();

      // Add Lua tools if enabled
      if (this.luaClientManager.isEnabled()) {
        tools.push(...getLuaToolSchemas());
        tools.push(...getConfigToolSchemas()); // Phase 9: Config tools (require Lua)
        tools.push(...getBuildGoalsToolSchemas()); // Build diagnostics (require Lua)
      }

      // Add optimization tools
      tools.push(...getOptimizationToolSchemas());

      // Add validation tools
      tools.push(...getValidationToolSchemas());

      // Add export and persistence tools
      tools.push(...getExportToolSchemas());

      // Add skill gem analysis tools
      tools.push(...getSkillGemToolSchemas());

      // PoE2 mode (default for this fork): strip PoE1-only tool groups
      // — trade tools, poe.ninja, cluster jewels (cluster jewels are inside trade schemas)
      // Set POE2_MODE=false to re-enable for PoE1-style workflows.
      const isPoE2 = (process.env.POE2_MODE ?? 'true').toLowerCase() !== 'false';

      // Add Trade API tools if enabled — PoE2 has its own trade API at /api/trade2,
      // baseUrl is auto-switched in TradeApiClient based on POE2_MODE
      if (this.tradeClient) {
        tools.push(...getTradeToolSchemas());
      }

      // Add poe.ninja API tools — poe.ninja has PoE2 economy data at /poe2/api/...,
      // baseUrl is auto-switched in PoeNinjaClient based on POE2_MODE
      tools.push(...getPoeNinjaToolSchemas());

      // PoE2 mode: filter out tools that reference PoE1-only concepts (Anomalous/Divergent/
      // Awakened gems, Watcher's Eye, Shaper/Sirus boss roster, 4/5/6-link socket groups, etc.)
      // Keeping them registered would only mislead Claude — better to hide cleanly.
      if (isPoE2) {
        // Conservative gate list — only tools whose core concept doesn't exist in PoE2
        // at all. PoE2 has: Headhunter, Kalandra's Touch, Watcher's Eye, Cluster Jewels,
        // its own trade API (/trade2) and poe.ninja economy data (/poe2). All previously
        // gated trade/market/cluster/watcher tools are now back.
        const poe1OnlyTools = new Set([
          // PoE1 gem quality variants (PoE2 uses uncut-gem cutting + quality scales differently)
          'validate_gem_quality',    // PoE1 Anomalous/Divergent/Phantasmal quality types
          'gem_upgrade_path',        // PoE1 Awakened gem progression (PoE2 has no awakened equivalent)
          // PoE1-specific link aggregation (PoE2 supports work via support panel, not 4/5/6-links)
          'find_optimal_links',      // PoE1 4/5/6-link math
          'optimize_skill_links',    // PoE1 socket-link slot optimization
          // PoE1 campaign / endgame structure
          // plan_leveling re-enabled in POE2_MODE — rewritten for PoE2's 3-act + Cruel structure with real boss roster
          // check_boss_readiness re-enabled in POE2_MODE — boss roster rewritten for PoE2 pinnacles
          // PoE1 crafting bench
          'suggest_crafting',
        ]);
        return { tools: tools.filter(t => !poe1OnlyTools.has(t.name)) };
      }

      return { tools };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        // Build router dependencies
        const routerDeps: ToolRouterDependencies = {
          toolGate: this.toolGate,
          contextBuilder: this.contextBuilder,
          tradeClient: this.tradeClient,
          statMapper: this.statMapper,
          recommendationEngine: this.recommendationEngine,
          ninjaClient: this.ninjaClient,
          buildsClient: this.buildsClient,
          getLuaClient: () => this.luaClientManager.getClient(),
          ensureLuaClient: () => this.luaClientManager.ensureClient(),
        };

        // Route the tool call
        const result = await routeToolCall(name, args, routerDeps);

        // Apply truncation for specific tools that return large outputs
        const truncatedTools = ['analyze_build', 'analyze_defenses', 'suggest_optimal_nodes',
                                'optimize_tree', 'analyze_items', 'optimize_skill_links',
                                'create_budget_build', 'search_trade_items', 'find_item_upgrades',
                                'find_resistance_gear', 'compare_trade_items', 'search_cluster_jewels',
                                'generate_shopping_list',
                                // Additional tools that can produce large responses:
                                'validate_build', 'get_passive_upgrades', 'analyze_skill_links',
                                'suggest_support_gems', 'find_optimal_links', 'compare_gem_setups',
                                'lua_get_stats', 'suggest_masteries'];

        if (truncatedTools.includes(name)) {
          return wrapWithTruncation(result);
        }

        return result;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        // Log full stack trace for debugging
        console.error(`[Tool Error] tool=${name} error=${errorMsg}`);
        if (error instanceof Error && error.stack) {
          console.error(`[Tool Stack] ${error.stack}`);
        }
        return {
          content: [
            {
              type: "text",
              text: `Error: ${errorMsg}`,
            },
          ],
        };
      }
    });
  }

  /**
   * Initialize async components
   */
  private async initialize() {
    // Load official stat data from PoE trade API (if enabled)
    if (this.tradeClient && this.statMapper) {
      try {
        console.error('[StatMapper] Loading stats from PoE trade API...');
        const statData = await this.tradeClient.getStatData();
        await this.statMapper.loadFromTradeAPI(statData);
        console.error('[StatMapper] Successfully loaded official stat data');
      } catch (error) {
        console.error('[StatMapper] Failed to load official stats, using static fallback:', error);
        // Static mappings already loaded in constructor as fallback
      }
    }
  }

  async run() {
    // Initialize async components first
    await this.initialize();

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Path of Building MCP Server running on stdio");
  }
}

// Start the server
const server = new PoBMCPServer();
server.run().catch(console.error);
