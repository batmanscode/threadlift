const app = document.getElementById('app');
const token = location.hash.slice(1) || sessionStorage.getItem('threadlift-token');
if (token) sessionStorage.setItem('threadlift-token',token);
history.replaceState(null,'',location.pathname);
const escape = value => String(value ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const selected = new Map(); let state, busy = false;
const bytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n/1024)} KB` : `${(n/1048576).toFixed(1)} MB`;
async function api(path, data) {
  const response = await fetch('/api/'+path,{ method:data === undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Request failed.'); return result;
}
function error(message) {
  let box = document.getElementById('error'); if (!box) { box = document.createElement('div');box.id='error';box.className='notice error';box.setAttribute('role','alert');app.prepend(box); }
  box.textContent=message;
}
function picker() {
  app.innerHTML=`<div class="intro"><div class="eyebrow">Recover missing Codex chats</div><h1>Import Codex chats and available files.</h1><p>Choose what to import into T3 Code ${escape(state.version)}. Existing chats stay in place.</p></div><div class="layout"><aside><label for="search"><small>Recent Codex chats · last 30 days by default</small></label><input id="search" type="search" placeholder="Find a chat…"><div class="chats" id="chats"></div></aside><section class="review" aria-label="Import review"><div id="reviews"></div><div id="missing"></div><div class="footer"><div><strong id="selected-count">0 chats selected</strong><p>T3 is backed up first.<br>Next, quit T3 once other runs finish.</p></div><button class="primary" id="prepare" disabled>Prepare import</button></div></section></div>`;
  renderChats(); renderReviews();
  document.getElementById('search').addEventListener('input',renderChats);
  document.getElementById('prepare').addEventListener('click',prepare);
}
function renderChats() {
  const query=document.getElementById('search').value.toLowerCase();
  const chats=state.chats.filter(c=>c.title.toLowerCase().includes(query));
  document.getElementById('chats').innerHTML=chats.map(c=>`<label class="chat"><input type="checkbox" data-chat="${escape(c.id)}" ${selected.has(c.id)?'checked':''} ${c.existing?'disabled':''}><span><strong>${escape(c.title)}</strong><small>${escape(new Date(c.updatedAt).toLocaleDateString())} · ${c.existing?'Already in T3':escape(c.assignment)}</small>${c.archived?'<small>Archived in Codex</small>':''}</span></label>`).join('') || '<p>No matching chats.</p>';
  document.querySelectorAll('[data-chat]').forEach(input=>input.addEventListener('change',async()=>{
    if (!input.checked) { selected.delete(input.dataset.chat);renderReviews();return; }
    selected.set(input.dataset.chat,{loading:true});renderReviews();
    try {
      const detail=await api('preview',{id:input.dataset.chat});
      if (selected.has(detail.id)) selected.set(detail.id,{...detail,assetsSelected:new Set(detail.assets.filter(a=>a.kind==='upload').map(a=>a.key)),destination:detail.root || detail.cwd,recoverWorkspace:false});
    } catch(e) { selected.delete(input.dataset.chat);input.checked=false;error(e.message); }
    renderReviews();
  }));
}
// Match the helper's tilde expansion and POSIX path resolution on macOS.
function normalizedFolder(value) {
  const { home, cwd } = state.pathContext;
  let path = value === '~' ? home : value.startsWith('~/') ? home + '/' + value.slice(2) : value;
  if (!path.startsWith('/')) path = cwd + '/' + path;
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return '/' + parts.join('/');
}
function renderRecovery(card, c) {
  const hasFolder = Boolean(c.destination.trim()), hasSource = Boolean(c.cwd);
  const canCopy = hasFolder && hasSource && normalizedFolder(c.destination) !== normalizedFolder(c.cwd);
  if (!canCopy) c.recoverWorkspace = false;
  const slot = card.querySelector('[data-recovery]');
  const note = !hasFolder ? 'Choose the current project folder.' : !hasSource ? 'No original workspace folder was recorded.' : 'Project files remain in their existing folder.';
  slot.innerHTML = canCopy ? `<label class="checkline"><input type="checkbox" data-recover="${escape(c.id)}" ${c.recoverWorkspace?'checked':''}><span>Copy files from the original workspace folder<small class="path">${escape(c.cwd)} → selected project folder</small><small>Copies all regular files in this folder. Existing files will not be overwritten. Git metadata, caches and symlinks are skipped.</small></span></label>` : `<small>${note}</small>`;
  slot.querySelector('[data-recover]')?.addEventListener('change', event => c.recoverWorkspace = event.target.checked);
}
function renderAssets(id, c) {
  return [['Chat uploads', a => a.kind === 'upload' && a.role !== 'assistant'],
    ['Generated and linked files', a => a.kind === 'reference' || a.role === 'assistant']].map(([title, include]) => {
    const assets = c.assets.filter(include);
    if (!assets.length) return '';
    return `<h3 class="field">${title}</h3>${title === 'Generated and linked files' ? '<p class="file-note">Choose the files to recover. Imported links will open the files in your selected project folder. Files from elsewhere use your workspace copy when included in it, or a Threadlift files folder there.</p>' : ''}${assets.some(a => /\.html?$/i.test(a.name)) ? '<p class="file-note">HTML with local images or other files needs its folder layout. Use workspace copy if it includes the whole page folder, or a ZIP; selecting files separately may break its links.</p>' : ''}<ul class="assets">${assets.map(a => `<li>${a.error ? `<strong>${escape(a.name)}</strong><small> · ${escape(a.error)}</small>` : `<label class="assetlabel"><input type="checkbox" data-asset="${escape(a.key)}" data-id="${escape(id)}" ${c.assetsSelected.has(a.key)?'checked':''}><span>${escape(a.name)}<small>${bytes(a.sizeBytes)}</small>${a.path?`<small class="path">${escape(a.path)}</small>`:''}</span></label>`}</li>`).join('')}</ul>`;
  }).join('') || '<p>No recoverable files found. Files in the project folder stay available there.</p>';
}
function renderReviews() {
  const reviews=document.getElementById('reviews');
  reviews.innerHTML=selected.size?[...selected.entries()].map(([id,c])=>c.loading?'<div class="empty">Reading the available conversation and files…</div>':`<article class="review-card" data-review="${escape(id)}"><div class="review-title"><h2>${escape(c.title)}</h2><span class="badge count">${c.messages} available messages · ${c.assets.filter(a=>!a.error).length} files available</span></div><div class="review-content"><details><summary>Check the conversation</summary><small>First message</small><div class="preview-text">${escape(c.first)}</div><small>Last message</small><div class="preview-text">${escape(c.last)}</div></details><label class="field"><span>Use this project folder in T3</span><input type="text" data-root="${escape(id)}" value="${escape(c.destination)}"></label><div data-recovery></div>${renderAssets(id,c)}</div></article>`).join(''):'<div class="empty"><h2>Choose a missing chat.</h2><p>Review its history and files here before preparing the import. Chats already in T3 are left unchanged.</p></div>';
  reviews.querySelectorAll('[data-review]').forEach(card => {
    const c = selected.get(card.dataset.review), input = card.querySelector('[data-root]');
    renderRecovery(card, c);
    input.addEventListener('input', () => {
      c.destination = input.value;
      renderRecovery(card, c);
    });
  });
  reviews.querySelectorAll('[data-asset]').forEach(input=>input.addEventListener('change',()=>{const c=selected.get(input.dataset.id);input.checked?c.assetsSelected.add(input.dataset.asset):c.assetsSelected.delete(input.dataset.asset);}));
  const missing=[...selected.values()].flatMap(c=>c.assets?.filter(a=>a.error&&a.kind==='upload')||[]);
  document.getElementById('missing').innerHTML=missing.length?`<div class="notice"><p>${missing.length} uploaded ${missing.length===1?'file is':'files are'} unavailable. They will be listed in the receipt.</p><label class="checkline"><input type="checkbox" id="accept-missing"><span>Continue with these missing files recorded.</span></label></div>`:'';
  document.getElementById('selected-count').textContent=`${selected.size} ${selected.size===1?'chat':'chats'} selected`;
  document.getElementById('prepare').disabled=busy||!selected.size||[...selected.values()].some(c=>c.loading);
}
async function prepare() {
  if (busy) return;
  const missing=[...selected.values()].some(c=>c.assets.some(a=>a.error&&a.kind==='upload'));
  if (missing&&!document.getElementById('accept-missing')?.checked) return error('Review and acknowledge the missing files before preparing.');
  busy=true;document.getElementById('prepare').disabled=true;document.getElementById('prepare').textContent='Preparing files…';
  try {
    const result=await api('prepare',{acceptMissing:missing,selections:[...selected.values()].map(c=>({id:c.id,sourceHash:c.sourceHash,root:c.destination,recoverWorkspace:c.recoverWorkspace,assets:[...c.assetsSelected]}))});
    location.replace(result.url);
  } catch(e) { busy=false;renderReviews();error(e.message);document.getElementById('prepare').textContent='Prepare import'; }
}
function progress() {
  const s=state.status,waiting=['prepared','waiting'].includes(s.phase),failed=s.phase==='failed',complete=s.phase==='complete';
  const phases=['waiting','backing-up','importing','verifying','reopening'],active=complete?5:phases.indexOf(s.phase);
  const result=s.result||{};
  const waitingText='Finish any other T3 runs, then press <kbd>⌘Q</kbd> in T3 Code. Keep this tab open. Threadlift will import automatically.'+(state.autoReopen?' It will then try to reopen T3.':' Open T3 yourself once verification finishes.');
  const fileSummary=result.fileCounts ? `${result.fileCounts.attachment||0} chat uploads · ${result.fileCounts.linked||0} linked files copied · ${result.fileCounts.workspace||0} workspace files copied` : `${result.files||0} copied files verified`;
  const notes=[...(result.missing||[]).map(f=>`Missing: ${f.file} — ${f.reason}`),...(result.skipped||[]).map(f=>`Skipped: ${f.file} — ${f.reason}`)];
  app.innerHTML=`<section class="progress-shell" aria-live="polite"><div class="eyebrow">${failed?'Import stopped':complete?'Import complete':'Import prepared'}</div><h1>${failed?'Your import needs attention.':complete?'Your chats are in T3.':waiting?'Quit T3 Code to start.':s.phase==='reopening'?'Reopening T3 Code…':'Bringing your chats across.'}</h1><p>${waiting?waitingText:escape(s.detail)}</p><ol class="phase-list">${['Quit T3 Code','Back up T3','Import selected chats and files','Verify the result',state.autoReopen?'Reopen T3':'Open T3 when ready'].map((text,i)=>`<li class="${i===active?'active':i<active?'finished':''}"><span class="step">${i<active?'✓':i+1}</span><span>${text}${i===0&&waiting?'<small class="waiting-label">Waiting for T3 Code to quit…</small>':''}</span></li>`).join('')}</ol>${failed?`<div class="notice"><p>${escape(s.detail)}</p><p>${escape(s.recovery || 'Check the recovery details before trying again.')}</p></div>`:''}${complete?`<div class="receipt">${(result.threads||[]).map(t=>`<div class="receipt-row"><strong>${escape(t.title)}</strong><small>${t.messages} messages verified · session ID linked</small></div>`).join('')}<div class="receipt-row">${fileSummary}<small>${result.missing?.length?`${result.missing.length} expected files missing`:'Selected files verified'}</small></div></div>${result.linkedFiles?.length?`<details><summary>Generated and linked files (${result.linkedFiles.length})</summary><ul class="result-notes">${result.linkedFiles.map(f=>`<li><strong>${escape(f.name)}</strong><div class="path">${escape(f.path)}</div></li>`).join('')}</ul></details>`:''}<div class="notice">Find your chat in T3’s Settled section or search its title. Send a follow-up to confirm continuation. The session ID and folder are linked; a live follow-up has not been tested by this import.</div>${notes.length?`<details><summary>Missing and skipped files (${notes.length})</summary><ul class="result-notes">${notes.map(n=>`<li>${escape(n)}</li>`).join('')}</ul></details>`:''}`:''}<details><summary>Recovery details</summary><p class="path">${escape(state.directory)}</p><p>The backup, file manifest and receipt stay on this Mac.</p></details></section>`;
}
async function refresh() {
  try {state=await api('state');if(state.mode==='picker') picker();else{progress();if(!['complete','failed'].includes(state.status.phase))setTimeout(refresh,1200);}}
  catch(e){error(e.message+' Retrying… Keep this tab open.');setTimeout(refresh,3000);}
}
refresh();
