const {OperationsDatabase}=require('../electron/database'),assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lazada-price-scopes-')),file=path.join(dir,'test.db');
let db=new OperationsDatabase(file);const entries=[];
for(const [c,key]of Object.entries({ph:'Philippines',th:'Thailand',my:'Malaysia'})){
 entries.push(['lazadaOps'+key+'SystemV8',JSON.stringify({country:c,databases:[{id:'local',name:'本土'},{id:'cross',name:'跨境'}],stores:[],controlRecords:[{database_id:'local',sku:'SAME',la_price:111},{database_id:'cross',sku:'SAME',la_price:222}],controlConflicts:[]})]);
}
db.syncStorage(entries);for(const c of ['ph','th','my'])for(const [id,price]of [['local',111],['cross',222]]){const rows=db.getHistoryRows('control_price',{countryCode:c,databaseId:c+':'+id}).rows;assert(rows.length>0);assert(rows.every(r=>r.payload.records.every(x=>x.database_id===id&&x.la_price===price)));}
assert.equal(db.getMeta('last_history_archive_error'),'');db.close();db=new OperationsDatabase(file);assert(db.historyFilterOptions().countries.some(c=>c.code==='my'));assert.equal(db.getHistoryRows('control_price',{countryCode:'my',databaseId:'my:cross'}).rows[0].payload.records[0].la_price,222);db.close();fs.rmSync(dir,{recursive:true});console.log('DATABASE_PRICING_SCOPES_OK');
