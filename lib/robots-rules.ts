/**
 * File: lib/robots-rules.ts
 * DOES THIS robots.txt ALLOW THIS PATH? An RFC 9309 matcher, importing nothing.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * Because a gate asserted `/^Disallow: \/rep$/m.test(robots)` and passed, and the directive it proved
 * the existence of was disallowing the wrong things. robots.txt matching is PREFIX-BASED on the path
 * (RFC 9309 §2.2.2): `Disallow: /rep` disallows /rep, /rep/login, AND /rep-site/terms. The reseller
 * site's sitemap was advertising /rep-site/terms while its robots.txt forbade crawling it — two files
 * contradicting each other, with the forbidding one winning.
 *
 * The regex was anchored. The DIRECTIVE was not. A pattern that reads the file cannot say what the
 * file means, so this says it instead: the gate evaluates real paths against real directives.
 *
 * ── THE RULES, AS THE RFC STATES THEM ───────────────────────────────────────────────────────────
 *   • Groups are keyed by user-agent; the most specific matching group applies, `*` is the fallback.
 *   • Within a group, the LONGEST matching pattern wins (§2.2.2). A tie goes to ALLOW — which is how
 *     "disallow a prefix except one sub-prefix" is expressed, and what this file now relies on.
 *   • `*` matches any run of characters; `$` anchors to the end of the path. Both are widely
 *     implemented extensions rather than core RFC, and both are supported here because a rule that
 *     uses one must be testable.
 *   • No matching rule means ALLOWED. An empty or absent file means everything is allowed.
 */

export type RobotsDecision = { allowed: boolean; rule: string | null };

type Rule = { allow: boolean; pattern: string };

/** Directives for one user-agent, in file order. `agent` is lower-case; '*' is the fallback group. */
function groupsFor(robotsTxt: string): Map<string, Rule[]> {
  const groups = new Map<string, Rule[]>();
  let current: string[] = [];
  let expectingAgents = true;
  for (const raw of robotsTxt.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      // A RUN of user-agent lines shares one group of rules; a rule line ends the run.
      if (!expectingAgents) { current = []; expectingAgents = true; }
      current.push(value.toLowerCase());
      if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), []);
      continue;
    }
    if (field !== 'allow' && field !== 'disallow') continue;   // sitemap, crawl-delay, anything else
    expectingAgents = false;
    if (!current.length) continue;                              // a rule before any user-agent is orphaned
    // AN EMPTY Disallow MEANS "disallow nothing" and is not a rule about any path.
    if (field === 'disallow' && value === '') continue;
    for (const agent of current) groups.get(agent)!.push({ allow: field === 'allow', pattern: value });
  }
  return groups;
}

/** Does `pattern` match `path`? Prefix match, with `*` and a trailing `$` honoured. */
export function patternMatches(pattern: string, path: string): boolean {
  if (pattern === '') return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split('*');
  let i = 0;
  for (let p = 0; p < parts.length; p += 1) {
    const seg = parts[p];
    if (seg === '') continue;
    const at = p === 0 ? (path.startsWith(seg) ? 0 : -1) : path.indexOf(seg, i);
    if (at < 0) return false;
    i = at + seg.length;
  }
  if (anchored) return i === path.length && (parts[parts.length - 1] !== '' || body.includes('*'));
  return true;
}

/**
 * THE DECISION, and the rule that made it — because "disallowed" without the line is a fact nobody
 * can act on, and the gate reports the winning rule in its failure message.
 */
export function robotsDecision(robotsTxt: string, path: string, userAgent = '*'): RobotsDecision {
  const groups = groupsFor(robotsTxt);
  const agent = userAgent.toLowerCase();
  const rules = groups.get(agent) ?? groups.get('*') ?? [];
  let best: Rule | null = null;
  for (const r of rules) {
    if (!patternMatches(r.pattern, path)) continue;
    if (!best) { best = r; continue; }
    if (r.pattern.length > best.pattern.length) { best = r; continue; }
    // LONGEST WINS; A TIE GOES TO ALLOW. This is the precedence that lets one Allow carve a hole in a
    // broader Disallow, which is exactly how the portal is excluded without taking /rep-site with it.
    if (r.pattern.length === best.pattern.length && r.allow && !best.allow) best = r;
  }
  if (!best) return { allowed: true, rule: null };
  return { allowed: best.allow, rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.pattern}` };
}
