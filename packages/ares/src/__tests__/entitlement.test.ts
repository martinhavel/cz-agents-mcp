import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe,expect,it,vi } from 'vitest';
import { buildAresServer } from '../server.js';
import type { AresClient } from '../client.js';

async function setup(upstream:AresClient,allowed:boolean) {
  const record=vi.fn();const server=buildAresServer({client:upstream,authorizeLookup:()=>({upstreamAllowed:allowed,
    error:{error:'country_disabled',country:'CZ'},record})});
  const client=new Client({name:'test',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();
  await server.connect(st);await client.connect(ct);return {client,server,record};
}
describe('ARES hosted policy hook',()=>{
  it('blocks before ARES upstream',async()=>{
    const getByIco=vi.fn();const upstream={getByIco} as unknown as AresClient;const {client,server,record}=await setup(upstream,false);
    try{const result=await client.callTool({name:'lookup_by_ico',arguments:{ico:'27074358'}});
      expect(result.isError).toBe(true);expect(getByIco).not.toHaveBeenCalled();expect(record).toHaveBeenCalledWith(false);
    }finally{await client.close();await server.close();}
  });
  it('Core lookup calls ARES once',async()=>{
    const getByIco=vi.fn().mockResolvedValue({ico:'27074358',obchodniJmeno:'Alza.cz a.s.'});
    const upstream={getByIco,getResNacePrevazujici:vi.fn().mockResolvedValue(undefined)} as unknown as AresClient;
    const {client,server,record}=await setup(upstream,true);
    try{await client.callTool({name:'lookup_by_ico',arguments:{ico:'27074358'}});
      expect(getByIco).toHaveBeenCalledTimes(1);expect(record).toHaveBeenCalledWith(true);
    }finally{await client.close();await server.close();}
  });
});
