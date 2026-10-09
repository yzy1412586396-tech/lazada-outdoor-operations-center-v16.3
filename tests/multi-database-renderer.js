async function(){
 const check=(v,m)=>{if(!v)throw Error(m)},output={};
 const file=n=>new File([Uint8Array.from(atob(multiFiles[n]),c=>c.charCodeAt(0))],n+'.xlsx');
 const setFile=(id,f)=>{const dt=new DataTransfer();dt.items.add(f);$('#'+id).files=dt.files;};
 const select=(id,value)=>{$('#'+id).value=value;$('#'+id).dispatchEvent(new Event('change'));};
 const importFile=async(n)=>{const f=file(n);setFile('controlFile',f);await $('#controlFile').onchange({target:$('#controlFile')});await $('#importControlBtn').onclick();check(!$('#controlImportMsg').textContent.includes('失败'),'import failed '+$('#controlImportMsg').textContent);};
 for(const c of ['ph','th','my']){
  __opsDebug.switchCountry(c);go('control');const local=state.databases[0].id;
  $('#addDatabaseBtn').click();$('#newDatabaseName').value='跨境控价';$('#modalOk').click();const cross=$('#controlDatabase').value;check(cross!==local,'new database');
  select('controlImportDatabase',local);await importFile('local');
  select('controlImportDatabase',cross);await importFile('cross');
  check(state.controlRecords.filter(r=>r.database_id===local)[0].la_price===111,'local untouched '+c);
  check(state.controlRecords.filter(r=>r.database_id===cross)[0].la_price===222,'cross receives import '+c);
  select('repDatabase',cross);currentMatchDatabaseId=cross;check(matchControl('T1234567890','', '').record.la_price===222,'cross matching');
  select('repDatabase',local);currentMatchDatabaseId=local;check(matchControl('T1234567890','', '').record.la_price===111,'local matching');
  select('actDatabase',cross);setFile('activityFile',file('activity'));await $('#analyzeActivityBtn').onclick();check(activitySession,'activity analyzes '+$('#activityMsg').textContent);check(activitySession.results[0].internalPrice===223,'activity selected cross price');
  select('actDatabase',local);check(!activitySession,'switch invalidates preview');
  select('controlImportDatabase',cross);$('#controlImportMode').value='replace';await importFile('conflict');
  check(state.controlConflicts.some(r=>r.database_id===cross),'cross conflicts scoped');check(state.controlRecords.some(r=>r.database_id===local&&r.la_price===111),'local remains after conflict');
  check(state.controlVersions.some(v=>v.database_id===cross&&v.records[0].la_price===222),'cross version backup');
  currentMatchDatabaseId=local;check(matchControl('T1234567890','').record.la_price===111,'local not blocked by sibling conflict');
  // Restore cross version through UI, then replace cross again to check cache invalidation.
  renderControlVersions();const version=state.controlVersions.find(v=>v.database_id===cross&&v.records[0].la_price===222);document.querySelector('[data-restore-version="'+version.id+'"]').click();$('#modalOk').click();
  currentMatchDatabaseId=cross;controlIndexCache=new Map();check(matchControl('T1234567890','').record.la_price===222,'restore cross');await importFile('local');currentMatchDatabaseId=cross;check(matchControl('T1234567890','').record.la_price===111,'import invalidates old matching index');
  await importFile('cross');select('actDatabase',cross);select('repDatabase',local);
  check(Object.keys(state.controlMetaByLibrary).some(k=>k.startsWith(cross+'|')),'metadata scoped');
  // Delete/clear a disposable third library without touching either pricing database.
  $('#addDatabaseBtn').click();$('#newDatabaseName').value='删除测试库';$('#modalOk').click();const disposable=$('#controlDatabase').value;
  await importFile('local');$('#clearAllControlBtn').click();$('#modalOk').click();check(!state.controlRecords.some(r=>r.database_id===disposable),'clear only target');
  $('#deleteDatabaseBtn').click();$('#modalOk').click();check(!state.databases.some(d=>d.id===disposable),'delete target');check(state.controlRecords.some(r=>r.database_id===local&&r.la_price===111)&&state.controlRecords.some(r=>r.database_id===cross&&r.la_price===222),'delete preserves siblings');
  // A selector changed while workbook I/O is pending must not produce a stale session.
  select('actDatabase',local);setFile('activityFile',file('activity'));const pending=$('#analyzeActivityBtn').onclick();select('actDatabase',cross);await pending;check(!activitySession,'mid-analysis database switch cancels');
  await $('#analyzeActivityBtn').onclick();check(activitySession&&activitySession.databaseId===cross,'selected database reanalysis');
  const oldSession=activitySession;select('actDatabase',local);let blocked=false;try{await cloneAndPatch(oldSession,'activity')}catch{blocked=true}check(blocked,'stale export blocked');
  select('controlImportDatabase',cross);select('actDatabase',cross);select('repDatabase',local);
  output[c]={records:structuredClone(state.controlRecords),conflicts:structuredClone(state.controlConflicts),selections:structuredClone(state.databaseSelections)};
 }
 check(document.querySelector('[data-country="my"]').classList.contains('active'),'Malaysia header');check(document.querySelector('#countryCurrencyBadge').textContent.includes('MYR'),'Malaysia currency');
 return output;
}
