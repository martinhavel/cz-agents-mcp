#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { EntitlementStore } from './store.js';
import type { EntitlementSource, UsageLimits } from './types.js';

function main(argv = process.argv.slice(2)): void {
  const { command, values } = parseArgs(argv);
  const dbPath = values.get('db') ?? process.env.TOKEN_DB ?? './tokens.db';
  const actor = command === 'report' ? (values.get('actor') ?? 'report-readonly') : required(values, 'actor');
  const changeSource = values.get('change-source') ?? 'internal-cli';
  const store = new EntitlementStore(dbPath);
  try {
    if (command === 'seed') {
      console.log(JSON.stringify({ ok: true, policy_version: store.seedPolicy(actor, changeSource) }));
      return;
    }
    if (command === 'set-country') {
      const countryCode = required(values,'country').normalize('NFKC').trim().toUpperCase();
      const group = required(values,'group');
      if (group !== 'core' && group !== 'extended') fail('group must be core or extended');
      const enabled = parseBoolean(required(values,'enabled'));
      const aliases = (values.get('aliases') ?? '').split(',').map((v)=>v.trim()).filter(Boolean);
      console.log(JSON.stringify({ ok:true, policy_version:store.setCountryPolicy({countryCode,
        coverageGroup:group,enabled,aliases,actor,changeSource}) }));
      return;
    }
    if (command === 'grant') {
      const source = parseSource(required(values,'source'));
      const coverage = values.get('coverage');
      const depth = values.get('depth');
      if (coverage && coverage !== 'core' && coverage !== 'extended') fail('coverage must be core or extended');
      if (depth && depth !== 'basic' && depth !== 'ddplus') fail('depth must be basic or ddplus');
      const usage = values.get('usage-json') ? JSON.parse(values.get('usage-json')!) as UsageLimits : {};
      const id=store.putAccountEntitlement({accountId:required(values,'account'),
        coverageTier:coverage as 'core'|'extended'|undefined,depthTier:depth as 'basic'|'ddplus'|undefined,
        usageLimits:usage,source,validFrom:parseDate(values.get('valid-from')),
        validUntil:parseDate(values.get('valid-until')),actor,changeSource});
      console.log(JSON.stringify({ok:true,id})); return;
    }
    if (command === 'override-country') {
      const effect=required(values,'effect');
      if (effect !== 'allow' && effect !== 'deny') fail('effect must be allow or deny');
      const id=store.putCountryOverride({accountId:required(values,'account'),
        countryCode:required(values,'country').normalize('NFKC').trim().toUpperCase(),effect,
        source:parseSource(required(values,'source')),validFrom:parseDate(values.get('valid-from')),
        validUntil:parseDate(values.get('valid-until')),actor,changeSource});
      console.log(JSON.stringify({ok:true,id})); return;
    }
    if (command === 'report') {
      const days=Number(values.get('days') ?? '30');
      if (!Number.isFinite(days)||days<=0) fail('days must be positive');
      const since=Date.now()-days*86_400_000;
      console.log(JSON.stringify({since_days:days,countries:store.intentReport(since),
        fanout_upgrade_ctas:store.intentReportFanoutCtas(since)},null,2));
      return;
    }
    fail('command must be seed, set-country, grant, override-country, or report');
  } finally { store.close(); }
}

function parseArgs(argv:string[]):{command:string;values:Map<string,string>} {
  const command=argv[0] ?? ''; const values=new Map<string,string>();
  for (let i=1;i<argv.length;i+=2) {
    const key=argv[i]; const value=argv[i+1];
    if (!key?.startsWith('--')||value===undefined) fail(`invalid argument near ${key ?? '(end)'}`);
    values.set(key.slice(2),value);
  }
  return {command,values};
}
function required(values:Map<string,string>,key:string):string { const v=values.get(key); if (!v) fail(`--${key} is required`); return v; }
function parseBoolean(v:string):boolean { if(v==='true'||v==='1')return true;if(v==='false'||v==='0')return false;fail('boolean must be true/false'); }
function parseSource(v:string):EntitlementSource { if(['plan','trial','grandfathered','manual','promotion'].includes(v))return v as EntitlementSource;fail('invalid source'); }
function parseDate(v:string|undefined):number|undefined { if(!v)return undefined;const n=Date.parse(v);if(!Number.isFinite(n))fail(`invalid date: ${v}`);return n; }
function fail(message:string):never { throw new Error(message); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : 'CLI failed'); process.exit(1); }
}
