import test from 'node:test';import assert from 'node:assert/strict';import * as W from '../public/workspace.js';import * as D from '../public/domain.js';
test('presets independent of aspect ratio and original edits',()=>{const p=D.demoProject(),v=W.makeVariant(p.variants[0],{mode:'long',width:1080,height:1920});assert.equal(v.mode,'long');assert.equal(v.targetDuration,300);assert.equal(v.settings.width,1080);assert.notEqual(v.id,p.variants[0].id);assert.equal(p.variants[0].settings.height,1920)});
test('cloud DTO has no paths, tokens, URLs or raw assets',()=>{const p=D.demoProject();p.assets=[{id:'a',sha256:'b'.repeat(64),kind:'image',size:5,path:'/private/foo',url:'blob:secret'}];p.analysis={imageLimit:50,token:'secret'};p.token='secret';const data=W.cloudData(p);assert.equal(data.assets[0].sha256,'b'.repeat(64));assert.ok(!JSON.stringify(data).includes('secret'));assert.ok(!JSON.stringify(data).includes('/private/'))});
test('file relink uses content identity, not absolute path or name guess',()=>{const p=D.demoProject(),s=p.variants[0].scenes[0];p.variants[0].scenes=[s];p.assets=[{id:s.source_id,sha256:'a'.repeat(64),size:12,kind:'image'}];const r=W.relinkProject(p,[{id:'new-id',sha256:'a'.repeat(64),size:12,kind:'image'}]);assert.equal(r.project.variants[0].scenes[0].source_id,'new-id');assert.equal(r.missing.length,0);assert.equal(s.source_id,'sample1')});
test('ambiguous relink never silently chooses a duplicate',()=>{const p=D.demoProject();p.variants[0].scenes=p.variants[0].scenes.slice(0,1);p.assets=[{id:'sample1',sha256:'a'.repeat(64),size:12,kind:'image'}];const a={sha256:'a'.repeat(64),size:12,kind:'image'};const r=W.relinkProject(p,[{id:'a',...a},{id:'b',...a}]);assert.deepEqual(r.ambiguous,['sample1']);assert.equal(r.project.variants[0].scenes[0].source_id,'sample1')});
test('internal concept instructions never automatically enter public captions',()=>{const p=D.demoProject();p.description='비공개 지시: 요리 장면 없음';p.publicNote='수산시장 기록';assert.ok(!W.composePost(p,p.variants[0],'naver_blog').includes('비공개'));assert.ok(W.composePost(p,p.variants[0],'x').includes('수산시장'))});
test('per-variant and per-channel copy overrides are independent',()=>{const p=D.demoProject();p.posts={short:{x:'직접 적은 글'}};assert.equal(W.composePost(p,p.variants[0],'x'),'직접 적은 글');assert.notEqual(W.composePost(p,p.variants[0],'instagram'),'직접 적은 글')});
test('proposal can add sources while retaining manual blank and timings',()=>{const p=D.demoProject(),s=p.variants[0].scenes[0];s.caption='';s.field_locks=['caption','timing'];const r=W.propose(p,{scenes:[{source_id:s.source_id,name:'새이름',title:'낙지',caption:'덮어쓰면안됨'},{source_id:'new',name:'새 자료',title:'시장',caption:''}]},{addNew:true,media:[{id:'new',kind:'image',relative_path:'new.jpg'}],reorder:true});assert.equal(r.variants[0].scenes.length,4);assert.equal(r.variants[0].scenes[0].caption,'')});
test('invalid imported identifiers and infinite values fail early',()=>{for(const fn of [p=>p.id='../secret',p=>p.variants[0].scenes[0].duration=Infinity,p=>p.activeVariant='missing']){const p=D.demoProject();fn(p);assert.throws(()=>W.validateProject(p))}});
test('options are bounded and unknown object fields are dropped',()=>{const a=W.analysisOptions({imageLimit:9999,frameSize:300,maxScenes:0,seed:3,order:'invalid',token:'secret'});assert.equal(a.imageLimit,600);assert.equal(a.maxScenes,1);assert.equal(a.order,'concept');assert.ok(!('token'in a))});
test('transition duration affects labels without fake global progress',()=>{const p=D.demoProject(),v=p.variants[0];v.scenes[0].transition='fade';v.scenes[0].transition_duration=.5;assert.equal(W.sceneSequence(v)[1].start,2.5);assert.equal(W.progressLabel({status:'running'}).value,null);assert.equal(W.progressLabel({status:'done'}).value,100)});

 test('unconnected cloud project keeps file fingerprints for later relinking',()=>{const p=D.demoProject();p.assets=[{id:'old',sha256:'a'.repeat(64),kind:'image',size:123}];p.variants[0].scenes[0].source_id='old';const unloaded=W.relinkProject(p,[]).project;assert.equal(unloaded.assets.length,1);const loaded=W.relinkProject(unloaded,[{id:'new',sha256:'a'.repeat(64),kind:'image',size:123}]);assert.equal(loaded.project.variants[0].scenes[0].source_id,'new')});
 test('deliberately empty SNS text stays empty and unedited channels remain draftable',()=>{const p=D.demoProject();p.posts={short:{x:''}};assert.equal(W.composePost(W.cloudData(p),p.variants[0],'x'),'');assert.ok(W.composePost(W.cloudData(p),p.variants[0],'instagram').length>0)});

test('project media isolation retains only files belonging to the opened project',()=>{
 const media=[
  {id:'a',sha256:'a'.repeat(64),kind:'image',size:10},
  {id:'b',sha256:'b'.repeat(64),kind:'video',size:20},
  {id:'c',sha256:'c'.repeat(64),kind:'image',size:30}
 ];
 const project={assets:[{id:'other-id',sha256:'b'.repeat(64),kind:'video',size:20}]};
 assert.deepEqual(W.projectMedia(project,media).map(x=>x.id),['b']);
 assert.deepEqual(W.projectMedia({assets:[]},media),[]);
});


test('browser studio does not override the workspace new-project action',async()=>{
 const {readFile}=await import('node:fs/promises');
 const source=await readFile(new URL('../public/browser-studio.js',import.meta.url),'utf8');
 assert.ok(source.includes("'local-new-project':"),'Local editor must use its own new-story action.');
 assert.ok(source.includes("button('local-new-project','새 이야기'"),'Local editor button must target its private action.');
 assert.ok(!source.includes("'new-project':()=>{assertIdle()"),'Browser editor must not hijack the workspace new-project action.');
});


test('logged-in users with zero cloud projects start editing instead of seeing an empty workspace',async()=>{
 const {readFile}=await import('node:fs/promises');
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 assert.ok(source.includes('async function routeLoggedInHome'), 'Logged-in home routing helper must exist.');
 assert.ok(source.includes('if(cloudRows.length===0){\n   await createNewProject();'), 'Zero-project accounts must start a project immediately.');
 assert.ok(source.includes("await routeLoggedInHome({notify:true})"), 'Interactive login must use project-aware home routing.');
 assert.ok(source.includes("if(next&&page==='home'){routeLoggedInHome()"), 'Auth restoration must use the same project-aware routing.');
});
