import { describe,expect,it,vi } from 'vitest';
import { buildDdServer } from '../server.js';
import type { AresLike } from '../clients.js';

function fakeAres():AresLike {
  return {getByIco:vi.fn().mockResolvedValue({ico:'12345679',obchodniJmeno:'Test s.r.o.',pravniForma:'112',datumVzniku:'2010-01-01'}),
    getBankAccounts:vi.fn().mockResolvedValue([]),getVrRecord:vi.fn().mockResolvedValue(null),
    search:vi.fn().mockResolvedValue({pocetCelkem:0,ekonomickeSubjekty:[]})};
}
function tool(server:ReturnType<typeof buildDdServer>,name:string) {
  return (server as unknown as {_registeredTools:Record<string,{handler:(args:unknown)=>Promise<any>}>})._registeredTools[name]!;
}
describe('DD hosted depth entitlement hook',()=>{
  it('depth gate runs before any DD upstream',async()=>{
    const ares=fakeAres();const record=vi.fn();const server=buildDdServer({ares},'agency',{authorizeLookup:()=>({
      upstreamAllowed:false,error:{error:'tier_required',dimension:'depth',required_tier:'ddplus',country:'CZ'},record})});
    const result=await tool(server,'get_risk_score').handler({ico:'12345679'});
    expect(result.isError).toBe(true);expect(JSON.parse(result.content[0].text)).toMatchObject({error:'tier_required',dimension:'depth'});
    expect(ares.getByIco).not.toHaveBeenCalled();expect(record).toHaveBeenCalledWith(false);
  });
  it('Basic DD calls the upstream once when allowed',async()=>{
    const ares=fakeAres();const record=vi.fn();const authorize=vi.fn(()=>({upstreamAllowed:true,record}));
    const server=buildDdServer({ares},'agency',{authorizeLookup:authorize});
    await tool(server,'get_dd_report').handler({ico:'12345679',depth:'basic'});
    expect(authorize).toHaveBeenCalledWith({country:'CZ',tool:'get_dd_report',depth:'basic'});
    expect(ares.getByIco).toHaveBeenCalledTimes(1);expect(record).toHaveBeenCalledWith(true);
  });
  it('full report is classified as DD+',async()=>{
    const ares=fakeAres();const authorize=vi.fn(()=>({upstreamAllowed:false,error:{error:'tier_required'}}));
    const server=buildDdServer({ares},'agency',{authorizeLookup:authorize});
    await tool(server,'get_dd_report').handler({ico:'12345679',depth:'full'});
    expect(authorize).toHaveBeenCalledWith({country:'CZ',tool:'get_dd_report',depth:'ddplus'});
    expect(ares.getByIco).not.toHaveBeenCalled();
  });
});
