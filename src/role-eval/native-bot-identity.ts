import type {BotReadScope} from './wecom-bot-context.js';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';

/** Read-only Native identity seam. No server listener or credential discovery. */
export function createNativeBotIdentityReader(file:string) {
  const unavailable=()=>Error('native_identity_unverifiable');
  if(!path.isAbsolute(file))throw unavailable();
  let db:DatabaseSync;
  try{db=new DatabaseSync(file,{readOnly:true});}catch{throw unavailable();}
  let closed=false;
  const check=(scope:BotReadScope)=>{
    if(scope.signal.aborted)throw Error('authority_cancelled');
    if(!Number.isFinite(scope.deadline)||performance.now()>=scope.deadline)throw Error('authority_timeout');
    if(closed)throw unavailable();
  };
  const read = async (accountId:string, scope:BotReadScope):Promise<{user:unknown;workspaceJid:string}> => {
    check(scope);
    if(typeof accountId!=='string'||!accountId||accountId.length>120||/[\s\u0000]/.test(accountId))throw unavailable();
    let transaction=false;
    try{
      // Match the existing Native schema without importing initDatabase or
      // getOrCreate/ensure helpers, which can write to the original instance.
      db.exec('BEGIN');transaction=true;
      const user=db.prepare('SELECT id,role,status,must_change_password FROM users WHERE id=?').get(accountId);
      const homes=db.prepare('SELECT jid,created_by,is_home,execution_mode FROM registered_groups WHERE is_home=1 AND created_by=?').all(accountId);
      if(!user||user.id!==accountId||!['admin','member'].includes(String(user.role))||!['active','disabled','deleted'].includes(String(user.status))||![0,1].includes(Number(user.must_change_password))||typeof user.must_change_password!=='number'||homes.length!==1)throw unavailable();
      const home=homes[0]!;
      if(home.created_by!==accountId||home.is_home!==1||home.execution_mode!=='container'||typeof home.jid!=='string'||!home.jid.startsWith('web:')||home.jid.length>200||/[\s\u0000#]/.test(home.jid))throw unavailable();
      const result={user:{id:accountId,role:user.role,status:user.status,must_change_password:user.must_change_password===1},workspaceJid:home.jid};
      check(scope);db.exec('COMMIT');transaction=false;check(scope);
      return result;
    }catch(error){
      if(transaction)try{db.exec('ROLLBACK');}catch{}
      if(error instanceof Error&&['authority_cancelled','authority_timeout'].includes(error.message))throw error;
      throw unavailable();
    }
  };
  return Object.assign(read,{close(){if(!closed){closed=true;db.close();}}});
}
