import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp } from 'lucide-react';
import { useTreeModeProfile } from '../../hooks/useGlobalStats';
import { usePersistentState } from '../../hooks/usePersistentState';
import { calculateStats, type AggregatedStats, type StatSensitivity } from '../../utils/statEngine';
import { playerCombatStats } from '../../engine/mapStats';
import { getStatName } from '../../utils/statNames';
import { cn } from '../../lib/utils';

type SortColumn = 'combinedScore' | 'dpsChange' | 'healingHpsChange' | 'effectiveHpsChange' | 'maximumHealthChange';

const SORT_COLUMNS: { value: SortColumn; label: string }[] = [
    { value: 'combinedScore', label: 'Combined score (DPS-eq)' },
    { value: 'dpsChange', label: 'DPS change' },
    { value: 'healingHpsChange', label: 'Healing HPS change' },
    { value: 'effectiveHpsChange', label: 'Block-prevented effective HPS' },
    { value: 'maximumHealthChange', label: 'Maximum HP change' },
];

interface ScorePreferences {
    survivalHpsRate: number;
    maximumHealthRate: number;
}

interface SensitivityRow {
    id: string;
    label: string;
    incrementLabel: string;
    dpsChange: number;
    healingHpsChange: number;
    effectiveHpsChange: number;
    maximumHealthChange: number;
    inactiveReason?: string;
}

const DEFAULT_SCORE_PREFERENCES: ScorePreferences = {
    survivalHpsRate: 1,
    maximumHealthRate: 0,
};

const SCORE_PREFERENCES_KEY = 'fm_stat_value_score_preferences';

function normalizeScorePreferences(preferences: Partial<ScorePreferences> | null | undefined): ScorePreferences {
    return {
        survivalHpsRate: typeof preferences?.survivalHpsRate === 'number'
            && Number.isFinite(preferences.survivalHpsRate) && preferences.survivalHpsRate >= 0
            ? preferences.survivalHpsRate
            : DEFAULT_SCORE_PREFERENCES.survivalHpsRate,
        maximumHealthRate: typeof preferences?.maximumHealthRate === 'number'
            && Number.isFinite(preferences.maximumHealthRate) && preferences.maximumHealthRate >= 0
            ? preferences.maximumHealthRate
            : DEFAULT_SCORE_PREFERENCES.maximumHealthRate,
    };
}

function mirrorBlockableDamagePerSecond(stats: AggregatedStats): number {
    return Math.max(
        0,
        stats.weaponDps + stats.skillDps + stats.theoreticalSkillBuffDps
    );
}

function blockPreventedHps(defenderStats: AggregatedStats, incomingDamagePerSecond: number): number {
    const defender = playerCombatStats(defenderStats);
    const dodgeChance = Math.min(1, Math.max(0, defender.dodgeChance ?? 0));
    const blockChance = Math.min(1, Math.max(0, defender.blockChance ?? 0));
    return incomingDamagePerSecond * (1 - dodgeChance) * blockChance;
}

const DISPLAY_NAMES: Record<string, string> = {
    CriticalChance: 'Critical Chance',
    CriticalMulti: 'Critical Damage',
    BlockChance: 'Block Chance',
    HealthRegen: 'Health Regeneration',
    LifeSteal: 'Lifesteal',
    DoubleDamageChance: 'Double Damage Chance',
    DamageMulti: 'Damage Multiplier',
    MeleeDamageMulti: 'Melee Damage Multiplier',
    RangedDamageMulti: 'Ranged Damage Multiplier',
    AttackSpeed: 'Attack Speed',
    SkillDamageMulti: 'Skill Damage Multiplier',
    SkillCooldownMulti: 'Skill Cooldown',
    HealthMulti: 'Health Multiplier',
};

function formatChange(value: number, compact = false): string {
    const absoluteValue = Math.abs(value);
    const formattedValue = compact && absoluteValue >= 1000
        ? absoluteValue.toLocaleString(undefined, { notation: 'compact', maximumSignificantDigits: 3 })
        : absoluteValue.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return `${value < 0 ? '−' : '+'}${formattedValue}`;
}

function formatExactChange(value: number): string {
    const exactValue = Math.abs(value).toLocaleString(undefined, { maximumSignificantDigits: 21 });
    return `${value < 0 ? '−' : '+'}${exactValue}`;
}

function ChangeValue({ label, value, compact = false, className }: {
    label: string;
    value: number;
    compact?: boolean;
    className?: string;
}) {
    const exactValue = formatExactChange(value);
    return (
        <span
            className={cn(className, compact && 'rounded-sm focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-primary')}
            title={compact ? `${label}: ${exactValue}` : undefined}
            aria-label={compact ? `${label}: ${exactValue}` : undefined}
            tabIndex={compact ? 0 : undefined}
        >
            {formatChange(value, compact)}
        </span>
    );
}

function inactiveReason(statId: string, isRanged: boolean, hasSkills: boolean): string | undefined {
    if (statId === 'MeleeDamageMulti' && isRanged) return 'Inactive: this profile uses a ranged weapon.';
    if (statId === 'RangedDamageMulti' && !isRanged) return 'Inactive: this profile uses a melee weapon.';
    if ((statId === 'SkillDamageMulti' || statId === 'SkillCooldownMulti') && !hasSkills) {
        return 'Inactive: no skills are equipped.';
    }
    return undefined;
}

export function StatValuePanel() {
    const { profile, libs, ready } = useTreeModeProfile();
    const panelRef = useRef<HTMLElement>(null);
    const [storedPreferences, setStoredPreferences] = usePersistentState<ScorePreferences>(
        SCORE_PREFERENCES_KEY,
        DEFAULT_SCORE_PREFERENCES
    );
    const [isCompact, setIsCompact] = useState(true);
    const preferences = normalizeScorePreferences(storedPreferences);
    const [survivalRateInput, setSurvivalRateInput] = useState(String(preferences.survivalHpsRate));
    const [maximumHealthRateInput, setMaximumHealthRateInput] = useState(String(preferences.maximumHealthRate));
    const [sortColumn, setSortColumn] = useState<SortColumn>('combinedScore');
    const [sortDescending, setSortDescending] = useState(true);
    const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());

    useEffect(() => {
        const panel = panelRef.current;
        if (!panel) return;

        const observer = new ResizeObserver(entries => {
            setIsCompact(entries[0].contentRect.width < 1000);
        });
        observer.observe(panel);
        return () => observer.disconnect();
    }, []);

    const rows = useMemo((): SensitivityRow[] => {
        if (!ready || !libs.secondaryStatLibrary) return [];

        const baseline = calculateStats(profile, libs, false);
        const baselineDps = baseline.averageTotalDps;
        const baselineHealingHps = baseline.realTotalHps;
        const mirrorDamagePerSecond = mirrorBlockableDamagePerSecond(baseline);
        const baselineEffectiveHps = blockPreventedHps(baseline, mirrorDamagePerSecond);
        const hasSkills = baseline.skillBreakdown.length > 0;
        const runSensitivity = (
            id: string,
            label: string,
            incrementLabel: string,
            sensitivity: StatSensitivity,
            reason?: string
        ) => {
            const changed = calculateStats(profile, libs, false, { sensitivity });
            return {
                id,
                label,
                incrementLabel,
                dpsChange: changed.averageTotalDps - baselineDps,
                healingHpsChange: changed.realTotalHps - baselineHealingHps,
                effectiveHpsChange: blockPreventedHps(changed, mirrorDamagePerSecond) - baselineEffectiveHps,
                maximumHealthChange: changed.totalHealth - baseline.totalHealth,
                inactiveReason: reason,
            };
        };

        const passiveRows = Object.entries(
            libs.secondaryStatLibrary as Record<string, { UpperRange?: number }>
        )
            .filter(([, stat]) => typeof stat.UpperRange === 'number' && stat.UpperRange > 0)
            .map(([statId]) => runSensitivity(
                statId,
                DISPLAY_NAMES[statId] || getStatName(statId),
                '+1 percentage point',
                { secondaryStats: { [statId]: 1 } },
                inactiveReason(statId, baseline.isRangedWeapon, hasSkills)
            ));

        return [
            runSensitivity('weaponDamage', 'Weapon Damage', '+1 displayed unit', { weaponDamage: 1 }),
            runSensitivity('maximumHealth', 'Maximum Health', '+1 displayed unit', { maximumHealth: 1 }),
            ...passiveRows,
        ];
    }, [libs, profile, ready]);

    const scoredRows = useMemo(() => rows.map(row => ({
        ...row,
        combinedScore: row.dpsChange
            + preferences.survivalHpsRate * (row.healingHpsChange + row.effectiveHpsChange)
            + preferences.maximumHealthRate * row.maximumHealthChange,
    })), [preferences, rows]);

    const sortedRows = useMemo(() => [...scoredRows].sort((a, b) => {
        const difference = a[sortColumn] - b[sortColumn];
        return (sortDescending ? -difference : difference) || a.label.localeCompare(b.label);
    }), [scoredRows, sortColumn, sortDescending]);

    const updateRate = (field: keyof ScorePreferences, input: string) => {
        const value = Number(input);
        if (input.trim() !== '' && Number.isFinite(value) && value >= 0) {
            setStoredPreferences(current => ({ ...normalizeScorePreferences(current), [field]: value }));
        }
    };

    const resetInvalidRate = (field: keyof ScorePreferences) => {
        if (field === 'survivalHpsRate') {
            setSurvivalRateInput(String(preferences.survivalHpsRate));
        } else {
            setMaximumHealthRateInput(String(preferences.maximumHealthRate));
        }
    };

    const changeSort = (column: SortColumn) => {
        if (column === sortColumn) {
            setSortDescending(value => !value);
        } else {
            setSortColumn(column);
            setSortDescending(true);
        }
    };

    const toggleExpanded = (rowId: string) => {
        setExpandedRows(current => {
            const next = new Set(current);
            if (next.has(rowId)) next.delete(rowId);
            else next.add(rowId);
            return next;
        });
    };

    const sortButton = (column: SortColumn, title: string) => (
        <button
            type="button"
            onClick={() => changeSort(column)}
            className="inline-flex items-center justify-end gap-1 text-right hover:text-text-primary"
            aria-label={`Sort by ${title}`}
            aria-pressed={sortColumn === column}
        >
            {title}
            {sortColumn === column && (sortDescending
                ? <ArrowDown className="w-3 h-3" />
                : <ArrowUp className="w-3 h-3" />)}
        </button>
    );

    if (!ready || !libs.secondaryStatLibrary) {
        return <div className="rounded-xl border border-border/40 bg-bg-input/20 p-4 text-sm text-text-muted">Loading game stats…</div>;
    }

    return (
        <section ref={panelRef} className="w-full min-w-0 space-y-4" aria-labelledby="stat-value-title">
            <header className="space-y-2">
                <div>
                    <h2 id="stat-value-title" className="text-lg font-bold text-text-primary">Stat Value</h2>
                    <p className="text-xs text-text-muted">Marginal changes for {profile.name}'s current full profile.</p>
                </div>
                <div className="rounded-xl border border-accent-primary/20 bg-accent-primary/5 p-3 text-xs leading-relaxed text-text-muted">
                    These are quick-screening estimates for this profile, not universal rankings or predictions for a specific weapon.
                    Rows change one input at a time; summing them is not an exact whole-build result. Use Compare Build for an exact candidate-build check.
                    Attack Speed uses a smooth average estimate, not an exact breakpoint prediction.
                    Effective HPS is expected incoming weapon and skill damage prevented by block against a mirror profile; dodge is applied first, and reflect is excluded.
                </div>
            </header>

            <details className="rounded-xl border border-border/40 bg-bg-input/20 p-3">
                <summary className="cursor-pointer list-none text-sm font-semibold text-text-primary [&::-webkit-details-marker]:hidden">
                    <span className="inline-flex items-center gap-2">
                        <ChevronDown className="h-4 w-4" />
                        Scoring weights
                    </span>
                </summary>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                    <label className="flex min-w-0 flex-col gap-1 text-xs text-text-muted">
                        <span>Survival HPS exchange rate (DPS-eq per HPS)</span>
                        <input
                            type="number"
                            min="0"
                            step="any"
                            inputMode="decimal"
                            value={survivalRateInput}
                            onChange={event => {
                                setSurvivalRateInput(event.target.value);
                                updateRate('survivalHpsRate', event.target.value);
                            }}
                            onBlur={() => resetInvalidRate('survivalHpsRate')}
                            aria-label="Survival HPS exchange rate"
                            className="w-full max-w-40 rounded-lg border border-border/50 bg-bg-secondary px-2.5 py-1.5 text-sm text-text-primary"
                        />
                    </label>
                    <label className="flex min-w-0 flex-col gap-1 text-xs text-text-muted">
                        <span>Maximum HP exchange rate (DPS-eq per HP)</span>
                        <input
                            type="number"
                            min="0"
                            step="any"
                            inputMode="decimal"
                            value={maximumHealthRateInput}
                            onChange={event => {
                                setMaximumHealthRateInput(event.target.value);
                                updateRate('maximumHealthRate', event.target.value);
                            }}
                            onBlur={() => resetInvalidRate('maximumHealthRate')}
                            aria-label="Maximum HP exchange rate"
                            className="w-full max-w-40 rounded-lg border border-border/50 bg-bg-secondary px-2.5 py-1.5 text-sm text-text-primary"
                        />
                    </label>
                    <p className="min-w-0 flex-1 text-xs text-text-muted">
                        Score = DPS change + rate × (healing HPS + effective HPS) + HP rate × maximum HP change.
                        Survival rate defaults to 1:1; maximum HP rate defaults to 0. Rates are saved across profiles and visits.
                    </p>
                </div>
            </details>

            {isCompact ? (
                <div className="min-w-0 overflow-hidden rounded-xl border border-border/40">
                    <div className="flex min-w-0 items-center gap-2 border-b border-border/30 bg-bg-input/40 p-2">
                        <label htmlFor="stat-value-sort" className="shrink-0 text-xs font-semibold text-text-muted">Sort by</label>
                        <select
                            id="stat-value-sort"
                            value={sortColumn}
                            onChange={event => {
                                setSortColumn(event.target.value as SortColumn);
                                setSortDescending(true);
                            }}
                            className="min-w-0 flex-1 rounded-lg border border-border/50 bg-bg-secondary px-2 py-1.5 text-xs text-text-primary"
                        >
                            {SORT_COLUMNS.map(column => (
                                <option key={column.value} value={column.value}>{column.label}</option>
                            ))}
                        </select>
                        <button
                            type="button"
                            onClick={() => setSortDescending(value => !value)}
                            aria-label={`Sort ${sortDescending ? 'descending' : 'ascending'}`}
                            className="rounded-lg border border-border/50 p-1.5 text-text-muted hover:text-text-primary focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-primary"
                        >
                            {sortDescending ? <ArrowDown className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
                        </button>
                    </div>
                    <ul className="divide-y divide-border/30">
                        {sortedRows.map(row => {
                            const isExpanded = expandedRows.has(row.id);
                            const detailsId = `stat-value-details-${row.id}`;
                            return (
                                <li key={row.id} className={cn('min-w-0 p-3', row.inactiveReason && 'bg-bg-input/15')}>
                                    <div className="flex min-w-0 items-start gap-2">
                                        <button
                                            type="button"
                                            onClick={() => toggleExpanded(row.id)}
                                            aria-expanded={isExpanded}
                                            aria-controls={detailsId}
                                            aria-label={`${isExpanded ? 'Hide' : 'Show'} details for ${row.label}`}
                                            className="mt-0.5 shrink-0 rounded p-1 text-text-muted hover:text-text-primary focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-primary"
                                        >
                                            {isExpanded
                                                ? <ChevronUp className="h-4 w-4" />
                                                : <ChevronDown className="h-4 w-4" />}
                                        </button>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex min-w-0 items-baseline justify-between gap-2">
                                                <span className="min-w-0 break-words font-medium text-text-primary">{row.label}</span>
                                                <span className="shrink-0 text-right font-mono font-semibold text-text-primary">
                                                    <ChangeValue label="Combined score (DPS-eq)" value={row.combinedScore} compact />
                                                    <span className="ml-1 text-[10px] font-normal text-text-muted">DPS-eq</span>
                                                </span>
                                            </div>
                                            <div className="mt-0.5 text-[10px] text-text-muted">{row.incrementLabel}</div>
                                            {row.id === 'AttackSpeed' && (
                                                <div className="mt-0.5 text-[10px] text-text-muted">Average estimate</div>
                                            )}
                                            {row.inactiveReason && (
                                                <div className="mt-0.5 break-words text-[10px] text-amber-400">{row.inactiveReason}</div>
                                            )}
                                            {!row.inactiveReason && row.dpsChange === 0 && row.healingHpsChange === 0 && row.effectiveHpsChange === 0 && row.maximumHealthChange === 0 && (
                                                <div className="mt-0.5 text-[10px] text-text-muted">No change to shown outcomes</div>
                                            )}
                                        </div>
                                    </div>
                                    {isExpanded && (
                                        <dl id={detailsId} className="mt-3 grid grid-cols-2 gap-2 pl-8">
                                            <div className="min-w-0 rounded-lg bg-bg-input/40 p-2">
                                                <dt className="text-[10px] text-text-muted">DPS change</dt>
                                                <dd className="break-all font-mono text-sm text-orange-300">
                                                    <ChangeValue label="DPS change" value={row.dpsChange} compact />
                                                </dd>
                                            </div>
                                            <div className="min-w-0 rounded-lg bg-bg-input/40 p-2">
                                                <dt className="text-[10px] text-text-muted">Healing HPS change</dt>
                                                <dd className="break-all font-mono text-sm text-emerald-300">
                                                    <ChangeValue label="Healing HPS change" value={row.healingHpsChange} compact />
                                                </dd>
                                            </div>
                                            <div className="min-w-0 rounded-lg bg-bg-input/40 p-2">
                                                <dt className="text-[10px] text-text-muted">Block-prevented effective HPS</dt>
                                                <dd className="break-all font-mono text-sm text-cyan-300">
                                                    <ChangeValue label="Block-prevented effective HPS change" value={row.effectiveHpsChange} compact />
                                                </dd>
                                            </div>
                                            <div className="min-w-0 rounded-lg bg-bg-input/40 p-2">
                                                <dt className="text-[10px] text-text-muted">Maximum HP change</dt>
                                                <dd className="break-all font-mono text-sm text-green-300">
                                                    <ChangeValue label="Maximum HP change" value={row.maximumHealthChange} compact />
                                                </dd>
                                            </div>
                                        </dl>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            ) : (
            <div className="min-w-0 overflow-hidden rounded-xl border border-border/40">
                <table className="w-full table-fixed border-collapse text-sm">
                    <thead className="bg-bg-input/40 text-xs text-text-muted">
                        <tr>
                            <th scope="col" className="px-3 py-2 text-left font-semibold">Stat / increment</th>
                            <th scope="col" className="px-3 py-2 text-right font-semibold">{sortButton('dpsChange', 'DPS change')}</th>
                            <th scope="col" className="px-3 py-2 text-right font-semibold">{sortButton('healingHpsChange', 'Healing HPS change')}</th>
                            <th scope="col" className="px-3 py-2 text-right font-semibold">{sortButton('effectiveHpsChange', 'Block-prevented effective HPS')}</th>
                            <th scope="col" className="px-3 py-2 text-right font-semibold">{sortButton('maximumHealthChange', 'Maximum HP change')}</th>
                            <th scope="col" className="px-3 py-2 text-right font-semibold">{sortButton('combinedScore', 'Combined score (DPS-eq)')}</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border/30">
                        {sortedRows.map(row => (
                            <tr key={row.id} className={cn(row.inactiveReason && 'bg-bg-input/15')}>
                                <th scope="row" className="px-3 py-2.5 text-left font-medium text-text-primary">
                                    <div>{row.label}</div>
                                    <div className="mt-0.5 text-[10px] font-normal text-text-muted">{row.incrementLabel}</div>
                                    {row.id === 'AttackSpeed' && (
                                        <div className="mt-0.5 text-[10px] font-normal text-text-muted">Average estimate</div>
                                    )}
                                    {row.inactiveReason && (
                                        <div className="mt-0.5 text-[10px] font-normal text-amber-400">{row.inactiveReason}</div>
                                    )}
                                    {!row.inactiveReason && row.dpsChange === 0 && row.healingHpsChange === 0 && row.effectiveHpsChange === 0 && row.maximumHealthChange === 0 && (
                                        <div className="mt-0.5 text-[10px] font-normal text-text-muted">No change to shown outcomes</div>
                                    )}
                                </th>
                                <td className="break-words px-2 py-2.5 text-right font-mono text-orange-300"><ChangeValue label="DPS change" value={row.dpsChange} /></td>
                                <td className="break-words px-2 py-2.5 text-right font-mono text-emerald-300"><ChangeValue label="Healing HPS change" value={row.healingHpsChange} /></td>
                                <td className="break-words px-2 py-2.5 text-right font-mono text-cyan-300"><ChangeValue label="Block-prevented effective HPS change" value={row.effectiveHpsChange} /></td>
                                <td className="break-words px-2 py-2.5 text-right font-mono text-green-300"><ChangeValue label="Maximum HP change" value={row.maximumHealthChange} /></td>
                                <td className="px-3 py-2.5 text-right font-mono font-semibold text-text-primary">
                                    <ChangeValue label="Combined score (DPS-eq)" value={row.combinedScore} /> <span className="text-[10px] font-normal text-text-muted">DPS-eq</span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            )}
        </section>
    );
}
