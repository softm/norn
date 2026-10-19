import {planVariant,joinGraph,LIMITS} from './browser-plan.js';
import {textPNG} from './browser-text.js';
export class BrowserRenderer{
 constructor(){this.worker=null;this.running=false;this.reject=null;this.cancelled=false;}
 cancel(){this.cancelled=true;this.worker?.terminate();this.worker=null;this.reject?.(new DOMException('영상 생성을 취소했습니다. 원본과 이전 결과는 유지됩니다.','AbortError'));this.reject=null;this.running=false;}
 async render(variant,library,{quality='720',sceneId=null,onProgress=()=>{}}={}){
  if(this.running)throw Error('현재 작업을 완료하거나 취소하세요.');if(!window.Worker||!window.WebAssembly)throw Error('이 브라우저는 영상 생성 엔진을 지원하지 않습니다. 최신 브라우저로 열어주세요.');
  const plan=planVariant(variant,library.items,quality,sceneId);this.running=true;this.cancelled=false;let worker;
  try{
   const inputs=[],indexes=new Map(),overlays=[];
   for(let i=0;i<plan.scenes.length;i++){if(this.cancelled)throw new DOMException('생성 취소','AbortError');const s=plan.scenes[i],m=library.items.find(m=>m.id===s.source_id);onProgress({phase:'prepare',detail:`자막·이미지 준비 ${i+1}/${plan.scenes.length}`,percent:Math.floor(i/plan.scenes.length*100)});
    // Images are bounded-size derived PNGs; video/audio File objects are read-only mounts.
    const key=m.kind==='image'?m.id+'-'+plan.settings.width+'-'+plan.settings.height:m.id;
    if(!indexes.has(key)){const file=m.kind==='image'?await library.normalizedImage(m.id,plan.settings.width,plan.settings.height):library.files.get(m.id);if(!file)throw Error('원본 파일을 다시 선택하세요.');indexes.set(key,inputs.length);inputs.push({file,kind:m.kind,ext:m.kind==='image'?'png':(file.name?.split('.').pop().match(/^[a-zA-Z0-9]{1,8}$/)?.[0]||'bin')});}
    s.inputIndex=indexes.get(key);overlays.push(await textPNG(s,plan.settings.width,plan.settings.height));
   }
   const mid=plan.audio.music_id;if(mid){const file=library.files.get(mid);if(!file)throw Error('배경음악 파일을 다시 선택하거나 음악 없음을 선택하세요.');plan.musicIndex=inputs.length;inputs.push({file,kind:'audio',ext:file.name.split('.').pop()});}
   if(this.cancelled)throw new DOMException('생성 취소','AbortError');worker=new Worker(new URL('./browser-ffmpeg-worker.js',import.meta.url));this.worker=worker;
   const result=await new Promise((resolve,reject)=>{this.reject=reject;worker.onmessage=({data})=>{if(data.type==='progress')onProgress(data);if(data.type==='error')reject(Error(data.message));if(data.type==='done')resolve({blob:new Blob([data.data],{type:'video/mp4'}),metadata:data.metadata,plan});};worker.onerror=()=>reject(Error('영상 작업자가 종료됐습니다. 메모리 부족·브라우저 제한일 수 있습니다. 해상도나 길이를 줄여주세요.'));worker.postMessage({type:'render',plan,inputs,overlays,join:joinGraph(plan.scenes),workLimit:LIMITS.maxWorkBytes});});
   return result;
  }finally{worker?.terminate();this.worker=null;this.reject=null;this.running=false;}
 }
}
