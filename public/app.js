import * as D from './domain.js';
import * as Cloud from './firebase-v2.js?v=0.5.1';
import * as W from './workspace.js';
import {installStudioPlus} from './studio-plus.js?v=0.5.1';
import {installBrowserStudio} from './browser-studio.js?v=0.5.1';
import {BROWSER_TRANSITIONS} from './browser-renderer.js';
let plus=null,browserStudio=null,engineRevision=0;
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const app=$('#app');let project=emptyProject(),media=[],selected='',engine=null,user=null,page='home',job={status:'idle'},history=[],redo=[],previewUrl='',cloudRevision=0,unsaved=false,lastDone='',proposal=null,cloudRows=[];
let catalog={styles:D.styles,transitions:BROWSER_TRANSITIONS};let defaultFrames=5;let pending=false,toastTimer,overlayTimer;
const sampleSVG=i=>`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="850" viewBox="0 0 600 850"><rect width="600" height="850" fill="${['#cbbfa0','#b6c6b2','#d6b899'][i-1]}"/><circle cx="${i===1?170:385}" cy="${i===2?265:220}" r="112" fill="${['#ead7a1','#e6dfbc','#f0d29c'][i-1]}"/><path d="M-50 550 Q200 210 680 590 L680 900 L-50 900Z" fill="${['#697759','#64877a','#a07961'][i-1]}"/><path d="M-40 700 Q260 440 650 685 L650 900 L-40 900Z" fill="${['#364a39','#345d52','#6c6252'][i-1]}"/><path d="M-50 790 Q250 660 650 780" fill="none" stroke="#ded4ad" stroke-width="4" opacity=".7"/><text x="45" y="76" fill="#404d3b" font-family="sans-serif" font-size="15" letter-spacing="5">NORN / STUDY 0${i}</text><text x="45" y="820" fill="#eadfca" font-family="sans-serif" font-size="13" letter-spacing="4">FRAGMENTS OF A STORY</text></svg>`;
const sampleURL=i=>'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(sampleSVG(i));
const samples=()=>[1,2,3].map(i=>({id:'sample'+i,kind:'image',relative_path:['오후의 빛.svg','작은 파동.svg','기억의 조각.svg'][i-1],analysis:{width:600,height:850,duration:0},url:sampleURL(i),sample:true}));selected='';
function emptyProject(){const p=D.demoProject();p.id=D.uid();p.title='새 이야기';p.description='';p.variants[0].name='나의 첫 영상';p.variants[0].scenes=[];p.assets=[];return p}
const v=()=>project.variants.find(x=>x.id===project.activeVariant)||project.variants[0];const scene=()=>v().scenes.find(s=>s.id===selected);const mfor=s=>media.find(m=>m.id===s?.source_id);
const tokenURL=path=>engine?engine.url+path+(path.includes('?')?'&':'?')+'token='+encodeURIComponent(engine.token):'';
function url(m,thumb=false){if(!m)return '';if(thumb&&m.thumb_url)return m.thumb_url;if(m.sample||m.url)return m.url;return tokenURL((thumb?'/thumb/':'/media/')+encodeURIComponent(m.id))}
function toast(t,action){
 clearTimeout(toastTimer);
 const box=$('#toast');box.replaceChildren();
 const message=document.createElement('span');message.textContent=t;box.append(message);
 if(action){const button=document.createElement('button');button.className='small';button.dataset.action=action;button.textContent='되돌리기';box.append(button)}
 box.style.display='flex';toastTimer=setTimeout(()=>box.style.display='none',6000);
}
let cloudSyncTimer=null,cloudEditVersion=0,cloudSaveQueue=Promise.resolve();
const waitCloudSync=()=>cloudSaveQueue.catch(()=>{});
function saveCloudCurrent(event='autosave'){
 if(!user)return Promise.resolve(null);
 const run=async()=>{
  if(!user)return null;
  const syncProject=project.id,syncUser=user.uid,saveVersion=cloudEditVersion,status=$('#save-status');
  const linked=W.relinkProject(project,media).project;
  project.assets=linked.assets;
  if(status)status.textContent='Firebase 저장 중…';
  try{
   const revision=await Cloud.saveCloud(project,cloudRevision,event);
   if(user?.uid===syncUser&&project.id===syncProject){
    cloudRevision=revision;
    if(cloudEditVersion===saveVersion){
     unsaved=false;
     if(status)status.textContent='Firebase 저장됨';
    }else{
     unsaved=true;
     if(status)status.textContent='변경됨 · Firebase 저장 대기';
     scheduleCloudSync();
    }
   }
   return revision;
  }catch(err){
   if(user?.uid===syncUser&&project.id===syncProject&&status)status.textContent='로컬 변경됨 · Firebase 확인 필요';
   throw err;
  }
 };
 const result=cloudSaveQueue.then(run,run);
 cloudSaveQueue=result.catch(()=>{});
 return result;
}
function scheduleCloudSync(){
 clearTimeout(cloudSyncTimer);
 if(!user)return;
 const syncProject=project.id,syncUser=user.uid;
 cloudSyncTimer=setTimeout(()=>{
  if(!user||user.uid!==syncUser||project.id!==syncProject)return;
  saveCloudCurrent('autosave').catch(err=>console.warn('NORN cloud autosave:',err));
 },1800);
}
function persist(){cloudEditVersion++;unsaved=true;if(!user){try{localStorage.setItem('norn.guest.project',JSON.stringify(W.cloudData(project)))}catch{toast('브라우저 임시저장 공간이 부족합니다. JSON으로 백업하세요.')}}else scheduleCloudSync();const e=$('#save-status');if(e)e.textContent=user?'변경됨 · Firebase 저장 대기':'변경됨 · 저장 필요'}
let inputHistoryTarget=null;
const historySnapshot=()=>({project:D.clone(project),selected});
const editingBusy=()=>browserStudio?.busy()||job.status==='running';
const hasCurrentWork=()=>media.length>0||v().scenes.length>0||unsaved||project.title!=='새 이야기'||Boolean(project.description);
function pushHistory(){
 $('#toast [data-action=undo]')?.remove();
 history.push(historySnapshot());if(history.length>60)history.shift();redo=[];
 const undoButton=$('.timeline [data-action=undo]'),redoButton=$('.timeline [data-action=redo]');
 if(undoButton)undoButton.disabled=false;if(redoButton)redoButton.disabled=true;
}
function focusTimeline(){const target=$('.clip.selected .clip-select')||$('#track');target?.focus({preventScroll:true})}
function selectScene(id){
 if(editingBusy()||!v().scenes.some(s=>s.id===id))return;
 selected=id;previewUrl='';render();focusTimeline();
}
function deleteScene(id=selected){
 if(editingBusy())return;
 const scenes=v().scenes,index=scenes.findIndex(s=>s.id===id);
 if(index<0)return;
 edit(()=>{
  scenes.splice(index,1);
  if(selected===id||!scenes.some(s=>s.id===selected))selected=scenes[Math.min(index,scenes.length-1)]?.id||'';
 });
 focusTimeline();toast('장면을 삭제했습니다. 원본은 그대로예요.','undo');
}
function restoreEdit(from,to){
 if(editingBusy()||$('.modal')||!from.length)return;
 to.push(historySnapshot());
 const snapshot=from.pop();project=snapshot.project;project.revision=engineRevision;
 selected=v().scenes.some(s=>s.id===snapshot.selected)?snapshot.selected:v().scenes[0]?.id||'';
 previewUrl='';persist();render();focusTimeline();
 toast(from===history?'되돌렸습니다.':'다시 실행했습니다.');
}
function edit(fn){pushHistory();fn();previewUrl='';persist();render()}
function restoreGuest(){try{const p=JSON.parse(localStorage.getItem('norn.guest.project'));if(p){project={...W.validateProject(p),revision:0};selected=v().scenes[0]?.id||'';if(project.variants.some(v=>v.scenes.some(s=>s.source_id.startsWith('sample'))))media=samples()}}catch{}}
function enter(){if(!user)sessionStorage.removeItem('norn.cloud.project');if(page==='home'&&!engine&&!user&&!media.length)restoreGuest();page='studio';location.hash='studio';render()}
function brand(){return '<a class="brand" href="#" data-action="home" aria-label="노른 홈"><span class="mark">n</span>NORN</a>'}
function cloudTime(value){try{return value?.toDate?.().toLocaleString('ko-KR',{dateStyle:'medium',timeStyle:'short'})||'저장 시각 없음'}catch{return '저장 시각 없음'}}
async function refreshWorkspace(renderAfter=true){if(!user){cloudRows=[];if(renderAfter&&page==='home')render();return}try{cloudRows=await Cloud.listCloud()}catch(e){toast('프로젝트 목록을 불러오지 못했습니다: '+(e.message||e))}if(renderAfter&&page==='home')render()}
function workspaceHome(){
 const rows=cloudRows||[];
 app.innerHTML=`<header class="topbar project-topbar">${brand()}<nav><button class="ghost small" data-action="workspace-refresh">새로고침</button><button class="small" data-action="account">${esc(user?.displayName||'내 계정')}</button></nav></header><main class="project-workspace"><section class="project-workspace-hero"><div><span class="eyebrow">NORN PROJECT WORKSPACE</span><h1>내 영상 프로젝트</h1><p>영상 작업 하나를 하나의 프로젝트로 저장합니다. 프로젝트를 다시 열면 제목·장면·자막·효과·음악 설정을 이어서 편집할 수 있습니다.</p></div><button class="primary project-create-main" data-action="new-project">＋ 새 프로젝트</button></section><section class="project-list-section"><div class="project-list-head"><div><h2>프로젝트</h2><p class="muted">Firebase에 저장된 작업 ${rows.length}개 · 원본 사진·영상은 내 컴퓨터에 유지</p></div></div><div class="project-grid"><button class="project-new-card" data-action="new-project"><span class="project-plus">＋</span><strong>새 프로젝트</strong><small>새 영상 작업 시작</small></button>${rows.map(row=>`<article class="workspace-project-card"><button class="project-open-area" data-action="project-open" data-id="${esc(row.id)}"><span class="project-cover" aria-hidden="true">${esc((row.title||'N').trim().slice(0,1).toUpperCase())}</span><span class="project-card-body"><strong>${esc(row.title||'제목 없는 프로젝트')}</strong><small>최근 작업 · ${cloudTime(row.updatedAt)}</small><span class="project-meta">버전 ${row.variantIds?.length||0} · 자료 ${row.assets?.length||0} · r${row.revision||0}</span></span></button><div class="project-card-actions"><button class="ghost small" data-action="project-history" data-id="${esc(row.id)}" data-title="${esc(row.title||'프로젝트')}">이력</button><button class="danger small" data-action="project-delete" data-id="${esc(row.id)}" data-revision="${row.revision||0}">삭제</button></div></article>`).join('')}</div></section></main>`;
}
async function openWorkspace(){if(!user){page='home';location.hash='';render();return account()}clearTimeout(cloudSyncTimer);await waitCloudSync();if(unsaved){try{await saveCloudCurrent('autosave')}catch(e){if(!confirm('현재 프로젝트의 Firebase 저장이 완료되지 않았습니다. 그래도 프로젝트 목록으로 이동할까요?'))return}}page='home';location.hash='';await refreshWorkspace(false);render()}
async function loadCloudProject(id,{notify=true}={}){
 if(!user)throw Error('로그인이 필요합니다.');
 if(!W.validId(id))throw Error('프로젝트 ID 오류');
 const p=await Cloud.loadCloud(id),revision=p.revision,matchedMedia=W.projectMedia(p,media),linked=W.relinkProject(p,matchedMedia);
 browserStudio?.resetProjectState?.();
 browserStudio?.retainMedia?.(matchedMedia);
 media=matchedMedia;project=linked.project;project.revision=engineRevision||0;cloudRevision=revision;cloudEditVersion=0;selected=v().scenes[0]?.id||'';
 history=[];redo=[];previewUrl='';unsaved=false;page='studio';sessionStorage.setItem('norn.cloud.project',id);
 if(location.hash!=='#studio')window.history.replaceState(null,'','#studio');
 render();
 if(notify)toast(linked.missing.length?'프로젝트를 열었습니다. 이 프로젝트의 원본 파일을 다시 연결하세요.':'프로젝트를 열었습니다.');
}
function home(){if(user)return workspaceHome();app.innerHTML=`<header class="topbar">${brand()}<nav><button class="ghost small" data-action="enter">작업실</button><button class="primary small" data-action="account">${user?'내 계정':'로그인'}</button></nav></header><main class="landing"><section class="hero"><div><div class="eyebrow">YOUR LOCAL STORY STUDIO</div><h1>노른노른하게,<br><em>영상을 굽다.</em></h1><p>사진에 담긴 순간, 영상에 흩어진 이야기를<br>하나의 흐름으로 엮어보세요.<br>짧은 순간부터 오래 남길 이야기까지.</p><div class="hero-actions"><button class="primary" data-action="addfiles">사진·영상 선택 ↗</button><button data-action="addfolder">폴더 선택</button></div><span class="pill on">원본은 내 컴퓨터에</span> <span class="pill">숏폼 · 롱폼 · 타임랩스</span><p class="tiny" style="font-size:11px;margin-top:18px">선택한 파일로 이 브라우저에서 편집하고 영상을 저장합니다.<br>원본 업로드 없이, 로그인 없이 시작하세요.<br><button class="ghost small" data-action="demo">예제로 둘러보기 →</button></p></div><div class="hero-art" aria-label="노른 샘플 그래픽"><span class="art-caption">A FEW FRAGMENTS. ONE STORY.</span><div class="art-orbit"></div><div class="polaroid one"><img src="${sampleURL(1)}" alt="오후의 빛 샘플 그래픽"><small>01 &nbsp; A LITTLE LIGHT</small></div><div class="polaroid two"><img src="${sampleURL(2)}" alt="작은 파동 샘플 그래픽"><small>02 &nbsp; A GENTLE RHYTHM</small></div><div class="polaroid three"><img src="${sampleURL(3)}" alt="기억의 조각 샘플 그래픽"><small>03 &nbsp; WOVEN TOGETHER</small></div><span class="spark">✳</span><div class="art-badge">✦ &nbsp; 당신의 순간에, 이야기 한 스푼.</div></div></section><section class="feature-strip"><div><span class="eyebrow">01 · THE WELL</span><strong>자료에 의도를 더하고</strong><p>폴더를 연결하고 만들고 싶은 이야기를 적어요.<br>사진·영상 원본은 그 자리에 둡니다.</p></div><div><span class="eyebrow">02 · FATE SCAN</span><strong>이야기의 결을 고르고</strong><p>장면의 순서와 길이를 정하고 문구를 더해요.<br>자동 배치로 첫 구성을 빠르게 시작할 수 있어요.</p></div><div><span class="eyebrow">03 · THE LOOM</span><strong>내 취향대로 구워내요</strong><p>글씨·배속·전환·음악을 더해 영상을 만들고,<br>SNS 문구와 첨부 자료까지 준비해요.</p></div></section><footer class="footer"><span>NORN · Weave your fragments into narratives.</span><span>브라우저에서 바로 편집 · Firebase 프로젝트 워크스페이스 · 0.5.1</span></footer></main>`}
function studio(){const current=scene(),m=mfor(current),variant=v();const missing=variant.scenes.some(s=>!mfor(s));app.innerHTML=`<main class="studio"><header class="topbar"><div class="project-head">${brand()}<span class="name">${esc(project.title)}</span><span class="pill ${engine?'on':''}" id="connection-label">${engine?'고급 엔진 연결됨':user?'브라우저 편집 · 계정 연결':'브라우저에서 편집'}</span></div><div class="toolbar"><span class="muted tiny desktop-only" id="save-status">${unsaved?'변경됨 · 저장 필요':'편집 준비됨'}</span><button class="small" data-action="concept">✦ 자동 구성</button><button class="small" data-action="save">${user?'프로젝트 저장':'편집 저장'}</button><button class="small" data-action="connect">자료 추가</button><button class="primary small" data-action="render">영상 저장 ↗</button><button class="ghost small desktop-only" data-action="account">${user?esc(user.displayName||'계정'):'로그인'}</button></div></header><div id="progress"></div><div class="workspace"><aside class="library"><div class="section-head"><h2>자료 보관함 <span class="muted tiny">${media.length}</span></h2><button class="ghost small" data-action="addfiles" aria-label="사진·영상 추가" title="사진·영상 추가">＋</button></div><div class="library-grid">${media.filter(m=>m.kind!=='audio').map(m=>`<div class="asset"><button class="view" data-action="view" data-id="${esc(m.id)}" aria-label="${esc(m.relative_path)} 원본 크게 보기"><img src="${esc(url(m,true))}" alt="${esc(m.relative_path)}"></button><button class="add" data-action="add" data-id="${esc(m.id)}" aria-label="${esc(m.relative_path)} 장면 추가">＋</button>${m.kind==='video'?`<span class="duration">▶ ${D.seconds(m.analysis.duration)}</span>`:''}<div class="asset-name">${esc(m.relative_path)}</div></div>`).join('')}</div><div class="helper">사진을 누르면 크게 보기 · ＋로 장면 추가</div><details class="library-more"><summary>작업 불러오기·관리</summary><button class="small" data-action="rescan">원본 다시 선택</button><button class="small ghost" data-action="import">편집 파일 열기 (JSON)</button></details></aside><section class="stage"><div class="stage-toolbar"><div class="row"><select class="variant-select" id="variant" aria-label="출력 버전">${project.variants.map(x=>`<option value="${esc(x.id)}" ${x.id===variant.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select><button class="small ghost" data-action="newvariant" title="출력 버전 추가">＋</button></div><span class="muted tiny">${variant.settings.width} × ${variant.settings.height} · ${variant.settings.fps} FPS</span></div><div class="preview-area"><div class="screen" id="screen">${current&&m?`${m.kind==='video'||previewUrl?`<video id="player" src="${esc(previewUrl||url(m))}" controls playsinline preload="metadata"></video>`:`<img class="media" src="${esc(url(m))}" alt="${esc(current.name)}">`}<div class="frame-badge">${previewUrl?'생성한 실제 미리보기':m.sample?'샘플 그래픽':m.kind==='video'?'원본 · 1배속 확인':'사진 원본'}</div>${previewUrl?'':`<div id="text-overlay" class="text-overlay ${esc(current.style)}"><strong>${esc(current.title)}</strong><span>${esc(current.caption)}</span></div>`}`:`<div class="empty">${missing?'원본을 다시 연결해주세요.':'사진·영상 또는 폴더를 선택해 이야기를 시작하세요.'}</div>`}</div></div><div class="transport"><button class="small ghost" data-action="previous" aria-label="이전 장면">←</button><button class="small" data-action="preview">▶ ${current?.playback_speed>4?'실제 배속 미리보기':'이 장면 미리보기'}</button><button class="small ghost" data-action="next" aria-label="다음 장면">→</button><time>${D.seconds(current?.duration||0)} / ${D.seconds(D.duration(variant))}</time></div><div class="stage-note">${engine?'원본·구간 확인과 실제 합성 미리보기는 구분됩니다. 글씨·효과는 렌더링으로 확인하세요.':'자료 추가 → 장면 편집 → 영상 저장. 결과는 MP4 또는 WebM으로 저장됩니다.'}</div>${previewUrl?'<button class="small ghost" data-action="original">↶ 원본 · 구간 편집으로 돌아가기</button>':''}</section><aside class="inspector" data-scene-id="${esc(selected)}">${current?inspector(current,m):'<h2>장면 속성</h2><p class="muted">편집할 장면을 선택하세요.</p>'}</aside></div>${timeline(variant)}</main>`;progress();fitScreen();updateOverlay();const player=$('#player');if(player&&!previewUrl){player.addEventListener('loadedmetadata',()=>{player.currentTime=Math.min(current.start||0,player.duration||0)});player.addEventListener('timeupdate',()=>{if(player.currentTime>(current.start||0)+(current.source_duration||0)&&!player.paused)player.pause()})}}
function timeline(variant){
 return `<section class="timeline" aria-label="장면 편집">
  <div class="timeline-head">
   <strong>이야기 타임라인 <span class="muted tiny">${variant.scenes.length}개 장면 · ${D.seconds(D.duration(variant))}</span></strong>
   <div class="toolbar timeline-actions">
    <button class="small danger" data-action="delete" ${scene()?'':'disabled'}>선택 장면 삭제</button>
    <button class="ghost small" data-action="undo" title="되돌리기 (Ctrl/⌘ Z)" ${history.length?'':'disabled'}>↶ 되돌리기</button>
    <button class="ghost small" data-action="redo" title="다시 실행 (Ctrl/⌘ Shift Z)" ${redo.length?'':'disabled'}>↷ 다시 실행</button>
    <button class="small" data-action="posting">SNS 문구</button>
   </div>
  </div>
  <p class="timeline-help">장면을 끌어 순서 변경 · ×로 삭제 · 되돌리기로 복원<span class="desktop-only"> · 선택 후 <kbd>Delete</kbd> / <kbd>Backspace</kbd></span></p>
  <div class="track" id="track" tabindex="0" role="region" aria-label="영상 타임라인" data-variant-id="${esc(variant.id)}">
   ${variant.scenes.map((s,i)=>`<div draggable="true" class="clip ${s.id===selected?'selected':''}" data-id="${esc(s.id)}" style="width:${Math.max(128,Math.min(240,s.duration*16))}px">
    <button class="clip-select" data-action="select" data-id="${esc(s.id)}" aria-pressed="${s.id===selected}" aria-label="${i+1}번 ${esc(s.name||'이름 없는 장면')} 편집">
     <img src="${esc(url(mfor(s),true))}" alt="" draggable="false">
     <span class="clip-top">${esc(s.name||'이름 없는 장면')}</span>
     <span class="clip-bottom">${String(i+1).padStart(2,'0')} &nbsp; ${D.seconds(s.duration)}</span>
     <span class="clip-tag">${s.playback_speed!==1?s.playback_speed+'×':s.transition==='cut'?'CUT':'↔'}</span>
    </button>
    <button class="clip-delete" data-action="delete-scene" data-id="${esc(s.id)}" aria-label="${i+1}번 ${esc(s.name||'이름 없는 장면')} 삭제" title="장면 삭제 · 원본은 보존">×</button>
   </div>`).join('')||'<div class="blank-clip">아직 장면이 없어요.<br>자료를 추가해 시작하세요.</div>'}
   <button class="clip-add" data-action="connect">＋<br>자료 추가</button>
  </div>
 </section>`;
}
function inspector(s,m){const n=(key,label,min,max,step=1)=>`<label>${label}<div class="row"><input type="range" min="${min}" max="${max}" step="${step}" value="${s[key]}" data-bind="${key}" aria-label="${label}"><input class="narrow" type="number" min="${min}" max="${max}" step="${step}" value="${s[key]}" data-bind="${key}" aria-label="${label} 숫자"></div></label>`;return `<div class="section-head"><h2>장면을 다듬어요</h2><span class="pill">${m?.kind==='video'?'영상':'사진'}</span></div><div class="inspector-basic"><label for="scene-name">장면명 <span class="muted">· 편집용 이름</span></label><input id="scene-name" data-bind="name" maxlength="100" value="${esc(s.name)}"><label for="scene-title">타이틀 <span class="muted">· 영상에 크게</span></label><input id="scene-title" data-bind="title" maxlength="100" value="${esc(s.title)}" placeholder="이 장면의 한 줄 제목"><label for="scene-caption">영상 문구</label><textarea id="scene-caption" data-bind="caption" maxlength="240" placeholder="기억하고 싶은 한마디">${esc(s.caption)}</textarea><div class="locknote">${s.field_locks?.length?'● 직접 고친 문구는 자동 구성에서도 유지돼요.':'빈칸은 화면에 표시되지 않아요.'}</div>${m?.kind==='video'?'':`<label>사진 재생 시간(초)<input type="number" data-bind="duration" min=".1" max="600" step=".1" value="${s.duration}"></label>`}</div><details class="text-options" data-panel="text"><summary>글씨 꾸미기</summary>${n('title_size','타이틀 크기',12,200)}${n('font_size','문구 크기',12,200)}<div class="row"><div><label>글씨 스타일</label><select data-bind="style">${Object.entries(catalog.styles).map(([k,t])=>`<option value="${k}" ${s.style===k?'selected':''}>${esc(t)}</option>`).join('')}</select></div><div><label>위치</label><select data-bind="text_position">${['top','middle','bottom'].map((k,i)=>`<option value="${k}" ${s.text_position===k?'selected':''}>${['위','가운데','아래'][i]}</option>`).join('')}</select></div></div></details><details data-panel="timing" ${m?.kind==='video'?'open':''}><summary>${m?.kind==='video'?'구간 · 재생속도':'사진 움직임'}</summary>${m?.kind==='video'?`<label>시작점 <span id="start-label">${s.start.toFixed(3)}초</span><input type="range" min="0" max="${m.analysis.duration}" step=".001" value="${s.start}" data-timing="start"></label><label>끝점 <span id="end-label">${(s.start+s.source_duration).toFixed(3)}초</span><input type="range" min="0" max="${m.analysis.duration}" step=".001" value="${s.start+s.source_duration}" data-timing="end"></label><div class="row"><div><label>시작(초)</label><input type="number" step=".001" min="0" data-timing="start" value="${s.start.toFixed(3)}"></div><div><label>끝(초)</label><input type="number" step=".001" min="0" data-timing="end" value="${(s.start+s.source_duration).toFixed(3)}"></div></div><label>재생속도(배)<input type="number" min=".1" max="3600" step=".1" data-timing="speed" value="${s.playback_speed}"></label><div class="tags">${[1,2,4,8,16,60,120].map(n=>`<button class="small" data-action="speed" data-value="${n}">${n}×</button>`).join('')}</div><button class="small" style="width:100%;margin-top:9px" data-action="timelapse">전체 원본 ${D.seconds(m.analysis.duration)} → 30초</button><label>완성 길이(초)<input type="number" min=".034" step=".1" data-timing="output" value="${s.duration.toFixed(3)}"></label><button class="small ghost" data-action="split">현재 원본 재생 위치에서 분할</button><p class="micro">고배속은 실제 미리보기를 만들어 확인합니다. 전체 압축은 하이라이트 선택과 다릅니다.</p>`:`<label>사진 움직임<select data-bind="motion"><option value="zoom" ${s.motion==='zoom'?'selected':''}>부드럽게 확대</option><option value="none" ${s.motion==='none'?'selected':''}>움직임 없음</option></select></label>`}</details><details data-panel="transition"><summary>다음 장면으로 전환</summary><label>효과<select data-bind="transition">${Object.entries(catalog.transitions).map(([k,t])=>`<option value="${k}" ${s.transition===k?'selected':''}>${esc(t)}</option>`).join('')}</select></label>${n('transition_duration','전환 길이(초)',0,3,.05)}<p class="micro">두 장면이 겹친 만큼 전체 재생 시간이 짧아져요.</p></details><details data-panel="audio"><summary>원음 · 배경음악</summary><label class="check"><input type="checkbox" data-bind="keep_audio" ${s.keep_audio?'checked':''}>이 장면 원음 사용</label><label class="check"><input type="checkbox" id="mute-all" ${v().audio?.mute_original?'checked':''}>전체 원음 끄기</label><label>전체 배경음악<select id="music"><option value="">음악 없음</option>${media.filter(m=>m.kind==='audio').map(m=>`<option value="${m.id}" ${v().audio?.music_id===m.id?'selected':''}>${esc(m.relative_path)}</option>`).join('')}</select></label><label>음악 음량<input type="range" id="music-volume" min="0" max="1" step=".01" value="${v().audio?.music_volume??.22}"></label><p class="micro">원본 폴더의 음원을 읽습니다. 직접 보유한 음악의 SNS 사용권을 확인해주세요. 음악은 배속과 별개로 재생됩니다.</p></details><div class="row" style="margin-top:20px"><button class="small" data-action="duplicate">장면 복제</button></div><div class="row" style="margin-top:8px"><button class="small" data-action="moveleft">← 앞으로</button><button class="small" data-action="moveright">뒤로 →</button></div>`}
const headerResizeObserver=new ResizeObserver(entries=>{
 for(const {target} of entries)target.closest('.studio')?.style.setProperty('--studio-header-height',target.getBoundingClientRect().height+'px');
});
function observeHeader(){
 headerResizeObserver.disconnect();
 const header=$('.studio .topbar');
 if(header){header.closest('.studio').style.setProperty('--studio-header-height',header.getBoundingClientRect().height+'px');headerResizeObserver.observe(header)}
}
function fitScreen(){const s=$('#screen'),a=$('.preview-area');if(!s||!a)return;const r=v().settings.width/v().settings.height;let h=Math.min(a.clientHeight,a.clientWidth/r);s.style.height=h+'px';s.style.width=h*r+'px'}
function progress(){const e=$('#progress');if(!e)return;const running=job.status==='running',done=job.status==='done',error=job.status==='error';const phase={encoding:'장면 굽는 중',transitions:'이야기 연결 중',verifying:'완성 파일 확인',analysis:'표본 살펴보는 중',story:'이야기 엮는 중',render:'오븐 준비 중',complete:'노른노른하게 완성',concept:'편집안 준비'}[job.phase]||'준비됐어요';e.innerHTML=`<section class="progress-rail ${error?'error':''}" role="status" aria-live="polite"><span class="label">${job.status==='cancelled'?'중지됨 · 원본 보존':error?'생성 오류':running?'◌ '+phase:done?'✓ '+phase:'✦ '+phase}</span><span class="detail">${job.batch?`버전 ${job.batch.current}/${job.batch.total} · ${esc(job.batch.name||'')} · `:''}${esc(job.detail||'자료를 추가하고, 장면을 다듬은 다음 영상을 저장하세요.')}${running&&job.total?` · ${Math.min(job.total,job.current+1)}/${job.total}`:''}${running&&job.elapsed?` · ${D.seconds(job.elapsed)} 경과`:''}</span>${running?`<span class="tiny">${job.stagePercent!=null?'현재 단계 '+job.stagePercent+'%':''}</span><progress max="100" ${job.stagePercent!=null?'value="'+job.stagePercent+'"':''} aria-label="현재 단계 진행률"></progress><button class="small" data-action="cancel">취소</button>`:done&&job.result?'<button class="small" data-action="result">완성 영상 보기 ↗</button>':''}<button class="small ghost" data-action="log">로그</button></section>`}
function render(){
 const track=$('#track'),trackScroll=track?.scrollLeft||0,trackVariant=track?.dataset.variantId;
 const inspector=$('.inspector'),sameScene=inspector?.dataset.sceneId===selected;
 const panels=sameScene?[...inspector.querySelectorAll('details[data-panel]')].map(el=>[el.dataset.panel,el.open]):[];
 const inspectorScroll=sameScene?inspector.scrollTop:0;
 page==='home'?home():studio();plus?.mount();browserStudio?.mount();observeHeader();
 const renderedTrack=$('#track');
 if(renderedTrack&&renderedTrack.dataset.variantId===trackVariant)renderedTrack.scrollLeft=trackScroll;
 for(const [name,open] of panels){const panel=$('.inspector details[data-panel="'+name+'"]');if(panel)panel.open=open}
 if(sameScene&&$('.inspector'))$('.inspector').scrollTop=inspectorScroll;
}
async function api(path,data){if(!engine)throw Error('먼저 로컬 엔진을 연결하세요.');const c=new AbortController(),t=setTimeout(()=>c.abort(),30000);try{const r=await fetch(engine.url+path,{method:data?'POST':'GET',headers:{'X-Norn-Token':engine.token,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined,signal:c.signal});const d=await r.json();if(!r.ok)throw Error(d.error||'요청에 실패했습니다.');return d}catch(e){if(e.name==='AbortError')throw Error('연결 응답이 늦습니다. 엔진 터미널과 브라우저 로컬 네트워크 권한을 확인하세요.');throw e}finally{clearTimeout(t)}}
function modal(title,body,wide=false){$('#toast [data-action=undo]')?.remove();$('#modal-root').innerHTML=`<div class="modal-backdrop"><section class="modal ${wide?'wide':''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><h2>${esc(title)}</h2><button class="ghost small" data-action="close" aria-label="닫기">✕</button></div>${body}<div id="modal-error"></div></section></div>`;requestAnimationFrame(()=>$('.modal input,.modal button')?.focus())}
function close(){const el=$('#modal-root');el.innerHTML=''}
function modalError(e){const t=$('#modal-error');if(t)t.innerHTML='<div class="error-box" style="margin-top:15px">'+esc(e.message||e)+'</div>';else toast(e.message||String(e))}
function account(){modal(user?'내 이야기 보관함':'이야기를 시작하세요',user?`<p>${esc(user.displayName||'사용자')}님, 반가워요.<br>원본은 올리지 않고 제목·문구·편집 설정을 계정에 저장합니다.</p><div class="cards"><button class="option-card" data-action="workspace">프로젝트 워크스페이스</button>${page==='studio'?'<button class="option-card" data-action="cloudsave">현재 편집을 Firebase에 저장</button>':''}</div><label>기본 분석 장수<input id="default-frames" type="number" min="1" max="20" value="${defaultFrames}"></label><div class="actions"><button data-action="prefs">기본 설정 저장</button><button data-action="logout">로그아웃</button></div>`:`<p>흩어진 순간을 나만의 이야기로.<br>계정에는 편집 정보만 저장하고 원본은 내 컴퓨터에 둡니다.</p><button class="google" data-action="login"><b>G</b> Google로 계속하기</button><div class="divider">먼저 둘러보고 싶다면</div><button style="width:100%" data-action="guest">로그인 없이 작업하기</button><p class="tiny">로그인 없이 파일 선택·편집·영상 저장을 할 수 있습니다. 계정 저장을 사용할 때만 로그인하세요.</p>`)}
function connectModal(){modal('내 컴퓨터와 연결',`<p>원본 폴더는 웹에 업로드하지 않습니다. 터미널에서 로컬 엔진을 실행한 뒤, 표시된 주소와 연결 코드를 입력하세요.</p><pre>python3 engine/main.py "/원본폴더" --web-origin ${esc(location.origin)}</pre><label for="engine-url">로컬 엔진 주소</label><input id="engine-url" value="${esc(engine?.url||'http://127.0.0.1:8765')}" spellcheck="false"><label for="engine-token">연결 코드 <span class="muted">· 외부 공유 금지</span></label><input id="engine-token" type="password" autocomplete="off" value="${esc(engine?.token||'')}" placeholder="엔진 터미널에 표시된 코드"><p class="tiny">브라우저가 로컬 네트워크 접근을 물으면 허용해야 연결됩니다. 허용한 폴더만 읽으며 임의 경로는 접근하지 않습니다.</p><div class="actions">${engine?'<button data-action="disconnect">연결 해제</button>':''}<button class="primary" data-action="connect-submit">폴더 연결</button></div>`)}
async function connectTo(url,token,replace=true){const u=new URL(url);if(!['127.0.0.1','localhost'].includes(u.hostname)||u.protocol!=='http:'||u.username||u.password||!['','/'].includes(u.pathname)||u.search||u.hash)throw Error('http://127.0.0.1:포트 형태의 내 컴퓨터 주소만 사용할 수 있습니다.');if(token.length<20)throw Error('연결 코드를 확인하세요.');const before=engine;engine={url:u.origin,token};let state;try{state=await api('/api/state')}catch(e){engine=before;throw e}browserStudio?.reset();sessionStorage.setItem('norn.engine',JSON.stringify(engine));media=state.media;catalog={styles:state.styles,transitions:state.transitions};job=state.job;engineRevision=state.project.revision;history=[];redo=[];if(replace){project=state.project;cloudRevision=0;selected=v().scenes[0]?.id||''}unsaved=false;page='studio';location.hash='studio';close();render();if(state.warnings?.length)toast(state.warnings.join(' / '))}
function conceptModal(){modal('이야기에 한 스푼의 의도',`<span class="eyebrow">THE WELL · 자료와 콘셉트</span><label>콘셉트 제목</label><input id="concept-title" value="${esc(project.title)}" maxlength="160"><label>어떤 이야기를 만들까요?</label><textarea id="concept-note" rows="4" maxlength="6000" placeholder="무엇을 찍었는지, 무엇을 강조할지 알려주세요. 예: 낙지를 중심으로. 조리 장면은 없어요.">${esc(project.description)}</textarea><div class="row"><div><label>영상당 표본 프레임</label><input id="frames" type="number" min="1" max="20" value="${project.frames||5}"></div><div><label>목표 길이(초)</label><input id="target-duration" type="number" min="1" max="3600" value="${project.targetDuration||30}"></div></div><details style="margin-top:15px"><summary class="muted tiny">로컬 AI 설정</summary><label>설치된 Ollama 이미지 모델</label><input id="model" value="qwen3.5:4b" spellcheck="false"></details><p class="tiny">시간 구간을 나눠 랜덤 표본을 뽑습니다. 기본 5장은 핵심 장면을 보장하지 않으며 전체를 본 결과가 아닙니다. 분석은 버튼을 누를 때만 실행합니다.</p>${!engine?'<div class="connection-banner">먼저 로컬 엔진과 Ollama를 연결하세요. 체험에서는 콘셉트를 저장하고 직접 편집할 수 있습니다.</div>':''}<div class="actions"><button data-action="concept-save">콘셉트만 저장</button><button class="primary" data-action="analyze" ${engine?'':'disabled'}>✦ 분석하고 편집안 만들기</button></div>`)}
function saveConcept(){const frames=Number($('#frames').value),target=Number($('#target-duration').value);if(!Number.isInteger(frames)||frames<1||frames>20||!Number.isFinite(target)||target<1||target>3600)throw Error('분석 장수 1~20, 목표 길이 1~3600을 확인하세요.');pushHistory();project.title=$('#concept-title').value;project.description=$('#concept-note').value;project.frames=frames;project.targetDuration=target;persist()}
function showProposal(){if(!proposal)return toast('아직 분석된 편집안이 없습니다.');modal('이야기 초안을 확인하세요',`<p>${esc(proposal.summary)}</p><span class="pill">표본 ${proposal.sample_count}장 · 캐시 ${proposal.cache_hits}건</span>${proposal.scenes.map(r=>`<div class="proposal"><strong>${esc(r.name)}</strong><p>${esc(r.title)}<br>${esc(r.caption)}</p><small class="muted">${esc(r.reason)}</small></div>`).join('')}<details style="margin-top:16px"><summary>분석에 사용한 표본 보기</summary>${proposal.observations.map(o=>`<p class="tiny">${esc(media.find(m=>m.id===o.source_id)?.relative_path)}</p><div class="samples">${o.samples.map(s=>`<img src="${esc(tokenURL('/sample/'+s.file))}" alt="${s.time}초 표본" title="${s.time}초">`).join('')}</div><p class="tiny">${esc(o.observed)}<br>불확실: ${esc(o.uncertain)}</p>`).join('')}</details><label class="check"><input type="checkbox" id="reorder">추천 순서도 적용</label><p class="tiny">직접 수정하거나 지운 글씨는 그대로 보호합니다. 이 버튼은 현재 타임라인의 장면에만 적용합니다.</p><div class="actions"><button data-action="close">나중에</button><button class="primary" data-action="apply-proposal">편집기에 적용</button></div>`,true)}
async function requestRender(preview=false){if(!engine)return browserStudio?.requestRender(preview);if(pending||job.status==='running')return toast('현재 작업 완료 후 다시 시작하세요.');pending=true;try{const d=await api('/api/render',{project,preview,sceneId:preview?selected:null});project.revision=d.project.revision;engineRevision=d.project.revision;unsaved=false;job=d.job;close();render()}finally{pending=false}}
async function poll(){if(!engine)return;try{const state=await api('/api/state');job=state.job;progress();if(job.status==='done'&&job.id!==lastDone){lastDone=job.id;if(job.proposal){proposal=job.proposal;plus?plus.onProposal(proposal):showProposal()}else if(job.result){if(job.preview&&(!plus||plus.canUsePreview(job))){previewUrl=tokenURL('/output/'+job.result.path.replace('generated/',''))+'&v='+job.id;render();$('#player')?.play().catch(()=>{})}else toast('영상이 완성됐어요. 상단에서 바로 확인하세요.')}}}catch(e){const el=$('#connection-label');if(el){el.textContent='엔진 응답 확인 필요';el.classList.remove('on')}}}
function newVariant(){modal('이야기의 다른 버전',`<p>원본과 분석은 공유하되 장면·글씨·구간은 별도로 편집합니다. 기존 버전을 자동으로 늘리거나 자르지 않습니다.</p><label>제작 모드<select id="new-mode"><option value="short">숏폼</option><option value="long">롱폼</option><option value="timelapse">타임랩스</option><option value="free">자유 편집</option></select></label><label>버전 이름<input id="new-name" placeholder="예: 시장 브이로그 · 가로형"></label><label>화면 비율<select id="new-ratio"><option value="1080,1920">세로 9:16</option><option value="1920,1080">가로 16:9</option><option value="1080,1080">정사각형 1:1</option><option value="1080,1350">세로 4:5</option></select></label><div class="actions"><button class="primary" data-action="create-variant">현재 편집을 복제해 만들기</button></div>`)}
function posting(){const channels=['인스타그램','틱톡','X','스레드','페이스북','네이버 블로그','네이버 클립'];modal('세상에 내놓기 전, 마지막 한 번',`<span class="eyebrow">THE LOOM · 게시 준비</span><p>${esc(v().name)} · ${D.seconds(D.duration(v()))}<br>직접 입력한 콘셉트 기반 게시문입니다. 사실·글자 수·첨부 제한을 확인한 뒤 직접 발행하세요.</p><div class="tags">${channels.map((c,i)=>`<button class="small ${i===0?'active':''}" data-action="channel" data-value="${i}">${c}</button>`).join('')}</div><label>복사할 게시문</label><textarea id="post-text" rows="7">${esc(postText(0))}</textarea><p class="tiny">영상은 공통 생성본을 사용합니다. 블로그·클립용 사진은 기존 원본 폴더에서 첨부하세요. 원본 파일은 복사하지 않습니다.</p><div class="actions"><button data-action="copy-post">본문 복사</button><button data-action="save-post">TXT 저장</button><button class="primary" data-action="result">생성한 영상 보기</button></div>`)}
function postText(i){const captions=v().scenes.map(s=>s.caption).filter(Boolean),title=project.title,note=project.description;return i===2?title+'\n'+(captions[0]||''):i===5?title+'\n\n'+note+'\n\n'+captions.join('\n\n'):title+'\n\n'+note+'\n\n'+captions.join('\n')}
function download(name,data,type='application/json'){const u=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
function result(){if(!engine)return toast('로컬 엔진 연결 후 먼저 영상을 생성하세요.');const lastPath=job.result?.path?.replace('generated/','');const path=lastPath?.startsWith(v().id+'/')?lastPath:v().id+'/video.mp4';modal('노른노른하게 완성됐어요',`<video src="${esc(tokenURL('/output/'+path))}" controls playsinline></video><p class="tiny">현재 파일이 없다면 영상 생성을 먼저 실행해주세요. 미리보기와 최종 영상은 별도 파일입니다.</p><div class="actions"><a class="pill" href="${esc(tokenURL('/output/'+path))}" target="_blank" rel="noopener">영상 열기 / 저장 ↗</a><button data-action="posting">SNS 게시 준비</button></div>`,true)}
async function updateOverlay(){clearTimeout(overlayTimer);if(previewUrl||!scene()||page!=='studio')return;const s=scene(),o=$('#text-overlay');if(o){o.className='text-overlay '+s.style;o.innerHTML='<strong>'+esc(s.title)+'</strong><span>'+esc(s.caption)+'</span>';o.style.bottom='auto';o.style.top={top:'12%',middle:'42%',bottom:'66%'}[s.text_position]||'66%';const ratio=($('#screen')?.clientWidth||200)/v().settings.width;o.querySelector('strong').style.fontSize=Math.max(6,s.title_size*ratio)+'px';o.querySelector('span').style.fontSize=Math.max(6,s.font_size*ratio)+'px';if(!s.title&&!s.caption)o.style.display='none';else o.style.display=''}if(!engine)return;const sid=s.id;overlayTimer=setTimeout(async()=>{try{const response=await api('/api/overlay',{scene:s,variant:v()});if(scene()?.id!==sid||previewUrl)return;const screen=$('#screen');if(!screen)return;$('#text-overlay')?.remove();screen.querySelector('.bitmap')?.remove();const img=document.createElement('img');img.className='bitmap';img.alt='실제 렌더링 글씨';img.src=response.image;Object.assign(img.style,{left:response.x/response.canvas_width*100+'%',top:response.y/response.canvas_height*100+'%',width:response.width/response.canvas_width*100+'%'});screen.append(img)}catch{}},220)}
async function addFiles(){return browserStudio?.selectFiles?.()}
const actions={home:()=>user?openWorkspace():(page='home',location.hash='',render()),enter,guest:()=>{close();enter()},close,account,connect:connectModal,
 'workspace-refresh':()=>refreshWorkspace(),
 'new-project':()=>{if(!user)return account();modal('새 프로젝트',`<span class="eyebrow">NEW PROJECT</span><p>하나의 영상 작업을 하나의 프로젝트로 관리합니다.</p><label>프로젝트 이름<input id="new-project-title" maxlength="160" placeholder="예: 2026 들깨 수확 영상" autofocus></label><div class="actions"><button data-action="close">취소</button><button class="primary" data-action="create-project">프로젝트 만들기</button></div>`)},
 'create-project':async()=>{if(!user)throw Error('로그인이 필요합니다.');const title=($('#new-project-title')?.value||'').trim();if(!title)throw Error('프로젝트 이름을 입력하세요.');clearTimeout(cloudSyncTimer);await waitCloudSync();browserStudio?.reset();project=emptyProject();project.title=title;media=[];selected='';history=[];redo=[];previewUrl='';engineRevision=0;cloudRevision=0;cloudEditVersion=0;unsaved=true;await saveCloudCurrent('manual');sessionStorage.setItem('norn.cloud.project',project.id);close();page='studio';location.hash='studio';render();toast('프로젝트를 만들었습니다. 이제 사진·영상을 추가하세요.')},
 'project-open':async el=>loadCloudProject(el.dataset.id),
 'project-delete':async el=>{if(!confirm('이 프로젝트의 Firebase 편집 정보를 삭제할까요? 로컬 원본 파일은 삭제하지 않습니다.'))return;await Cloud.deleteCloud(el.dataset.id,Number(el.dataset.revision));if(sessionStorage.getItem('norn.cloud.project')===el.dataset.id)sessionStorage.removeItem('norn.cloud.project');await refreshWorkspace();toast('프로젝트를 삭제했습니다.')},
 'project-history':async el=>{const rows=await Cloud.listHistory(el.dataset.id),labels={autosave:'자동 저장',manual:'직접 저장',restore:'복원','quick-maker':'자동 제작',render:'영상 생성'};const body=rows.length?'<div class="project-history">'+rows.map(row=>'<div class="history-row"><span><strong>r'+row.revision+'</strong> · '+(labels[row.event]||'저장')+'</span><small>'+cloudTime(row.createdAt)+'</small></div>').join('')+'</div>':'<p>저장된 세부 이력이 없습니다.</p>';modal((el.dataset.title||'프로젝트')+' · 작업 이력',body)},
 login:async()=>{const btn=$('[data-action="login"]');if(btn)btn.disabled=true;const wasStudio=page==='studio',hadWork=hasCurrentWork();try{const signedIn=await Cloud.login();user=signedIn;cloudRevision=0;close();if(wasStudio&&hadWork){cloudEditVersion++;unsaved=true;let copied=false,saveError=null;try{await saveCloudCurrent('manual')}catch(e){if(/충돌/.test(String(e?.message||e))){project.id=D.uid();cloudRevision=0;cloudEditVersion++;unsaved=true;try{await saveCloudCurrent('manual');copied=true}catch(inner){saveError=inner}}else saveError=e}sessionStorage.setItem('norn.cloud.project',project.id);render();if(saveError)toast('Google 로그인은 완료됐지만 프로젝트 저장은 실패했습니다: '+(saveError.message||saveError));else toast(copied?'로그인 완료 · 현재 작업을 새 프로젝트로 저장했습니다.':'Google 로그인 완료 · 현재 작업을 프로젝트로 저장했습니다.')}else{page='home';location.hash='';await refreshWorkspace(false);render();toast('Google 로그인 완료 · 워크스페이스를 열었습니다.')}}finally{if(btn)btn.disabled=false}},
 logout:async()=>{clearTimeout(cloudSyncTimer);await waitCloudSync();if(user&&unsaved)await saveCloudCurrent('autosave');await waitCloudSync();await Cloud.logout();user=null;cloudRevision=0;cloudEditVersion=0;cloudSaveQueue=Promise.resolve();engine=null;sessionStorage.removeItem('norn.engine');sessionStorage.removeItem('norn.cloud.project');browserStudio?.reset();project=emptyProject();media=[];selected='';close();render();toast('로그아웃했습니다. 내 파일을 선택해 계속 작업할 수 있습니다.')},
 'connect-submit':async()=>{if(unsaved&&!confirm('현재 미저장 편집 대신 연결한 폴더의 편집을 열까요? 필요하면 먼저 JSON으로 백업하세요.'))return;await connectTo($('#engine-url').value.trim(),$('#engine-token').value.trim())},
 disconnect:()=>{engine=null;sessionStorage.removeItem('norn.engine');close();render();toast('엔진 연결을 해제했습니다. 작업 프로세스는 터미널에서 종료하세요.')},
 select:el=>selectScene(el.dataset.id),previous:()=>selectOffset(-1),next:()=>selectOffset(1),
 view:el=>{const m=media.find(m=>m.id===el.dataset.id);if(!m)return;modal(m.relative_path,m.kind==='video'?`<video src="${esc(url(m))}" controls autoplay playsinline></video>`:`<img class="lightbox" src="${esc(url(m,true))}" alt="${esc(m.relative_path)}">`,true)},
 add:el=>edit(()=>{if(v().scenes.length>=120)throw Error('한 버전에는 최대 120개 장면을 추가할 수 있습니다.');const m=media.find(m=>m.id===el.dataset.id),r=D.scene(m,v().settings.fps),i=v().scenes.findIndex(s=>s.id===selected);v().scenes.splice(i+1,0,r);selected=r.id}),
 delete:()=>deleteScene(), 'delete-scene':el=>deleteScene(el.dataset.id),
 duplicate:()=>edit(()=>{if(v().scenes.length>=120)throw Error('한 버전에는 최대 120개 장면을 추가할 수 있습니다.');const s={...D.clone(scene()),id:D.uid()};const i=v().scenes.findIndex(s=>s.id===selected);v().scenes.splice(i+1,0,s);selected=s.id}),
 moveleft:()=>move(-1),moveright:()=>move(1),undo:()=>restoreEdit(history,redo),redo:()=>restoreEdit(redo,history),
 speed:el=>changeTiming('speed',Number(el.dataset.value)),timelapse:()=>{const s=scene(),m=mfor(s);edit(()=>Object.assign(s,D.timing(s,0,m.analysis.duration,m.analysis.duration/30,v().settings.fps)))},
 split:()=>{if(v().scenes.length>=120)return toast('한 버전에는 최대 120개 장면을 추가할 수 있습니다.');const s=scene(),player=$('#player');if(!player||previewUrl)return toast('원본 재생 위치에서 분할하세요.');const t=player.currentTime,end=s.start+s.source_duration;if(t<=s.start+.05||t>=end-.05)return toast('장면 내부의 재생 위치를 선택하세요.');edit(()=>{const b=D.timing({...D.clone(s),id:D.uid()},t,end,s.playback_speed,v().settings.fps);Object.assign(s,D.timing(s,s.start,t,s.playback_speed,v().settings.fps));v().scenes.splice(v().scenes.indexOf(s)+1,0,b)})},
 original:()=>{previewUrl='';render()},preview:()=>requestRender(true),render:()=>requestRender(false),cancel:async()=>{await api('/api/cancel',{});toast('취소를 요청했습니다. 현재 작업 정리를 기다려주세요.')},
 log:async()=>{if(!engine)return toast('연결된 엔진이 없습니다.');const d=await api('/api/log');modal('생성 로그 · 오류',`<p class="tiny">경로·파일명이 포함될 수 있습니다. 외부 공유 전 개인정보를 확인하세요.</p><pre id="log-text">${esc(d.text||job.detail||'아직 기록이 없습니다.')}</pre><div class="actions"><button data-action="copy-log">로그 복사</button></div>`,true)},
 'copy-log':()=>copy($('#log-text').textContent),save:async()=>{let localSaved=false;if(engine){const r=await api('/api/save',{project});project.revision=r.project.revision;engineRevision=r.project.revision;localSaved=true}if(user){clearTimeout(cloudSyncTimer);await saveCloudCurrent('manual');render();toast(localSaved?'로컬 편집과 Firebase 프로젝트를 저장했습니다.':'Firebase 프로젝트를 저장했습니다.')}else if(localSaved){unsaved=false;render();toast('원본 옆 업로드준비 폴더에 저장했습니다.')}else{download('norn-project.json',JSON.stringify(W.cloudData(project),null,2));toast('편집 JSON을 저장했습니다. 원본은 포함하지 않습니다.')}},
 concept:conceptModal,'concept-save':()=>{saveConcept();close();render()},analyze:async()=>{saveConcept();const model=$('#model').value;if(!engine)throw Error('로컬 엔진을 연결하세요.');const r=await api('/api/concept',{project,model});project.revision=r.project.revision;engineRevision=r.project.revision;job=r.job;close();render()},
 'apply-proposal':()=>{const order=$('#reorder').checked;pushHistory();project=D.applyProposal(project,proposal,order);persist();close();render();toast('직접 수정한 문구는 보호하고 초안을 반영했습니다.')},
 newvariant:newVariant,'create-variant':()=>{if(project.variants.length>=12)throw Error('버전은 최대 12개입니다.');const mode=$('#new-mode').selectedOptions[0].textContent,name=$('#new-name').value||mode+' · 새 버전',dims=$('#new-ratio').value.split(',').map(Number);edit(()=>{const item=D.variantCopy(v(),name);item.settings.width=dims[0];item.settings.height=dims[1];project.variants.push(item);project.activeVariant=item.id;selected=item.scenes[0]?.id||''});close()},
 posting,result,channel:el=>{$('.tags button.active')?.classList.remove('active');el.classList.add('active');$('#post-text').value=postText(Number(el.dataset.value))},'copy-post':()=>copy($('#post-text').value),'save-post':()=>download('norn-post.txt',$('#post-text').value,'text/plain'),
 addfiles:addFiles,rescan:async()=>{if(!engine)return addFiles();const r=await api('/api/rescan',{});media=r.media;render();toast('원본 목록을 다시 읽었습니다. 기존 편집 순서는 유지합니다.')},
 import:()=>{const input=document.createElement('input');input.type='file';input.accept='.json';input.onchange=async()=>{try{const p=W.validateProject(JSON.parse(await input.files[0].text()));if(p.schema_version!==2||!Array.isArray(p.variants)||!p.variants.length)throw Error('NORN 프로젝트 JSON을 선택하세요. 이전 v10 편집은 엔진으로 원본 폴더를 열어 가져올 수 있습니다.');if(!confirm('현재 편집을 가져온 JSON으로 바꿀까요? 원본 미디어는 별도로 다시 연결해야 합니다.'))return;pushHistory();p.revision=project.revision||0;project=p;selected=v().scenes[0]?.id||'';persist();render()}catch(e){toast(e.message)}};input.click()},
 cloudsave:async()=>{if(!confirm('제목·설명·장면 문구·편집 설정을 Google 계정에 저장할까요? 원본 파일은 업로드하지 않습니다.'))return;clearTimeout(cloudSyncTimer);await saveCloudCurrent('manual');toast('계정에 편집 정보를 저장했습니다.');close()},
 cloudlist:async()=>{cloudRows=await Cloud.listCloud();modal('계정에 저장한 이야기',cloudRows.length?cloudRows.map(p=>`<button class="project-card" data-action="cloudload" data-id="${esc(p.id)}"><span>${esc(p.title)}</span><span class="muted tiny">열기 ↗</span></button>`).join(''):'<p>저장한 프로젝트가 없습니다.</p>')},
 cloudload:async el=>{if(unsaved&&!confirm('현재 미저장 내용을 바꾸고 클라우드 편집을 열까요?'))return;const p=await Cloud.loadCloud(el.dataset.id);cloudRevision=p.revision;p.revision=project.revision||0;project=p;selected=v().scenes[0]?.id||'';close();page='studio';render();toast('편집 정보를 불러왔습니다. 같은 원본 폴더가 필요합니다.')},
 prefs:async()=>{const frames=Number($('#default-frames').value);if(!Number.isInteger(frames)||frames<1||frames>20)throw Error('1~20장을 입력하세요.');await Cloud.savePreferences({frames});defaultFrames=frames;toast('기본 분석 장수를 계정에 저장했습니다.')}
};
function selectOffset(dir){const idx=v().scenes.findIndex(s=>s.id===selected);const target=v().scenes[idx+dir];if(target)selectScene(target.id)}
function move(dir){const idx=v().scenes.findIndex(s=>s.id===selected),to=idx+dir;if(to<0||to>=v().scenes.length)return;edit(()=>{const [s]=v().scenes.splice(idx,1);v().scenes.splice(to,0,s)})}
function changeTiming(key,val){const s=scene(),m=mfor(s);if(m?.kind!=='video')return;const begin=key==='start'?val:s.start,end=key==='end'?val:s.start+s.source_duration,sp=key==='speed'?val:key==='output'?(end-begin)/val:s.playback_speed;if(end>m.analysis.duration+.001)throw Error('끝점이 원본 길이를 넘습니다.');const r=D.timing(s,begin,end,sp,v().settings.fps);edit(()=>{Object.assign(s,r);s.field_locks=[...new Set([...(s.field_locks||[]),'timing'])]});if(key==='start'&&$('#player'))$('#player').currentTime=begin}
async function copy(text){try{await navigator.clipboard.writeText(text);toast('복사했습니다.')}catch{toast('자동 복사가 차단됐습니다. 본문을 선택해 Command+C / Ctrl+C로 복사하세요.');$('#post-text')?.select()}}
document.addEventListener('click',async e=>{const el=e.target.closest('[data-action]');if(!el)return;e.preventDefault();try{await actions[el.dataset.action]?.(el)}catch(err){modalError(err)}});
document.addEventListener('focusin',()=>{inputHistoryTarget=null});
document.addEventListener('input',e=>{if(browserStudio?.busy())return;const el=e.target,key=el.dataset.bind,s=scene();if(!key||!s)return;let val=el.type==='checkbox'?el.checked:['number','range'].includes(el.type)?Number(el.value):el.value;if(typeof val==='number'&&!Number.isFinite(val)||s[key]===val)return;if(inputHistoryTarget!==el){pushHistory();inputHistoryTarget=el}s[key]=val;if(['name','title','caption'].includes(key))s.field_locks=[...new Set([...(s.field_locks||[]),key])];previewUrl='';persist();document.querySelectorAll(`[data-bind="${key}"]`).forEach(other=>{if(other!==el)other.value=el.value});updateOverlay()});
document.addEventListener('change',e=>{if(browserStudio?.busy())return;try{const el=e.target;if(el.dataset.timing)changeTiming(el.dataset.timing,Number(el.value));else if(el.id==='variant'){project.activeVariant=el.value;selected=v().scenes[0]?.id||'';previewUrl='';render()}else if(el.id==='mute-all')edit(()=>v().audio.mute_original=el.checked);else if(el.id==='music')edit(()=>v().audio.music_id=el.value);else if(el.id==='music-volume')edit(()=>v().audio.music_volume=Number(el.value));else if(el.dataset.bind){persist();render()}}catch(err){toast(err.message)}});
document.addEventListener('dragstart',e=>{
 const el=e.target.closest('.clip');if(!el)return;
 if(editingBusy()||e.target.closest('.clip-delete')){e.preventDefault();return}
 e.dataTransfer.setData('text/plain',el.dataset.id);
});
document.addEventListener('dragover',e=>{if(!editingBusy()&&e.target.closest('.clip'))e.preventDefault()});
document.addEventListener('drop',e=>{
 const el=e.target.closest('.clip');if(!el||editingBusy())return;e.preventDefault();
 const from=v().scenes.findIndex(s=>s.id===e.dataTransfer.getData('text/plain')),to=v().scenes.findIndex(s=>s.id===el.dataset.id);
 if(from<0||to<0||from===to)return;
 edit(()=>{const [s]=v().scenes.splice(from,1);v().scenes.splice(to,0,s)});focusTimeline();
});
document.addEventListener('keydown',e=>{
 if(e.key==='Escape'){close();return}
 if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){
  e.preventDefault();Promise.resolve().then(()=>actions.save()).catch(modalError);
 }
 if(e.key==='Tab'&&$('.modal')){
  const nodes=[...$('.modal').querySelectorAll('button:not(:disabled),input,select,textarea,a[href]')].filter(n=>n.offsetParent!==null);
  if(!nodes.length)return;
  const a=nodes[0],b=nodes.at(-1);
  if(e.shiftKey&&document.activeElement===a){e.preventDefault();b.focus()}
  else if(!e.shiftKey&&document.activeElement===b){e.preventDefault();a.focus()}
 }
 if(e.isComposing||e.repeat||page!=='studio'||editingBusy()||$('.modal')||e.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;
 const key=e.key.toLowerCase();
 if((e.ctrlKey||e.metaKey)&&!e.altKey&&(key==='z'||key==='y'&&!e.metaKey)){
  e.preventDefault();(key==='y'||e.shiftKey?actions.redo:actions.undo)();return;
 }
 if(['Delete','Backspace'].includes(e.key)&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&e.target.closest('#track')){
  e.preventDefault();deleteScene();
 }
});
window.addEventListener('resize',()=>{fitScreen();updateOverlay()});window.addEventListener('beforeunload',e=>{if(unsaved||browserStudio?.busy()||browserStudio?.hasUnsavedOutputs()){e.preventDefault();e.returnValue=''}});
window.addEventListener('hashchange',()=>{if(location.hash==='#studio'){page='studio';render()}else if(!location.hash){page='home';render()}});
const context={D,Cloud,$,esc,modal,close,toast,api,tokenURL,render,persist,edit,download,
 actions,variant:v,scene,progress,emptyProject,samples,requestRender,changeTiming,connectModal,connectTo,url,showProposal,copy,modalError,openWorkspace,
 read:()=>({project,media,selected,engine,user,job,proposal,cloudRevision,engineRevision,unsaved,previewUrl,page}),
 assign:values=>{if('project'in values){project=values.project;if(Number.isFinite(project.revision))engineRevision=project.revision;}if('media'in values)media=values.media;if('selected'in values)selected=values.selected;if('job'in values)job=values.job;if('proposal'in values)proposal=values.proposal;if('cloudRevision'in values)cloudRevision=values.cloudRevision;if('unsaved'in values)unsaved=values.unsaved;if('previewUrl'in values)previewUrl=values.previewUrl;if('page'in values)page=values.page;if('engine'in values)engine=values.engine;if('catalog'in values)catalog=values.catalog;if(values.clearHistory){history=[];redo=[];}}
};
plus=installStudioPlus(context);
browserStudio=installBrowserStudio(context);
render();
(async()=>{const hash=location.hash;if(hash.startsWith('#connect=')){const [url,token]=decodeURIComponent(hash.slice(9)).split('|');historyReplace();try{await connectTo(url,token)}catch(e){toast(e.message);connectModal()}}else{if(hash==='#studio'){page='studio';restoreGuest();render()}/* A saved localhost token never triggers a connection on normal website entry. */}Cloud.observe(async next=>{const old=user?.uid;if(old&&old!==next?.uid){engine=null;sessionStorage.removeItem('norn.engine');sessionStorage.removeItem('norn.cloud.project');browserStudio?.reset();project=emptyProject();media=[];history=[];redo=[];selected='';cloudRevision=0;}user=next;if(next)Cloud.loadPreferences().then(p=>{if(p?.frames)defaultFrames=p.frames}).catch(()=>{});if(next&&page==='home'){refreshWorkspace(false).then(render).catch(()=>render());return}if(next&&page==='studio'&&cloudRevision===0){const id=sessionStorage.getItem('norn.cloud.project');if(id){try{await loadCloudProject(id,{notify:false});return}catch(e){sessionStorage.removeItem('norn.cloud.project');toast('이전 프로젝트를 다시 열지 못했습니다: '+(e.message||e))}}if(!hasCurrentWork()){page='home';location.hash='';await refreshWorkspace(false);render();return}}render()}).catch(()=>{});setInterval(poll,1200)})();
function historyReplace(){window.history.replaceState(null,'','#studio')}
