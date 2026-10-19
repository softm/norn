/* NORN browser FFmpeg worker. No HTTP upload, local server, SharedArrayBuffer or font files. */
const CORE='https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
const ALLOWED=new Set('cut fade fadeblack fadewhite dissolve pixelize wipeleft wiperight wipeup wipedown slideleft slideright slideup slidedown smoothleft smoothright circleopen circleclose radial diagtl diagbr hblur squeezeh squeezev zoomin'.split(' '));
let ff=null,stage={},log=[];
function send(type,data){self.postMessage({type,...data});}
function update(detail,percent=null){stage={...stage,detail};send('progress',{...stage,percent});}
async function cached(url,mime){let response,cache;try{cache=await caches.open('norn-engine-0.12.10');response=await cache.match(url);}catch{}if(!response){response=await fetch(url,{credentials:'omit',referrerPolicy:'no-referrer'});if(!response.ok)throw Error(`브라우저 영상 엔진을 받지 못했습니다 (${response.status}). 네트워크를 확인하세요.`);if(cache)cache.put(url,response.clone()).catch(()=>{});}return URL.createObjectURL(new Blob([await response.arrayBuffer()],{type:mime}));}
async function load(){if(ff)return;update('브라우저 영상 엔진 준비 · 최초 약 31MB 다운로드');const [js,wasm]=await Promise.all([cached(CORE+'/ffmpeg-core.js','text/javascript'),cached(CORE+'/ffmpeg-core.wasm','application/wasm')]);
 try{importScripts(js);ff=await self.createFFmpegCore({mainScriptUrlOrBlob:js+'#'+btoa(JSON.stringify({wasmURL:wasm}))});}finally{URL.revokeObjectURL(js);URL.revokeObjectURL(wasm);}
 ff.setLogger(({message})=>{log.push(message);if(log.length>80)log.shift();});
 ff.setProgress(({time})=>{const t=Number(time)/1e6;if(stage.expected>0&&Number.isFinite(t))send('progress',{...stage,percent:Math.min(99,Math.max(0,Math.floor(t/stage.expected*100)))});});
 ff.FS.mkdir('/work');ff.FS.mkdir('/sources');
}
function run(args,expected){stage.expected=expected;log=[];ff.setTimeout(-1);ff.exec('-v','warning',...args);const code=ff.ret;ff.reset();if(code!==0)throw Error(`영상 처리 실패 (${code})\n${log.slice(-10).join('\n')}`);}
function probe(path){log=[];ff.setTimeout(-1);ff.ffprobe('-v','error','-show_streams','-show_format','-of','json','-o','/work/probe.json',path);const code=ff.ret;ff.reset();if(code!==0)throw Error(`영상 메타데이터 확인 실패 (${code}, ${path})\n${log.slice(-20).join('\n')}`);const value=JSON.parse(ff.FS.readFile('/work/probe.json',{encoding:'utf8'}));ff.FS.unlink('/work/probe.json');return value;}
function tempo(speed){const out=[];while(speed>2.000001){out.push('atempo=2');speed/=2;}while(speed<.499999){out.push('atempo=0.5');speed*=2;}out.push('atempo='+speed.toFixed(8));return out.join(',');}
const enc=['-c:v','libx264','-preset','ultrafast','-crf','24','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-ar','44100','-ac','2','-threads','1','-movflags','+faststart'];
function memoryCheck(limit){const bytes=ff.FS.readdir('/work').filter(n=>!['.','..'].includes(n)).reduce((sum,n)=>sum+ff.FS.stat('/work/'+n).size,0);if(bytes>limit)throw Error('브라우저 작업 메모리 안전 한도에 도달했습니다. 해상도·장면 수·완성 길이를 줄여주세요.');}
async function render({plan,inputs,overlays,join,workLimit}){
 await load();const {width:w,height:h,fps}=plan.settings;if(![w,h,fps,plan.duration].every(Number.isFinite)||w<144||h<144||Math.max(w,h)>1920||fps>30||plan.duration>600||plan.scenes.length>60)throw Error('브라우저 출력 범위 오류');
 const mount=ff.FS.filesystems.WORKERFS;if(!mount)throw Error('읽기 전용 파일 마운트를 지원하지 않는 영상 엔진입니다.');
 ff.FS.mount(mount,{blobs:inputs.map((x,i)=>({name:'f'+i+'.'+x.ext,data:x.file}))},'/sources');
 try{
  for(let i=0;i<plan.scenes.length;i++){
   const s=plan.scenes[i],input=inputs[s.inputIndex];if(!ALLOWED.has(s.transition)||![s.duration,s.start,s.source_duration,s.playback_speed].every(Number.isFinite))throw Error('장면 설정이 잘못되었습니다.');
   stage={scene:i+1,total:plan.scenes.length,phase:'encoding'};update(`장면 ${i+1}/${plan.scenes.length} · 이 브라우저에서 굽는 중`);
   const source='/sources/f'+s.inputIndex+'.'+input.ext,overlay='/work/text.png',output='/work/seg'+i+'.mp4',photo=input.kind==='image';
   ff.FS.writeFile(overlay,new Uint8Array(await overlays[i].arrayBuffer()));
   let hasAudio=false;if(!photo){const p=probe(source);hasAudio=p.streams.some(x=>x.codec_type==='audio');}
   const keep=hasAudio&&!plan.audio.mute_original&&s.keep_audio&&(s.playback_speed<=4||s.speed_audio==='speed');
   const args=photo?['-loop','1','-framerate',String(fps),'-i',source]:['-ss',String(s.start),'-t',String(s.source_duration),'-i',source];
   args.push('-loop','1','-framerate',String(fps),'-i',overlay);
   if(!keep)args.push('-f','lavfi','-i','anullsrc=r=44100:cl=stereo');
   let visual=photo?`scale=${w}:${h}`:`setpts=(PTS-STARTPTS)/${s.playback_speed},fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x10120f`;
   if(photo&&s.motion==='zoom')visual+=`,zoompan=z='min(1.06,1+on*${.06/Math.max(1,s.frames-1)})':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${w}x${h}:fps=${fps}`;
   visual+=`,setsar=1,format=yuv420p,settb=AVTB,trim=duration=${s.duration},setpts=PTS-STARTPTS`;
   const graph=`[0:v]${visual}[base];[1:v]format=rgba,fade=t=in:st=0:d=${Math.min(.16,s.duration/4)}:alpha=1[text];[base][text]overlay=shortest=1:format=auto,format=yuv420p[v];`+(keep?`[0:a]asetpts=PTS-STARTPTS,${tempo(s.playback_speed)},volume=${Math.max(0,Math.min(2,Number(plan.audio.original_volume??1)))},aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${s.duration}[a]`:`[2:a]atrim=duration=${s.duration},asetpts=PTS-STARTPTS[a]`);
   args.push('-filter_complex_threads','1','-filter_complex',graph,'-map','[v]','-map','[a]','-r',String(fps),'-t',String(s.duration),...enc,output);run(args,s.duration);ff.FS.unlink(overlay);memoryCheck(workLimit);
  }
  stage={phase:'transitions',scene:plan.scenes.length,total:plan.scenes.length};update('장면·전환·원음 연결');const segments=plan.scenes.map((_,i)=>'/work/seg'+i+'.mp4');let joined='/work/joined.mp4';
  if(segments.length===1){ff.FS.rename(segments[0],joined);}
  else if(plan.scenes.every(s=>s.transition==='cut')){ff.FS.writeFile('/work/list.txt',segments.map(p=>`file '${p}'`).join('\n'));run(['-f','concat','-safe','0','-i','/work/list.txt','-c','copy','-movflags','+faststart',joined],plan.duration);ff.FS.unlink('/work/list.txt');}
  else {const args=segments.flatMap(p=>['-i',p]);run([...args,'-filter_complex_threads','1','-filter_complex',join.graph,'-map','['+join.video+']','-map','['+join.audio+']','-r',String(fps),'-t',String(plan.duration),...enc,joined],plan.duration);}
  for(const path of segments){try{ff.FS.unlink(path);}catch{}}memoryCheck(workLimit);
  const final='/work/video.mp4';
  if(Number.isInteger(plan.musicIndex)&&plan.musicIndex>=0){stage={phase:'music'};update('배경음악 합성');const args=['-i',joined];if(plan.audio.loop)args.push('-stream_loop','-1');args.push('-ss',String(Math.max(0,Number(plan.audio.music_start)||0)),'-i','/sources/f'+plan.musicIndex+'.'+inputs[plan.musicIndex].ext);
   const volume=Math.min(1,Math.max(0,Number(plan.audio.music_volume??.22))),fi=Math.min(plan.duration/2,Math.max(0,Number(plan.audio.fade_in)||0)),fo=Math.min(plan.duration/2,Math.max(0,Number(plan.audio.fade_out)||0));const graph=`[1:a]asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,volume=${volume},apad,atrim=duration=${plan.duration},afade=t=in:st=0:d=${Math.max(.001,fi)},afade=t=out:st=${Math.max(0,plan.duration-fo)}:d=${Math.max(.001,fo)}[music];[0:a][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]`;
   run([...args,'-filter_complex_threads','1','-filter_complex',graph,'-map','0:v','-map','[a]','-c:v','copy','-c:a','aac','-b:a','128k','-t',String(plan.duration),'-movflags','+faststart',final],plan.duration);ff.FS.unlink(joined);
  }else ff.FS.rename(joined,final);
  stage={phase:'verify'};update('완성 MP4 길이·영상·오디오 확인');const metadata=probe(final),video=metadata.streams.find(s=>s.codec_type==='video'),audio=metadata.streams.find(s=>s.codec_type==='audio');
  if(!video||video.width!==w||video.height!==h||Math.abs(Number(metadata.format.duration)-plan.duration)>.2||!audio)throw Error('완성 영상 검증에 실패했습니다. 이전 결과는 보존됩니다.');memoryCheck(workLimit);
  const data=ff.FS.readFile(final);send('progress',{phase:'complete',detail:'이 브라우저에서 MP4 생성 완료',percent:100});self.postMessage({type:'done',data,metadata:{duration:Number(metadata.format.duration),width:w,height:h,fps,size:data.byteLength,video:video.codec_name,audio:audio.codec_name}},[data.buffer]);
 }finally{try{ff.FS.unmount('/sources');}catch{}for(const n of ff.FS.readdir('/work'))if(!['.','..'].includes(n))try{ff.FS.unlink('/work/'+n);}catch{}}
}
self.onmessage=async({data})=>{try{if(data.type!=='render')throw Error('지원하지 않는 작업');await render(data);}catch(e){send('error',{message:e.message||String(e)});}};
