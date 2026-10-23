import {expect,it} from 'vitest';
import fs from 'node:fs';

it('loads the synthetic .env before the actual entry import closure captures execution policy',async()=>{
 expect(process.env.MINICLAW_EXECUTION_BOUNDARY).toBeUndefined();
 // This is emitted from the actual composed index's runtime import declarations
 // in their original order. It has no main body and cannot start business work.
 await import('../src/index-imports.mjs');
 const policy=await import('../src/business-execution-policy.js');
 expect(process.env.MINICLAW_EXECUTION_BOUNDARY).toBe('member-container-only');
 expect(policy.BUSINESS_EXECUTION_BOUNDARY).toBe('member-container-only');
 fs.writeFileSync(process.env.QIWE_FULL_HOST_ENV_EVIDENCE!,JSON.stringify({processId:process.pid,loaded:process.env.MINICLAW_EXECUTION_BOUNDARY,captured:policy.BUSINESS_EXECUTION_BOUNDARY,scope:'actual composed runtime imports only; no main, no gate restore'}));
});
