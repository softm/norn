"""NORN local engine: explicit folder, token, origin allowlist, native FFmpeg.
Run: python3 engine/server.py /path/to/media [--web-origin https://host]
Only derivatives are written to the sibling <folder>업로드준비 directory.
"""
from __future__ import annotations
import argparse, base64, copy, hashlib, hmac, html, io, json, math, mimetypes, os, random
import secrets, shutil, sys, tempfile, threading, time, urllib.parse, urllib.request, uuid, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from PIL import Image, ImageOps
import media_core as core
import editor_features as fx
import speed_tools as speed
from render_runtime import RenderRunner, RenderCancelled, check_runtime
from timeline_render import render_timeline
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:pass

ROOT=Path(__file__).resolve().parents[1]
KINDS={**dict.fromkeys(['.jpg','.jpeg','.png','.webp','.heic','.heif','.bmp'],'image'),
       **dict.fromkeys(['.mp4','.mov','.mkv','.webm','.m4v','.avi'],'video'),
       **dict.fromkeys(['.mp3','.wav','.m4a','.flac','.aac','.ogg'],'audio')}


def read_json(path,default=None):
    try:return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError,ValueError):return copy.deepcopy(default)


def number(value,lo,hi):
    if isinstance(value,bool):raise ValueError('유효한 숫자를 입력하세요.')
    n=float(value)
    if not math.isfinite(n) or not lo<=n<=hi:raise ValueError(f'{lo}~{hi} 범위를 확인하세요.')
    return n


def text(value,limit=160):
    if not isinstance(value,str) or len(value)>limit:raise ValueError(f'문구는 {limit}자 이내 문자열이어야 합니다.')
    if any(ord(c)<32 and c not in '\n\t' for c in value):raise ValueError('사용할 수 없는 제어 문자입니다.')
    return value


def new_scene(m):
    span=min(5,float(m['analysis'].get('duration',5))) if m['kind']=='video' else 3
    return {'id':uuid.uuid4().hex,'source_id':m['id'],'name':Path(m['relative_path']).stem,
        'title':'','caption':'','start':0,'duration':span,'source_duration':span,'playback_speed':1,
        'style':'clean','title_size':52,'font_size':42,'font_family':'default','text_position':'bottom',
        'transition':'cut','transition_duration':.3,'keep_audio':False,'speed_audio':'auto','motion':'zoom','field_locks':[]}


def validate_variant(value,by_id):
    if not isinstance(value,dict):raise ValueError('영상 설정이 없습니다.')
    v=copy.deepcopy(value)
    if not isinstance(v.get('id'),str) or not v['id'].replace('-','').isalnum() or len(v['id'])>80:raise ValueError('출력 버전 ID 오류')
    s=v.get('settings',{});fps=int(number(s.get('fps',30),10,60))
    w=int(number(s.get('width',1080),144,3840));h=int(number(s.get('height',1920),144,3840))
    if w%2 or h%2:raise ValueError('출력 해상도는 짝수로 입력하세요.')
    v['settings']={'width':w,'height':h,'fps':fps}
    rows=v.get('scenes')
    if not isinstance(rows,list) or not 1<=len(rows)<=120:raise ValueError('장면을 1~120개 선택하세요.')
    seen=set()
    for row in rows:
        if row.get('source_id') not in by_id or by_id[row['source_id']]['kind']=='audio':raise ValueError('원본 폴더를 다시 연결하세요.')
        if not isinstance(row.get('id'),str) or row['id'] in seen:raise ValueError('장면 ID가 중복되거나 없습니다.')
        seen.add(row['id']);m=by_id[row['source_id']]
        for key,limit in [('name',100),('title',100),('caption',240)]:row[key]=text(row.get(key,''),limit)
        row.update(fx.default_scene_fields(row))
        if row.get('style') not in fx.STYLES:raise ValueError('지원하지 않는 글씨 스타일')
        if row['font_family'] not in fx.FONT_GROUPS:raise ValueError('지원하지 않는 폰트')
        if row['text_position'] not in ('top','middle','bottom'):raise ValueError('글씨 위치 오류')
        if row.get('motion') not in ('zoom','none'):raise ValueError('사진 효과 오류')
        if row.get('transition') not in fx.supported_transitions():raise ValueError('설치된 FFmpeg에서 이 전환을 지원하지 않습니다.')
        for key in ('title_size','font_size'):row[key]=number(row[key],12,200)
        row['transition_duration']=number(row['transition_duration'],0,3)
        row['keep_audio']=bool(row.get('keep_audio',False))
        if row.get('speed_audio','auto') not in ('auto','mute','stretch'):raise ValueError('원음 설정 오류')
        if m['kind']=='video':row.update(speed.video_timing(row,float(m['analysis']['duration']),fps))
        else:
            row.update(start=0,playback_speed=1,duration=round(number(row.get('duration',3),1/fps,600)*fps)/fps)
            row['source_duration']=row['duration']
    overlaps=fx.overlaps(rows,fps)
    total=sum(r['duration'] for r in rows)-sum(overlaps)
    if total>3600:raise ValueError('현재 버전의 최대 출력 길이는 60분입니다. 실제 긴 영상 성능은 기기별 확인이 필요합니다.')
    audio=fx.audio_defaults(v.get('audio'));audio['mute_original']=bool(audio['mute_original']);audio['loop']=bool(audio['loop'])
    for key in ('original_volume','music_volume'):audio[key]=number(audio[key],0,2)
    for key in ('music_start','fade_in','fade_out'):audio[key]=number(audio[key],0,86400)
    mid=audio['music_id']
    if mid and (mid not in by_id or by_id[mid]['kind']!='audio'):raise ValueError('음악 원본을 다시 선택하세요.')
    v['audio']=audio;return v


class App:
    def __init__(self,source):
        self.source=Path(source).expanduser().resolve(strict=True)
        if not self.source.is_dir() or self.source==self.source.parent or self.source.name.endswith('업로드준비'):raise ValueError('실제 원본 폴더를 선택하세요.')
        out=self.source.with_name(self.source.name+'업로드준비')
        if out.is_symlink():raise ValueError('출력 폴더는 심볼릭 링크일 수 없습니다.')
        out.mkdir(exist_ok=True);self.store=core.Store(self.source,out)
        self.token=secrets.token_urlsafe(32);self.mutex=threading.RLock();self.cancel=threading.Event()
        self.job={'status':'idle','phase':'ready','detail':'준비됐어요. 원하는 이야기를 구워보세요.'}
        self.media=[];self.by_id={};self.warnings=[];self.scan()
        self.project=read_json(out/'norn-project.json')
        if not self.project:
            old=read_json(out/'edit-project.json',{})
            if old.get('schema_version')==1:
                legacy_manifest=read_json(out/'manifest.json',{});aliases={m['id']:m.get('relative_path') for m in legacy_manifest.get('sources',[])}
                ids={m['relative_path']:m['id'] for m in self.media};rows=copy.deepcopy(old.get('scenes',[]))
                for r in rows:
                    r['source_id']=ids.get(aliases.get(r.get('source_id')),r.get('source_id'))
                    r['field_locks']=['name','title','caption','timing']
                v={'id':'legacy','name':'기존 편집 가져오기','settings':old.get('settings',{}),'audio':old.get('audio',{}),'scenes':rows}
                old_music=v['audio'].get('music_id','')
                if old_music and old_music not in self.by_id:
                    v['audio']['music_id']='';self.warnings.append('기존 내장 음악은 파일을 원본 폴더에 다시 연결하세요. 기존 편집 파일은 변경하지 않았습니다.')
                title=old.get('concept',{}).get('settings',{}).get('title',self.source.name)
                note=old.get('concept',{}).get('settings',{}).get('description','')
            else:
                v={'id':'short','name':'숏폼 · 30초','settings':{'width':1080,'height':1920,'fps':30},'audio':fx.audio_defaults(),
                   'scenes':[new_scene(m) for m in self.media if m['kind']!='audio'][:12]};title=self.source.name;note=''
            self.project={'schema_version':2,'id':uuid.uuid4().hex,'revision':0,'title':title,'description':note,
                'frames':5,'targetDuration':30,'activeVariant':v['id'],'variants':[v]}
            self.store.write_json('norn-project.json',self.project)

    def source_path(self,sid):return core.safe_path(self.source,self.by_id[sid]['relative_path'])

    def scan(self):
        cache=read_json(self.store.root/'source-index.json',{});records=[];warnings=[]
        for p in sorted(self.source.rglob('*')):
            rel=p.relative_to(self.source)
            if any(s.startswith('.') for s in rel.parts) or p.is_symlink() or not p.is_file() or p.suffix.lower() not in KINDS:continue
            try:
                p=core.safe_path(self.source,str(rel));st=p.stat();key=f'{st.st_size}:{st.st_mtime_ns}'
                prev=cache.get(str(rel),{})
                sha=prev.get('sha256') if prev.get('stat')==key else core.file_hash(p)
                sid=hashlib.sha256((str(rel)+'\0'+sha).encode()).hexdigest()[:32]
                kind=KINDS[p.suffix.lower()]
                if kind=='image':
                    with Image.open(p) as image:
                        image=ImageOps.exif_transpose(image);info={'width':image.width,'height':image.height,'duration':0,'has_audio':False}
                else:info=core.probe(p)
                m={'id':sid,'relative_path':str(rel),'kind':kind,'sha256':sha,'stat':key,'analysis':info,'size':st.st_size}
                records.append(m)
            except Exception as e:warnings.append(f'{rel}: {e}')
        self.media=records;self.by_id={m['id']:m for m in records};self.warnings=warnings
        self.store.write_json('source-index.json',{m['relative_path']:m for m in records})

    def thumb(self,sid):
        m=self.by_id[sid];target=self.store.path('.cache/thumbs/'+sid+'.jpg')
        if target.exists():return target
        p=self.source_path(sid)
        if m['kind']=='image':
            with Image.open(p) as im:
                im=ImageOps.exif_transpose(im).convert('RGB');im.thumbnail((1280,1280));im.save(target,quality=86)
        elif m['kind']=='video':
            core.run_command(['ffmpeg','-nostdin','-v','error','-y','-ss',str(min(.5,m['analysis']['duration']/2)),'-i',str(p),'-frames:v','1','-vf','scale=640:-2','-threads','1',str(target)],90)
        else:raise ValueError('오디오에는 썸네일이 없습니다.')
        return target

    def state(self):
        with self.mutex:
            return copy.deepcopy({'project':self.project,'media':self.media,'warnings':self.warnings,'job':self.job,
                'styles':fx.STYLES,'transitions':{k:v[0] for k,v in fx.TRANSITIONS.items() if k in fx.supported_transitions()},
                'fonts':fx.font_catalog(),'engine':'NORN 0.1.0','sourceName':self.source.name})

    def save(self,p):
        if not isinstance(p,dict) or p.get('schema_version')!=2:raise ValueError('지원하지 않는 프로젝트입니다.')
        if p.get('revision')!=self.project.get('revision'):raise ValueError('다른 화면에서 프로젝트가 바뀌었습니다. 다시 연결한 뒤 편집하세요.')
        q=copy.deepcopy(p);q['title']=text(q.get('title',''),160);q['description']=text(q.get('description',''),6000)
        if not isinstance(q.get('variants'),list) or not 1<=len(q['variants'])<=12:raise ValueError('출력 버전은 1~12개까지입니다.')
        ids=set()
        for v in q['variants']:
            if v.get('id') in ids:raise ValueError('출력 버전 ID 중복')
            ids.add(v.get('id'))
            if v.get('scenes'):validate_variant(v,self.by_id)
        q['revision']=self.project.get('revision',0)+1
        self.store.write_json('norn-project.json',q);self.project=q;return copy.deepcopy(q)

    def start(self,payload,kind):
        with self.mutex:
            if self.job['status']=='running':raise ValueError('이미 처리 중입니다. 완료 또는 취소 후 다시 시작하세요.')
            p=payload.get('project',self.project)
            variant=next((v for v in p['variants'] if v['id']==p['activeVariant']),None)
            if kind=='render':
                variant=validate_variant(variant,self.by_id);check_runtime()
                if payload.get('preview') and payload.get('sceneId'):
                    variant=copy.deepcopy(variant)
                    selected=next((r for r in variant['scenes'] if r['id']==payload['sceneId']),None)
                    if not selected:raise ValueError('미리볼 장면을 선택하세요.')
                    selected['transition']='cut';variant['scenes']=[selected]
            if kind=='concept':
                text(p.get('title',''),160);text(p.get('description',''),6000)
                number(p.get('frames',5),1,20)
                if not p.get('description','').strip():raise ValueError('먼저 콘셉트 내용을 입력하세요.')
            # Validation precedes revision changes, so a failed request never poisons the next render.
            saved=self.save(p);self.cancel.clear();jid=uuid.uuid4().hex
            self.job={'id':jid,'status':'running','phase':kind,'current':0,'total':0,'detail':'준비 중','startedAt':time.time(),'preview':bool(payload.get('preview'))}
            worker=threading.Thread(target=self._worker,args=(kind,variant,copy.deepcopy(saved),payload),daemon=True);worker.start()
            return {'project':saved,'job':copy.deepcopy(self.job)}

    def _worker(self,kind,v,p,payload):
        try:
            if kind=='concept':
                from concept import create_proposal
                result=create_proposal(self,p,payload.get('model','qwen3.5:4b'))
                self.store.write_json('norn-proposal.json',result)
                with self.mutex:self.job.update(status='done',phase='concept',detail='편집 초안 준비 완료 · 확인 후 적용하세요.',proposal=result)
                return
            preview=bool(payload.get('preview'));settings=v['settings'];vid=v['id']
            if preview:
                ratio=min(1,640/max(settings['width'],settings['height']));settings={**settings,'width':round(settings['width']*ratio/2)*2,'height':round(settings['height']*ratio/2)*2}
            stage=Path(tempfile.mkdtemp(prefix='norn-render-',dir=self.store.path('.cache/work/.keep').parent));ss=core.Store(self.source,stage)
            self.job['log']='logs/last-render.log'
            current_expected=0
            def stage_progress(phase,current,total,detail):
                with self.mutex:self.job.update(phase=phase,current=current,total=total,detail=detail,stagePercent=None)
            def heartbeat(status):
                with self.mutex:self.job.update(elapsed=status.get('elapsed_seconds',0),frame=status.get('frame'),outTime=status.get('out_time',''),heartbeatAt=time.time())
            runner=RenderRunner(self.store.path('logs/last-render.log'),self.cancel,heartbeat)
            def run(cmd,timeout=900,**kwargs):
                duration=0
                if '-t' in cmd:
                    try:duration=float(cmd[cmd.index('-t')+1])
                    except (ValueError,IndexError):pass
                def progress(state):
                    heartbeat(state)
                    with self.mutex:
                        try:self.job['stagePercent']=min(99,round(float(state.get('out_time_us',0))/1000000/duration*100)) if duration else None
                        except ValueError:self.job['stagePercent']=None
                runner.heartbeat=progress;return runner.run(cmd,timeout,**kwargs)
            music=self.source_path(v['audio']['music_id']) if v['audio']['music_id'] else None
            args=SimpleNamespace(**settings,_edit_scenes=v['scenes'],_edit_audio=v['audio'],_music_path=music,_music_credit='',
                _edit_hook='',_edit_outro='',_progress_fn=stage_progress,_run_command=run,font=None,threads=2,preset='ultrafast' if preview else 'fast',render_timeout=900,keep_work=False)
            try:
                result=render_timeline(self.media,{'style_preset':'manual'},{},ss,args)
                if self.cancel.is_set():raise RenderCancelled('생성을 취소했습니다.')
                target=self.store.path(f'generated/{vid}/'+('preview.mp4' if preview else 'video.mp4'))
                os.replace(ss.path('generated/sns-video.mp4'),target)
                if not preview:
                    for name in ('cover.jpg','subtitles.srt','storyboard.json','video-script.txt'):
                        os.replace(ss.path('generated/'+name),self.store.path(f'generated/{vid}/'+name))
                    self.store.write_json(f'generated/{vid}/render-plan.json',read_json(stage/'render-plan.json'))
                    self.write_posting(p,v)
                result['path']=str(target.relative_to(self.store.root))
            finally:shutil.rmtree(stage,ignore_errors=True)
            # A published completion permits another request immediately. Finish
            # cleanup and subclass artifact/cache promotion before exposing done.
            with self.mutex:
                self._finalize_render(result,v,p,payload)
                self.job.update(status='done',phase='complete',stagePercent=100,detail='노른노른하게 완성됐어요.',result=result,finishedAt=time.time())
        except Exception as e:
            with self.mutex:self.job.update(status='cancelled' if isinstance(e,RenderCancelled) else 'error',detail=str(e)[:4000],finishedAt=time.time())
            self.store.write_json('logs/last-error.json',{'error':str(e),'job':self.job})

    def _finalize_render(self,result,v,p,payload):
        """Finalize derivatives under the job lock before publishing completion."""
        pass

    def write_posting(self,p,v):
        title=p['title'];body=p['description'];lines=[r.get('caption','') for r in v['scenes'] if r.get('caption')]
        for channel in ['x','instagram','tiktok','threads','facebook','naver_blog','naver_clip']:
            self.store.write(f'sns/{v["id"]}/{channel}/post.txt',title+'\n\n'+body+'\n\n'+'\n'.join(lines))
            paths=[str(self.store.root/f'generated/{v["id"]}/video.mp4')]
            if channel in ('naver_blog','naver_clip'):
                images=[self.source_path(r['source_id']) for r in v['scenes'] if self.by_id[r['source_id']]['kind']=='image']
                paths+=list(dict.fromkeys(map(str,images)))[:9 if channel=='naver_clip' else 120]
            self.store.write(f'sns/{v["id"]}/{channel}/attachment-paths.txt','\n'.join(paths))
        self.store.write('README.md','# '+title+'\n\n'+body+'\n\n원본은 기존 폴더를 참조합니다. SNS 본문은 입력 기반 초안이며 게시 전 길이와 사실을 확인하세요.\n')
        # A local-only gallery references originals; no source copy or upload.
        items=[]
        for m in self.media:
            if m['kind']=='audio':continue
            relative=os.path.relpath(self.source_path(m['id']),self.store.root)
            url=html.escape(urllib.parse.quote(relative,safe='/'),quote=True)
            label=html.escape(m['relative_path'])
            tag=f'<a href="{url}" target="_blank" rel="noopener"><img loading="lazy" src="{url}" alt="{label}"></a>' if m['kind']=='image' else f'<video controls preload="metadata" src="{url}"></video>'
            items.append(f'<figure>{tag}<figcaption>{label}</figcaption></figure>')
        videos=[]
        for vv in p['variants']:
            rel=f'generated/{vv["id"]}/video.mp4'
            if (self.store.root/rel).is_file():videos.append(f'<h2>{html.escape(vv.get("name","영상"))}</h2><video controls preload="metadata" src="{html.escape(rel,quote=True)}"></video>')
        self.store.write('index.html','<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            +'<title>'+html.escape(title)+' · NORN</title><style>body{max-width:1000px;margin:40px auto;padding:0 20px;font:16px/1.7 system-ui;background:#121a17;color:#f6efdd}h1{font-size:32px}p{white-space:pre-wrap}video{max-width:100%;max-height:640px}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}figure{margin:0}img{width:100%;height:220px;object-fit:contain;background:#202b23}figcaption{overflow-wrap:anywhere}small{color:#bac2b7}</style>'
            +'<h1>'+html.escape(title)+'</h1><p>'+html.escape(body)+'</p>'+''.join(videos)+'<h2>원본 자료</h2><section>'+''.join(items)+'</section><p><small>원본은 기존 폴더를 참조합니다. 이 폴더만 다른 곳으로 이동하면 연결이 끊길 수 있습니다. HEIC 등 브라우저 미지원 원본은 시스템 뷰어로 열어주세요.</small></p></html>')


class Server(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self,app,port,origins):
        super().__init__(('127.0.0.1',port),Handler);self.app=app
        self.origin=f'http://127.0.0.1:{self.server_port}'
        self.origins={self.origin,*origins}


class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*args):pass  # Do not log tokens or private source paths.
    def headers_common(self):
        origin=self.headers.get('Origin')
        if origin in self.server.origins:self.send_header('Access-Control-Allow-Origin',origin);self.send_header('Vary','Origin')
        self.send_header('Cache-Control','no-store');self.send_header('Referrer-Policy','no-referrer');self.send_header('X-Content-Type-Options','nosniff')
    def send_json(self,status,data):
        b=json.dumps(data,ensure_ascii=False).encode();self.send_response(status);self.headers_common();self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
    def authorized(self):
        if self.headers.get('Host') not in {f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'}:return False
        if self.headers.get('Origin') and self.headers['Origin'] not in self.server.origins:return False
        q=urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        token=self.headers.get('X-Norn-Token','') or q.get('token',[''])[0]
        return hmac.compare_digest(token,self.server.app.token)
    def do_OPTIONS(self):
        if self.headers.get('Origin') not in self.server.origins:return self.send_json(403,{'error':'허용되지 않은 사이트입니다.'})
        self.send_response(204);self.headers_common();self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS');self.send_header('Access-Control-Allow-Headers','Content-Type, X-Norn-Token');self.send_header('Access-Control-Allow-Private-Network','true');self.send_header('Content-Length','0');self.end_headers()
    def do_GET(self):
        try:
            path=urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
            if path.startswith(('/api/','/media/','/thumb/','/output/','/sample/')):
                if not self.authorized():return self.send_json(403,{'error':'로컬 엔진의 연결 코드를 확인하세요.'})
                app=self.server.app
                if path=='/api/state':return self.send_json(200,app.state())
                if path=='/api/log':return self.send_json(200,{'text':(app.store.root/'logs/last-render.log').read_text(errors='replace')[-60000:] if (app.store.root/'logs/last-render.log').exists() else ''})
                if path.startswith('/thumb/'):return self.file(app.thumb(path[7:]))
                if path.startswith('/media/'):return self.file(app.source_path(path[7:]))
                if path.startswith('/sample/'):return self.file(core.safe_path(app.store.root,'.cache/samples/'+path[8:]))
                if path.startswith('/output/'):return self.file(core.safe_path(app.store.root,'generated/'+path[8:]))
                return self.send_json(404,{'error':'없는 작업입니다.'})
            # Serve public application files only, never the repository or engine folder.
            return self.file(core.safe_path(ROOT/'public','index.html' if path=='/' else path.lstrip('/')))
        except (KeyError,ValueError,FileNotFoundError,OSError) as e:self.send_json(404,{'error':str(e)[:400]})
        except (BrokenPipeError,ConnectionResetError):pass
    def do_POST(self):
        if not self.authorized():return self.send_json(403,{'error':'연결 코드·사이트 권한을 확인하세요.'})
        try:
            if self.headers.get('Content-Type','').split(';')[0]!='application/json':raise ValueError('JSON만 허용합니다.')
            size=int(self.headers.get('Content-Length',0))
            if not 1<=size<=2*1024*1024:raise ValueError('요청이 너무 큽니다.')
            p=json.loads(self.rfile.read(size));path=urllib.parse.urlsplit(self.path).path;app=self.server.app
            with app.mutex:
                if path=='/api/save':return self.send_json(200,{'project':app.save(p['project'])})
                if path=='/api/render':return self.send_json(202,app.start(p,'render'))
                if path=='/api/concept':return self.send_json(202,app.start(p,'concept'))
                if path=='/api/cancel':app.cancel.set();return self.send_json(200,{'ok':True})
                if path=='/api/rescan':
                    if app.job['status']=='running':raise ValueError('현재 작업 완료 후 다시 읽으세요.')
                    app.scan();return self.send_json(200,app.state())
                if path=='/api/overlay':
                    v=p['variant'];r=copy.deepcopy(p['scene']);w=int(number(v['settings']['width'],144,3840));h=int(number(v['settings']['height'],144,3840))
                    r.update(fx.default_scene_fields(r))
                    for key,limit in [('title',100),('caption',240)]:r[key]=text(r.get(key,''),limit)
                    for key in ('title_size','font_size'):r[key]=number(r[key],12,200)
                    if r.get('style') not in fx.STYLES or r.get('font_family') not in fx.FONT_GROUPS:raise ValueError('글씨 스타일 오류')
                    return self.send_json(200,fx.overlay_response(w,h,r))
            self.send_json(404,{'error':'없는 작업입니다.'})
        except (ValueError,TypeError,KeyError) as e:self.send_json(400,{'error':str(e)})
        except Exception as e:self.send_json(500,{'error':str(e)[:2000]})
    def file(self,p):
        size=p.stat().st_size;start=0;end=size-1;status=200
        range_=self.headers.get('Range','')
        if range_:
            import re
            m=re.fullmatch(r'bytes=(\d*)-(\d*)',range_)
            if not m:return self.send_json(416,{'error':'지원하지 않는 범위'})
            if m[1]:start=int(m[1]);end=min(end,int(m[2])) if m[2] else end
            elif m[2]:start=max(0,size-int(m[2]))
            if start>end or start>=size:
                self.send_response(416);self.send_header('Content-Range',f'bytes */{size}');self.send_header('Content-Length','0');self.end_headers();return
            status=206
        self.send_response(status);self.headers_common();self.send_header('Content-Type',mimetypes.guess_type(p)[0] or 'application/octet-stream');self.send_header('Accept-Ranges','bytes')
        if status==206:self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length',str(end-start+1));self.end_headers()
        with p.open('rb') as f:
            f.seek(start);remaining=end-start+1
            while remaining>0:
                block=f.read(min(1024*256,remaining))
                if not block:break
                self.wfile.write(block);remaining-=len(block)


def main():
    ap=argparse.ArgumentParser(description='NORN · 원본은 로컬에, 이야기는 자유롭게')
    ap.add_argument('directory',nargs='?');ap.add_argument('--port',type=int,default=8765);ap.add_argument('--web-origin',action='append',default=[]);ap.add_argument('--no-browser',action='store_true')
    args=ap.parse_args()
    if not args.directory:
        import tkinter as tk
        from tkinter.filedialog import askdirectory
        root=tk.Tk();root.withdraw();args.directory=askdirectory(title='NORN · 원본 사진·영상 폴더');root.destroy()
        if not args.directory:return
    for o in args.web_origin:
        u=urllib.parse.urlsplit(o)
        if u.scheme not in ('https','http') or u.path not in ('','/') or not u.hostname:ap.error('--web-origin은 경로 없는 정확한 사이트 주소입니다.')
    check_runtime();app=App(args.directory);server=Server(app,args.port,[o.rstrip('/') for o in args.web_origin])
    print(f'\nNORN · 노른노른하게, 영상을 굽다.\n로컬 엔진: {server.origin}\n연결 코드: {app.token}\n원본은 읽기 전용입니다.\n종료: Ctrl+C\n',flush=True)
    if not args.no_browser:webbrowser.open(server.origin+'/#connect='+urllib.parse.quote(server.origin+'|'+app.token))
    try:server.serve_forever(.2)
    except KeyboardInterrupt:app.cancel.set()
    finally:server.server_close()

if __name__=='__main__':main()
