/** Keep branch-root entry pages in sync with public/, without redirects or frames. */
import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
for(const name of ['index.html','setup.html']){
  const source=await readFile(new URL('public/'+name,root),'utf8');
  // Only assets change location. Anchors and navigation stay on the current route.
  const entry=source.replace(/\b(href|src)="\.\/([^"?#]+\.(?:css|js))"/g,'$1="./public/$2"');
  await writeFile(new URL(name,root),entry);
}
console.log('NORN branch-root entry pages updated; public/ remains the source of truth.');
