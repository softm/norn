import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const text=path=>readFile(new URL(path,root),'utf8');
for(const name of ['index.html','setup.html']){
  test(`branch root ${name} uses the same application without navigation or iframe`,async()=>{
    const source=await text('public/'+name),entry=await text(name);
    const expected=source.replace(/\b(href|src)="\.\/([^"?#]+\.(?:css|js))"/g,'$1="./public/$2"');
    assert.equal(entry,expected,'Run npm run sync:root after changing public entry HTML.');
    assert.doesNotMatch(entry,/<iframe\b|<base\b|http-equiv=["']refresh|location\.(?:replace|assign)\(/i);
    for(const match of entry.matchAll(/\b(?:href|src)="(\.\/public\/[^"?#]+\.(?:css|js))"/g)){
      await access(new URL(match[1],root));
    }
  });
}
test('root entry contains the application DOM and loads its actual module',async()=>{
  const entry=await text('index.html');
  for(const id of ['app','modal-root','toast'])assert.ok(entry.includes(`id="${id}"`));
  assert.match(entry,/<script type="module" src="\.\/public\/browser-studio\.js"><\/script>/);
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
