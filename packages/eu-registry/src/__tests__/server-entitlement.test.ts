import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe,expect,it,vi } from 'vitest';
import { buildEuRegistryServer } from '../server.js';
import type { RegistryAdapter } from '../types.js';

async function clientFor(options:Parameters<typeof buildEuRegistryServer>[0]) {
  const server=buildEuRegistryServer(options); const client=new Client({name:'test',version:'1'});
  const [ct,st]=InMemoryTransport.createLinkedPair(); await server.connect(st);await client.connect(ct);
  return {client,server};
}
function adapter(country:string):RegistryAdapter {
  return {searchByName:vi.fn().mockResolvedValue({total_results:1,companies:[{id:`${country}-1`,country,name:`${country} Co`,status:'active'}]}),
    getById:vi.fn().mockResolvedValue({id:`${country}-1`,country,name:`${country} Co`,status:'active'})};
}
function parsed(result:Awaited<ReturnType<Client['callTool']>>):any {
  const block=result.content[0];if(!block||block.type!=='text')throw new Error('text expected');return JSON.parse(block.text);
}

describe('EU Registry hosted entitlement hook',()=>{
  it('gated request returns stable error and never calls upstream',async()=>{
    const de=adapter('de');const record=vi.fn();
    const {client,server}=await clientFor({adapters:{de},authorizeLookup:()=>({upstreamAllowed:false,
      error:{error:'tier_required',dimension:'coverage',required_tier:'extended',country:'DE',country_group:'extended',upgrade_url:'https://example.test',message:'Extended European coverage is required for Germany.'},record})});
    try { const result=await client.callTool({name:'get_company',arguments:{id:'de-1',country:'DE'}});
      expect(result.isError).toBe(true);expect(parsed(result)).toMatchObject({error:'tier_required',dimension:'coverage',country:'DE'});
      expect(de.getById).not.toHaveBeenCalled();expect(record).toHaveBeenCalledWith(false);
    } finally {await client.close();await server.close();}
  });

  it('allowed request calls upstream exactly once',async()=>{
    const de=adapter('de');const record=vi.fn();
    const {client,server}=await clientFor({adapters:{de},authorizeLookup:()=>({upstreamAllowed:true,record})});
    try {await client.callTool({name:'get_company',arguments:{id:'de-1',country:'Germany'}});
      expect(de.getById).toHaveBeenCalledTimes(1);expect(record).toHaveBeenCalledWith(true);
    } finally {await client.close();await server.close();}
  });

  it('country-less search evaluates each adapter and filters gated upstreams',async()=>{
    const gb=adapter('gb');const de=adapter('de');
    const authorize=vi.fn(({country}:{country:string})=>country==='de'
      ? {upstreamAllowed:false,error:{error:'tier_required',country:'DE'}}:{upstreamAllowed:true});
    const {client,server}=await clientFor({adapters:{gb,de},authorizeLookup:authorize});
    try {const result=await client.callTool({name:'search_company',arguments:{name:'co'}});const body=parsed(result);
      expect(authorize).toHaveBeenCalledTimes(2);expect(gb.searchByName).toHaveBeenCalledTimes(1);
      expect(de.searchByName).not.toHaveBeenCalled();expect(body.companies).toHaveLength(1);
      expect(body.coverage_preview).toMatchObject([{country:'DE',connector_available:true}]);
    } finally {await client.close();await server.close();}
  });

  it('gates VAT country before the VIES fetch',async()=>{
    const vatLookup=vi.fn();const {client,server}=await clientFor({adapters:{gb:adapter('gb')},vatLookup,
      authorizeLookup:({country})=>({upstreamAllowed:country!=='de',error:{error:'tier_required',country:'DE'}})});
    try {const result=await client.callTool({name:'lookup_company_by_vat',arguments:{vat:'DE123456789'}});
      expect(result.isError).toBe(true);expect(vatLookup).not.toHaveBeenCalled();
    } finally {await client.close();await server.close();}
  });
});

describe('open-source/default execution path',()=>{
  it('allows Core, Extended, and UK alias without hosted account or policy',async()=>{
    const gb=adapter('gb');const de=adapter('de');const {client,server}=await clientFor({adapters:{gb,de}});
    try {
      await client.callTool({name:'get_company',arguments:{id:'gb-1',country:'GB'}});
      await client.callTool({name:'get_company',arguments:{id:'de-1',country:'DE'}});
      await client.callTool({name:'get_company',arguments:{id:'gb-1',country:'UK'}});
      expect(gb.getById).toHaveBeenCalledTimes(2);expect(de.getById).toHaveBeenCalledTimes(1);
    } finally {await client.close();await server.close();}
  });
});
