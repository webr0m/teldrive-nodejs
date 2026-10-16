import { mkdtemp, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const directory=await mkdtemp(path.join(os.tmpdir(),'teldrive-npm-runtime-'));
async function run(executable,args){const code=await new Promise((resolve,reject)=>{const child=spawn(executable,args,{cwd:directory,env:{...process.env,NODE_PATH:''},stdio:'inherit',windowsHide:true,shell:process.platform==='win32'&&executable.endsWith('.cmd')});child.on('error',reject);child.on('close',resolve);});if(code)throw new Error(`Production installation check exited ${code}`);}
try{
  const pkg=JSON.parse(await readFile('package.json','utf8'));delete pkg.devDependencies;
  await writeFile(path.join(directory,'package.json'),JSON.stringify(pkg));
  await cp('src',path.join(directory,'src'),{recursive:true});
  await cp('edge',path.join(directory,'edge'),{recursive:true});
  await cp('packages/rclone-teldrive',path.join(directory,'packages/rclone-teldrive'),{recursive:true,filter:source=>!source.split(path.sep).includes('node_modules')});
  await run(process.platform==='win32'?'npm.cmd':'npm',['install','--omit=dev','--ignore-scripts','--package-lock=false','--no-audit','--no-fund']);
  await run(process.execPath,['--input-type=module','-e',"await import('./src/server.mjs'); console.log('Standalone npm production imports passed')"]);
}finally{const resolved=path.resolve(directory);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('teldrive-npm-runtime-'))throw new Error('Invalid installation-test cleanup path');await rm(resolved,{recursive:true,force:true});}
