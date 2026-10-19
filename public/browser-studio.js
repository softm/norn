/** The default workflow: select originals, edit, render and save in this browser. */
import * as W from './workspace.js';
import {MEDIA_ACCEPT,readLocalFiles,readDroppedFiles,revokeMedia,safeFileName} from './local-media.js';
import {BROWSER_TRANSITIONS,getBrowserRenderSupport,validateBrowserRender,renderInBrowser} from './browser-renderer.js';
import {createZip,postingFiles} from './browser-package.js';

export function installBrowserStudio(C) {
  const {D,$,esc,modal,close,toast,render,persist,edit}=C;
  const previous={...C.actions},state=()=>C.read(),variant=()=>C.variant();
  const outputs=new Map();let controller=null,operation='',folderName='',lastImport=null,previewObjectURL='',exportChoice=null;
  const busy=()=>!!controller;
  const hasUnsavedOutputs=()=>[...outputs.values()].some(result=>!result.saved);
  const signature=v=>JSON.stringify([state().project.id,v]);
  const button=(action,label,cls='small')=>`<button class="${cls}" data-action="${action}">${label}</button>`;
  const support=()=>getBrowserRenderSupport();
  const localMode=()=>!state().engine;
  function clearOutputs(){for(const result of outputs.values())URL.revokeObjectURL(result.url);outputs.clear();if(previewObjectURL)URL.revokeObjectURL(previewObjectURL);previewObjectURL='';}
  function reset(){controller?.abort();clearOutputs();revokeMedia(state().media);folderName='';lastImport=null;}
  function detachEngine(){C.assign({engine:null,catalog:{styles:D.styles,transitions:BROWSER_TRANSITIONS}});sessionStorage.removeItem('norn.engine');}
  function openStudio(){C.assign({page:'studio'});if(location.hash!=='#studio')window.history.replaceState(null,'','#studio');}
  function setJob(values){C.assign({job:{...state().job,...values}});C.progress();}
  function release(){controller=null;operation='';}
  function assertIdle(){if(busy()||state().job.status==='running')throw Error('현재 작업을 완료하거나 취소한 다음 다시 시작하세요.');}
  function updateManifest(){const linked=W.relinkProject(state().project,state().media);state().project.assets=linked.project.assets;}
  function downloadBlob(name,blob){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=safeFileName(name);a.hidden=true;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  function snapshot(){updateManifest();return W.cloudData(state().project);}
  function resultForCurrent({required=true,current=false}={}){
    const result=outputs.get(variant().id);
    if(!result&&required)throw Error('이 버전의 영상을 먼저 구워주세요. 미리보기와 완성 영상은 따로 저장됩니다.');
    if(result&&current&&result.signature!==signature(variant()))throw Error('영상 생성 후 편집이 바뀌었습니다. 다시 구운 다음 게시 묶음을 저장하세요.');
    return result;
  }
  function selectFiles({folder=false,relink=false,audio=false}={}){
    assertIdle();
    const input=document.createElement('input');input.type='file';input.multiple=true;input.accept=audio?'audio/*':MEDIA_ACCEPT;
    input.id=folder?'norn-folder-input':'norn-file-input';input.hidden=true;
    if(folder){
      if(!('webkitdirectory'in input)){toast('이 브라우저에서는 폴더 대신 여러 파일을 선택하세요.');folder=false;}
      else{input.webkitdirectory=true;input.setAttribute('webkitdirectory','');input.removeAttribute('accept');}
    }
    input.oncancel=()=>input.remove();
    input.onchange=()=>{const files=Array.from(input.files||[]);input.remove();if(files.length)importLocal(files,{relink,audio}).catch(C.modalError);};
    document.body.append(input);input.click();
  }
  async function importLocal(files,{relink=false,audio=false}={}){
    assertIdle();if(!files.length)return;
    const prior=state(),wasSample=!audio&&!relink&&prior.media.some(m=>m.sample)&&prior.project.variants.some(v=>v.scenes.length)&&prior.project.variants.every(v=>v.scenes.every(s=>s.source_id.startsWith('sample'))),wasEngine=!!prior.engine;
    const existing=wasSample||wasEngine?[]:prior.media;
    const hadMissing=prior.project.variants.some(v=>v.scenes.some(s=>!existing.some(m=>m.id===s.source_id)));
    controller=new AbortController();operation='import';openStudio();close();
    C.assign({job:{status:'running',phase:'import',detail:'선택한 파일을 읽습니다.',stagePercent:0}});render();
    try{
      const imported=await readLocalFiles(files,{existing,signal:controller.signal,onProgress:p=>{
        setJob({phase:'import',detail:`${p.current}/${p.total} · ${p.name} · ${p.phase==='hash'?'파일 확인':p.phase==='metadata'?'미리보기 준비':'확인됨'}`,stagePercent:Math.min(99,Math.floor(((p.current-1)+(p.phase==='complete'?1:p.filePercent/100*.8))/p.total*100))});
      }});
      lastImport=imported;
      if(!imported.assets.length){
        setJob({status:'idle',phase:'import',detail:imported.duplicates?'이미 선택한 자료입니다.':'읽을 수 있는 새 자료가 없습니다.',stagePercent:null});
        release();render();if(imported.skipped.length)showImportReport();else toast('이미 선택한 자료입니다. 기존 편집을 유지했습니다.');return;
      }
      detachEngine();
      let project=wasSample?C.emptyProject():D.clone(prior.project);
      if(wasSample){revokeMedia(prior.media);clearOutputs();}
      const media=[...existing,...imported.assets];
      const linked=W.relinkProject(project,media);project=linked.project;
      const active=project.variants.find(v=>v.id===project.activeVariant);
      let added=0;
      const onlyRelink=relink||(!wasSample&&hadMissing&&active.scenes.length>0);
      if(!onlyRelink){
        for(const source of imported.assets){
          if(source.kind==='audio'||active.scenes.length>=120)continue;
          if(source.kind==='video'&&source.analysis.duration*active.settings.fps<1){imported.skipped.push({name:source.relative_path,reason:'한 프레임보다 짧아 자동으로 장면에 넣지 않았습니다.'});continue;}
          const row=D.scene(source,active.settings.fps);row.name=row.name.slice(0,100);
          if(source.kind==='video')Object.assign(row,D.timing(row,0,Math.min(5,source.analysis.duration),1,active.settings.fps));
          active.scenes.push(row);added++;
        }
      }
      const music=imported.assets.find(item=>item.kind==='audio');
      if(music&&audio)active.audio.music_id=music.id;
      const path=imported.assets[0]?.relative_path||'';
      if(!folderName&&path.includes('/'))folderName=path.split('/')[0];
      if(project.title==='새 이야기'&&folderName)project.title=folderName.slice(0,160);
      C.assign({project,media,selected:active.scenes.some(s=>s.id===prior.selected)?prior.selected:active.scenes[0]?.id||'',clearHistory:wasSample||wasEngine,previewUrl:'',unsaved:true});
      updateManifest();persist();
      const missing=project.variants.flatMap(v=>v.scenes).filter(s=>!media.some(m=>m.id===s.source_id)).length;
      const detail=`자료 ${imported.assets.length}개 연결 · ${onlyRelink?'기존 편집 유지':added+'개 장면 추가'}${missing?' · 미연결 장면 '+missing+'개':''}${imported.skipped.length?' · 제외 '+imported.skipped.length+'개':''}`;
      setJob({status:'idle',phase:'import',detail,stagePercent:null});release();render();toast(detail);
      if(imported.skipped.length||imported.assets.filter(m=>m.kind!=='audio').length>added&&!onlyRelink&&active.scenes.length===120)showImportReport();
    }catch(error){
      setJob({status:error.name==='AbortError'?'cancelled':'error',phase:'import',detail:error.name==='AbortError'?'파일 선택을 취소했습니다. 기존 편집은 유지합니다.':error.message,stagePercent:null});
      release();render();if(error.name!=='AbortError')C.modalError(error);
    }finally{release();}
  }
  function showImportReport(){
    if(!lastImport)return toast('아직 불러온 자료가 없습니다.');
    modal('선택한 자료 확인',`<p>새 자료 ${lastImport.assets.length}개 · 중복 ${lastImport.duplicates}개 · 제외 ${lastImport.skipped.length}개</p><p class="tiny">자료 보관함은 최대 600개, 한 버전의 타임라인은 최대 120개입니다. 추가 장면은 다른 버전에 배치할 수 있습니다.</p>${lastImport.skipped.length?'<ul class="import-issues">'+lastImport.skipped.map(item=>`<li><strong>${esc(item.name)}</strong><span>${esc(item.reason)}</span></li>`).join(''):'<p>선택한 파일을 정상적으로 읽었습니다.</p>'}`);
  }
  function sourceChooser(){
    assertIdle();modal('내 자료로 시작하기',`<p>사진·영상·음악을 선택하면 이 브라우저에서 바로 편집합니다.</p><div class="source-choices">${button('addfiles','사진·영상 선택','primary')}${button('addfolder','폴더 선택')}${button('relink-files','원본 다시 연결')}${button('import','편집 JSON 열기')}</div><p class="tiny">파일이나 폴더를 화면에 끌어놓아도 됩니다. 새로고침 후에는 같은 원본을 다시 선택하세요.</p><details class="advanced-tools"><summary>고급 도구</summary><p class="tiny">기존 Python·FFmpeg 작업이나 Ollama 분석을 사용할 때만 선택하세요.</p>${button('advanced-engine','고급 엔진 연결')}${state().engine?button('browser-mode','브라우저 편집으로 돌아가기'):''}<a class="tiny" href="./setup.html" target="_blank" rel="noopener">계정 연결 진단 ↗</a></details>`);
  }
  function renderVariant(v,quality){
    const clone=D.clone(v);const edge=({'480':854,'720':1280,'1080':1920})[quality]||1280;
    const scale=Math.min(1,edge/Math.max(clone.settings.width,clone.settings.height));
    clone.settings={...clone.settings,text_reference_width:v.settings.width,width:Math.round(clone.settings.width*scale/2)*2,height:Math.round(clone.settings.height*scale/2)*2};
    return clone;
  }
  function exportDialog({all=false}={}){
    assertIdle();const info=support();
    if(!info.supported)throw Error(info.reason);
    const variants=all?state().project.variants.filter(v=>v.scenes.length):[variant()];
    if(!variants.length)throw Error('장면을 먼저 추가하세요.');
    for(const v of variants)validateBrowserRender(renderVariant(v,'720'),state().media);
    exportChoice={ids:variants.map(v=>v.id)};
    modal(all?'전체 버전 영상 굽기':'영상 굽기',`<p>${all?variants.length+'개 버전을 차례로':esc(variant().name)+'을'} 이 브라우저에서 만듭니다.</p><div class="export-facts"><span>저장 형식 <strong>${esc(info.label)}</strong></span><span>총 영상 길이 <strong>${D.seconds(variants.reduce((sum,v)=>sum+D.duration(v),0))}</strong></span></div><label>출력 화질<select id="browser-quality"><option value="480">480p · 처리 부담 줄이기</option><option value="720" selected>720p · 기본 화질</option><option value="1080">1080p · 선명하게 저장</option></select></label><p class="tiny">최대 10분·120장면·0.25~4배속. 원본을 재생하며 합성하므로 영상 길이 정도의 시간이 걸립니다. 생성 중에는 이 화면을 유지하세요. 처리가 느리면 480p로 낮춰주세요.</p>${info.extension==='webm'?'<p class="connection-banner">이 브라우저는 WebM으로 저장합니다. MP4 업로드만 받는 서비스에서는 MP4 저장을 지원하는 브라우저가 필요합니다.</p>':''}<div class="actions">${button('close','더 편집하기')}${button('start-browser-export','영상 생성 시작','primary')}</div>`);
  }
  async function executeRender({preview=false,transition=false,all=false,quality='720'}={}){
    assertIdle();let selectedVariants;
    if(preview){
      const source=variant(),index=source.scenes.findIndex(s=>s.id===state().selected);
      if(index<0)throw Error('미리 볼 장면을 선택하세요.');
      if(transition&&index===source.scenes.length-1)throw Error('다음 장면이 없습니다.');
      const clone=D.clone(source);clone.scenes=clone.scenes.slice(index,index+(transition?2:1));
      clone.scenes.at(-1).transition='cut';selectedVariants=[clone];
    }else selectedVariants=(all?state().project.variants.filter(v=>exportChoice?.ids.includes(v.id)):[variant()]).map(v=>renderVariant(v,quality));
    if(!selectedVariants.length)throw Error('생성할 버전이 없습니다.');
    for(const v of selectedVariants)validateBrowserRender(v,state().media,{preview});
    const sourceProject=D.clone(snapshot()),sourceMedia=[...state().media],originalSignatures=new Map(state().project.variants.map(v=>[v.id,signature(v)]));
    controller=new AbortController();operation='render';const signal=controller.signal;
    close();C.assign({job:{status:'running',phase:'render',detail:'선택한 원본을 준비합니다.',stagePercent:0}});render();
    let completed=0;
    try{
      for(const [index,item] of selectedVariants.entries()){
        const result=await renderInBrowser({variant:item,media:sourceMedia,preview,signal,onProgress:p=>setJob({phase:p.stage==='preparing'?'render':p.stage==='finalizing'?'verifying':'encoding',detail:p.detail,stagePercent:Math.round(p.percent),elapsed:p.elapsed,batch:all?{current:index+1,total:selectedVariants.length,name:item.name}:null})});
        const outputURL=URL.createObjectURL(result.blob);
        if(preview){
          if(previewObjectURL)URL.revokeObjectURL(previewObjectURL);previewObjectURL=outputURL;
          C.assign({previewUrl:outputURL});
        }else{
          const former=outputs.get(item.id);if(former)URL.revokeObjectURL(former.url);
          outputs.set(item.id,{...result,url:outputURL,signature:originalSignatures.get(item.id),variant:D.clone(item),project:sourceProject,createdAt:new Date().toISOString(),fileName:safeFileName(sourceProject.title+'-'+item.name)+'.'+result.extension});
        }
        completed++;
      }
      setJob({status:'done',phase:'complete',stagePercent:100,detail:preview?'미리보기가 완성됐습니다.':`${completed}개 영상이 완성됐습니다. 다운로드해서 저장하세요.`,result:preview?null:{renderer:'browser'},batch:null});
      release();render();if(!preview)showResult();else $('#player')?.play().catch(()=>{});
    }catch(error){
      setJob({status:error.name==='AbortError'?'cancelled':'error',detail:(error.name==='AbortError'?'영상 생성을 취소했습니다.':error.message)+(completed?` · 완료한 ${completed}개 영상은 결과 보관함에 유지합니다.`:''),errorDetails:error.name==='AbortError'?null:{...error.details,code:error.code||'BROWSER_RENDER'},stagePercent:null,batch:null,result:null});
      release();render();if(error.name!=='AbortError')C.modalError(error);
    }finally{release();}
  }
  function showResult(){
    const result=resultForCurrent(),stale=result.signature!==signature(variant());
    modal('노른노른하게 완성됐어요',`<video id="browser-result-player" src="${esc(result.url)}" controls playsinline preload="metadata"></video><p>${esc(result.fileName)}<br>${result.width} × ${result.height} · ${D.seconds(result.duration)} · ${(result.blob.size/1048576).toFixed(1)}MB</p>${stale?'<div class="connection-banner">이 영상은 편집 전 결과입니다. 현재 변경사항을 담으려면 다시 구워주세요.</div>':''}<p class="tiny">영상은 아직 이 탭에 있습니다. 닫기 전에 다운로드해 주세요.</p>${result.warnings?.length?'<details><summary>생성 안내</summary><ul>'+result.warnings.map(message=>'<li>'+esc(message)+'</li>').join('')+'</ul></details>':''}<div class="actions">${button('download-video',result.extension.toUpperCase()+' 다운로드','primary')}${button('download-package','영상·게시자료 ZIP')}${typeof window.showDirectoryPicker==='function'?button('save-results-folder','폴더에 저장'):''}${button('posting','SNS 문구')}</div>`,true);
  }
  function capturePost(){
    const textarea=$('#post-text');if(!textarea)return;
    const channel=$('[data-action="channel"].active')?.dataset.channel||'instagram',project=state().project;
    project.publicNote=$('#public-note')?.value??project.publicNote??'';project.posts??={};project.posts[variant().id]??={};project.posts[variant().id][channel]=textarea.value;persist();
  }
  function packageData(includeVideo=true){
    capturePost();const result=includeVideo?resultForCurrent({current:true}):null;
    return postingFiles(snapshot(),result?.variant||variant(),state().media,result,{folderName});
  }
  async function savePackage(includeVideo=true){
    assertIdle();const data=packageData(includeVideo);
    controller=new AbortController();operation='package';close();setJob({status:'running',phase:'packaging',detail:'저장할 게시 묶음을 준비합니다.',stagePercent:0});render();
    try{
      const blob=await createZip(data.files.map(file=>({...file,path:data.directoryName+'/'+file.path})),{signal:controller.signal,onProgress:p=>setJob({phase:'packaging',detail:p.path,stagePercent:Math.round(p.current/p.total*100)})});
      downloadBlob(data.directoryName+'.zip',blob);if(includeVideo)resultForCurrent().saved=true;setJob({status:'idle',detail:'게시 묶음을 다운로드했습니다.',stagePercent:null});
    }catch(error){setJob({status:error.name==='AbortError'?'cancelled':'error',detail:error.message,stagePercent:null});}
    finally{release();render();}
  }
  async function saveToFolder(){
    assertIdle();const data=packageData();
    if(typeof window.showDirectoryPicker!=='function')return savePackage();
    let parent;try{parent=await window.showDirectoryPicker({mode:'readwrite',id:'norn-output'});}catch(error){if(error.name==='AbortError')return;throw Error('저장 폴더를 열지 못했습니다. 영상·게시자료 ZIP 다운로드를 이용하세요.');}
    controller=new AbortController();operation='saving';close();setJob({status:'running',phase:'saving',detail:'선택한 위치에 결과 폴더를 만듭니다.',stagePercent:0});render();
    let targetName='';
    try{
      let directory;
      for(let i=1;i<=1000;i++){
        targetName=data.directoryName+(i===1?'':'-'+i);
        try{await parent.getDirectoryHandle(targetName);}catch(error){if(error.name!=='NotFoundError'&&error.name!=='TypeMismatchError')throw error;if(error.name==='TypeMismatchError')continue;directory=await parent.getDirectoryHandle(targetName,{create:true});break;}
      }
      if(!directory)throw Error('같은 이름의 폴더가 많습니다. 다른 저장 위치를 선택하세요.');
      for(const [index,file]of data.files.entries()){
        controller.signal.throwIfAborted();let dir=directory;const parts=file.path.split('/');
        for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part,{create:true});
        const handle=await dir.getFileHandle(parts.at(-1),{create:true});const stream=await handle.createWritable();
        try{await stream.write(file.blob);controller.signal.throwIfAborted();await stream.close();}catch(error){await stream.abort().catch(()=>{});throw error;}
        setJob({phase:'saving',detail:file.path,stagePercent:Math.round((index+1)/data.files.length*100)});
      }
      resultForCurrent().saved=true;setJob({status:'idle',detail:targetName+' 폴더에 결과를 저장했습니다.',stagePercent:null});
    }catch(error){setJob({status:error.name==='AbortError'?'cancelled':'error',detail:(targetName?targetName+' 폴더에 일부 파일만 저장됐습니다. ':'')+error.message+' ZIP 다운로드로 다시 저장할 수 있습니다.',stagePercent:null});}
    finally{release();render();}
  }
  function concept(){
    modal('이야기 구성',`<label>영상 제목<input id="concept-title" maxlength="160" value="${esc(state().project.title)}"></label><label>편집 메모<textarea id="concept-note" rows="4" maxlength="6000" placeholder="만들고 싶은 이야기와 편집 방향을 적어두세요.">${esc(state().project.description)}</textarea></label><label>목표 길이(초)<input id="target-duration" type="number" min="1" max="600" value="${variant().targetDuration||state().project.targetDuration||30}"></label><p class="tiny">자동 구성은 현재 순서와 원본 길이를 사용해 장면 길이를 배분합니다. 사진 내용이나 말소리를 AI로 분석하는 기능은 아닙니다. 직접 고친 제목·문구는 유지합니다.</p><div class="actions">${button('concept-save','저장')}${button('auto-arrange','현재 순서로 자동 구성','primary')}</div>`);
  }
  function saveConcept(){
    const target=Number($('#target-duration').value);if(!Number.isFinite(target)||target<1||target>600)throw Error('목표 길이는 1~600초로 입력하세요.');
    edit(()=>{state().project.title=$('#concept-title').value;state().project.description=$('#concept-note').value;state().project.targetDuration=target;variant().targetDuration=target;});close();
  }
  function autoArrange(){
    const target=Number($('#target-duration').value);if(!Number.isFinite(target)||target<1||target>600)throw Error('목표 길이는 1~600초로 입력하세요.');
    const title=$('#concept-title').value,note=$('#concept-note').value;
    if(!variant().scenes.length)throw Error('먼저 사진·영상을 선택하세요.');
    edit(()=>{
      state().project.title=title;state().project.description=note;state().project.targetDuration=target;variant().targetDuration=target;
      const amount=target/variant().scenes.length,fps=variant().settings.fps;
      for(const row of variant().scenes){
        if(row.field_locks?.includes('timing'))continue;
        const source=state().media.find(m=>m.id===row.source_id);if(!source)continue;
        if(source.kind==='video'){
          const start=row.start||0,span=Math.min(source.analysis.duration-start,Math.max(1/fps,amount));
          Object.assign(row,D.timing(row,start,start+span,1,fps));
        }else row.duration=Math.max(1/fps,Math.floor(amount*fps)/fps);
        row.transition='cut';
      }
    });close();toast('현재 순서로 장면 길이를 배분했습니다. 직접 자른 구간과 짧은 원본 때문에 목표 길이와 다를 수 있습니다.');
  }
  function importProject(){
    assertIdle();const input=document.createElement('input');input.type='file';input.accept='.json,application/json';input.id='norn-project-input';input.hidden=true;
    input.oncancel=()=>input.remove();input.onchange=async()=>{
      const file=input.files?.[0];input.remove();if(!file)return;
      try{
        if(file.size>10*1024*1024)throw Error('편집 JSON은 10MB 이하 파일을 선택하세요.');
        const p=W.cloudData(W.validateProject(JSON.parse(await file.text())));
        if((state().unsaved||hasUnsavedOutputs())&&!confirm('현재 편집 대신 선택한 JSON을 열까요? 저장하지 않은 편집은 먼저 JSON으로 저장할 수 있습니다.'))return;
        const linked=W.relinkProject(p,state().media.filter(m=>m.local||m.sample));detachEngine();clearOutputs();
        C.assign({project:{...linked.project,revision:0},selected:linked.project.variants.find(v=>v.id===p.activeVariant).scenes[0]?.id||'',job:{status:'idle'},previewUrl:'',clearHistory:true,cloudRevision:0});
        openStudio();persist();render();toast(linked.missing.length?'편집을 열었습니다. 자료 선택에서 같은 원본 파일·폴더를 다시 선택하세요.':'편집을 열고 원본을 연결했습니다.');
      }catch(error){C.modalError(error);}
    };document.body.append(input);input.click();
  }
  function mount(){
    if(!localMode())return;
    const library=$('.library');
    if(library&&!$('#local-import-buttons')){
      const controls=document.createElement('div');controls.id='local-import-buttons';controls.className='local-import-buttons';
      controls.innerHTML=button('addfiles','파일 선택','primary small')+button('addfolder','폴더 선택');$('.library-grid')?.before(controls);
      if(!state().media.length){const empty=document.createElement('div');empty.className='local-drop-hint';empty.textContent='여기에 사진·영상이나 폴더를 끌어놓으세요.';$('.library-grid')?.append(empty);}
      const info=document.createElement('div');info.className='local-library-info';
      info.innerHTML='<span>원본은 선택한 위치에 그대로 있어요.</span>'+button('import-report','불러오기 결과','ghost small')+button('new-project','새 이야기','ghost small');library.append(info);
    }
    const nav=$('#workflow-nav');if(nav){nav.innerHTML=button('connect','1 자료 선택')+button('concept','2 이야기 구성')+button('focus-timeline','3 장면 편집')+button('posting','4 영상·게시 준비');}
    if(state().media.length===0&&state().project.variants.some(v=>v.scenes.length)&&!$('#local-relink-banner')){
      const banner=document.createElement('div');banner.id='local-relink-banner';banner.className='connection-banner local-relink';banner.innerHTML='편집정보를 복원했습니다. 같은 원본을 다시 선택하면 순서·문구·구간을 유지합니다. '+button('relink-files','원본 다시 선택');$('.workflow-nav')?.after(banner);
    }
    const styleSelect=$('[data-bind="transition"]');if(styleSelect&&C.scene()&&!BROWSER_TRANSITIONS[C.scene().transition]){const opt=document.createElement('option');opt.value=C.scene().transition;opt.textContent=(D.transitions[C.scene().transition]||C.scene().transition)+' · 브라우저 미지원';styleSelect.append(opt);opt.selected=true;}
    document.querySelectorAll('[data-timing="speed"]').forEach(input=>{input.min='.25';input.max='4';input.step='.25';});
    document.querySelectorAll('[data-action="speed"]').forEach(button=>button.hidden=Number(button.dataset.value)>4);
    const timelapse=$('[data-action="timelapse"]');if(timelapse)timelapse.hidden=true;
    const music=$('[data-action="builtin-music"]');if(music){music.textContent='음악 파일 선택';music.dataset.action='addaudio';}
    const info=support();const note=$('.stage-note');
    if(note)note.textContent=info.supported?'이 장면 미리보기로 글씨·효과를 확인하고 영상 굽기로 '+info.label+' 파일을 저장하세요.':info.reason;
    const stageLabel=$('#connection-label');if(stageLabel){stageLabel.classList.add('on');stageLabel.textContent='브라우저에서 편집';}
    const running=busy();
    document.querySelectorAll('.studio button,.studio input,.studio select,.studio textarea,.studio .clip').forEach(element=>{
      if(running&&!['cancel','log'].includes(element.dataset.action)){element.disabled=true;element.draggable=false;}
    });
    if(!info.supported)document.querySelectorAll('[data-action="render"],[data-action="preview"],[data-action="render-all"]').forEach(button=>{button.disabled=true;button.title=info.reason;});
  }
  Object.assign(C.actions,{
    connect:sourceChooser,'advanced-engine':()=>previous.connect(),
    'browser-mode':()=>{assertIdle();detachEngine();C.assign({media:state().media.filter(m=>m.local||m.sample),job:{status:'idle'},previewUrl:''});close();render();toast('브라우저 편집을 시작합니다. 같은 원본 파일·폴더를 선택하세요.');},
    addfiles:()=>selectFiles(),addfolder:()=>selectFiles({folder:true}),addaudio:()=>selectFiles({audio:true}),'relink-files':()=>selectFiles({relink:true}),
    rescan:()=>localMode()?selectFiles({relink:true}):previous.rescan(),'import-report':showImportReport,
    demo:()=>{assertIdle();if((state().unsaved||hasUnsavedOutputs())&&!confirm('현재 편집 대신 예제를 열까요?'))return;reset();detachEngine();C.assign({project:D.demoProject(),media:C.samples(),selected:'',job:{status:'idle'},previewUrl:'',clearHistory:true});C.assign({selected:variant().scenes[0]?.id||''});openStudio();render();},
    'new-project':()=>{assertIdle();if((state().unsaved||hasUnsavedOutputs())&&!confirm('현재 편집을 닫고 새 이야기를 시작할까요? 원본과 다운로드한 파일은 그대로 있습니다.'))return;reset();detachEngine();C.assign({project:C.emptyProject(),media:[],selected:'',job:{status:'idle'},previewUrl:'',clearHistory:true,cloudRevision:0});persist();render();},
    import:()=>localMode()?importProject():previous.import(),
    save:async()=>{assertIdle();if(!localMode())return previous.save();downloadBlob(safeFileName(state().project.title)+'-norn-project.json',new Blob([JSON.stringify(snapshot(),null,2)],{type:'application/json'}));C.assign({unsaved:false});render();toast('편집 JSON을 저장했습니다. 원본은 포함하지 않습니다.');},
    backup:()=>localMode()?C.actions.save():previous.backup(),
    concept:()=>localMode()?concept():previous.concept(),'concept-save':()=>localMode()?saveConcept():previous['concept-save'](),'auto-arrange':autoArrange,
    preview:()=>localMode()?executeRender({preview:true}):previous.preview(),render:()=>localMode()?exportDialog():previous.render(),
    'render-all':()=>localMode()?exportDialog({all:true}):previous['render-all'](),
    'start-browser-export':()=>executeRender({all:exportChoice?.ids.length>1,quality:$('#browser-quality')?.value||'720'}),
    'transition-preview':()=>localMode()?executeRender({preview:true,transition:true}):previous['transition-preview'](),
    cancel:()=>{if(controller){controller.abort();toast('작업을 취소하고 정리합니다.');}else return previous.cancel();},
    log:()=>localMode()?modal('작업 상태',`<p>${esc(state().job.detail||'진행 중인 작업이 없습니다.')}</p>${state().job.errorDetails?'<details><summary>상세 진단</summary><pre id="browser-error-details">'+esc(JSON.stringify(state().job.errorDetails,null,2))+'</pre></details>':''}${lastImport?button('import-report','파일 불러오기 결과'):''}`):previous.log(),
    result:()=>localMode()?showResult():previous.result(),
    'download-video':()=>{const result=resultForCurrent();downloadBlob(result.fileName,result.blob);result.saved=true;},
    'download-package':()=>savePackage(true),'save-results-folder':saveToFolder,
    'export-posting':()=>localMode()?savePackage(true):previous['export-posting'](),
    'posting-save':()=>localMode()?savePackage(false):previous['posting-save'](),
    posting:async()=>{await previous.posting();if(!localMode())return;
      const files=$('#attachment-list');if(files)files.textContent=variant().scenes.map(scene=>state().media.find(m=>m.id===scene.source_id)?.relative_path||'원본 다시 선택 필요').join('\n');
      const zip=$('[data-action="export-posting"]');if(zip)zip.textContent='영상·게시자료 ZIP';
      if(files?.closest('details')?.nextElementSibling)files.closest('details').nextElementSibling.textContent='SNS에는 직접 복사·첨부합니다. ZIP에는 완성 영상·편집 JSON·문구를 담으며 원본 사진·영상은 포함하지 않습니다.';
    },
  });
  document.addEventListener('click',event=>{
    if(!busy())return;const button=event.target.closest('[data-action]');
    if(button&&!['cancel','log','close'].includes(button.dataset.action)){event.preventDefault();event.stopImmediatePropagation();toast('현재 작업이 끝나거나 취소된 뒤 편집하세요.');}
  },true);
  document.addEventListener('dragover',event=>{if(Array.from(event.dataTransfer?.types||[]).includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';document.body.classList.add('local-dragover');}});
  document.addEventListener('dragleave',event=>{if(!event.relatedTarget)document.body.classList.remove('local-dragover');});
  document.addEventListener('drop',event=>{
    document.body.classList.remove('local-dragover');
    if(!Array.from(event.dataTransfer?.types||[]).includes('Files'))return;
    event.preventDefault();event.stopImmediatePropagation();
    if(busy()){toast('현재 작업을 완료하거나 취소한 후 자료를 선택하세요.');return;}
    readDroppedFiles(event.dataTransfer).then(files=>files.length?importLocal(files):toast('폴더를 읽지 못했습니다. 폴더 선택 버튼으로 다시 선택하세요.')).catch(C.modalError);
  },true);
  return {mount,reset,busy,hasUnsavedOutputs,selectFiles,requestRender:preview=>preview?executeRender({preview:true}):exportDialog()};
}
