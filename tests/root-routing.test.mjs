import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const text=path=>readFile(new URL(path,root),'utf8');
const references=html=>[...html.matchAll(/\b(href|src)="([^"]+)"/g)];
const {version}=JSON.parse(await text('package.json'));
for(const name of ['index.html','setup.html']){
  test(`branch root ${name} uses the same application without navigation or iframe`,async()=>{
    const source=await text('public/'+name),entry=await text(name);
    const sourceRefs=references(source),entryRefs=references(entry);
    assert.equal(entryRefs.length,sourceRefs.length,'Root entry references must match public/.');
    let restored=entry;
    for(let i=sourceRefs.length-1;i>=0;i--){
      const original=sourceRefs[i],generated=entryRefs[i];
      assert.equal(generated[1],original[1]);
      const sourceURL=new URL(original[2],new URL('public/'+name,root));
      if(original[2].startsWith('./')&&['.css','.js','.mjs'].some(ext=>sourceURL.pathname.endsWith(ext))){
        assert.ok(generated[2].startsWith('./public/'),'Root assets must load from public/.');
        const entryURL=new URL(generated[2],new URL(name,root));
        assert.equal(entryURL.href,sourceURL.href,'Root and public assets must resolve to the same file, query and hash.');
        entryURL.search='';entryURL.hash='';
        await access(entryURL);
      }else assert.equal(generated[2],original[2],'Navigation must stay on its current route.');
      restored=restored.slice(0,generated.index)+original[0]+restored.slice(generated.index+generated[0].length);
    }
    assert.equal(restored,source,'Run npm run sync:root after changing public entry HTML.');
    assert.doesNotMatch(entry,/<iframe\b|<base\b|http-equiv=["']refresh|location\.(?:replace|assign)\(/i);
  });
}
test('root entry loads exactly the application and shared-account adapter modules',async()=>{
  const entry=await text('index.html');
  for(const id of ['app','modal-root','toast'])assert.ok(entry.includes(`id="${id}"`));
  const modules=[...entry.matchAll(/<script\b([^>]*)>/g)].map(match=>
    Object.fromEntries([...match[1].matchAll(/\b([a-z-]+)="([^"]*)"/g)].map(attribute=>[attribute[1],attribute[2]]))
  ).filter(attributes=>attributes.type==='module');
  assert.equal(modules.length,2);
  const moduleURLs=modules.map(attributes=>{assert.ok(attributes.src,'Each module needs an actual source file.');return new URL(attributes.src,new URL('index.html',root));});
  assert.deepEqual(moduleURLs.map(url=>url.pathname),['public/app.js','public/account-menu.mjs'].map(file=>new URL(file,root).pathname));
  assert.equal(moduleURLs[0].searchParams.get('v'),version,'The app must use the current release cache version.');
  assert.equal(moduleURLs[1].searchParams.get('v'),'20261030-menu-1','The account adapter must use its published cache version.');
  const style=references(entry).find(reference=>new URL(reference[2],root).pathname===new URL('public/browser-studio.css',root).pathname);
  assert.ok(style,'The browser studio stylesheet must be present.');
  assert.equal(new URL(style[2],root).searchParams.get('v'),version,'The changed stylesheet must use the current release cache version.');
  assert.ok(references(entry).some(reference=>new URL(reference[2],root).pathname===new URL('public/account-menu.css',root).pathname));
});
test('shared account adapter leaves native workspace identities and storage unchanged',async()=>{
  const adapter=await text('public/account-menu.mjs'),css=await text('public/account-menu.css');
  assert.match(adapter,/SoftmAccounts\?\.has\('norn'\)/);
  assert.match(adapter,/mountRegisteredSite\('norn'\)/);
  assert.doesNotMatch(adapter,/signInWithCustomToken|updateProfile|localStorage\.(?:clear|removeItem)|indexedDB\.deleteDatabase/);
  assert.match(css,/html\[data-norn-account-menu="ready"\] \.common-account-entry/);
});
test('root diagnostic links stay at root',async()=>{
  const entry=await text('setup.html');
  assert.doesNotMatch(entry,/href="\.\/#studio"/,'Setup navigation should return to the project-aware home/workspace.');
  assert.match(entry,/href="\.\/"/);
  assert.doesNotMatch(entry,/<a[^>]+href="\.\/public\//);
});
test('index landing and workspace are distinct routes',async()=>{
  const source=await text('public/app.js');
  assert.match(source,/function home\(\)\{if\(workspaceRequested\)return workspaceHome\(\)/);
  assert.doesNotMatch(source,/if\(user\|\|workspaceRequested\|\|localRows\.length\)return workspaceHome\(\)/);
  assert.match(source,/data-action="workspace">내 프로젝트<\/button>/);
  assert.match(source,/location\.hash==='#workspace'/);
  assert.match(source,/window\.history\.replaceState\(null,'',location\.pathname\+location\.search\+'#workspace'\)/);
});

test('runtime config resolves relative to its module, not the document',async()=>{
  const original=globalThis.fetch;let requested;
  globalThis.fetch=async url=>{requested=String(url);return {ok:true,json:async()=>({enabled:false,firebase:null})};};
  try{
    const {config}=await import('../public/firebase-v2.js?root-routing-test');
    assert.deepEqual(await config(),{enabled:false,firebase:null});
    assert.equal(requested,new URL('public/firebase-config.json',root).href);
  }finally{globalThis.fetch=original;}
});
