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
      if(original[2].startsWith('./')&&['.css','.js'].some(ext=>sourceURL.pathname.endsWith(ext))){
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
test('root entry contains the application DOM and loads its actual module',async()=>{
  const entry=await text('index.html');
  for(const id of ['app','modal-root','toast'])assert.ok(entry.includes(`id="${id}"`));
  const modules=[...entry.matchAll(/<script\b([^>]*)>/g)].map(match=>
    Object.fromEntries([...match[1].matchAll(/\b([a-z-]+)="([^"]*)"/g)].map(attribute=>[attribute[1],attribute[2]]))
  ).filter(attributes=>attributes.type==='module');
  assert.equal(modules.length,1);
  assert.ok(modules[0].src,'The module script needs an actual source file.');
  const appURL=new URL(modules[0].src,new URL('index.html',root));
  assert.equal(appURL.pathname,new URL('public/app.js',root).pathname);
  assert.equal(appURL.searchParams.get('v'),version,'The entry module must use the current release cache version.');
  const style=references(entry).find(reference=>new URL(reference[2],root).pathname===new URL('public/browser-studio.css',root).pathname);
  assert.ok(style,'The browser studio stylesheet must be present.');
  assert.equal(new URL(style[2],root).searchParams.get('v'),version,'The changed stylesheet must use the current release cache version.');
});
test('root diagnostic links stay at root',async()=>{
  const entry=await text('setup.html');
  assert.match(entry,/href="\.\/#studio"/);
  assert.doesNotMatch(entry,/<a[^>]+href="\.\/public\//);
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
