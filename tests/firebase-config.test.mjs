import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {normalizeConfig,configStatus,authMessage,projectId} from '../public/firebase-config-utils.js';
// Synthetic SDK fixture, deliberately not a real usable project.
const sdk=()=>({apiKey:'AIza'+'X'.repeat(35),authDomain:'demo-norn.firebaseapp.com',projectId:'demo-norn',appId:'1:123456789:web:abcdef',extra:'drop-me'});
test('accept CLI sdkConfig result, retain only public fields',()=>{const v=normalizeConfig({result:{sdkConfig:sdk()}},'demo-norn');assert.equal(v.projectId,'demo-norn');assert.equal(v.extra,undefined)});
test('accept runtime config but not mismatched project',()=>{assert.equal(normalizeConfig({enabled:true,firebase:sdk()}).appId,sdk().appId);assert.throws(()=>normalizeConfig(sdk(),'another-project'),/다릅니다/)});
test('reject service account, private keys and nested credentials',()=>{for(const extra of [{type:'service_account'},{private_key:'hidden'},{nested:{refreshToken:'hidden'}},{other:'-----BEGIN PRIVATE KEY-----'}])assert.throws(()=>normalizeConfig({...sdk(),...extra}),/키|토큰/)});
test('missing SDK keys, placeholders, invalid IDs and domains fail closed',()=>{for(const change of [{apiKey:'your key'},{projectId:'??'},{appId:'1:123:android:aa'},{authDomain:'https://host/'},{databaseURL:'http://x'}])assert.throws(()=>normalizeConfig({...sdk(),...change}));assert.throws(()=>normalizeConfig({}));assert.throws(()=>projectId('wrong/identifier'))});
test('disabled is not configured and shape validation is not OAuth verification',()=>{assert.equal(configStatus({enabled:false}).ready,false);assert.equal(configStatus({enabled:true,firebase:sdk()}).ready,true);assert.match(configStatus({enabled:true,firebase:sdk()}).message,/별도/)});
test('actionable auth errors never impersonate a successful trial login',()=>{assert.match(authMessage({code:'auth/unauthorized-domain'}),/도메인/);assert.match(authMessage({code:'auth/operation-not-allowed'}),/Google/);assert.match(authMessage({code:'permission-denied'}),/거부/);assert.match(authMessage({code:'auth/popup-blocked'}),/팝업/)});
test('CLI dry run requires neither authorization nor file modifications',async()=>{const before=await readFile('public/firebase-config.json','utf8');const r=spawnSync(process.execPath,['scripts/setup-firebase.mjs','--dry-run'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/외부 호출·파일 변경 없이/);assert.equal(await readFile('public/firebase-config.json','utf8'),before)});
