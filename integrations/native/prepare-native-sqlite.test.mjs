import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readArchive,verifyPreparedNativeSqlite} from './prepare-native-sqlite.mjs';

function archive(entries) {
  const chunks=[];
  for(const {name,type='0',data='synthetic'} of entries){
    const h=Buffer.alloc(512);h.write(name,0,100);h.write('0000644\0',100);h.write('0000000\0',108);h.write('0000000\0',116);
    h.write(Buffer.byteLength(data).toString(8).padStart(11,'0')+'\0',124);h.fill(32,148,156);h.write(type,156);h.write('ustar\0',257);
    const sum=h.reduce((n,v)=>n+v,0);h.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
    chunks.push(h,Buffer.from(data),Buffer.alloc((512-Buffer.byteLength(data)%512)%512));
  }
  return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));
}

test('rejects traversal, absolute paths, links, duplicate members and malformed archives before extraction',()=>{
  for(const name of ['../escape','package/../../escape','/absolute','C:/absolute','package\\..\\escape','package//escape']){
    assert.throws(()=>readArchive(archive([{name}])),/Unsafe archive/);
  }
  for(const type of ['1','2','x','g']) assert.throws(()=>readArchive(archive([{name:'package/lib/index.js',type}])),/Unsafe archive/);
  assert.throws(()=>readArchive(archive([{name:'package/lib/index.js'},{name:'package/lib/index.js'}])),/Unsafe archive/);
  const invalid=archive([{name:'package/lib/index.js'}]);invalid[0]=0;
  assert.throws(()=>readArchive(invalid));
});

test('returns regular file bytes and directories without executing archive content',()=>{
  const result=readArchive(archive([{name:'package/',type:'5',data:''},{name:'package/lib/index.js',data:'throw Error("must not execute")'}]));
  assert.equal(result.length,1);
  assert.equal(result[0].name,'package/lib/index.js');
  assert.equal(result[0].data.toString(),'throw Error("must not execute")');
});

test('offline prepared-package admission rejects substituted JS and native binary without trusting a manifest',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qiwe-sqlite-admission-test-'));
  try{
    const source=path.join(directory,'app/src'),original=path.join(directory,'app/node_modules/better-sqlite3'),prepared=path.join(directory,'prepared');
    fs.mkdirSync(source,{recursive:true});fs.mkdirSync(path.join(original,'lib'),{recursive:true});fs.mkdirSync(path.join(prepared,'lib'),{recursive:true});fs.mkdirSync(path.join(prepared,'build/Release'),{recursive:true});
    const metadata=JSON.stringify({name:'better-sqlite3',version:'12.11.1',main:'lib/index.js'});
    for(const packagePath of [original,prepared])fs.writeFileSync(path.join(packagePath,'package.json'),metadata);
    fs.writeFileSync(path.join(directory,'app/package-lock.json'),JSON.stringify({packages:{'node_modules/better-sqlite3':{version:'12.11.1',resolved:'https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-12.11.1.tgz',integrity:'sha512-dq9AtApgg5PGFtBzPFSBl3HZQjHok5gaQCM6zh2Yk0aSmDCs1CbnVI8/HgASQkNKsWFpseIO9beg5xxpYhbIfA=='}}}));
    fs.writeFileSync(path.join(original,'lib/index.js'),'module.exports = 1;');fs.writeFileSync(path.join(prepared,'lib/index.js'),'throw Error("substituted JS must not run");');
    fs.writeFileSync(path.join(prepared,'build/Release/better_sqlite3.node'),'substituted binary');
    fs.writeFileSync(path.join(prepared,'../manifest.json'),JSON.stringify({version:'12.11.1',binarySha256:'forged-manifest-is-not-authority'}));
    assert.throws(()=>verifyPreparedNativeSqlite(source,prepared),/Prepared JS differs/);
    fs.copyFileSync(path.join(original,'lib/index.js'),path.join(prepared,'lib/index.js'));
    assert.throws(()=>verifyPreparedNativeSqlite(source,prepared),/Prepared binary differs/);
    assert.throws(()=>verifyPreparedNativeSqlite(source,'relative/package'),/absolute/);
  }finally{
    const resolved=fs.realpathSync(directory);
    if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!path.basename(resolved).startsWith('qiwe-sqlite-admission-test-'))throw Error('Unsafe cleanup');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});
