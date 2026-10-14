# Installation

Two parts: (A) connect the cz-agents MCP servers to your client, (B) install the skill.
No API key is needed for the free tier. **Never put tokens or API keys into this skill's
files or into shared config committed to git.**

Recommended: **remote HTTP** (hosted, anonymous, always-current data, sanctions lists
maintained by the operator). Local stdio via npm is possible but has caveats (see A3).

Hosted endpoints (from each package's `server.json`):

| Name | URL |
|---|---|
| dd | `https://dd.cz-agents.dev/mcp` |
| ares | `https://ares.cz-agents.dev/mcp` |
| isir | `https://isir.cz-agents.dev/mcp` |
| sanctions | `https://sanctions.cz-agents.dev/mcp` |
| adis | `https://adis.cz-agents.dev/mcp` |
| eu-registry | `https://eu-registry.cz-agents.dev/mcp` |

Keep the server names exactly as above (`dd`, `ares`, …) so the tool names in the skill
match what your client shows (e.g. `mcp__dd__get_dd_report` in Claude Code).

## A1. Claude Code — remote HTTP

Syntax checked against `claude mcp add --help` (Claude Code 2.1.300):

```bash
claude mcp add --transport http --scope user dd          https://dd.cz-agents.dev/mcp
claude mcp add --transport http --scope user ares        https://ares.cz-agents.dev/mcp
claude mcp add --transport http --scope user isir        https://isir.cz-agents.dev/mcp
claude mcp add --transport http --scope user sanctions   https://sanctions.cz-agents.dev/mcp
claude mcp add --transport http --scope user adis        https://adis.cz-agents.dev/mcp
claude mcp add --transport http --scope user eu-registry https://eu-registry.cz-agents.dev/mcp
claude mcp list        # check status
```

`--scope user` makes the servers available in all projects; use `--scope project` to
write a shared `.mcp.json` into the repo instead.

## A2. Other clients — remote HTTP

**Cursor** — `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "dd":          { "url": "https://dd.cz-agents.dev/mcp" },
    "ares":        { "url": "https://ares.cz-agents.dev/mcp" },
    "isir":        { "url": "https://isir.cz-agents.dev/mcp" },
    "sanctions":   { "url": "https://sanctions.cz-agents.dev/mcp" },
    "adis":        { "url": "https://adis.cz-agents.dev/mcp" },
    "eu-registry": { "url": "https://eu-registry.cz-agents.dev/mcp" }
  }
}
```

**VS Code / GitHub Copilot (agent mode)** — `.vscode/mcp.json` (note: top-level key is
`servers`, not `mcpServers`):

```json
{
  "servers": {
    "dd":          { "type": "http", "url": "https://dd.cz-agents.dev/mcp" },
    "ares":        { "type": "http", "url": "https://ares.cz-agents.dev/mcp" },
    "isir":        { "type": "http", "url": "https://isir.cz-agents.dev/mcp" },
    "sanctions":   { "type": "http", "url": "https://sanctions.cz-agents.dev/mcp" },
    "adis":        { "type": "http", "url": "https://adis.cz-agents.dev/mcp" },
    "eu-registry": { "type": "http", "url": "https://eu-registry.cz-agents.dev/mcp" }
  }
}
```

**Claude Desktop / claude.ai** — add each URL as a custom connector
(Settings → Connectors → Add custom connector).
*TODO: confirm the current menu path; `claude_desktop_config.json` itself only takes
stdio servers (A3).*

> The Cursor and VS Code formats above follow those tools' MCP docs as known at the time
> of writing; their docs could not be fetched from the build sandbox. **TODO: re-check
> against current Cursor / VS Code documentation before publishing.**

## A3. Local stdio (npm packages)

**Known issue (verified 2026-10-14 with the published versions dd 0.3.9, ares 0.1.9,
isir 0.2.4, sanctions 0.1.5, adis 0.1.4, eu-registry 0.8.0):**

1. `npx -y @czagents/<pkg>` starts and exits immediately without serving MCP. The entry
   point only runs when `process.argv[1]` equals the real file path, which is not the
   case when started through npm's bin symlink.
2. `npx -y @czagents/sanctions` and `npx -y @czagents/eu-registry` additionally fail with
   `could not determine executable to run` (these packages ship several bins).

Until fixed upstream, install into a folder and point the client at the real file:

```bash
mkdir -p ~/cz-agents && cd ~/cz-agents
npm install @czagents/dd @czagents/ares @czagents/isir @czagents/sanctions @czagents/adis @czagents/eu-registry
# sanctions lists must be downloaded before use (EU list may need SANCTIONS_EU_URL):
SANCTIONS_DB=$HOME/cz-agents/sanctions.db npx -p @czagents/sanctions cz-agents-sanctions-refresh
```

Claude Code (replace `/home/me` with your absolute home path):

```bash
B=/home/me/cz-agents/node_modules/@czagents
claude mcp add --scope user dd          -e SANCTIONS_DB=/home/me/cz-agents/sanctions.db -- node $B/dd/dist/index.js
claude mcp add --scope user ares        -- node $B/ares/dist/index.js
claude mcp add --scope user isir        -e ISIR_SOAP_ENABLED=1 -- node $B/isir/dist/index.js
claude mcp add --scope user sanctions   -e SANCTIONS_DB=/home/me/cz-agents/sanctions.db -- node $B/sanctions/dist/index.js
claude mcp add --scope user adis        -e ADIS_SOAP_ENABLED=1 -- node $B/adis/dist/index.js
claude mcp add --scope user eu-registry -- node $B/eu-registry/dist/index.js
```

Claude Desktop (`claude_desktop_config.json`) / Cursor (`mcp.json`):

```json
{
  "mcpServers": {
    "dd":          { "command": "node", "args": ["/home/me/cz-agents/node_modules/@czagents/dd/dist/index.js"], "env": { "SANCTIONS_DB": "/home/me/cz-agents/sanctions.db" } },
    "ares":        { "command": "node", "args": ["/home/me/cz-agents/node_modules/@czagents/ares/dist/index.js"] },
    "isir":        { "command": "node", "args": ["/home/me/cz-agents/node_modules/@czagents/isir/dist/index.js"], "env": { "ISIR_SOAP_ENABLED": "1" } },
    "sanctions":   { "command": "node", "args": ["/home/me/cz-agents/node_modules/@czagents/sanctions/dist/index.js"], "env": { "SANCTIONS_DB": "/home/me/cz-agents/sanctions.db" } },
    "adis":        { "command": "node", "args": ["/home/me/cz-agents/node_modules/@czagents/adis/dist/index.js"], "env": { "ADIS_SOAP_ENABLED": "1" } },
    "eu-registry": { "command": "node", "args": ["/home/me/cz-agents/node_modules/@czagents/eu-registry/dist/index.js"] }
  }
}
```

VS Code: same entries under `"servers"` with `"type": "stdio"` added to each.

Local-mode limitations (from code):
- ISIR and ADIS stay in offline **stub** mode unless `ISIR_SOAP_ENABLED=1` /
  `ADIS_SOAP_ENABLED=1` is set.
- The stdio `dd` server does not wire ADIS, so the DD report shows VAT reliability as not
  configured; use the `adis` server.
- `dd.get_owners` / `dd.person_companies` need a VR Postgres mirror (`VR_DATABASE_URL`);
  without it they return `vr_not_configured`. Use `ares.get_owners` instead.
- An unrefreshed sanctions DB makes the published `@czagents/sanctions@0.1.5` report
  "no match" without a warning. Refresh before use.
- Local stdio runs at the free tier: Compliance+ tools return `tier_required`.

## B. Install the skill

The skill is the folder `skills/cz-company-due-diligence/` in this repository.

**Claude Code** — copy it into a skills directory:

```bash
git clone https://github.com/martinhavel/cz-agents-mcp.git
# personal (all projects):
cp -r cz-agents-mcp/skills/cz-company-due-diligence ~/.claude/skills/
# or project-scoped (commit it for your team):
mkdir -p .claude/skills && cp -r cz-agents-mcp/skills/cz-company-due-diligence .claude/skills/
```

Verify it loads:

1. Start `claude` in the project and invoke `/cz-company-due-diligence` directly.
   The tested CLI does not list `/skills` among its system slash commands.
2. Non-interactive check (what we ran when building it):
   `claude -p "Is a skill named cz-company-due-diligence in your available skills? Reply YES: <description> or NO."`
3. Functional check: ask *"Prověř firmu s IČO 45274649"* and confirm the transcript shows
   the skill being launched, then `dd.get_dd_report` and `isir.check_ico_insolvency`.

Test-harness note (Claude Code 2.1.296): the valid non-interactive live runs used
`--setting-sources project` with the skill in `.claude/skills/` and a strict MCP
configuration. The earlier `--restricted` runs did not load the custom skill.
Verify an actual `Skill` invocation in the transcript before counting a run as a
skill evaluation; successful MCP calls alone do not prove skill loading.

**Other agents (Cursor, Copilot, …)** — the folder follows the
[Agent Skills](https://agentskills.io) layout (`SKILL.md` + `references/`). Where a client
does not load skills natively, add `SKILL.md` as a rule / custom instruction and keep
`references/` next to it. *TODO: per-client skill-loading steps not verified.*
