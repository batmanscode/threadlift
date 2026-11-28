#!/usr/bin/env node
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readFile, realpath } from 'node:fs/promises';
import { servePicker, runWorker } from '../src/server.mjs';
import { discoverCodex } from '../src/codex.mjs';
import { inspectTarget, atomicJson } from '../src/target.mjs';
import { applyJobs } from '../src/jobs.mjs';

try {
  const args = process.argv.slice(2), command = args[0]?.startsWith('-') ? 'open' : args.shift() || 'open', options = {};
  while (args.length) {
    const key = args.shift(); if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const flag = key.slice(2);
    if (!['codex-home','t3-home','app','days','no-browser','no-reopen','help','job-root','job','label','details','launch-id'].includes(flag)) throw new Error(`Unknown option: ${key}`);
    if (['no-browser','no-reopen','help','details'].includes(flag)) options[flag] = true;
    else { const value = args.shift(); if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`); options[flag] = value; }
  }
  if (options.help || command === 'help') {
    console.log(`Threadlift — bring missing Codex chats into T3 Code\n\n  node bin/threadlift.mjs open\n  node bin/threadlift.mjs inspect\n  node bin/threadlift.mjs apply --job /absolute/path/job.json\n  node bin/threadlift.mjs status --job /absolute/path/job.json\n\nOptions: --codex-home PATH --t3-home PATH --app PATH --days 30 --no-browser\nRequires Node 24.10+, macOS, and an initialized T3 profile. Tested with T3 0.1.12 and 0.1.13; later versions require a recognized database format and show a warning.\nFinish other T3 work, then quit T3 with Cmd+Q when the browser says ready.`);
  } else {
    const [major,minor] = process.versions.node.split('.').map(Number); if (major < 24 || (major === 24 && minor < 10)) throw new Error('Threadlift requires Node 24.10 or later.');
    const codexHome = options['codex-home'] || join(homedir(),'.codex'), t3Home = options['t3-home'] || join(homedir(),'.t3');
    if (command === 'open') {
      const service = await servePicker({ codexHome,t3Home, days: options.days === undefined ? 30 : Number(options.days), appPath: options.app,
        jobRoot: options['job-root'], openBrowser: !options['no-browser'], reopen: !options['no-reopen'] });
      console.log(`Threadlift is ready. Private browser link (keep it local):\n${service.url}`);
    } else if (command === 'inspect') {
      const index = await discoverCodex(codexHome,{ days: options.days === undefined ? 30 : Number(options.days) }), target = await inspectTarget(t3Home);
      console.log(JSON.stringify({ t3Version:target.version, databaseFormat:target.formatVersion, warnings:target.warnings,
        ...(options.details ? { chats:index.chats.map(({id,title,root,cwd,assignment}) => ({id,title,root,cwd,assignment,alreadyInT3:Boolean(target.owners[id])})) }
          : { chatsFound:index.chats.length,alreadyInT3:index.chats.filter(c=>target.owners[c.id]).length,unsupportedHistories:index.unsupported.size }) },null,2));
    } else if (command === 'worker') await runWorker(options.job,{label:options.label,launchId:options['launch-id']});
    else if (command === 'apply') {
      if (!options.job) throw new Error('Provide --job /absolute/path/job.json');
      const result = await applyJobs(options.job);
      await atomicJson(join(dirname(await realpath(options.job)), 'status.json'), { phase: 'complete', detail: 'Import finished. Open T3 when ready.', updatedAt: new Date().toISOString(), result });
      console.log(JSON.stringify(result,null,2));
    }
    else if (command === 'status') { if (!options.job) throw new Error('Provide --job /absolute/path/job.json'); console.log(await readFile(join(dirname(options.job),'status.json'),'utf8')); }
    else throw new Error(`Unknown command: ${command}`);
  }
} catch (e) { console.error(`Threadlift: ${e.message}`); process.exitCode = 1; }
