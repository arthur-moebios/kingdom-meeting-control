import { expect, it } from 'vitest';
import { cloudflareOrigin,checkRemoteOrigin } from './cloudflare.js';

it('fixed Cloudflare hosts are HTTPS origins without credentials, ports or paths',()=> {
  expect(cloudflareOrigin('cronometro.example.com')).toBe('https://cronometro.example.com');
  for(const url of ['http://example.com','https://user:password@example.com','https://example.com:4433','https://example.com/admin','https://127.0.0.1','https://localhost','https://example.com/?token=secret'])
    expect(()=>cloudflareOrigin(url)).toThrow();
});
it('edge connectivity alone cannot mark a public link ready',async()=> {
  const probe=(response:Response)=>checkRemoteOrigin('https://timers.example.com','expected',async()=>response);
  expect(await probe(new Response('Bad gateway',{status:502}))).toBe(false);
  expect(await probe(new Response('Other website',{status:200}))).toBe(false);
  expect(await probe(new Response('Old cached app',{status:200,headers:{'x-kmc-instance':'previous'}}))).toBe(false);
  expect(await probe(new Response('Remote app',{status:200,headers:{'x-kmc-instance':'expected'}}))).toBe(true);
});
