/** Shared, side-effect-free editing contracts. Original bytes and paths never enter cloud DTOs. */
import * as D from './domain.js';
export const modes={short:{label:'숏폼',seconds:30,width:1080,height:1920},long:{label:'롱폼',seconds:300,width:1920,height:1080},timelapse:{label:'타임랩스',seconds:30,width:1920,height:1080},photo:{label:'사진 스토리',seconds:30,width:1080,height:1920},free:{label:'자유 편집',seconds:60,width:1920,height:1080}};
export const channelList=[['instagram','인스타그램'],['tiktok','틱톡'],['x','X'],['threads','스레드'],['facebook','페이스북'],['naver_blog','네이버 블로그'],['naver_clip_video','클립 · 영상'],['naver_clip_mixed','클립 · 사진+영상'],['youtube','YouTube']];
const idPattern=/^[A-Za-z0-9_-]{1,80}$/;
export function validId(value){return typeof value==='string'&&idPattern.test(value)}
export function analysisOptions(input={}){const number=(key,fallback,min,max)=>{const n=Number(input[key]??fallback);return Number.isFinite(n)?Math.min(max,Math.max(min,Math.floor(n))):fallback};return {imageLimit:number('imageLimit',100,1,600),frameSize:number('frameSize',640,256,960),maxScenes:number('maxScenes',12,1,120),seed:number('seed',0,0,999999),order:['concept','source','current'].includes(input.order)?input.order:'concept',scope:['folder','timeline'].includes(input.scope)?input.scope:'folder',fullVideo:Boolean(input.fullVideo)}}
export function makeVariant(base,{mode='short',name='',width,height,targetDuration,empty=false}={}){const preset=modes[mode]||modes.short;const v=D.variantCopy(base,name.trim()||preset.label);v.mode=mode in modes?mode:'short';v.targetDuration=Number(targetDuration)||preset.seconds;v.settings={...v.settings,width:Number(width)||preset.width,height:Number(height)||preset.height};if(empty)v.scenes=[];return v}
const validAsset=a=>a&&validId(a.id)&&['image','video','audio'].includes(a.kind)&&/^[a-f0-9]{64}$/.test(a.sha256||'')&&Number.isSafeInteger(a.size)&&a.size>=0;
const sameAsset=(a,b)=>a.sha256===b.sha256&&a.kind===b.kind&&a.size===b.size;
export function assetManifest(media){
 const assets=new Map();
 for(const m of media.filter(validAsset)){
  const previous=assets.get(m.id);
  if(previous&&!sameAsset(previous,m))throw Error('같은 자료 ID에 다른 파일이 연결되어 있습니다. 원본을 다시 확인하세요.');
  assets.set(m.id,{id:m.id,sha256:m.sha256,kind:m.kind,size:m.size});
 }
 if(assets.size>600)throw Error('자료 보관함은 최대 600개입니다. 프로젝트를 나눠 저장하세요.');
 return [...assets.values()];
}
export function projectMedia(project,media){
 const assets=(project?.assets||[]).filter(validAsset);
 if(!assets.length)return [];
 return media.filter(m=>assets.some(a=>sameAsset(a,m)));
}
export function relinkProject(project,media){const p=D.clone(project),byId=new Map(media.map(m=>[m.id,m])),available=assetManifest(media),old=new Map(assetManifest(p.assets||[]).map(m=>[m.id,m]));const map=new Map(),missing=[],ambiguous=[];
 const referenced=new Set(p.variants.flatMap(v=>[...v.scenes.map(s=>s.source_id),v.audio?.music_id].filter(Boolean)));
 // Resolve the entire library, including files not currently used by a scene or music track.
 for(const sid of new Set([...referenced,...old.keys()])){
  const expected=old.get(sid),direct=byId.get(sid);
  if(direct&&(!expected||sameAsset(expected,direct))){map.set(sid,sid);continue}
  const matches=expected?available.filter(m=>sameAsset(expected,m)):[];
  if(matches.length===1)map.set(sid,matches[0].id);
  else if(referenced.has(sid)){if(matches.length>1)ambiguous.push(sid);else missing.push(sid)}
 }
 for(const v of p.variants){for(const s of v.scenes)if(map.has(s.source_id))s.source_id=map.get(s.source_id);if(map.has(v.audio?.music_id))v.audio.music_id=map.get(v.audio.music_id)}
 // Absence of bytes is not a deletion. Retain the old manifest until a unique reconnect replaces it.
 p.assets=assetManifest([...available,...[...old.values()].filter(a=>!map.has(a.id))]);
 return {project:p,missing,ambiguous,matched:[...referenced].filter(id=>map.has(id)).length};}
export function validateProject(p){if(!p||p.schema_version!==2||!validId(p.id)||!Array.isArray(p.variants)||p.variants.length<1||p.variants.length>12)throw Error('노른 프로젝트 파일을 확인하세요.');if(typeof p.title!=='string'||p.title.length>160||typeof p.description!=='string'||p.description.length>6000)throw Error('프로젝트 제목·설명 길이를 확인하세요.');const ids=new Set();for(const v of p.variants){if(!validId(v.id)||ids.has(v.id)||!Array.isArray(v.scenes)||v.scenes.length>120)throw Error('출력 버전과 장면 수를 확인하세요.');ids.add(v.id);if(!v.settings||![v.settings.width,v.settings.height,v.settings.fps].every(Number.isFinite)||v.settings.width<144||v.settings.width>3840||v.settings.height<144||v.settings.height>3840||v.settings.fps<10||v.settings.fps>60)throw Error('해상도·프레임 설정 오류');const rows=new Set();for(const s of v.scenes){if(!validId(s.id)||rows.has(s.id)||!validId(s.source_id))throw Error('장면 ID 오류');rows.add(s.id);for(const [k,max] of [['name',100],['title',100],['caption',240]])if(typeof s[k]!=='string'||s[k].length>max)throw Error('장면 글씨 길이를 확인하세요.');for(const k of ['start','duration','source_duration','playback_speed'])if(!Number.isFinite(s[k]))throw Error('장면 시간 정보 오류');if(s.start<0||s.duration<=0||s.source_duration<=0||s.playback_speed<.1||s.playback_speed>3600)throw Error('장면 구간·배속 범위 오류')}}if(!ids.has(p.activeVariant))throw Error('선택한 출력 버전이 없습니다.');return p}
export function cloudData(p){validateProject(p);const q=D.cloudProject(p);q.assets=(p.assets||[]).filter(a=>validId(a.id)&&/^[a-f0-9]{64}$/.test(a.sha256)&&['image','video','audio'].includes(a.kind)&&Number.isSafeInteger(a.size)).map(({id,sha256,kind,size})=>({id,sha256,kind,size}));q.analysis=analysisOptions(p.analysis);q.publicNote=String(p.publicNote??'').slice(0,6000);q.posts=Object.fromEntries(Object.entries(p.posts||{}).filter(([key,value])=>q.variants.some(v=>v.id===key)&&value&&typeof value==='object').map(([key,value])=>[key,Object.fromEntries(channelList.filter(([ch])=>typeof value[ch]==='string').map(([ch])=>[ch,value[ch].slice(0,12000)]))]));q.variants.forEach((v,i)=>{v.mode=p.variants[i].mode in modes?p.variants[i].mode:'free';v.targetDuration=Math.min(3600,Math.max(1,Number(p.variants[i].targetDuration)||p.targetDuration||30))});return q}
export function sceneSequence(v){let t=0;return v.scenes.map((s,i)=>{const fade=i<v.scenes.length-1&&s.transition!=='cut'?Math.min(s.transition_duration,s.duration/2,v.scenes[i+1].duration/2):0;const item={id:s.id,start:t,end:t+s.duration,overlap:fade};t+=s.duration-fade;return item})}
export function composePost(p,v,channel){const saved=p.posts?.[v.id]?.[channel];if(typeof saved==='string')return saved;const title=p.title.trim(),body=String(p.publicNote||'').trim();const lines=[...new Set(v.scenes.map(s=>s.caption?.trim()).filter(Boolean))];const short=channel==='x'||channel==='threads';return [title,body,short?lines.slice(0,1).join('\n'):lines.join(channel==='naver_blog'?'\n\n':'\n')].filter(Boolean).join('\n\n')}
export function propose(p,proposal,{addNew=false,reorder=false,replaceManual=false,media=[],useTiming=false}={}){const q=D.applyProposal(p,proposal,false),v=q.variants.find(v=>v.id===q.activeVariant),byId=new Map(media.map(m=>[m.id,m]));const recommended=[];for(const row of proposal.scenes){let found=v.scenes.filter(s=>s.source_id===row.source_id);if(!found.length&&addNew&&byId.has(row.source_id)){const s=D.scene(byId.get(row.source_id),v.settings.fps);v.scenes.push(s);found=[s]}for(const s of found){for(const key of ['name','title','caption'])if(replaceManual||!(s.field_locks||[]).includes(key))s[key]=row[key]||'';if(useTiming&&!(s.field_locks||[]).includes('timing')&&row.timing){const m=byId.get(s.source_id);if(m?.kind==='video'){Object.assign(s,D.timing(s,row.timing.start,row.timing.end,row.timing.speed,v.settings.fps))}else if(m?.kind==='image')s.duration=Math.max(1/v.settings.fps,Math.min(600,row.timing.duration))}s.reason=row.reason||'';recommended.push(s)}}if(reorder){const used=new Set(recommended.map(s=>s.id));v.scenes=[...recommended,...v.scenes.filter(s=>!used.has(s.id))]}if(v.scenes.length>120)throw Error('한 버전의 장면은 최대 120개입니다.');return q}
export function progressLabel(job){if(job.status==='done')return {value:100,text:'완료'};if(job.status!=='running')return {value:null,text:job.status==='error'?'실패':'대기'};const n=Number(job.stagePercent);return {value:job.stagePercent!=null&&Number.isFinite(n)?Math.max(0,Math.min(99,n)):null,text:job.detail||'처리 중'}}
