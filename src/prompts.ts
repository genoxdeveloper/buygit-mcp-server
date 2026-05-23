/**
 * MCP prompts — slash-menu entries in Claude Desktop / Cursor that
 * pre-shape a question and chain the right tool calls.
 *
 * Each prompt is a small recipe that the LLM expands at use time. Unlike
 * tools, prompts return a *prepared message* (or message sequence) the
 * model will reason over — they don't have to call our API directly.
 */

export interface PromptDefinition {
  name: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
  /** Renders the prompt as the role/content pair the SDK expects. */
  render: (args: Record<string, string | undefined>) => {
    description: string;
    messages: { role: 'user' | 'assistant'; content: { type: 'text'; text: string } }[];
  };
}

export const ALL_PROMPTS: PromptDefinition[] = [
  {
    name: 'starter_for_stack',
    description: 'Recommend BuyGit Open Index starter kits / templates for a given stack.',
    arguments: [
      { name: 'stack', description: 'Tech stack the user is building on (e.g. "Next.js + Supabase + Stripe").', required: true },
      { name: 'budget', description: 'Free / under_50 / under_200 / any (default any).', required: false },
    ],
    render: (args) => ({
      description: `Find starter kits for: ${args.stack}`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `I'm building a project on **${args.stack}**${args.budget ? ` (budget: ${args.budget})` : ''}.\n\n` +
              `Use \`buygit_search\` against the BuyGit Open Index — start with the stack name as the query, ` +
              `then refine with \`category\` or \`language\` if the first page is noisy. Aim for repos that:\n\n` +
              `1. Match the stack closely (not "kind of related").\n` +
              `2. Are actively maintained — check \`last_commit_at\` in the result.\n` +
              `3. Have a permissive license (MIT / Apache-2.0).\n\n` +
              `Recommend the top 3-5 with one sentence each on why they fit. Always include the BuyGit listing URL.`,
          },
        },
      ],
    }),
  },
  {
    name: 'alternative_to',
    description: 'Find BuyGit Open Index alternatives to a known library or repo.',
    arguments: [{ name: 'target', description: 'Library or repo URL to find alternatives for.', required: true }],
    render: (args) => ({
      description: `Find alternatives to ${args.target}`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Find alternatives to **${args.target}** in the BuyGit Open Index.\n\n` +
              `Use \`buygit_find_alternative\` with the target name as the query. If the result list looks weak, fall back to \`buygit_search\` with the same query and sort=stars.\n\n` +
              `For each suggestion, briefly explain how it compares (smaller / larger / newer / older / different license / different language).`,
          },
        },
      ],
    }),
  },
  {
    name: 'audit_my_dependency',
    description: 'Pull the safety signals (secret scan, malware flag, upstream status, license) for a BuyGit-indexed repo.',
    arguments: [{ name: 'slug_or_url', description: 'BuyGit slug or canonical buygit.com/asset/* URL.', required: true }],
    render: (args) => ({
      description: `Audit ${args.slug_or_url}`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Audit this BuyGit-indexed dependency: **${args.slug_or_url}**.\n\n` +
              `1. Extract the slug (last path segment if a URL was given).\n` +
              `2. Call \`buygit_get_listing(slug)\`.\n` +
              `3. Surface the safety_signals block (secret scan, malware flag, upstream status) clearly. ` +
              `Flag anything that's not "clean" in plain English.\n` +
              `4. Note the license and whether it's compatible with a typical commercial closed-source project.`,
          },
        },
      ],
    }),
  },
  {
    name: 'explore_category',
    description: 'Browse the top crawler listings in a BuyGit category.',
    arguments: [{ name: 'category', description: 'Category slug or partial name. Use buygit_list_categories first if unsure.', required: true }],
    render: (args) => ({
      description: `Explore category: ${args.category}`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Show me what's in the BuyGit category **${args.category}**.\n\n` +
              `1. If the input isn't a clean slug, call \`buygit_list_categories\` and pick the closest match.\n` +
              `2. Then call \`buygit_trending\` with the resolved slug and period=week to surface what's hot.\n` +
              `3. Summarise the top 5 in one sentence each. Include BuyGit URLs.`,
          },
        },
      ],
    }),
  },
];
