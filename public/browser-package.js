/** Output files are generated data. Original media never enters the download package. */
import * as W from './workspace.js';
import {safeFileName} from './local-media.js';

const encoder = new TextEncoder();
const crcTable = new Uint32Array(256);
for (let n=0;n<256;n++) { let c=n; for(let k=0;k<8;k++) c=c&1 ? 0xedb88320^(c>>>1) : c>>>1; crcTable[n]=c>>>0; }
export async function crc32(blob,signal) {
  let crc=0xffffffff;
  for(let offset=0;offset<blob.size;offset+=1048576) {
    signal?.throwIfAborted();
    const data=new Uint8Array(await blob.slice(offset,offset+1048576).arrayBuffer());
    for(const byte of data) crc=crcTable[(crc^byte)&255]^(crc>>>8);
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  signal?.throwIfAborted();
  return (crc^0xffffffff)>>>0;
}
function header(size) { const bytes=new Uint8Array(size);return {bytes,view:new DataView(bytes.buffer)}; }
function safePath(path) {
  return typeof path==='string' && path.length>0 && !path.startsWith('/') && !/[\\\x00-\x1f]/.test(path)
    && path.split('/').every(part=>part && part!=='.' && part!=='..');
}
/** ZIP store mode avoids compressing already-compressed video and keeps Blob slices lazy. */
export async function createZip(files,{signal,onProgress}={}) {
  if(!Array.isArray(files)||files.length>1000) throw Error('저장할 파일 목록을 확인하세요.');
  const parts=[],central=[],seen=new Set();let offset=0,centralSize=0;
  const date=new Date(),time=(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1);
  const day=((Math.max(1980,date.getFullYear())-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate();
  for(let i=0;i<files.length;i++) {
    signal?.throwIfAborted();
    const file=files[i],name=encoder.encode(file.path);
    if(!safePath(file.path)||seen.has(file.path)||name.length>65535||!(file.blob instanceof Blob)) throw Error('안전한 출력 파일명과 내용을 확인하세요.');
    seen.add(file.path);
    if(offset+file.blob.size>600*1024*1024) throw Error('게시 묶음이 너무 큽니다. 영상과 문구를 각각 저장하세요.');
    const crc=await crc32(file.blob,signal),local=header(30),directory=header(46);
    const l=local.view,d=directory.view;
    l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint16(6,0x800,true);
    l.setUint16(10,time,true);l.setUint16(12,day,true);l.setUint32(14,crc,true);
    l.setUint32(18,file.blob.size,true);l.setUint32(22,file.blob.size,true);l.setUint16(26,name.length,true);
    d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x800,true);
    d.setUint16(12,time,true);d.setUint16(14,day,true);d.setUint32(16,crc,true);
    d.setUint32(20,file.blob.size,true);d.setUint32(24,file.blob.size,true);d.setUint16(28,name.length,true);d.setUint32(42,offset,true);
    parts.push(local.bytes,name,file.blob);central.push(directory.bytes,name);
    offset+=30+name.length+file.blob.size;centralSize+=46+name.length;
    onProgress?.({current:i+1,total:files.length,path:file.path});
  }
  const end=header(22),e=end.view;e.setUint32(0,0x06054b50,true);
  e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,centralSize,true);e.setUint32(16,offset,true);
  return new Blob([...parts,...central,end.bytes],{type:'application/zip'});
}
const json=value=>new Blob([JSON.stringify(value,null,2)],{type:'application/json'});
const text=value=>new Blob([value],{type:'text/plain;charset=utf-8'});
export function postingFiles(project,variant,media,result,{folderName=''}={}) {
  const directoryName=safeFileName(folderName||project.title||'노른')+'업로드준비';
  const clean=W.cloudData(project),files=[{path:'norn-project.json',blob:json(clean)}];
  if(result) {
    if(!(result.blob instanceof Blob)||!result.blob.size||!['mp4','webm'].includes(result.extension)) throw Error('완성된 영상 파일이 없습니다.');
    const actual=result.blob.type.split(';')[0];
    if(actual!==({mp4:'video/mp4',webm:'video/webm'})[result.extension]) throw Error('영상 형식과 파일 확장자가 일치하지 않습니다.');
    files.push({path:'video.'+result.extension,blob:result.blob});
    files.push({path:'result.json',blob:json({variantId:variant.id,variantName:variant.name,format:result.extension,width:result.width,height:result.height,fps:result.fps,duration:result.duration,createdAt:result.createdAt,renderer:'browser'})});
  }
  for(const [id,label]of W.channelList) files.push({path:'sns/'+id+'/post.txt',blob:text(W.composePost(project,variant,id))});
  const originals=[...new Set(variant.scenes.map(scene=>scene.source_id))].map(id=>{
    const source=media.find(item=>item.id===id);
    return {id,name:source?.relative_path||'원본을 다시 선택하세요',kind:source?.kind||'missing',included:false};
  });
  files.push({path:'attachments.json',blob:json({video:result?'video.'+result.extension:null,originals,notice:'원본 파일은 이 묶음에 포함하지 않습니다. SNS 사진 첨부는 기존 원본 폴더에서 선택하세요.'})});
  files.push({path:'읽어주세요.txt',blob:text(`${project.title}\n\n${result?'video.'+result.extension+' 파일이 완성된 영상입니다.':'이 묶음에는 편집정보와 문구만 있습니다. 영상은 아직 생성하지 않았습니다.'}\nnorn-project.json은 편집정보이며 원본 백업이 아닙니다. 노른에서 JSON을 연 다음 같은 원본 파일이나 폴더를 다시 선택하세요.\nsns 폴더의 채널별 post.txt를 복사하고 영상·원본 사진을 직접 첨부하세요.\n원본 사진·영상·음악은 복사하거나 업로드하지 않았습니다.\n`)});
  return {directoryName,files};
}
