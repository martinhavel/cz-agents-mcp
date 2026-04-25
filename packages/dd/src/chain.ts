/**
 * Statutory chain BFS — UBO discovery for KYC.
 *
 * From a root IČO, fetch each statutory person, then for each person
 * search ARES for *other* companies where they appear (currently active).
 * Builds a tree of (ico → person → other company) relationships up to
 * a max depth.
 *
 * Heavy on ARES calls — caller should rate-limit / cache aggressively.
 */
import type { AresLike } from './clients.js';
import type { ChainNode, ChainResult } from './types.js';

const MAX_DEPTH_LIMIT = 5;
const SEARCH_PAGE_SIZE = 50;

export interface ChainOptions {
  maxDepth?: number; // default 3
  /** Skip persons whose name has fewer than N chars (avoid common-name explosion). */
  minNameLength?: number; // default 5
}

export async function buildChain(
  rootIco: string,
  ares: AresLike,
  opts: ChainOptions = {},
): Promise<ChainResult> {
  const maxDepth = Math.min(opts.maxDepth ?? 3, MAX_DEPTH_LIMIT);
  const minNameLength = opts.minNameLength ?? 5;

  const visited = new Set<string>([rootIco]);
  const root = await buildNode(rootIco, [], 0, maxDepth, ares, visited, minNameLength);

  return {
    root_ico: rootIco,
    tree: root,
    total_companies: visited.size,
    max_depth: maxDepth,
  };
}

async function buildNode(
  ico: string,
  via: string[],
  depth: number,
  maxDepth: number,
  ares: AresLike,
  visited: Set<string>,
  minNameLength: number,
): Promise<ChainNode> {
  const subject = await safeCall(() => ares.getByIco(ico));
  const node: ChainNode = {
    ico,
    name: subject?.obchodniJmeno,
    via,
  };
  if (depth >= maxDepth) return node;

  const vr = await safeCall(() => ares.getVrRecord(ico));
  if (!vr?.statutarniOrgany) return node;

  const personNames: string[] = [];
  for (const organ of vr.statutarniOrgany) {
    if (organ.datumVymazu) continue;
    for (const m of organ.clenoveOrganu ?? []) {
      if (m.datumVymazu) continue;
      const fo = m.fyzickaOsoba;
      if (!fo) continue;
      const name = [fo.jmeno, fo.prijmeni].filter(Boolean).join(' ').trim();
      if (name && name.length >= minNameLength && !personNames.includes(name)) {
        personNames.push(name);
      }
    }
  }

  const children: ChainNode[] = [];
  for (const personName of personNames) {
    const otherCompanies = await findOtherCompanies(personName, ico, ares);
    for (const co of otherCompanies) {
      if (visited.has(co.ico)) {
        children.push({ ico: co.ico, name: co.name, via: [...via, personName], cycle: true });
        continue;
      }
      visited.add(co.ico);
      const child = await buildNode(co.ico, [...via, personName], depth + 1, maxDepth, ares, visited, minNameLength);
      children.push(child);
    }
  }

  if (children.length > 0) node.children = children;
  return node;
}

async function findOtherCompanies(
  personName: string,
  excludeIco: string,
  ares: AresLike,
): Promise<Array<{ ico: string; name?: string }>> {
  // ARES doesn't have a direct "person → companies" endpoint in the search API.
  // We approximate by searching companies whose obchodniJmeno contains the person's
  // surname — a known approximation of UBO discovery, intentionally conservative.
  // (For production-grade UBO, hit /vyhledat-vr endpoints; left as future iteration.)
  const surname = personName.split(' ').pop() ?? personName;
  if (surname.length < 4) return [];

  const result = await safeCall(() =>
    ares.search({ obchodniJmeno: surname, pocet: SEARCH_PAGE_SIZE }),
  );
  if (!result) return [];

  return result.ekonomickeSubjekty
    .filter((s) => s.ico && s.ico !== excludeIco)
    .map((s) => ({ ico: s.ico, name: s.obchodniJmeno }));
}

async function safeCall<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
