/**
 * Markdown formatting helpers tuned for LLM consumption.
 *
 * Design rules
 *   - Always include the canonical BuyGit URL so the LLM can paste it as
 *     a clickable link without an extra tool call.
 *   - Compact. ≤ ~4KB per tool response. LLMs chain tool calls when they
 *     need detail; we don't need to inline everything.
 *   - Stable shape: bold names, bullets, single dot separators. LLMs
 *     learn this once and reproduce it accurately on follow-ups.
 *   - Never strip the slug — the next tool call (`buygit_get_listing`)
 *     keys off it.
 */

export type LicenseCategory =
  | 'permissive'
  | 'weak-copyleft'
  | 'strong-copyleft'
  | 'public-domain'
  | 'proprietary'
  | 'unknown';

export interface Signals {
  license_category: LicenseCategory;
  license_warning: string | null;
  popularity: number;
  risk: number;
  price_usd: number;
  pricing_tier: 'free' | 'paid';
}

export interface ListingSummary {
  id: string;
  slug: string;
  title: string;
  short_description: string;
  source: string;
  source_url: string | null;
  repo_url: string | null;
  license: string | null;
  stars: number;
  forks: number;
  language: string | null;
  category: { slug: string; name: string } | null;
  tags: string[];
  rating: number | null;
  last_commit_at: string | null;
  created_at: string;
  url: string;
  signals?: Signals;
}

export interface ListingDetail extends ListingSummary {
  full_description_md: string;
  attribution: string | null;
  repo_signals: {
    repo_url: string | null;
    repo_name: string | null;
    default_branch: string | null;
    stars: number;
    forks: number;
    good_first_issues: number;
    help_wanted: number;
    language: string | null;
    last_commit_at: string | null;
    upstream_status: string | null;
  };
  safety_signals: {
    secret_scan: 'clean' | 'flagged' | 'unscanned';
    malware_flag: boolean;
  };
  signals: Signals;
  rating_block: { avg: number | null; count: number };
  product_type: string;
  updated_at: string;
  similar?: ListingSummary[];
}

/**
 * Compact signal badge: e.g. `[MIT · pop 50 · risk 0 · free]`. Designed to
 * fit on one line per listing so a search result list still renders cleanly
 * in a chat surface. risk badge becomes loud (⚠) when ≥40.
 */
export function signalBadge(s: Signals | undefined): string | null {
  if (!s) return null;
  const parts: string[] = [];
  // License is the most-asked question — lead with the category, then warn.
  parts.push(s.license_category);
  parts.push(`pop ${s.popularity}`);
  parts.push(`risk ${s.risk}${s.risk >= 40 ? ' ⚠' : ''}`);
  parts.push(s.pricing_tier);
  return `[${parts.join(' · ')}]`;
}

const NBSP = ' ';

function fmtStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function joinMeta(parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => Boolean(p && p.length > 0)).join(' · ');
}

export function summaryLine(r: ListingSummary, idx?: number): string {
  const head = idx !== undefined ? `${idx}. **${r.title}**` : `**${r.title}**`;
  const meta = joinMeta([
    r.stars > 0 ? `★${NBSP}${fmtStars(r.stars)}` : null,
    r.license || null,
    r.language || null,
    r.category ? r.category.name : null,
  ]);
  const badge = signalBadge(r.signals);
  const lwarn = r.signals?.license_warning;
  return [
    head,
    meta ? `   ${meta}` : null,
    badge ? `   ${badge}` : null,
    `   ${r.short_description}`,
    lwarn ? `   ⚠ ${lwarn}` : null,
    `   ${r.url}`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

export function summaryList(items: ListingSummary[], opts?: { header?: string; footer?: string }): string {
  const head = opts?.header ? `${opts.header}\n\n` : '';
  const foot = opts?.footer ? `\n\n${opts.footer}` : '';
  if (items.length === 0) return `${head}_No results._${foot}`;
  return head + items.map((r, i) => summaryLine(r, i + 1)).join('\n\n') + foot;
}

export function detailBlock(d: ListingDetail): string {
  const lines: string[] = [];
  lines.push(`# ${d.title}`);
  lines.push('');
  lines.push(
    joinMeta([
      d.repo_signals.stars > 0 ? `★ ${fmtStars(d.repo_signals.stars)}` : null,
      d.license,
      d.repo_signals.language,
      d.category?.name ?? null,
      d.source,
    ]),
  );
  lines.push('');
  lines.push(d.short_description);
  lines.push('');

  if (d.tags && d.tags.length > 0) {
    lines.push(`**Tags:** ${d.tags.slice(0, 12).map((t) => `\`${t}\``).join(' ')}`);
    lines.push('');
  }

  const safety: string[] = [];
  if (d.safety_signals.secret_scan === 'clean') safety.push('secret-scan: clean ✓');
  else if (d.safety_signals.secret_scan === 'flagged') safety.push('secret-scan: **flagged** ⚠');
  else safety.push('secret-scan: not run');
  if (d.safety_signals.malware_flag) safety.push('**malware flag set** ⚠');
  if (d.repo_signals.upstream_status === 'removed') safety.push('**upstream removed** ⚠');
  lines.push(`**Safety:** ${safety.join(' · ')}`);
  lines.push('');

  // 4-axis signals — visible on every detail response.
  const s = d.signals;
  lines.push(`**Signals:** license: ${s.license_category} · popularity: ${s.popularity}/100 · risk: ${s.risk}/100 · pricing: ${s.pricing_tier}`);
  if (s.license_warning) {
    lines.push(`> ⚠ ${s.license_warning}`);
  }
  lines.push('');

  const repo: string[] = [];
  if (d.repo_signals.repo_url) repo.push(`repo: ${d.repo_signals.repo_url}`);
  if (d.repo_signals.default_branch) repo.push(`branch: \`${d.repo_signals.default_branch}\``);
  if (d.repo_signals.last_commit_at) repo.push(`last commit: ${d.repo_signals.last_commit_at.slice(0, 10)}`);
  if (d.repo_signals.good_first_issues > 0) repo.push(`good-first-issues: ${d.repo_signals.good_first_issues}`);
  if (repo.length > 0) {
    lines.push(`**Repo:** ${repo.join(' · ')}`);
    lines.push('');
  }

  // Truncate the full description so tool responses stay small.
  if (d.full_description_md && d.full_description_md.trim().length > 0) {
    const trimmed = d.full_description_md.slice(0, 1200);
    lines.push('## Description');
    lines.push(trimmed + (d.full_description_md.length > 1200 ? '\n\n_(truncated — see canonical page for full text)_' : ''));
    lines.push('');
  }

  lines.push(`**BuyGit listing:** ${d.url}`);
  if (d.attribution) {
    lines.push('');
    lines.push(`_Attribution:_ ${d.attribution}`);
  }

  if (d.similar && d.similar.length > 0) {
    lines.push('');
    lines.push('## Similar listings');
    for (const s of d.similar.slice(0, 5)) {
      lines.push(`- **${s.title}** · ${s.url}`);
    }
  }

  return lines.join('\n');
}

export function compareBlock(items: (ListingDetail | { slug: string; error: string })[]): string {
  const lines: string[] = ['# Side-by-side comparison', ''];
  for (const item of items) {
    if ('error' in item) {
      lines.push(`## \`${item.slug}\``);
      lines.push(`_not found in the crawler index_`);
      lines.push('');
      continue;
    }
    lines.push(`## ${item.title}`);
    lines.push(
      joinMeta([
        item.repo_signals.stars > 0 ? `★ ${fmtStars(item.repo_signals.stars)}` : null,
        item.license,
        item.repo_signals.language,
        item.category?.name ?? null,
      ]),
    );
    lines.push('');
    lines.push(item.short_description);
    lines.push('');
    lines.push(`→ ${item.url}`);
    lines.push('');
  }
  return lines.join('\n');
}
