import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTrustedBunSandbox, trustedSandboxAvailable } from "./trusted-bun-sandbox";

if (!trustedSandboxAvailable()) throw new Error("Pinned Bun sandbox is unavailable");

const probes = {
  "staged-read-and-environment": `import {readFileSync} from 'node:fs';
if(readFileSync(process.argv[2],'utf8')!=='safe'||process.env.GITHUB_TOKEN||process.env.AWS_SECRET_ACCESS_KEY||process.env.HOME!=='/nonexistent')process.exit(1);`,
  "outside-read": `import {readFileSync} from 'node:fs';
for(const p of ['/root/.ssh/id_rsa','/var/run/docker.sock','/host-secret','/sandbox/../host-secret']){try{readFileSync(p);process.exit(1)}catch{}}`,
  "filesystem-writes": `import {writeFileSync} from 'node:fs';
for(const p of ['/sandbox/inputs/data.txt','/tmp/ci-policy-write','/dev/shm/ci-policy-write']){try{writeFileSync(p,'unsafe');process.exit(1)}catch{}}`,
  "tcp-loopback-and-unix": `import net from 'node:net';
for(const address of [{host:'127.0.0.1',port:45678},{path:'/var/run/docker.sock'}]){
await new Promise((resolve,reject)=>{const s=net.connect(address);s.on('connect',()=>{s.destroy();reject(Error('network allowed'))});s.on('error',()=>resolve());});}`, 
  "http-fetch": `try{await fetch('http://127.0.0.1:45678',{signal:AbortSignal.timeout(2000)});process.exit(1)}catch(e){if(e.name==='TimeoutError')process.exit(1)}`,
  "udp": `import {createSocket} from 'node:dgram';
await new Promise((resolve,reject)=>{const s=createSocket('udp4');s.on('error',()=>{try{s.close()}catch{};resolve()});s.bind(0,()=>{s.close();reject(Error('UDP allowed'))});});`,
  "dns": `import {Resolver} from 'node:dns/promises';
const r=new Resolver({timeout:1000,tries:1});r.setServers(['127.0.0.1']);try{await r.resolve4('example.invalid');process.exit(1)}catch{}finally{r.cancel()}`,
  "child-process": `import {spawnSync} from 'node:child_process';
try{const r=spawnSync('/bin/true');if(!r.error&&r.status===0)process.exit(1)}catch{}`,
  "string-code-generation": `for(const attempt of [()=>eval('1+1'),()=>new Function('return 1')]){try{attempt();process.exit(1)}catch(e){if(e.name!=='EvalError')process.exit(1)}}`,
  "workers-and-ffi": `import {Worker} from 'node:worker_threads';import {dlopen} from 'bun:ffi';
for(const attempt of [()=>new Worker('unused.mjs'),()=>dlopen('libc.so.6',{})]){try{attempt();process.exit(1)}catch(e){if(e.code!=='ERR_ACCESS_DENIED')process.exit(1)}}`,
};

for (const [label, source] of Object.entries(probes)) {
  const root = mkdtempSync(path.join(tmpdir(), "ci-policy-probe-"));
  const outside = `${root}-outside`;
  try {
    mkdirSync(path.join(root, "program"));
    mkdirSync(path.join(root, "inputs"));
    const script = path.join(root, "program", "probe.mjs");
    const input = path.join(root, "inputs", "data.txt");
    writeFileSync(outside, "host-only-control");
    const outsideControl = label === "outside-read"
      ? `\ntry{readFileSync(${JSON.stringify(outside)});process.exit(1)}catch{}`
      : "";
    writeFileSync(script, source + outsideControl);
    writeFileSync(input, "safe");
    if (!runTrustedBunSandbox(root, script, [input], 30_000, true)) throw new Error(`Sandbox probe failed: ${label}`);
    console.log(`Sandbox verified: ${label}`);
  } finally {
    rmSync(outside, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

const root = mkdtempSync(path.join(tmpdir(), "ci-policy-timeout-"));
try {
  const script = path.join(root, "loop.mjs");
  writeFileSync(script, "while(true){}");
  const started = Date.now();
  if (runTrustedBunSandbox(root, script, [], 1000)) throw new Error("Sandbox timeout did not fail closed");
  const elapsed = Date.now() - started;
  if (elapsed < 900 || elapsed > 10_000) throw new Error("Sandbox did not exercise a bounded timeout and cleanup");
  console.log("Sandbox verified: timeout and container cleanup");
} finally {
  rmSync(root, { recursive: true, force: true });
}
