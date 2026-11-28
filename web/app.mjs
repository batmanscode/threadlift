const app = document.getElementById('app');
const token = location.hash.slice(1) || sessionStorage.getItem('threadlift-token');
if (token) sessionStorage.setItem('threadlift-token',token);
history.replaceState(null,'',location.pathname);
const escape = value => String(value ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const selected = new Map(), selectionErrors = new Map();
let state, busy = false, selectingAll = false, bulkMode = false, stopSelection = false, acceptSkippedChats = false;
const bytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n/1024)} KB` : `${(n/1048576).toFixed(1)} MB`;
async function api(path, data) {
  const response = await fetch('/api/'+path,{ method:data === undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Request failed.'); return result;
}
function error(message) {
  let box = document.getElementById('error'); if (!box) { box = document.createElement('div');box.id='error';box.className='notice error';box.setAttribute('role','alert');app.prepend(box); }
  box.textContent=message;
}
const compatibilityNotice = warnings => warnings?.length ? `<div class="notice" role="status">${warnings.map(w => `<p>${escape(w)}</p>`).join('')}</div>` : '';
function picker() {
  app.innerHTML=`<div class="intro"><div class="eyebrow">Recover missing Codex chats</div><h1>Import Codex chats and available files.</h1><p>Choose what to import into T3 Code${state.version ? ' ' + escape(state.version) : ' (database format ' + escape(state.formatVersion) + ')'}. Existing chats stay in place.</p>${compatibilityNotice(state.warnings)}${state.helperSessionsExcluded?`<p class="file-note">${state.helperSessionsExcluded} internal agent helper sessions excluded. Your regular chats and forks are included.</p>`:''}<div class="bulk-actions"><button class="primary" id="select-all">Select all missing</button><button id="clear-selection">Clear selection</button><button id="cancel-selection" hidden>Stop selecting</button></div><p class="file-note">Select all includes every date and skips chats already in T3. Available uploads and generated/linked files are selected by default; workspace-folder copies are optional.</p><div id="bulk-status" role="status"></div><div id="selection-errors"></div></div><div class="layout"><aside><label for="search"><small>${state.scanDays === 0 ? 'All local Codex chats' : 'Recent Codex chats · last ' + escape(state.scanDays) + ' days'}</small></label><input id="search" type="search" placeholder="Find a chat…"><div class="chats" id="chats"></div></aside><section class="review" aria-label="Import review"><div id="folder-problems"></div><div id="reviews"></div><div id="missing"></div><div class="footer"><div><strong id="selected-count">0 chats selected</strong><p id="selected-files"></p><p>T3 is backed up first.<br>Next, quit T3 once other runs finish.</p><p class="file-note">Large imports run in automatic batches. Each batch keeps a T3 backup.</p></div><button class="primary" id="prepare" disabled>Prepare import</button></div></section></div>`;
  renderChats(); renderReviews();
  document.getElementById('search').addEventListener('input',renderChats);
  document.getElementById('prepare').addEventListener('click',prepare);
  document.getElementById('select-all').addEventListener('click',selectAllMissing);
  document.getElementById('clear-selection').addEventListener('click',()=>{
    selected.clear(); selectionErrors.clear(); bulkMode=false; acceptSkippedChats=false;
    document.getElementById('bulk-status').textContent=''; renderSelectionErrors(); renderChats(); renderReviews();
  });
  document.getElementById('cancel-selection').addEventListener('click',()=>{ stopSelection=true; });
  updateControls();
}
function updateControls() {
  document.getElementById('select-all').disabled=busy||selectingAll;
  document.getElementById('clear-selection').disabled=busy||selectingAll||(!selected.size&&!selectionErrors.size);
  document.getElementById('cancel-selection').hidden=!selectingAll;
  document.getElementById('prepare').disabled=busy||selectingAll||!selected.size||[...selected.values()].some(c=>c.loading)||(selectionErrors.size>0&&!acceptSkippedChats)||[...selected.values()].some(c=>!c.loading&&(!c.destination.trim()||c.folderError));
  document.querySelectorAll('[data-root],[data-asset],[data-recover],#accept-missing,#accept-skipped-chats').forEach(input=>input.disabled=busy||selectingAll);
}
function renderSelectionErrors() {
  document.getElementById('selection-errors').innerHTML=selectionErrors.size?`<div class="notice"><p>${selectionErrors.size} ${selectionErrors.size===1?'chat':'chats'} could not be selected and will not be imported.</p><ul class="result-notes">${[...selectionErrors.values()].map(e=>`<li><strong>${escape(e.title)}</strong>: ${escape(e.message)}</li>`).join('')}</ul><label class="checkline"><input type="checkbox" id="accept-skipped-chats" ${acceptSkippedChats?'checked':''}><span>Continue with these chats omitted.</span></label></div>`:'';
  document.getElementById('accept-skipped-chats')?.addEventListener('change',event=>{acceptSkippedChats=event.target.checked;updateControls();});
}
async function selectChat(id, scanId, previous = null) {
  const pending={loading:true};selected.set(id,pending);
  try {
    const detail=await api('preview',{id,...(scanId?{scanId}:{})});
    if(selected.get(id)!==pending)return;
    const listing=state.chats.find(c=>c.id===id);if(listing)listing.title=detail.title;
    selected.set(id,{...detail,assetsSelected:new Set(detail.assets.map(a=>a.key)),destination:detail.root||detail.cwd||'',recoverWorkspace:false});
    if(previous&&!previous.loading) {
      const current=selected.get(id), oldKeys=new Set(previous.assets.map(a=>a.key));
      current.assetsSelected=new Set(detail.assets.filter(a=>!oldKeys.has(a.key)||previous.assetsSelected.has(a.key)).map(a=>a.key));
      if(previous.destinationOverride){current.destination=previous.destination;current.destinationOverride=true;current.folderError=current.destination.trim()?null:'Choose the current project folder.';}
      current.recoverWorkspace=previous.recoverWorkspace;
    }
    selectionErrors.delete(id);
  } catch(e) {
    if(selected.get(id)!==pending)return;
    selected.delete(id); acceptSkippedChats=false;
    selectionErrors.set(id,{title:state.chats.find(c=>c.id===id)?.title||'Chat',message:e.message});
  }
}
async function selectAllMissing() {
  if(busy||selectingAll)return;
  selectingAll=true; stopSelection=false; bulkMode=true; acceptSkippedChats=false; selectionErrors.clear(); updateControls();
  document.getElementById('bulk-status').textContent='Scanning all dates…';
  try {
    const previousSelections=new Map(selected);
    state=await api('scan',{});
    selected.clear();
    picker();
    for(const c of state.unavailableChats||[])selectionErrors.set(c.id,{title:c.title,message:c.error});
    const missing=state.chats.filter(c=>!c.existing);
    let done=0;
    for(const c of missing) {
      if(stopSelection)break;
      document.getElementById('bulk-status').textContent=`Reading chats and files: ${done+1} of ${missing.length}…`;
      await selectChat(c.id,state.scanId,previousSelections.get(c.id));
      done++;
      document.getElementById('selected-count').textContent=`${selected.size} chats selected`;
    }
    document.getElementById('bulk-status').textContent=stopSelection?`Selection stopped after ${done} of ${missing.length} missing chats. Remaining chats were not selected.`:`${selected.size} missing chats selected across all dates. ${state.chats.length-missing.length} already in T3 stayed unchanged.`;
  } catch(e) {document.getElementById('bulk-status').textContent='Bulk selection stopped. No import was started.';error(e.message);}
  finally {selectingAll=false;renderSelectionErrors();renderChats();renderReviews();updateControls();}
}
function renderChats() {
  const query=document.getElementById('search').value.toLowerCase();
  const chats=state.chats.filter(c=>c.title.toLowerCase().includes(query));
  document.getElementById('chats').innerHTML=chats.map(c=>`<label class="chat"><input type="checkbox" data-chat="${escape(c.id)}" ${selected.has(c.id)?'checked':''} ${c.existing||busy||selectingAll?'disabled':''}><span><strong>${escape(c.title)}</strong><small>${escape(new Date(c.updatedAt).toLocaleDateString())} · ${c.existing?'Already in T3':escape(c.assignment)}</small>${c.archived?'<small>Archived in Codex</small>':''}</span></label>`).join('') || '<p>No matching chats.</p>';
  document.querySelectorAll('[data-chat]').forEach(input=>input.addEventListener('change',async()=>{
    if (!input.checked) { selected.delete(input.dataset.chat);renderReviews();return; }
    selected.set(input.dataset.chat,{loading:true});renderReviews();
    await selectChat(input.dataset.chat);renderSelectionErrors();renderChats();renderReviews();
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
  const detailsOpen=document.getElementById('bulk-reviews')?.open;
  reviews.innerHTML=selected.size?[...selected.entries()].map(([id,c])=>c.loading?'<div class="empty">Reading the available conversation and files…</div>':`<article class="review-card" id="review-${escape(id)}" data-review="${escape(id)}"><div class="review-title"><h2>${escape(c.title)}</h2><span class="badge count">${c.messages} available messages · ${c.assets.filter(a=>!a.error).length} files available</span></div><div class="review-content"><details><summary>Check the conversation</summary><small>First message</small><div class="preview-text">${escape(c.first)}</div><small>Last message</small><div class="preview-text">${escape(c.last)}</div></details><label class="field"><span>Use this project folder in T3</span><input type="text" data-root="${escape(id)}" value="${escape(c.destination)}"></label><div data-recovery></div>${renderAssets(id,c)}</div></article>`).join(''):'<div class="empty"><h2>Choose a missing chat.</h2><p>Review its history and files here before preparing the import. Chats already in T3 are left unchanged.</p></div>';
  if(bulkMode&&selected.size>1)reviews.innerHTML=`<details id="bulk-reviews" ${detailsOpen?'open':''}><summary>Review ${selected.size} selected chats, files and folders</summary>${reviews.innerHTML}</details>`;
  reviews.querySelectorAll('[data-review]').forEach(card => {
    const c = selected.get(card.dataset.review), input = card.querySelector('[data-root]');
    renderRecovery(card, c);
    input.addEventListener('input', () => {
      c.destination = input.value; c.destinationOverride=true;
      c.folderError=!input.value.trim()||normalizedFolder(input.value)==='/'?'Choose the current project folder.':null;
      renderRecovery(card, c); renderFolderProblems(); updateControls();
    });
  });
  reviews.querySelectorAll('[data-asset]').forEach(input=>input.addEventListener('change',()=>{const c=selected.get(input.dataset.id);input.checked?c.assetsSelected.add(input.dataset.asset):c.assetsSelected.delete(input.dataset.asset);updateSelectionSummary();}));
  const missing=[...selected.values()].flatMap(c=>c.assets?.filter(a=>a.error&&c.assetsSelected.has(a.key))||[]);
  document.getElementById('missing').innerHTML=missing.length?`<div class="notice"><p>${missing.length} selected ${missing.length===1?'file is':'files are'} unavailable. They will be listed in the receipt.</p><label class="checkline"><input type="checkbox" id="accept-missing"><span>Continue with these missing files recorded.</span></label></div>`:'';
  renderFolderProblems();updateSelectionSummary();updateControls();
}
function renderFolderProblems() {
  const problems=[...selected.values()].filter(c=>!c.loading&&(!c.destination.trim()||c.folderError));
  document.getElementById('folder-problems').innerHTML=problems.length?`<div class="notice"><p>Choose a valid folder for ${problems.length} selected ${problems.length===1?'chat':'chats'} before preparing, or deselect them.</p>${problems.map(c=>`<button data-fix-folder="${escape(c.id)}">${escape(c.title)}: ${escape(c.folderError||'Choose the current project folder.')}</button>`).join('')}</div>`:'';
  document.querySelectorAll('[data-fix-folder]').forEach(button=>button.addEventListener('click',()=>{
    const details=document.getElementById('bulk-reviews');if(details)details.open=true;
    const card=document.getElementById('review-'+button.dataset.fixFolder);card.scrollIntoView({block:'start'});card.querySelector('[data-root]').focus();
  }));
}
function updateSelectionSummary() {
  document.getElementById('selected-count').textContent=`${selected.size} ${selected.size===1?'chat':'chats'} selected`;
  const files=[...selected.values()].flatMap(c=>c.assets?.filter(a=>!a.error&&c.assetsSelected.has(a.key))||[]);
  document.getElementById('selected-files').textContent=`${files.length} files selected · ${bytes(files.reduce((sum,a)=>sum+a.sizeBytes,0))}`;
}
async function prepare() {
  if (busy||selectingAll) return;
  if(selectionErrors.size&&!acceptSkippedChats)return error('Review and acknowledge the chats that could not be selected.');
  const missing=[...selected.values()].some(c=>c.assets.some(a=>a.error&&c.assetsSelected.has(a.key)));
  if (missing&&!document.getElementById('accept-missing')?.checked) return error('Review and acknowledge the missing files before preparing.');
  busy=true;updateControls();renderChats();document.getElementById('prepare').textContent='Preparing files…';
  try {
    const result=await api('prepare',{acceptMissing:missing,omittedChats:[...selectionErrors.keys()],acceptOmitted:acceptSkippedChats,selections:[...selected.values()].map(c=>({id:c.id,sourceHash:c.sourceHash,root:c.destination,recoverWorkspace:c.recoverWorkspace,...(c.assetsSelected.size===c.assets.length?{}:{assets:[...c.assetsSelected]})}))});
    location.replace(result.url);
  } catch(e) { busy=false;renderChats();renderReviews();error(e.message);document.getElementById('prepare').textContent='Prepare import'; }
}
function progress() {
  const s=state.status,waiting=['prepared','waiting'].includes(s.phase),failed=s.phase==='failed',complete=s.phase==='complete';
  const phases=['waiting','backing-up','importing','verifying','reopening'],active=complete?(state.autoReopen&&!s.reopenError?5:4):phases.indexOf(s.phase);
  const result=s.result||{}, showReceipt=complete||(failed&&result.threads?.length);
  const waitingText='Finish any other T3 runs, then press <kbd>⌘Q</kbd> in T3 Code. Keep this tab open. Threadlift will import automatically.'+(state.autoReopen?' It will then try to reopen T3.':' Open T3 yourself once verification finishes.');
  const fileSummary=result.fileCounts ? `${result.fileCounts.attachment||0} chat uploads · ${result.fileCounts.linked||0} linked files copied · ${result.fileCounts.workspace||0} workspace files copied` : `${result.files||0} copied files verified`;
  const threadRows=(result.threads||[]).map(t=>`<div class="receipt-row"><strong>${escape(t.title)}</strong><small>${t.messages} messages verified · session ID linked</small></div>`).join('');
  const notes=[...(result.omittedChats||[]).map(c=>`Chat omitted: ${c.title} — ${c.error}`),...(result.missing||[]).map(f=>`Missing: ${f.file} — ${f.reason}`),...(result.skipped||[]).map(f=>`Skipped: ${f.file} — ${f.reason}`)];
  app.innerHTML=`<section class="progress-shell" aria-live="polite"><div class="eyebrow">${failed?'Import stopped':complete?'Import complete':'Import prepared'}</div><h1>${failed?'Your import needs attention.':complete?'Your chats are in T3.':waiting?'Quit T3 Code to start.':s.phase==='reopening'?'Reopening T3 Code…':'Bringing your chats across.'}</h1><p>${waiting?waitingText:escape(s.detail)}</p>${state.batchCount>1?`<p class="file-note">${state.batchCount} automatic batches · one T3 backup per batch.${complete?'':' Keep T3 closed until they all finish.'}</p>`:''}${compatibilityNotice(result.compatibilityWarnings || state.warnings)}<ol class="phase-list">${['Quit T3 Code','Back up T3','Import selected chats and files','Verify the result',state.autoReopen&&!s.reopenError?'Reopen T3':'Open T3 when ready'].map((text,i)=>`<li class="${i===active?'active':i<active?'finished':''}"><span class="step">${i<active?'✓':i+1}</span><span>${text}${i===0&&waiting?'<small class="waiting-label">Waiting for T3 Code to quit…</small>':''}</span></li>`).join('')}</ol>${failed?`<div class="notice"><p>${escape(s.detail)}</p><p>${escape(s.recovery || 'Check the recovery details before trying again.')}</p></div>`:''}${showReceipt?`<div class="receipt">${result.threads?.length>5?`<div class="receipt-row"><strong>${result.threads.length} chats verified</strong><details><summary>Imported chats</summary>${threadRows}</details></div>`:threadRows}<div class="receipt-row">${fileSummary}<small>${result.missing?.length?`${result.missing.length} expected files missing`:'Selected files verified'}</small></div></div>${result.linkedFiles?.length?`<details><summary>Generated and linked files (${result.linkedFiles.length})</summary><ul class="result-notes">${result.linkedFiles.map(f=>`<li><strong>${escape(f.name)}</strong><div class="path">${escape(f.path)}</div></li>`).join('')}</ul></details>`:''}${complete?'<div class="notice">Find imported chats in T3’s Settled section or search their titles. The session ID and folder are linked; a live follow-up has not been tested by this import.</div>':''}${result.omittedChats?.length?`<div class="notice">${result.omittedChats.length} ${result.omittedChats.length===1?'chat was':'chats were'} omitted. See the recovery notes below.</div>`:''}${notes.length?`<details><summary>Omitted chats and missing/skipped files (${notes.length})</summary><ul class="result-notes">${notes.map(n=>`<li>${escape(n)}</li>`).join('')}</ul></details>`:''}`:''}<details><summary>Recovery details</summary><p class="path">${escape(state.directory)}</p><p>The backup, file manifest and receipt stay on this Mac.</p></details></section>`;
}
async function refresh() {
  try {state=await api('state');if(state.mode==='picker') picker();else{progress();if(!['complete','failed'].includes(state.status.phase))setTimeout(refresh,1200);}}
  catch(e){error(e.message+' Retrying… Keep this tab open.');setTimeout(refresh,3000);}
}
refresh();
