import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TokenStore } from '../billing/tokenStore.js';
import { getClientIp } from '../rateLimit.js';
import { accountContextFromToken } from './resolver.js';
import type { HostedAccountContext } from './types.js';

export interface HostedRequestContext {
  account: HostedAccountContext;
  requestId: string;
}

const storage = new AsyncLocalStorage<HostedRequestContext>();

export function runWithHostedRequestContext<T>(context:HostedRequestContext,fn:()=>T):T {
  return storage.run(context,fn);
}

export function getHostedRequestContext():HostedRequestContext|undefined { return storage.getStore(); }

export function authenticateHostedRequest(
  req:IncomingMessage,
  res:ServerResponse,
  tokenStore:TokenStore,
  pseudonymSalt:string,
):HostedRequestContext|null {
  const header=Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  const tokenValue=extractBearer(header);
  let token=null;
  if (header && !tokenValue) { writeAuthError(res,401,'unauthorized','Malformed bearer token.'); return null; }
  if (tokenValue) {
    token=tokenStore.find(tokenValue);
    if (!token) { writeAuthError(res,401,'unauthorized','Token unknown or revoked.'); return null; }
    if (token.expires_at != null && Date.now()>token.expires_at) {
      writeAuthError(res,402,'trial_expired','The token entitlement has expired.'); return null;
    }
  }
  const ip=getClientIp(req);
  return {account:accountContextFromToken(token,ip,pseudonymSalt),
    requestId:stringHeader(req.headers['x-request-id']) ?? randomUUID()};
}

function extractBearer(header:string|undefined):string|null {
  if(!header)return null; const match=/^Bearer\s+([^\s]+)$/i.exec(header.trim()); return match?.[1] ?? null;
}
function stringHeader(value:string|string[]|undefined):string|undefined { return Array.isArray(value)?value[0]:value; }
function writeAuthError(res:ServerResponse,status:number,error:string,message:string):void {
  res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({error,message}));
}
