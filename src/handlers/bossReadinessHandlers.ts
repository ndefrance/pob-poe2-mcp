import type { PoBLuaApiClient } from "../pobLuaBridge.js";
import { wrapHandler } from "../utils/errorHandling.js";

export interface BossReadinessContext {
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

interface BossThreshold {
  name: string;
  minLife: number;
  minDPS: number;
  minEHP: number;
  notes: string[];
  mechanics: string[];
}

// PoE2 pinnacle/notable encounters as of tree 0_4.
// Life/DPS thresholds reflect PoE2's lower HP scaling (1500-3000 life is common endgame).
// DPS thresholds reflect PoE2's longer fights and stricter damage windows.
const BOSS_THRESHOLDS: Record<string, BossThreshold> = {
  arbiter: {
    name: 'The Arbiter of Ash',
    minLife: 2000, minDPS: 400_000, minEHP: 12_000,
    notes: ['Fire pinnacle — fire resist 75% mandatory, overcap to mitigate -res penalty', 'Stays in melee range; movement skills help reposition'],
    mechanics: ['Fire ground patches persist — keep moving', 'Telegraphed slam — sidestep on windup', 'Adds spawn during phases — clear or ignore based on DPS budget'],
  },
  king_in_the_mists: {
    name: 'The King in the Mists',
    minLife: 2200, minDPS: 500_000, minEHP: 14_000,
    notes: ['Cold + chaos damage — cap both resists; chaos at 75% strongly recommended in PoE2', 'Slowing mists drain mobility — invest in some skill speed'],
    mechanics: ['Mist circles — stand in safe zones marked by absent fog', 'Phase transitions reset positioning', 'Spectral adds chase the player'],
  },
  trialmaster: {
    name: 'The Trialmaster (Trial of Chaos)',
    minLife: 2000, minDPS: 350_000, minEHP: 11_000,
    notes: ['Damage type rotates per trial — bring balanced resistances, not just one element', 'Multi-round encounter — sustain matters more than burst'],
    mechanics: ['Trial modifiers stack across rounds — read each one', 'Multiple damage types in sequence — flask up before each round', 'Honour drains on hit — minimise damage taken'],
  },
  xesht: {
    name: 'Xesht, We That Are One',
    minLife: 2200, minDPS: 600_000, minEHP: 14_000,
    notes: ['Chaos pinnacle — chaos res to 75% is mandatory, not optional', 'Phys-chaos hybrid hits punish low chaos res builds hard'],
    mechanics: ['Multiple eye/tentacle adds — prioritize correct ones per phase', 'Reality-warp visuals can mask telegraphs — listen for audio cues', 'Phase transition tentacle dive — get away from the centre'],
  },
  olroth: {
    name: 'Olroth, Originator of the Tale',
    minLife: 2200, minDPS: 550_000, minEHP: 13_000,
    notes: ['Cold-heavy with phys overlap — cold cap + good armour/PDR work well', 'Mid-fight phase shifts — bring multi-target capability'],
    mechanics: ['Ice spike volleys — projectile evasion helps', 'Telegraphed slam circles', 'Summons skeletal/cold add waves'],
  },
  zarokh: {
    name: 'Zarokh, the Temporal',
    minLife: 2300, minDPS: 700_000, minEHP: 14_000,
    notes: ['Lightning + temporal mechanics — lightning cap mandatory, slows hurt single-target windows', 'High damage burst phases'],
    mechanics: ['Temporal slow zones — get out fast', 'Lightning storm patterns rotate around arena', 'Damage windows are short — burst with all combat buffs active'],
  },
  pinnacle: {
    name: 'Generic PoE2 Pinnacle',
    minLife: 2000, minDPS: 500_000, minEHP: 12_000,
    notes: ['Generic endgame readiness check', 'PoE2: chaos res caps at 75% like other elements — aim to cap if possible'],
    mechanics: ['All elemental resists at 75% mandatory', 'Charm + Flask uptime matters in PoE2', 'Ailment threshold (life pool) determines freeze/stun resistance'],
  },
};

const BOSS_ALIASES: Record<string, string> = {
  'the arbiter': 'arbiter',
  'arbiter of ash': 'arbiter',
  'king': 'king_in_the_mists',
  'mists': 'king_in_the_mists',
  'king of the mists': 'king_in_the_mists',
  'trial of chaos': 'trialmaster',
  'chaos trial': 'trialmaster',
  'xesht': 'xesht',
  'we that are one': 'xesht',
  'olroth': 'olroth',
  'zarokh': 'zarokh',
  'temporal': 'zarokh',
  'endgame': 'pinnacle',
  'generic': 'pinnacle',
  'pinnacle': 'pinnacle',
};

export async function handleCheckBossReadiness(context: BossReadinessContext, boss: string) {
  return wrapHandler('check boss readiness', async () => {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_load_build first.');

  const key = BOSS_ALIASES[boss.toLowerCase()] ?? boss.toLowerCase().replace(/\s+/g, '_');
  const threshold = BOSS_THRESHOLDS[key] ?? BOSS_THRESHOLDS['pinnacle'];

  const stats = await luaClient.getStats([
    'Life', 'TotalEHP', 'EnergyShield',
    'TotalDPS', 'CombinedDPS', 'FullDPS', 'MinionTotalDPS',
    'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
    'EffectiveSpellSuppressionChance',
    'Armour', 'PhysicalDamageReduction',
    'Spirit',
  ]);

  const life = Number(stats.Life ?? 0);
  const ehp = Number(stats.TotalEHP ?? life);
  const dps = Number(stats.CombinedDPS ?? stats.TotalDPS ?? stats.MinionTotalDPS ?? 0);
  const fireRes = Number(stats.FireResist ?? -60);
  const coldRes = Number(stats.ColdResist ?? -60);
  const lightRes = Number(stats.LightningResist ?? -60);
  const chaosRes = Number(stats.ChaosResist ?? -60);

  interface StatCheck {
    label: string;
    value: string;
    pass: boolean;
    critical: boolean;
  }

  const checks: StatCheck[] = [
    {
      label: 'Life',
      value: life.toLocaleString(),
      pass: life >= threshold.minLife,
      critical: life < threshold.minLife * 0.7,
    },
    {
      label: 'Effective HP',
      value: ehp.toLocaleString(),
      pass: ehp >= threshold.minEHP,
      critical: ehp < threshold.minEHP * 0.6,
    },
    {
      label: 'DPS',
      value: dps.toLocaleString(),
      pass: dps >= threshold.minDPS,
      critical: dps < threshold.minDPS * 0.3,
    },
    ...(['Fire', 'Cold', 'Lightning'] as const).map(elem => {
      const val = elem === 'Fire' ? fireRes : elem === 'Cold' ? coldRes : lightRes;
      return { label: `${elem} Resist`, value: `${val}%`, pass: val >= 75, critical: val < 50 };
    }),
    {
      label: 'Chaos Resist',
      value: `${chaosRes}%`,
      // PoE2: chaos resist caps at 75% same as elemental, so use 75 as target
      pass: chaosRes >= 75,
      critical: chaosRes < 30,
    },
  ];

  const passed = checks.filter(c => c.pass).length;
  const criticalFails = checks.filter(c => !c.pass && c.critical);
  const minorFails = checks.filter(c => !c.pass && !c.critical);
  const ready = passed === checks.length;

  let output = `=== Boss Readiness: ${threshold.name} ===\n\n`;
  output += ready
    ? `✅ **READY** — all ${checks.length} checks pass\n\n`
    : `❌ **NOT READY** — ${checks.length - passed}/${checks.length} checks failed\n\n`;

  output += '**Stat Checks:**\n';
  for (const c of checks) {
    const icon = c.pass ? '✅' : c.critical ? '🔴' : '🟡';
    const req =
      c.label === 'Life'         ? ` (need ${threshold.minLife.toLocaleString()}+)` :
      c.label === 'Effective HP' ? ` (need ${threshold.minEHP.toLocaleString()}+)` :
      c.label === 'DPS'          ? ` (need ~${threshold.minDPS.toLocaleString()}+)` :
      c.label === 'Chaos Resist' ? ' (need 75% in PoE2)' :
                                    ' (need 75%)';
    output += `  ${icon} ${c.label}: ${c.value}${req}\n`;
  }

  if (criticalFails.length > 0) {
    output += `\n**Critical Gaps (fix before attempting):**\n`;
    for (const f of criticalFails) output += `  🔴 ${f.label} is dangerously low\n`;
  }
  if (minorFails.length > 0) {
    output += `\n**Recommended Improvements:**\n`;
    for (const f of minorFails) output += `  🟡 ${f.label} below threshold\n`;
  }

  output += `\n**Boss-Specific Notes:**\n`;
  for (const note of threshold.notes) output += `  - ${note}\n`;
  output += `\n**Key Mechanics to Know:**\n`;
  for (const m of threshold.mechanics) output += `  - ${m}\n`;

  return { content: [{ type: 'text' as const, text: output }] };
  });
}
