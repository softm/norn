/** Keep branch-root entry pages in sync with public/, without redirects or frames. */
import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
for(const name of ['index.html','setup.html']){
  const source=await readFile(new URL('public/'+name,root),'utf8');
  // Only assets change location. Anchors and navigation stay on the current route.
  const entry=source.replace(/\b(href|src)="(\.\/[^"]+)"/g,(attribute,key,reference)=>{
    const asset=new URL(reference,new URL('public/'+name,root));
    return /\.(?:css|m?js)$/.test(asset.pathname)?`${key}="./public/${reference.slice(2)}"`:attribute;
  });
  await writeFile(new URL(name,root),entry);
}
console.log('NORN branch-root entry pages updated; public/ remains the source of truth.');
