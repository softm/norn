import test from 'node:test';
import assert from 'node:assert/strict';
import {createZip,crc32,postingFiles} from '../public/browser-package.js';
import * as D from '../public/domain.js';

test('CRC32 is compatible with ZIP and handles chunk boundaries',async()=>{
  assert.equal(await crc32(new Blob(['123456789'])),0xcbf43926);
  assert.equal(await crc32(new Blob([])),0);
  const large=new Blob([new Uint8Array(1048593).fill(65)]);
  assert.equal(await crc32(large),0x3bf6c758);
});
test('ZIP includes binary bytes, Korean UTF-8 names and a correct central directory',async()=>{
  const zip=await createZip([{path:'노른/영상.webm',blob:new Blob([Uint8Array.from([0,1,2,254,255])])},{path:'노른/문구.txt',blob:new Blob(['안녕하세요'])}]);
  const bytes=new Uint8Array(await zip.arrayBuffer()),view=new DataView(bytes.buffer);
  assert.equal(zip.type,'application/zip');assert.equal(view.getUint32(0,true),0x04034b50);
  assert.equal(view.getUint16(6,true),0x800);
  const e=bytes.length-22;assert.equal(view.getUint32(e,true),0x06054b50);assert.equal(view.getUint16(e+10,true),2);
  const offset=view.getUint32(e+16,true);assert.equal(view.getUint32(offset,true),0x02014b50);
  assert.ok(new TextDecoder().decode(bytes).includes('노른/문구.txt'));
});
test('unsafe, repeated paths and aborted ZIP work are rejected',async()=>{
  for(const path of ['../original.mp4','/original.mp4','a/../b','a\\b','a//b'])await assert.rejects(createZip([{path,blob:new Blob(['x'])}]),/파일명/);
  const file={path:'one',blob:new Blob(['a'])};await assert.rejects(createZip([file,file]),/파일명/);
  const controller=new AbortController();controller.abort();await assert.rejects(createZip([file],{signal:controller.signal}),{name:'AbortError'});
});
test('posting package contains generated video, settings and all channel texts but never original media',async()=>{
  const p=D.demoProject();p.publicNote='공개 소개';p.description='외부에 복사하지 않을 메모';
  const original=new Blob(['PRIVATE ORIGINAL']);const media=[{id:'sample1',relative_path:'원본/사진.jpg',file:original,url:'blob:private',kind:'image'}];
  const result={blob:new Blob(['GENERATED'],{type:'video/webm;codecs=vp8,opus'}),extension:'webm',width:720,height:1280,duration:9,fps:30};
  const pack=postingFiles(p,p.variants[0],media,result,{folderName:'여행'});
  assert.equal(pack.directoryName,'여행업로드준비');assert.equal(pack.files.find(f=>f.path==='video.webm').blob,result.blob);
  assert.equal(pack.files.filter(f=>f.path.endsWith('post.txt')).length,9);
  const texts=await Promise.all(pack.files.filter(f=>f.path!=='video.webm').map(f=>f.blob.text()));
  assert.ok(texts.every(text=>!text.includes('PRIVATE ORIGINAL')&&!text.includes('blob:private')));
  const post=await pack.files.find(f=>f.path==='sns/instagram/post.txt').blob.text();
  assert.ok(post.includes('공개 소개'));assert.ok(!post.includes(p.description));
  assert.throws(()=>postingFiles(p,p.variants[0],media,{...result,extension:'mp4'}),/확장자/);
});
