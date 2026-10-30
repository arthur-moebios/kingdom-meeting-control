import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';

const HASH = 'd521b3bf68982165f0d06d76732f22d9a105ef057ff3ae4c0986f3a23190950f';
export async function checkRemoteOrigin(origin:string,instanceId:string,fetcher:typeof fetch=fetch):Promise<boolean> {
  try {
    const response=await fetcher(origin+'/remote.html',{headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(3000)});
    const ready=response.status===200 && response.headers.get('x-kmc-instance')===instanceId;
    await response.body?.cancel();return ready;
  }catch{return false;}
}
export function cloudflareOrigin(input: string): string {
  const url = new URL(input.includes('://') ? input : 'https://' + input);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]+$/i.test(url.hostname))
    throw new Error('Informe um domínio HTTPS da sua conta Cloudflare, sem caminho ou porta.');
  return url.origin;
}
export class CloudflareIntegration {
  private config: { origin: string; tunnelId: string; enabled: boolean } = { origin: '', tunnelId: '', enabled: false };
  private running: ChildProcess | null = null;
  private login: ChildProcess | null = null;
  private operations = new Set<ChildProcess>();
  private retry: NodeJS.Timeout | null = null;
  private health: NodeJS.Timeout | null = null;
  private phase = 'disabled';
  private error: string | null = null;
  private authorizationUrl: string | null = null;
  private busy = false;
  private closing = false;
  private verified = false;
  private publicReady = false;
  readonly instanceId = randomUUID();
  readonly binary: string;
  readonly directory: string;
  readonly certificate = path.join(os.homedir(), '.cloudflared', 'cert.pem');
  constructor(base: string, data: string, readonly gatewayPort = 4320, readonly metricsPort = 4321) {
    this.binary = path.join(base, 'cloudflared.exe');
    this.directory = path.join(data, 'cloudflare');
    fs.mkdirSync(this.directory, { recursive: true });
    try {
      const value = JSON.parse(fs.readFileSync(path.join(this.directory,'config.json'),'utf8'));
      if (value.origin) value.origin = cloudflareOrigin(value.origin);
      if (value.tunnelId && !/^[a-f0-9-]{36}$/.test(value.tunnelId)) throw new Error('Invalid tunnel');
      this.config = { origin: value.origin || '', tunnelId: value.tunnelId || '', enabled: value.enabled === true };
    } catch { }
  }
  status() {
    return { bundled: fs.existsSync(this.binary), version: '2026.10.6', authorized: fs.existsSync(this.certificate),
      phase: this.phase, enabled: this.config.enabled, publicUrl: this.config.origin, authorizationUrl: this.authorizationUrl,
      configured: !!this.config.tunnelId && !!this.config.origin, busy: this.busy, error: this.error, publicReady:this.publicReady };
  }
  get publicOrigin(): string { return this.config.origin; }
  private save() {
    const file = path.join(this.directory,'config.json'); fs.writeFileSync(file+'.tmp',JSON.stringify(this.config)); fs.renameSync(file+'.tmp',file);
  }
  private verify() {
    if (this.verified) return;
    if (!fs.existsSync(this.binary)) throw new Error('cloudflared não está incluído nesta instalação.');
    if (createHash('sha256').update(fs.readFileSync(this.binary)).digest('hex') !== HASH) throw new Error('A verificação do cloudflared falhou. Reinstale o pacote.');
    this.verified = true;
  }
  private launch(args: string[]): ChildProcess {
    this.verify();
    return spawn(this.binary,args,{ windowsHide: true, cwd:this.directory, stdio:['ignore','pipe','pipe'],
      env: { ...process.env, NO_AUTOUPDATE:'true' } });
  }
  authorize() {
    if (fs.existsSync(this.certificate) || this.login) return this.status();
    const child = this.launch(['tunnel','login']); this.login=child; this.phase='authorizing'; this.error=null;
    const read = (chunk: Buffer) => {
      const match = String(chunk).match(/https:\/\/dash\.cloudflare\.com\/argotunnel\?[^\s]+/);
      if (match) this.authorizationUrl=match[0];
    };
    child.stdout!.on('data',read); child.stderr!.on('data',read);
    child.on('error',()=> { this.error='Não foi possível abrir a autorização Cloudflare.'; });
    child.on('close',()=> { this.login=null; this.authorizationUrl=null; if (!this.running) this.phase='disabled';
      if (!fs.existsSync(this.certificate)) this.error='Autorização não concluída. Tente novamente no navegador.'; });
    return this.status();
  }
  private async command(args: string[], failure: string): Promise<string> {
    const child=this.launch(['tunnel','--origincert',this.certificate,...args]); this.operations.add(child);
    return new Promise((resolve,reject)=> {
      let output=''; const timeout=setTimeout(()=>child.kill(),60000);
      child.stdout!.on('data',data=> { output+=String(data); if(output.length>1_000_000) child.kill(); });
      child.stderr!.on('data',()=>{}); // Credentials and authorization URLs must not reach logs or clients.
      child.once('error',()=> { clearTimeout(timeout);this.operations.delete(child);reject(new Error(failure)); });
      child.once('close',code=> { clearTimeout(timeout);this.operations.delete(child); if(code===0) resolve(output);else reject(new Error(failure)); });
    });
  }
  async setup(input: string) {
    const origin=cloudflareOrigin(input);
    if(this.busy) throw new Error('A configuração Cloudflare já está em andamento.');
    if(!fs.existsSync(this.certificate)) throw new Error('Autorize a conta Cloudflare primeiro.');
    this.busy=true; this.error=null;
    try {
      if(!this.config.tunnelId) {
        const file=path.join(this.directory,'credentials.json');
        // Recover a completed creation even if the previous app closed before saving config.
        if(!fs.existsSync(file)) await this.command(['create','--output','json','--credentials-file',file,'kmc-timers-'+randomUUID().slice(0,8)],'Não foi possível criar o túnel. Confira a autorização da conta.');
        const credentials=JSON.parse(fs.readFileSync(file,'utf8'));
        if(!/^[a-f0-9-]{36}$/.test(credentials.TunnelID)) throw new Error('Credencial de túnel inválida.');
        this.config.tunnelId=credentials.TunnelID; this.save();
      }
      if(origin!==this.config.origin) await this.command(['route','dns',this.config.tunnelId,new URL(origin).hostname],
        'Não foi possível criar o endereço. Confira se o domínio está na conta autorizada e se o subdomínio está disponível.');
      this.config.origin=origin;this.config.enabled=true;this.save();
      this.stopChild(); this.start();
    } catch(error) { this.error=String(error instanceof Error?error.message:error);throw error; }
    finally { this.busy=false; }
    return this.status();
  }
  start() {
    if(this.closing || this.running || !this.config.enabled || !this.config.origin || !this.config.tunnelId) return;
    const file=path.join(this.directory,'tunnel.yml');
    fs.writeFileSync(file,`tunnel: ${this.config.tunnelId}\ncredentials-file: ${JSON.stringify(path.join(this.directory,'credentials.json'))}\ningress:\n  - hostname: ${new URL(this.config.origin).hostname}\n    service: http://127.0.0.1:${this.gatewayPort}\n  - service: http_status:404\n`);
    try {
      const child=this.launch(['tunnel','--config',file,'--no-autoupdate','--metrics',`127.0.0.1:${this.metricsPort}`,'run',this.config.tunnelId]);
      this.running=child;this.phase='connecting';this.error=null;this.publicReady=false;
      child.stdout!.on('data',()=>{});child.stderr!.on('data',()=>{});
      child.on('error',()=> { this.error='Não foi possível iniciar o túnel Cloudflare.'; });
      child.on('close',()=> {
        if(this.running!==child) return;this.running=null;this.phase='connecting';this.publicReady=false;
        if(this.health) clearInterval(this.health);this.health=null;
        if(this.config.enabled && !this.closing) this.retry=setTimeout(()=> {this.retry=null;this.start();},5000);
      });
      let checking=false,nextPublicCheck=0;
      this.health=setInterval(async()=> {
        if(checking) return;checking=true;
        try {
          const response=await fetch(`http://127.0.0.1:${this.metricsPort}/ready`,{signal:AbortSignal.timeout(1500)});
          if(this.running!==child)return;
          if(!response.ok) {this.phase='connecting';this.publicReady=false;nextPublicCheck=0;return;}
          if(Date.now()>=nextPublicCheck) {
            const ready=await checkRemoteOrigin(this.config.origin,this.instanceId);
            if(this.running!==child)return;
            this.publicReady=ready;
            nextPublicCheck=Date.now()+(this.publicReady?60000:5000);
          }
          if(this.running===child)this.phase=this.publicReady?'connected':'publishing';
        } catch { if(this.running===child) {this.phase='connecting';this.publicReady=false;nextPublicCheck=0;} } finally { checking=false; }
      },2000);this.health.unref();
    } catch(error) {this.phase='error';this.error=error instanceof Error?error.message:String(error);}
  }
  async enable(enabled: boolean) { this.config.enabled=enabled;this.save(); if(enabled)this.start();else this.stopChild();return this.status(); }
  private stopChild() {
    if(this.retry)clearTimeout(this.retry);this.retry=null;
    if(this.health)clearInterval(this.health);this.health=null;
    const child=this.running;this.running=null;child?.kill();this.phase='disabled';this.publicReady=false;
  }
  close() {this.closing=true;this.stopChild();this.login?.kill();for(const child of this.operations)child.kill();}
}
