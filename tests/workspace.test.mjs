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

test('opening without local bytes retains the complete library, including unused images and music',()=>{
 const p=D.demoProject();
 p.variants[0].scenes=[];
 p.assets=[
  {id:'unused-image',sha256:'a'.repeat(64),kind:'image',size:10},
  {id:'unused-audio',sha256:'b'.repeat(64),kind:'audio',size:20}
 ];
 const opened=W.relinkProject(p,[]).project;
 const saved=W.cloudData(opened);
 assert.deepEqual(saved.assets,p.assets);
 assert.deepEqual(W.relinkProject(saved,[]).project.assets,p.assets);
});

test('reconnecting a library-only file replaces content aliases without retaining duplicates',()=>{
 const p=D.demoProject();p.variants[0].scenes=[];
 const fingerprint={sha256:'a'.repeat(64),kind:'image',size:10};
 p.assets=[{id:'old-id',...fingerprint},{id:'old-alias',...fingerprint}];
 const local={id:'reconnected',...fingerprint,relative_path:'photo.jpg',url:'blob:local-only'};
 const linked=W.relinkProject(p,[local,local]);
 assert.deepEqual(linked.project.assets,[{id:'reconnected',...fingerprint}]);
 assert.equal(p.assets.length,2,'Relinking must not mutate the previous project snapshot.');
});

test('reconnecting one file preserves other library-only resources and their later relink identity',()=>{
 const p=D.demoProject();p.variants[0].scenes=[];
 p.assets=[
  {id:'photo',sha256:'a'.repeat(64),kind:'image',size:10},
  {id:'music',sha256:'b'.repeat(64),kind:'audio',size:20}
 ];
 const first=W.relinkProject(p,[{...p.assets[0],id:'photo-connected'}]).project;
 assert.equal(first.assets.length,2);
 assert.ok(first.assets.some(a=>a.id==='music'));
 const second=W.relinkProject(first,[{...p.assets[1],id:'music-connected'}]).project;
 assert.equal(second.assets.length,2);
 assert.ok(second.assets.some(a=>a.id==='photo-connected'));
 assert.ok(second.assets.some(a=>a.id==='music-connected'));
});

test('project media isolation rejects same-ID foreign bytes and hash matches with different kind or size',()=>{
 const asset={id:'saved',sha256:'a'.repeat(64),kind:'video',size:20};
 const p={assets:[asset]};
 const candidates=[
  {...asset,sha256:'b'.repeat(64)},
  {...asset,id:'wrong-kind',kind:'audio'},
  {...asset,id:'wrong-size',size:21},
  {...asset,id:'correct'}
 ];
 assert.deepEqual(W.projectMedia(p,candidates).map(a=>a.id),['correct']);
});

test('a full retained library rejects additions instead of silently losing absent originals',()=>{
 const p=D.demoProject();p.variants[0].scenes=[];
 p.assets=Array.from({length:600},(_,i)=>({id:'asset-'+i,sha256:i.toString(16).padStart(64,'0'),kind:'image',size:i+1}));
 assert.equal(W.relinkProject(p,[]).project.assets.length,600);
 const reconnected={...p.assets[0],id:'reconnected'};
 assert.equal(W.relinkProject(p,[reconnected]).project.assets.length,600);
 const additional={id:'extra',sha256:'f'.repeat(64),kind:'image',size:1000};
 assert.throws(()=>W.relinkProject(p,[additional]),/600/);
 assert.equal(p.assets.length,600);
});


test('browser studio does not override the workspace new-project action',async()=>{
 const {readFile}=await import('node:fs/promises');
 const source=await readFile(new URL('../public/browser-studio.js',import.meta.url),'utf8');
 assert.ok(source.includes("'local-new-project':"),'Local editor must use its own new-story action.');
 assert.ok(source.includes("button('local-new-project','새 이야기'"),'Local editor button must target its private action.');
 assert.ok(!source.includes("'new-project':()=>{assertIdle()"),'Browser editor must not hijack the workspace new-project action.');
});


// Empty-account startup and interactive-login races are exercised through real
// UI behavior in ui-persistence.py; avoid asserting app.js source formatting.
