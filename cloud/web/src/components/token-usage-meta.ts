function finiteNumber(value) {
    if (value == null) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function formatK(n) {
    if (n == null) return '?';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
    return String(n);
}

function formatTokenUsagePart(label, value) {
    const numeric = finiteNumber(value);
    return numeric != null ? `${label} ${formatK(numeric)}` : null;
}

export function resolveComposeTokenUsageMeta(contextUsage) {
    if (!contextUsage || typeof contextUsage !== 'object') return null;
    const context = contextUsage.context && typeof contextUsage.context === 'object'
        ? contextUsage.context
        : {
            used: contextUsage.tokens,
            total: contextUsage.contextWindow ?? contextUsage.context_window,
            percent: contextUsage.percent,
        };
    const daily = contextUsage.dailyQuota && typeof contextUsage.dailyQuota === 'object'
        ? contextUsage.dailyQuota
        : null;
    const totals = contextUsage.sessionUsage?.totals && typeof contextUsage.sessionUsage.totals === 'object'
        ? contextUsage.sessionUsage.totals
        : contextUsage.cacheUsage?.totals;
    const bySource = contextUsage.sessionUsage?.bySource && typeof contextUsage.sessionUsage.bySource === 'object'
        ? contextUsage.sessionUsage.bySource
        : {};
    const parts = [
        finiteNumber(context?.used) != null && finiteNumber(context?.total) != null
            ? `Context ${formatK(context.used)} / ${formatK(context.total)} · ${Math.round(finiteNumber(context.percent) ?? 0)}%`
            : null,
        daily && finiteNumber(daily.used) != null && finiteNumber(daily.total) != null
            ? `Daily ${formatK(daily.used)} / ${formatK(daily.total)} · ${Math.round(finiteNumber(daily.percent) ?? 0)}%`
            : null,
        totals
            ? [
                formatTokenUsagePart('In', totals.inputTokens),
                formatTokenUsagePart('Out', totals.outputTokens),
                formatTokenUsagePart('Cache R', totals.cacheReadTokens),
                formatTokenUsagePart('Cache W', totals.cacheWriteTokens),
            ].filter(Boolean).join(' · ')
            : null,
    ].filter(Boolean);
    if (parts.length === 0) return null;
    const sourceLabels = {
        assistant: 'Main Agent',
        side_prompt: 'Side Prompt',
        subagent: 'Subagent',
        compaction: 'Compaction',
    };
    const sourceParts = Object.entries(bySource).map(([source, usage]) => {
        const sourceTotal = finiteNumber(usage?.totalTokens)
            ?? ((finiteNumber(usage?.inputTokens) ?? 0) + (finiteNumber(usage?.outputTokens) ?? 0));
        return `${sourceLabels[source] || source}: ${formatK(sourceTotal)}`;
    });
    return {
        label: parts.join('  •  '),
        title: [...parts, ...sourceParts].join(' • '),
        contextPercent: finiteNumber(context?.percent),
        dailyPercent: finiteNumber(daily?.percent),
    };
}
