import test,{before,after} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {initializeTestEnvironment,assertFails} from '@firebase/rules-unit-testing';import * as sdk from 'firebase/firestore';
import {createCloudStore} from '../public/cloud-store.js';import {demoProject,variantCopy} from '../public/domain.js';
let env;before(async()=>{env=await initializeTestEnvironment({projectId:'demo-norn',firestore:{rules:await readFile('firebase/firestore.rules','utf8'),host:'127.0.0.1',port:8080}})});after(async()=>{await env?.cleanup()});
const repo=uid=>createCloudStore({sdk,db:env.authenticatedContext(uid).firestore(),currentUid:()=>uid});
test('save/load edited variants through actual emulator SDK transactions',async()=>{const r=repo('full-alice'),p=demoProject();p.publicNote='내가 쓴 게시문';p.variants.push(variantCopy(p.variants[0],'롱폼'));p.variants[1].mode='long';assert.equal(await r.save(p,0),1);const q=await r.load(p.id);assert.equal(q.publicNote,p.publicNote);assert.equal(q.variants.length,2);assert.equal(q.variants[1].mode,'long')});
test('stale revision rejected without overwriting',async()=>{const r=repo('full-bob'),p=demoProject();await r.save(p,0);p.title='saved';await r.save(p,1);p.title='stale';await assert.rejects(r.save(p,1),/충돌/);assert.equal((await r.load(p.id)).title,'saved')});
test('variant removed from project is removed from Firestore',async()=>{const r=repo('full-carol'),p=demoProject();p.variants.push(variantCopy(p.variants[0],'delete me'));const id=p.variants[1].id;await r.save(p);p.variants.splice(1);await r.save(p,1);const db=env.authenticatedContext('full-carol').firestore();const old=await sdk.getDoc(sdk.doc(db,'users','full-carol','projects',p.id,'variants',id));assert.equal(old.exists(),false)});
test('delete project and children, never another user',async()=>{const r=repo('full-dan'),p=demoProject();await r.save(p);await assert.rejects(repo('full-eve').load(p.id));await assertFails(sdk.getDoc(sdk.doc(env.authenticatedContext('full-eve').firestore(),'users','full-dan','projects',p.id)));await r.remove(p.id,1);await assert.rejects(r.load(p.id),/없습니다/)});
test('explicit diagnostic probe writes reads deletes only own temporary doc',async()=>{const r=repo('full-probe');assert.deepEqual(await r.probe(),{write:true,read:true,delete:true});const db=env.authenticatedContext('full-probe').firestore();assert.equal((await sdk.getDocs(sdk.collection(db,'users','full-probe','diagnostics'))).size,0)});
test('guest cannot access cloud and invalid project paths fail',async()=>{const r=createCloudStore({sdk,db:env.unauthenticatedContext().firestore(),currentUid:()=>null});await assert.rejects(r.list(),/로그인/);await assert.rejects(repo('full-h').load('../secret'),/ID/)});

test('project save creates revision history and can restore snapshot',async()=>{const r=repo('history-alice'),p=demoProject();await r.save(p,0,'manual');p.title='두 번째 제목';await r.save(p,1,'autosave');const history=await r.listHistory(p.id);assert.deepEqual(history.map(x=>x.revision).slice(0,2),[2,1]);const old=await r.loadHistory(p.id,1);assert.equal(old.title,'빛이 머무는 오후');assert.equal(old.historyEvent,'manual')});
test('project deletion removes history children',async()=>{const r=repo('history-delete'),p=demoProject();await r.save(p,0,'manual');await r.remove(p.id,1);const db=env.authenticatedContext('history-delete').firestore();const rows=await sdk.getDocs(sdk.collection(db,'users','history-delete','projects',p.id,'history'));assert.equal(rows.size,0)});

test('project list paginates beyond the first 100 projects',async()=>{
 const uid='many-projects',db=env.authenticatedContext(uid).firestore(),batch=sdk.writeBatch(db);
 for(let i=0;i<105;i++)batch.set(sdk.doc(db,'users',uid,'projects','p'+String(i).padStart(3,'0')),{schema_version:2,title:'P'+i,description:'',activeVariant:'short',frames:5,targetDuration:30,revision:1,updatedAt:sdk.serverTimestamp(),variantIds:['short']});
 await batch.commit();
 const rows=await repo(uid).list();
 assert.equal(rows.length,105);
});
