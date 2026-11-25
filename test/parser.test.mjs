import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './fixtures.mjs';
import { discoverCodex, readConversation } from '../src/codex.mjs';
import { stageJob } from '../src/stage.mjs';

test('Codex database project assignment takes precedence over stale desktop metadata', async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const db=new DatabaseSync(join(f.source,'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,project_id TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT);CREATE TABLE project_roots(project_id TEXT,path TEXT,position INTEGER)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run(f.id,'p',f.scratch,Math.floor(Date.now()/1000),f.path);
  db.prepare('INSERT INTO project_roots VALUES(?,?,?)').run('p',f.scratch,0);db.close();
  const index=await discoverCodex(f.source);
  assert.equal(index.chats[0].root,f.scratch);assert.equal(index.chats[0].assignment,'database');
});

test('reads a compressed child with its exact inherited byte prefix and rejects incomplete boundaries',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const parent=await readFile(f.path);const first=parent.indexOf(10)+1;const boundary=parent.indexOf(10,parent.indexOf(10,parent.indexOf(10,first)+1)+1)+1;
  const id=randomUUID(),path=join(dirname(f.path),`rollout-child-${id}.jsonl.zst`),at=new Date().toISOString();
  const child=[{type:'session_meta',payload:{id,cwd:f.scratch,history_base:{thread_id:f.id,end_byte_offset:boundary}}},
    {type:'event_msg',timestamp:at,payload:{type:'user_message',message:'Child question'}},
    {type:'event_msg',timestamp:at,payload:{type:'agent_message',message:'Child answer'}}];
  await writeFile(path,zstdCompressSync(Buffer.from(child.map(r=>JSON.stringify(r)).join('\n')+'\n')));
  let index=await discoverCodex(f.source),meta=index.chats.find(c=>c.id===id),conversation=await readConversation(meta,index);
  assert.deepEqual(conversation.messages.map(m=>m.text),['User message 0','Assistant reply 0','Child question','Child answer']);
  child[0].payload.history_base.end_byte_offset=boundary-1;
  await writeFile(path,zstdCompressSync(Buffer.from(child.map(r=>JSON.stringify(r)).join('\n')+'\n')));
  await assert.rejects(readConversation(meta,index),/inside a JSON record/);
});

test('mixed old agent events and response items preserve order and repeated equal user turns',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));const time=new Date().toISOString();
  const records=[{type:'session_meta',payload:{id:f.id,cwd:f.scratch}},
    {type:'event_msg',payload:{type:'user_message',message:'yes'}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'yes'}]}},
    {type:'event_msg',payload:{type:'user_message',message:'yes'}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'yes'}]}},
    {type:'event_msg',payload:{type:'agent_message',message:'older reply'}},
    {type:'event_msg',payload:{type:'user_message',message:'new question'}},
    {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'new reply'}]}},
    {type:'event_msg',payload:{type:'agent_message',message:'new reply'}}];
  await writeFile(f.path,records.map(r=>JSON.stringify({...r,timestamp:time})).join('\n')+'\n');
  const index=await discoverCodex(f.source),c=await readConversation(index.chats[0],index);
  assert.deepEqual(c.messages.map(m=>m.text),['yes','yes','older reply','new question','new reply']);
});

test('unrecoverable uploads require acknowledgement; replaced bytes invalidate the preview',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));const index=await discoverCodex(f.source),c=await readConversation(index.chats[0],index);
  await writeFile(join(f.scratch,'brief.pdf'),'replaced');
  await assert.rejects(stageJob(index,f.target,[{id:f.id,sourceHash:c.sourceHash}],{jobRoot:join(f.root,'jobs')}),/changed after preview/);
  await rm(join(f.scratch,'brief.pdf'));
  await assert.rejects(stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs')}),/unavailable/);
  const job=await stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs'),acceptMissing:true});
  assert.equal(job.job.missing.length,1);assert.equal(job.job.files.length,1);
});

test('a physically renamed project requires the current path, while explicit blank paths are refused',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));const moved=f.workspace+'-renamed';await rename(f.workspace,moved);
  const index=await discoverCodex(f.source);
  await assert.rejects(stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs')}),/Project folder not found/);
  await assert.rejects(stageJob(index,f.target,[{id:f.id,root:''}],{jobRoot:join(f.root,'jobs')}),/Invalid chat selection/);
  const job=await stageJob(index,f.target,[{id:f.id,root:moved}],{jobRoot:join(f.root,'jobs')});
  assert.equal(job.job.batch.threads[0].runtime.runtimePayload.cwd,moved);
});

test('unsupported rewind records and disabled Codex providers stop before import',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  let index=await discoverCodex(f.source);
  await writeFile(join(f.target,'userdata/settings.json'),JSON.stringify({providerInstances:{codex:{driver:'codex',enabled:false,config:{}}}}));
  await assert.rejects(stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs')}),/Enable the default Codex/);
  await writeFile(f.path,await readFile(f.path,'utf8')+JSON.stringify({type:'event_msg',payload:{type:'thread_rolled_back'}})+'\n');
  await assert.rejects(readConversation(index.chats[0],index),/unsupported rewind/);
});

test('file URLs decode spaces and injected Codex context stays out of visible messages',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const {pathToFileURL}=await import('node:url');const file=join(f.scratch,'a brief résumé.pdf');await writeFile(file,await readFile(join(f.scratch,'brief.pdf')));
  const at=new Date().toISOString();const records=[{type:'session_meta',payload:{id:f.id,cwd:f.scratch}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context>injected context</environment_context>'}]}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Actual user turn'},{type:'input_file',path:pathToFileURL(file).href,filename:'résumé.pdf'}]}},
    {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Actual answer'}]}}];
  await writeFile(f.path,records.map(r=>JSON.stringify({...r,timestamp:at})).join('\n')+'\n');
  const index=await discoverCodex(f.source),c=await readConversation(index.chats[0],index);
  assert.deepEqual(c.messages.map(m=>m.text),['Actual user turn','Actual answer']);assert.equal(c.assets[0].error,undefined);assert.equal(c.assets[0].path,file);
});

test('a different provider home is refused rather than creating an unresumable chat',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));const index=await discoverCodex(f.source);
  await writeFile(join(f.target,'userdata/settings.json'),JSON.stringify({providerInstances:{codex:{driver:'codex',config:{homePath:f.workspace}}}}));
  await assert.rejects(stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs')}),/differs from the home used by T3/);
});
