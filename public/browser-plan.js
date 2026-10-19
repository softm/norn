/** Pure browser render contracts. Does not read files, use network, or mutate edits. */
import {transitions} from './domain.js';
export const VERSION='0.3.0';
export const LIMITS={maxScenes:60,maxDuration:600,maxFileBytes:1024**3,maxWorkBytes:384*1024**2};
export function outputSettings(settings={},quality='720'){
 const edge=quality==='1080'?1920:quality==='480'?854:1280;
 let w=Number(settings.width)||1080,h=Number(settings.height)||1920;
 const scale=Math.min(1,edge/Math.max(w,h));
 return {width:Math.max(144,Math.round(w*scale/2)*2),height:Math.max(144,Math.round(h*scale/2)*2),fps:Math.min(30,Math.max(10,Number(settings.fps)||30))};
}
export function planVariant(v,media,quality='720',sceneId=null){
 const settings=outputSettings(v.settings,quality),byId=new Map(media.map(m=>[m.id,m]));
 const input=sceneId?v.scenes.filter(s=>s.id===sceneId):v.scenes;
 if(!input.length||input.length>LIMITS.maxScenes)throw Error(`장면은 1~${LIMITS.maxScenes}개를 선택하세요.`);
 let time=0;const rows=input.map((s,i)=>{
  const m=byId.get(s.source_id);if(!m)throw Error(`원본을 다시 선택하세요: ${s.name}`);
  if(!['image','video'].includes(m.kind))throw Error('지원하지 않는 장면 형식입니다.');
  const speed=Number(s.playback_speed),start=Number(s.start),span=Number(s.source_duration);
  if(!Number.isFinite(speed)||speed<.1||speed>3600||!Number.isFinite(start)||start<0)throw Error('시작점·배속을 확인하세요.');
  if(m.kind==='video'&&(!Number.isFinite(span)||span<=0||start+span>m.analysis.duration+.05))throw Error('원본 범위를 벗어난 영상 구간입니다.');
  const d=m.kind==='video'?span/speed:Number(s.duration),frames=Math.floor(d*settings.fps+1e-5);
  if(!Number.isFinite(d)||frames<1)throw Error('한 프레임보다 짧은 장면입니다.');
  if(Number(m.size)>LIMITS.maxFileBytes)throw Error('브라우저 모드의 파일당 안전 한도는 1GB입니다. 원본을 분할해 선택하세요.');
  const effect=i===input.length-1||sceneId?'cut':s.transition;
  if(!(effect in transitions))throw Error('지원하지 않는 전환입니다.');
  const fade=effect==='cut'?0:Math.floor(Math.max(0,Math.min(Number(s.transition_duration)||0,frames/settings.fps/2,(Number(input[i+1]?.duration)||0)/2))*settings.fps)/settings.fps;
  const row={...s,duration:frames/settings.fps,frames,transition:fade>0?effect:'cut',transition_duration:fade,timelineStart:time};
  time+=row.duration-fade;return row;
 });
 if(time>LIMITS.maxDuration)throw Error('이번 브라우저 버전은 완성 길이 10분까지입니다. 편집 버전을 나눠주세요.');
 return {id:v.id,name:v.name,settings,scenes:rows,audio:{...v.audio},duration:time};
}
export function tempoFilters(speed){const filters=[];while(speed>2+1e-6){filters.push('atempo=2');speed/=2;}while(speed<.5-1e-6){filters.push('atempo=0.5');speed*=2;}filters.push(`atempo=${speed.toFixed(8)}`);return filters.join(',');}
export function joinGraph(rows){let time=rows[0].duration,v='pv0',a='pa0';const parts=rows.flatMap((_,i)=>[`[${i}:v]settb=AVTB,setpts=PTS-STARTPTS[pv${i}]`,`[${i}:a]asetpts=PTS-STARTPTS[pa${i}]`]);
 for(let i=1;i<rows.length;i++){const left=rows[i-1],fade=left.transition_duration,nextv=`v${i}`,nexta=`a${i}`;
  if(left.transition==='cut'||!fade){parts.push(`[${v}][${a}][pv${i}][pa${i}]concat=n=2:v=1:a=1[${nextv}][${nexta}]`);time+=rows[i].duration;}
  else{parts.push(`[${v}][pv${i}]xfade=transition=${left.transition}:duration=${fade}:offset=${(time-fade).toFixed(6)}[${nextv}]`);parts.push(`[${a}][pa${i}]acrossfade=d=${fade}:c1=tri:c2=tri[${nexta}]`);time+=rows[i].duration-fade;}
  v=nextv;a=nexta;
 }
 return {graph:parts.join(';'),video:v,audio:a,duration:time};
}
export function sampleTimes(duration,count=5,seed=1,start=0,end=duration){
 count=Math.floor(Number(count));if(!Number.isFinite(duration)||duration<=0||count<1||count>20||start<0||end>duration||end<=start)throw Error('표본 범위를 확인하세요.');
 let x=Number(seed)>>>0;const random=()=>{x=(Math.imul(1664525,x)+1013904223)>>>0;return x/4294967296};
 return Array.from({length:count},(_,i)=>start+(i+.1+random()*.8)*(end-start)/count);
}
export function safeName(value,fallback='norn'){return String(value||fallback).replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/^\.+/,'').trim().slice(0,80)||fallback;}
export function timeCode(seconds){const ms=Math.max(0,Math.round(seconds*1000));return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;}
export function subtitles(plan){return plan.scenes.map((s,i)=>`${i+1}\n${timeCode(s.timelineStart)} --> ${timeCode(s.timelineStart+s.duration-s.transition_duration)}\n${[s.title,s.caption].filter(Boolean).join('\n')}\n`).filter((_,i)=>plan.scenes[i].title||plan.scenes[i].caption).join('\n');}
