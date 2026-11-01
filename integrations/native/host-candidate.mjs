import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {anchors,transformNative} from './targeted-execution.mjs';

// Read-only source identities. No original config, index, database or SDK is imported.
export const hostNativeHashes=Object.freeze({...anchors,
 'index.ts':'6a8f253dcc6d91f3454c9dd49abe190384da947876665584758324029e4dafa5',
 'group-queue.ts':'9ad64c718f2d8c37d16539a98554c04c0ed2ffe10d49a557a399fbf9018d4bb5',
 'web-context.ts':'9b6897c181cf0c8f6fd7a387bdb0b680b366b85d15c5c1f884eb49d639a471c9',
 'web.ts':'7049af95711fe243369d25c21651f1a33b093ab7792347e72f90a07092b2213d',
 'routes/tasks.ts':'2c2328c8ff4b897059fe19e8cea6491a1b97e90b50892bbdd18f4a1348e2f2d4',
 'isolated-task-ipc.ts':'fa0545c6ba9340f4aef2156c04db88db03c9b864d0afff4f061f55d5c6f53f3d',
 'channel-reliability-recovery.ts':'4dc582a70f5476db1f1ee266b06920a75fa6b73677a0c18ac64ce691ab4acf85',
 'types.ts':'846917d461980595c521c48af46e7cc2cc24ee0c959fee03feb3d426c0e763ec',
});
export const hostOverlayHashes=Object.freeze({
 'appointment-boot-gate.ts':'9d97ff38303b660eeaf3573757939ed4201a6e287d0548709cd18cc71ffde386',
 'appointment-boot-tasks-overlay.mjs':'dc380eae9b91ceda0da9a71a848f2516a25fbf0e29baa8d4c4271c0f5bc4904e',
 'appointment-boot-overlay.mjs':'d26b00342bb6424e439e1d10bec82bfe75f6729da7ec944ececa7c9d969716f7',
 'appointment-warm-overlay.mjs':'b95f2fbeaa48a2515384d3bc4a69a26edb0395dda2d9dbbbbcab0ac1e5a8cbca',
 'appointment-cold-overlay.mjs':'f6705639ccdeac14e212590e98fe4036e0c42c1a06094eeab8c8de77b337818d',
 'appointment-web-preflight-overlay.mjs':'4fc5063489566351453d5da6880f7e48c857b2ec90ddb0d92f3fa51a0c2d4d5f',
 'appointment-web-rejection-overlay.mjs':'2f33d568994d3fe66bda4cff531133b5b19ccbf04422d817dc9ea6199f5edfaf',
 'appointment-rejection-overlay.mjs':'3e0100573b538ac6363c03b795d13a2d950db92be1a988f89e660e7418eb23bb',
 'appointment-index-rejection-overlay.mjs':'9a90a299edc6bf2c5d1f7995a456bca8f9a1f2f199dd1e75b22f00212a667f6b',
 'appointment-task-cleanup.ts':'c59e88bcf584070f55456b09ce4002c7f684ef6b64c2d423066112503eec57b6',
 'appointment-boot-consumers-overlay.mjs':'8ee92f3b29537387803d4115c0848cded8965a10ede09998560aaf2177be4f4b',
 'appointment-boot-assembly-overlay.mjs':'7fb685bd17158f0b1f83254cd0350388b9d6a85cdda830374e0518762569077c',
 'appointment-boot-inventory-overlay.mjs':'705657a014cda3cc668ab1e0ec74cb1307405a4744c77e3daa28aad5e9078a81',
 'db-appointment-query.ts.fragment':'e899f401d9d0cafffc11115c07cf5d4b149f3a1fd43f84918e1f1c1ef9307b12',
 'db-appointment-boot.ts.fragment':'674514b364205669f5f5417e22d7cc82d5ff680e6914f2c0f54ef86be71988e0',
});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function exact(source,before,after){if(source.split(before).length!==2)throw Error('HOST_CANDIDATE_ANCHOR_CHANGED: '+before.slice(0,70));return source.replace(before,after);}
function verified(root,expected){const out=new Map();for(const [name,wanted]of Object.entries(expected)){const bytes=fs.readFileSync(path.join(root,name));if(hash(bytes)!==wanted)throw Error('HOST_SOURCE_CHANGED: '+name);out.set(name,bytes.toString('utf8'));}return out;}
function requireText(source,text){if(!source.includes(text))throw Error('HOST_WIRING_MISSING: '+text.slice(0,90));}

/** Returns only source strings for a disposable source COPY. Never writes to N/O.
 * The original O overlay rejects targeted source because its input identity is
 * intentionally frozen at N. The sole adaptation permits the exact, independently
 * hash-validated transformNative(N) scheduler identity as an additional input.
 * Its original expected identities and all behavior/substring guards remain.
 */
export async function createHostCandidate(nativeRoot,overlayRoot){
 if(!path.isAbsolute(nativeRoot)||!path.isAbsolute(overlayRoot))throw Error('HOST_ABSOLUTE_SOURCE_REQUIRED');
 const native=verified(nativeRoot,hostNativeHashes),overlay=verified(overlayRoot,hostOverlayHashes);
 const privateRoot=path.resolve(overlayRoot).replaceAll('\\','/')+'/';
 const target=transformNative('task-scheduler.ts',Buffer.from(native.get('task-scheduler.ts')));
 const targetIdentity=hash(target.replaceAll(privateRoot,'@appointment-candidate/'));
 // Execute only the verified immutable helper snapshots. Importing the original
 // path after checking it could otherwise evaluate a later, unchecked edit.
 const moduleUrls=new Map();
 function snapshotModule(name,source=overlay.get(name)){
  if(source===undefined||!name.endsWith('.mjs'))throw Error('HOST_UNVERIFIED_HELPER: '+name);
  if(moduleUrls.has(name)&&source===overlay.get(name))return moduleUrls.get(name);
  let code=source.replace(/from '(\.\/[^']+\.mjs)'/g,(_whole,relative)=>`from '${snapshotModule(relative.slice(2))}'`);
  code=code.replace("import ts from 'typescript';",`import ts from '${import.meta.resolve('typescript')}';`);
  code=code.replaceAll('import.meta.url',JSON.stringify(pathToFileURL(path.join(overlayRoot,name)).href));
  const url='data:text/javascript;base64,'+Buffer.from(code).toString('base64');
  if(source===overlay.get(name))moduleUrls.set(name,url);
  return url;
 }
 let adapted=exact(overlay.get('appointment-boot-tasks-overlay.mjs'),
  'if (identity !== identities[target])',
  `if (identity !== identities[target] && !(target === 'task-scheduler.ts' && identity === '${targetIdentity}'))`);
 const taskOverlay=await import(snapshotModule('appointment-boot-tasks-overlay.mjs',adapted));
 if(path.resolve(taskOverlay.bootTaskFiles['task-scheduler.ts'])!==path.resolve(nativeRoot,'task-scheduler.ts'))throw Error('HOST_NATIVE_OVERLAY_LAYOUT_MISMATCH');
 const originalOverlay=await import(snapshotModule('appointment-boot-tasks-overlay.mjs'));
 const inventoryOverlay=await import(snapshotModule('appointment-boot-inventory-overlay.mjs'));
 const composed=taskOverlay.applyBootTaskOverlay(target,path.join(nativeRoot,'task-scheduler.ts'));
 // Wiring is produced by O's complete ordered stack, then checked as text. The
 // test never imports index or starts a server, connection, recovery or pump.
 const indexSource=inventoryOverlay.applyBootInventoryCandidate(native.get('index.ts'),path.join(nativeRoot,'index.ts'));
 const routeSource=originalOverlay.applyBootTaskCandidate(native.get('routes/tasks.ts'),path.join(nativeRoot,'routes/tasks.ts'));
 for(const text of [
  "const appointmentBootGate = createAppointmentBootGate(\n  APPOINTMENT_BOOT_BOUNDARY === 'member-container-only' ? 'appointment' : 'original'",
  "const queue = new GroupQueue(APPOINTMENT_BOOT_BOUNDARY === 'member-container-only' ? appointmentBootGate : undefined);",
  "const schedulerDeps: import('./task-scheduler.js').SchedulerDependencies = {\n    appointmentBootGate,",
  '  startWebServer({\n    queue,\n    appointmentBootGate,',
  "if (appointmentBootGate.phase() !== 'ready') throw new Error('APPOINTMENT_RECOVERY_NOT_COMMITTED');",
  '      startSchedulerLoop(schedulerDeps);',
  '        stopSchedulerLoop(),',
 ])requireText(indexSource,text);
 for(const text of ['const gate = getWebDeps()?.appointmentBootGate;','const ticket = gate.beginWrite();','if (gate.isPaused()) return refuse();','finally { gate.finishWrite(ticket); }'])requireText(routeSource,text);
 const files=new Map([
  ['task-scheduler.ts',composed.replaceAll(privateRoot+'appointment-boot-gate.js','./appointment-boot-gate.js')],
  ['appointment-boot-gate.ts',overlay.get('appointment-boot-gate.ts')],
  ['appointment-task-cleanup.ts',overlay.get('appointment-task-cleanup.ts').replaceAll('../../../full-instance/stage/app/src/isolated-task-ipc.js','./isolated-task-ipc.js')],
 ]);
 for(const name of ['isolated-task-ipc.ts','channel-reliability-recovery.ts'])files.set(name,originalOverlay.applyBootTaskCandidate(native.get(name),path.join(nativeRoot,name)).replaceAll(privateRoot+'appointment-boot-gate.js','./appointment-boot-gate.js').replaceAll(privateRoot+'appointment-task-cleanup.js','./appointment-task-cleanup.js'));
 return {files,indexSource,routeSource,audit:{nativeHashes:hostNativeHashes,overlayHashes:hostOverlayHashes,targetIdentity,composedHashes:Object.fromEntries([...files].map(([name,value])=>[name,hash(value)])),
  sourceIndexWiring:'source-only: original O complete index transform passes the same gate into queue/WebDeps/schedulerDeps; ready-only consumer drain and original shutdown sequence; index/Web/routes never imported',
  runtimeCandidate:'real O BootGate + task-scheduler/isolated-task-ipc/reliability-recovery overlays + T7 targeted scheduler/DB; fixtures retain N queue and T7 DB, not full O queue/DB boot/Web stack; full host process startup is not runtime-validated',
 }};
}
