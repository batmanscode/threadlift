import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, rename, readdir, mkdir } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './fixtures.mjs';
import { discoverCodex, readConversation } from '../src/codex.mjs';
import { stageJob } from '../src/stage.mjs';

test('Codex database project assignment takes precedence over stale desktop metadata', async t=>{
  const f=await fixture(t);
  const db=new DatabaseSync(join(f.source,'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,project_id TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT);CREATE TABLE project_roots(project_id TEXT,path TEXT,position INTEGER)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run(f.id,'p',f.scratch,Math.floor(Date.now()/1000),f.path);
  db.prepare('INSERT INTO project_roots VALUES(?,?,?)').run('p',f.scratch,0);db.close();
  const index=await discoverCodex(f.source);
  const preview=await readConversation(index.chats[0],index);
  assert.equal(index.chats[0].root,f.scratch);assert.equal(index.chats[0].assignment,'database');
  await writeFile(f.path+'.zst',zstdCompressSync(await readFile(f.path)));await rm(f.path);
  const compressed=await discoverCodex(f.source);
  assert.equal(compressed.chats.length,1);
  assert.equal((await readConversation(compressed.chats[0],compressed)).sourceHash,preview.sourceHash);
  const other=join(f.root,'other-workspace');await mkdir(other);await writeFile(join(other,'unselected.txt'),'Must not be copied');
  const changed=new DatabaseSync(join(f.source,'state_5.sqlite'));
  changed.prepare('UPDATE threads SET cwd=? WHERE id=?').run(other,f.id);changed.close();
  await assert.rejects(stageJob(index,f.target,[{id:f.id,sourceHash:preview.sourceHash,root:f.workspace,recoverWorkspace:true}],{jobRoot:join(f.root,'jobs')}),/changed after preview/);
});

test('reads a compressed fork with an inherited byte prefix and rejects incomplete boundaries',async t=>{
  const f=await fixture(t, { turns: 2 });
  // Keep metadata, both representations of the first user turn, and its reply.
  const parent=await readFile(f.path,'utf8');
  const boundary=Buffer.byteLength(parent.split('\n').slice(0,4).join('\n')+'\n');
  const id=randomUUID(),path=join(dirname(f.path),`rollout-child-${id}.jsonl.zst`),at=new Date().toISOString();
  const child=[{type:'session_meta',payload:{id,cwd:f.scratch,history_base:{thread_id:f.id,end_byte_offset:boundary}}},
    {type:'event_msg',timestamp:at,payload:{type:'user_message',message:'Child question'}},
    {type:'event_msg',timestamp:at,payload:{type:'agent_message',message:'Child answer'}}];
  await writeFile(path,zstdCompressSync(Buffer.from(child.map(r=>JSON.stringify(r)).join('\n')+'\n')));
  let index=await discoverCodex(f.source),meta=index.chats.find(c=>c.id===id),conversation=await readConversation(meta,index);
  assert.deepEqual(conversation.messages.map(m=>m.text),['User message 0','Assistant reply 0','Child question','Child answer']);
  delete child[0].payload.history_base.end_byte_offset;
  await writeFile(path,zstdCompressSync(Buffer.from(child.map(r=>JSON.stringify(r)).join('\n')+'\n')));
  await assert.rejects(readConversation(meta,index),/requires a valid byte boundary/);
  child[0].payload.history_base.end_byte_offset=boundary-1;
  await writeFile(path,zstdCompressSync(Buffer.from(child.map(r=>JSON.stringify(r)).join('\n')+'\n')));
  await assert.rejects(readConversation(meta,index),/inside a JSON record/);
});

test('mixed old agent events and response items preserve order and repeated equal user turns',async t=>{
  const f=await fixture(t);const time=new Date().toISOString();
  const records=[{type:'session_meta',payload:{id:f.id,cwd:f.scratch}},
    {type:'event_msg',payload:{type:'user_message',message:'yes'}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'yes'}]}},
    {type:'event_msg',payload:{type:'user_message',message:'yes'}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'yes'}]}},
    {type:'event_msg',payload:{type:'agent_message',message:'older reply'}},
    {type:'event_msg',payload:{type:'user_message',message:'new question'}},
    {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'new reply'}]}},
    {type:'event_msg',payload:{type:'agent_message',message:'new reply'}},
    {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'same reply in another turn'}]}},
    {type:'turn_context',payload:{cwd:f.workspace}},
    {type:'event_msg',payload:{type:'agent_message',message:'same reply in another turn'}}];
  await writeFile(f.path,records.map(r=>JSON.stringify({...r,timestamp:time})).join('\n')+'\n');
  const index=await discoverCodex(f.source),c=await readConversation(index.chats[0],index);
  assert.deepEqual(c.messages.map(m=>m.text),['yes','yes','older reply','new question','new reply','same reply in another turn','same reply in another turn']);
});

test('unrecoverable uploads require acknowledgement; replaced bytes invalidate the preview',async t=>{
  const f=await fixture(t);const index=await discoverCodex(f.source),c=await readConversation(index.chats[0],index);
  await writeFile(join(f.scratch,'brief.pdf'),'replaced');
  await assert.rejects(stageJob(index,f.target,[{id:f.id,sourceHash:c.sourceHash}],{jobRoot:join(f.root,'jobs')}),/changed after preview/);
  await rm(join(f.scratch,'brief.pdf'));
  await assert.rejects(stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs')}),/unavailable/);
  assert.deepEqual(await readdir(join(f.root,'jobs')),[]);
  const job=await stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs'),acceptMissing:true});
  assert.equal(job.job.missing.length,1);assert.equal(job.job.files.length,1);
});

test('relative uploads need an original folder; absolute and inline uploads still recover', async t => {
  const f = await fixture(t), records = (await readFile(f.path,'utf8')).trim().split('\n').map(JSON.parse);
  delete records[0].payload.cwd;
  records.find(r => r.payload?.type === 'user_message').payload.local_images = [];
  const content = records.find(r => r.type === 'response_item' && r.payload.role === 'user').payload.content;
  content.push({ type:'input_file', path:relative(process.cwd(),join(f.scratch,'brief.pdf')), filename:'unknown-relative.pdf' },
    { type:'input_file', file_data:'data:text/plain;base64,aW5saW5l', filename:'inline.txt' });
  await writeFile(f.path,records.map(JSON.stringify).join('\n')+'\n');
  const index = await discoverCodex(f.source), c = await readConversation(index.chats[0],index);
  assert.equal(c.cwd,''); assert.equal(c.root,f.workspace);
  assert.match(c.assets.find(a => a.name === 'unknown-relative.pdf').error,/original folder.*unknown/);
  assert.equal(c.assets.filter(a => !a.error).length,2);
  await assert.rejects(stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs')}),/unavailable/);
  const staged = await stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs'),acceptMissing:true});
  assert.equal(staged.job.files.length,2); assert.equal(staged.job.missing.length,1);
  records[0].payload.cwd = f.scratch;
  records.splice(1, 0, {type:'turn_context', payload:{cwd:'unknown-relative-folder'}});
  await writeFile(f.path,records.map(JSON.stringify).join('\n')+'\n');
  const changedIndex = await discoverCodex(f.source), changed = await readConversation(changedIndex.chats[0],changedIndex);
  assert.match(changed.assets.find(a => a.name === 'unknown-relative.pdf').error,/original folder.*unknown/);
  assert.equal(changed.assets.filter(a => !a.error).length,2);
});

test('a physically renamed project requires the current path, while explicit blank paths are refused',async t=>{
  const f=await fixture(t);const moved=f.workspace+'-renamed';await rename(f.workspace,moved);
  const index=await discoverCodex(f.source);
  await assert.rejects(stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs')}),/Project folder not found/);
  await assert.rejects(stageJob(index,f.target,[{id:f.id,root:''}],{jobRoot:join(f.root,'jobs')}),/Invalid chat selection/);
  const job=await stageJob(index,f.target,[{id:f.id,root:moved}],{jobRoot:join(f.root,'jobs')});
  assert.equal(job.job.batch.threads[0].runtime.runtimePayload.cwd,moved);
});

test('unsupported rewind records and disabled Codex providers stop before import',async t=>{
  const f=await fixture(t);
  let index=await discoverCodex(f.source);
  await writeFile(join(f.target,'userdata/settings.json'),JSON.stringify({providerInstances:{codex:{driver:'codex',enabled:false,config:{}}}}));
  await assert.rejects(stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs')}),/Enable the default Codex/);
  await writeFile(f.path,await readFile(f.path,'utf8')+JSON.stringify({type:'event_msg',payload:{type:'thread_rolled_back'}})+'\n');
  await assert.rejects(readConversation(index.chats[0],index),/unsupported rewind/);
});

test('file URLs decode spaces and injected Codex context stays out of visible messages',async t=>{
  const f=await fixture(t);
  const file=join(f.scratch,'a brief résumé.pdf');await writeFile(file,await readFile(join(f.scratch,'brief.pdf')));
  const at=new Date().toISOString();const records=[{type:'session_meta',payload:{id:f.id,cwd:f.scratch}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<in-app-browser-context source=\"ambient-ui-state\">generated browser state</in-app-browser-context>'}]}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context>injected context</environment_context>'}]}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Actual user turn'},{type:'input_file',path:pathToFileURL(file).href,filename:'résumé.pdf'}]}},
    {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Actual answer'}]}}];
  await writeFile(f.path,records.map(r=>JSON.stringify({...r,timestamp:at})).join('\n')+'\n');
  const index=await discoverCodex(f.source),c=await readConversation(index.chats[0],index);
  assert.deepEqual(c.messages.map(m=>m.text),['Actual user turn','Actual answer']);assert.equal(c.assets[0].error,undefined);assert.equal(c.assets[0].path,file);
});

test('a different provider home is refused rather than creating an unresumable chat',async t=>{
  const f=await fixture(t);const index=await discoverCodex(f.source);
  await writeFile(join(f.target,'userdata/settings.json'),JSON.stringify({providerInstances:{codex:{driver:'codex',config:{homePath:f.workspace}}}}));
  await assert.rejects(stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs')}),/differs from the home used by T3/);
  await writeFile(join(f.target,'userdata/settings.json'),JSON.stringify({providerInstances:{codex:{driver:'codex',environment:[{name:'CODEX_HOME',value:f.source}],config:{setupMode:'existing'}}}}));
  await assert.doesNotReject(stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs')}));
});


test('same-thread rewinds refuse the whole lineage instead of importing discarded turns',async t=>{
  const f=await fixture(t),pack=records=>records.map(r=>JSON.stringify(r)+'\n').join('');
  const meta=extra=>({type:'session_meta',payload:{id:f.id,cwd:f.scratch,...extra}}),user=message=>({type:'event_msg',payload:{type:'user_message',message}});
  const kept=pack([meta({}),user('keep this')]);
  await writeFile(f.path,kept+pack([user('discarded by rewind')]));
  const cached = await discoverCodex(f.source), preview = await readConversation(cached.chats[0],cached);
  const current=f.path.replace('.jsonl','_'+randomUUID()+'.jsonl');
  await writeFile(current,pack([meta({history_base:{thread_id:f.id,end_byte_offset:Buffer.byteLength(kept)}}),user('replacement')]));
  const options={jobRoot:join(f.root,'jobs')};
  await assert.rejects(stageJob(cached,f.target,[{id:f.id,sourceHash:preview.sourceHash}],options),/rewound or ambiguous/);
  await assert.rejects(stageJob(await discoverCodex(f.source),f.target,[{id:f.id}],options),/rewound or ambiguous/);
  const db=new DatabaseSync(join(f.source,'state_5.sqlite'));db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,updated_at INTEGER)');
  db.prepare('INSERT INTO threads VALUES(?,?,?)').run(f.id,current,Math.floor(Date.now()/1000));db.close();
  await assert.rejects(stageJob(await discoverCodex(f.source),f.target,[{id:f.id}],options),/rewound or ambiguous/);
  await rm(current); // A missing active rewind must never fall back to the original branch.
  await assert.rejects(stageJob(await discoverCodex(f.source),f.target,[{id:f.id}],options),/rewound or ambiguous/);
});
