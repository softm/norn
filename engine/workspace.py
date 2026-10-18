"""NORN 0.2: workspace lifecycle, safe exports and loopback-only diagnostics.
No raw media copies; cloud configuration never grants access to local paths.
"""
from __future__ import annotations
import copy, hashlib, html, json, math, os, re, time, urllib.parse, uuid, zipfile, threading
from pathlib import Path
import media_core as core
from server import App, Handler, Server, validate_variant, text, number
from render_runtime import check_runtime

VERSION='0.2.0'
CHANNELS={'instagram':'인스타그램','tiktok':'틱톡','x':'X','threads':'스레드','facebook':'페이스북','naver_blog':'네이버 블로그','naver_clip_video':'클립 영상','naver_clip_mixed':'클립 사진+영상','youtube':'YouTube'}

def identifier(s):
    if not isinstance(s,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',s):raise ValueError('프로젝트/장면 식별자 오류')
    return s

def fingerprint(v,by_id):
    q=copy.deepcopy(v);q.pop('name',None);q.pop('mode',None);q.pop('targetDuration',None)
    for s in q['scenes']:
        for key in ('id','name','field_locks','reason'):s.pop(key,None)
    q['sources']={s['source_id']:by_id[s['source_id']].get('sha256') for s in q['scenes']}
    mid=q.get('audio',{}).get('music_id')
    if mid:q['music_sha']=by_id[mid].get('sha256')
    return hashlib.sha256(json.dumps(q,sort_keys=True,ensure_ascii=False).encode()).hexdigest()

def boundary_variant(value,sid):
    v=copy.deepcopy(value);rows=v['scenes']
    i=next((i for i,s in enumerate(rows) if s['id']==sid),-1)
    if i<0 or i>=len(rows)-1:raise ValueError('다음 장면이 있는 경계를 선택하세요.')
    a,b=copy.deepcopy(rows[i]),copy.deepcopy(rows[i+1])
    for row,last in ((a,True),(b,False)):
        span=min(row['duration'],max(1.2,a['transition_duration']*2))
        if last:row['start']+=max(0,row['source_duration']-span*row.get('playback_speed',1))
        row['duration']=span;row['source_duration']=span*row.get('playback_speed',1)
    b['transition']='cut';v['scenes']=[a,b];return v

class WorkspaceApp(App):
    def __init__(self,source):
        self.builtin={}
        super().__init__(source)
        self.runtime=check_runtime()
        self.batch_running=False;self.batch_info={}
        self.project.setdefault('analysis',{})
        self.project.setdefault('publicNote','')
        self.project.setdefault('posts',{})
        if any(str(v.get('audio',{}).get('music_id','')).startswith('builtin-') for v in self.project['variants']):self.prepare_music()
        self.project['assets']=self.asset_manifest()
        for v in self.project['variants']:
            v.setdefault('mode','free');v.setdefault('targetDuration',self.project.get('targetDuration',30))
        # Restore completed/cancelled job only, never claim a dead process is still rendering.
        old=core.safe_path(self.store.root,'last-job.json',False)
        if old.exists():
            try:
                status=json.loads(old.read_text())
                if status.get('status')=='running':status.update(status='interrupted',detail='엔진이 재시작되었습니다. 편집을 확인하고 다시 생성하세요.')
                self.job=status
            except (ValueError,OSError):pass
        self.store.write_json('norn-project.json',self.project)

    def scan(self):
        super().scan()
        self.media+=list(getattr(self,'builtin',{}).values())
        self.by_id.update(getattr(self,'builtin',{}))

    def source_path(self,sid):
        if sid in getattr(self,'builtin',{}):return core.safe_path(self.store.root,self.builtin[sid]['cache_path'])
        return super().source_path(sid)

    def prepare_music(self):
        from music import synthesize
        for f in synthesize(self.store.path('.cache/music/.keep').parent):
            path=f['path'];st=path.stat();sid='builtin-'+f['key']
            self.builtin[sid]={'id':sid,'sha256':core.file_hash(path),'kind':'audio','relative_path':'내장 루프 · '+f['title'],
                'cache_path':str(path.relative_to(self.store.root)),'size':st.st_size,'stat':f'{st.st_size}:{st.st_mtime_ns}',
                'analysis':{'width':0,'height':0,'duration':f['duration'],'has_audio':True},'builtin':True}
        self.media=[m for m in self.media if not m.get('builtin')]+list(self.builtin.values());self.by_id.update(self.builtin)
        return {'media':copy.deepcopy(self.media),'notice':'프로그램이 만든 간단한 합성 기악 루프입니다. 외부 샘플·유명곡은 포함하지 않습니다.'}

    def asset_manifest(self):
        return [{k:m[k] for k in ('id','sha256','size','kind')} for m in self.media][:600]

    def save(self,p):
        identifier(p.get('id'));identifier(p.get('activeVariant'))
        if p.get('activeVariant') not in [v.get('id') for v in p.get('variants',[])]:raise ValueError('선택된 출력 버전이 없습니다.')
        number(p.get('targetDuration',30),1,3600);n=number(p.get('frames',5),1,20)
        if int(n)!=n:raise ValueError('분석 장수는 정수입니다.')
        q=copy.deepcopy(p)
        q['publicNote']=text(q.get('publicNote',''),6000)
        q['assets']=self.asset_manifest()
        allowed={key:q[key] for key in ('schema_version','id','revision','title','description','frames','targetDuration','activeVariant','variants','assets','publicNote')}
        options=q.get('analysis',{})
        if not isinstance(options,dict):raise ValueError('분석 설정 오류')
        allowed['analysis']={}
        for key,default,lo,hi in [('imageLimit',100,1,600),('frameSize',640,256,960),('maxScenes',12,1,120),('seed',0,0,999999)]:
            allowed['analysis'][key]=int(number(options.get(key,default),lo,hi))
        allowed['analysis']['order']=options.get('order','concept')
        allowed['analysis']['scope']=options.get('scope','folder')
        allowed['analysis']['fullVideo']=bool(options.get('fullVideo',False))
        if allowed['analysis']['order'] not in ('concept','source','current') or allowed['analysis']['scope'] not in ('folder','timeline'):raise ValueError('분석 방식 오류')
        allowed['posts']={}
        for vid,rows in q.get('posts',{}).items():
            identifier(vid)
            if not isinstance(rows,dict):raise ValueError('게시 문구 형식 오류')
            allowed['posts'][vid]={ch:text(rows[ch],12000) for ch in CHANNELS if ch in rows}
        for v in allowed['variants']:
            identifier(v.get('id'));v['name']=text(v.get('name',''),160)
            v['mode']=v.get('mode','free')
            if v['mode'] not in ('short','long','timelapse','photo','free'):raise ValueError('영상 모드 오류')
            v['targetDuration']=number(v.get('targetDuration',30),1,3600)
            for s in v.get('scenes',[]):identifier(s.get('id'))
        result=super().save(allowed)
        return result

    def state(self):
        r=super().state();r['engine']='NORN '+VERSION;r['assets']=self.asset_manifest()
        
        if self.batch_running:
            r['job']={**r['job'],'status':'running','batch':copy.deepcopy(self.batch_info)}
        r['artifacts']=self.artifacts();r['capabilities']={'posts':True,'archive':True,'previewCache':True,'frames':True,'relink':True}
        return r

    def artifacts(self):
        result={}
        for v in self.project['variants']:
            vid=identifier(v['id']);p=self.store.root/f'generated/{vid}/result.json'
            try:
                d=json.loads(p.read_text());video=core.safe_path(self.store.root,d['path'])
                if video.is_file():result[vid]={k:d[k] for k in ('path','sha256','size','planned_duration','planned_frames','metadata','scene_count','fingerprint','createdAt') if k in d}
            except (ValueError,KeyError,OSError):continue
        return result

    def start(self,payload,kind):
        # Capture input hashes and edit snapshot. No in-flight edits leak into this job.
        request=copy.deepcopy(payload)
        p=request.get('project',self.project)
        if self.batch_running:raise ValueError('여러 버전을 순서대로 생성 중입니다.')
        if kind=='render':
            v=next((v for v in p['variants'] if v['id']==p['activeVariant']),None)
            v=validate_variant(v,self.by_id)
            if request.get('preview') and request.get('sceneId'):
                selected=next((s for s in v['scenes'] if s['id']==request['sceneId']),None)
                if not selected:raise ValueError('미리볼 장면이 없습니다.')
                v['scenes']=[selected];selected['transition']='cut'
            if request.get('boundaryId'):v=boundary_variant(v,request['boundaryId'])
            request['_fingerprint']=fingerprint(v,self.by_id)
            # Native ffmpeg input bytes must still match the selected originals.
            for sid in {row['source_id'] for row in v['scenes']} | ({v['audio']['music_id']} if v.get('audio',{}).get('music_id') else set()):
                m=self.by_id[sid];st=self.source_path(m['id']).stat()
                if m['stat']!=f'{st.st_size}:{st.st_mtime_ns}':raise ValueError('원본이 변경되었습니다. 원본 다시 읽기 후 검토하세요.')
        result=super().start(request,kind)
        self.store.write_json('last-job.json',self.job)
        return result

    def _worker(self,kind,v,p,payload):
        key=payload.get('_fingerprint','')
        if payload.get('boundaryId'):v=boundary_variant(v,payload['boundaryId'])
        with self.mutex:
            self.job.update(variantId=v['id'] if v else p['activeVariant'],sceneId=payload.get('sceneId'),transitionPreview=bool(payload.get('boundaryId')))
        vid=v['id'] if v else p['activeVariant']
        cache=self.store.path(f'.cache/previews/{key}.json') if key else None
        if kind=='render' and payload.get('preview') and cache and cache.exists():
            try:
                result=json.loads(cache.read_text());file=core.safe_path(self.store.root,result['path'])
                if file.is_file() and result.get('size')==file.stat().st_size and core.file_hash(file)==result.get('sha256'):
                    with self.mutex:self.job.update(status='done',phase='complete',result={**result,'cache_hit':True},detail='저장된 배속 미리보기를 재사용했습니다.',stagePercent=100,finishedAt=time.time())
                    self.store.write_json('last-job.json',self.job);return
            except (OSError,ValueError,KeyError):pass
        if kind=='concept':
            try:
                from story import create_proposal
                result=create_proposal(self,p,payload.get('model','qwen3.5:4b'))
                self.store.write_json('norn-proposal.json',result)
                with self.mutex:self.job.update(status='done',phase='concept',proposal=result,detail='편집 초안 준비 완료 · 확인 후 적용하세요.',finishedAt=time.time())
            except Exception as exc:
                from render_runtime import RenderCancelled
                with self.mutex:self.job.update(status='cancelled' if isinstance(exc,RenderCancelled) else 'error',detail=str(exc)[:2000],finishedAt=time.time())
        else:
            super()._worker(kind,v,p,payload)
        with self.mutex:
            if self.job['status']=='done' and kind=='render':
                result=self.job['result'];result.update(fingerprint=key,createdAt=time.time(),variantId=vid)
                if payload.get('preview'):
                    target=self.store.path(f'generated/{vid}/preview-{key[:24]}.mp4')
                    old=core.safe_path(self.store.root,result['path'])
                    os.replace(old,target);result['path']=str(target.relative_to(self.store.root))
                    self.store.write_json(f'.cache/previews/{key}.json',result)
                else:self.store.write_json(f'generated/{vid}/result.json',result)
            if self.cancel.is_set() and self.job['status']=='error':self.job.update(status='cancelled',detail='분석을 취소했습니다. 기존 편집은 유지됩니다.')
            self.store.write_json('last-job.json',self.job)

    def start_batch(self,p):
        with self.mutex:
            if self.batch_running or self.job['status']=='running':raise ValueError('이미 생성 중입니다.')
            variants=[validate_variant(v,self.by_id) for v in p['variants'] if v.get('scenes')]
            if not variants:raise ValueError('장면이 있는 출력 버전이 없습니다.')
            # Check all source revisions before any save or output.
            for v in variants:
                for sid in {row['source_id'] for row in v['scenes']} | ({v['audio']['music_id']} if v.get('audio',{}).get('music_id') else set()):
                    m=self.by_id[sid];st=self.source_path(m['id']).stat()
                    if m['stat']!=f'{st.st_size}:{st.st_mtime_ns}':raise ValueError('원본이 변경되었습니다. 다시 읽고 확인하세요.')
            saved=self.save(p);self.cancel.clear();jid=uuid.uuid4().hex
            self.batch_running=True;self.batch_info={'current':1,'total':len(variants),'results':[]}
            self.job={'id':jid,'status':'running','phase':'render','current':0,'total':len(variants),'startedAt':time.time(),'detail':'전체 버전 순차 생성 준비'}
            threading.Thread(target=self._batch,args=(jid,saved,variants),daemon=True).start()
            return {'project':saved,'job':self.state()['job']}

    def _batch(self,jid,p,variants):
        results=[]
        try:
            for i,v in enumerate(variants):
                if self.cancel.is_set():break
                with self.mutex:
                    self.batch_info.update(current=i+1,name=v['name'])
                    self.job.update(id=jid+'-'+str(i),status='running',phase='render',preview=False,detail='버전 '+v['name'],result=None)
                self._worker('render',v,p,{'_fingerprint':fingerprint(v,self.by_id)})
                results.append({'variantId':v['id'],'name':v['name'],'status':self.job['status'],'detail':self.job.get('detail','')})
                with self.mutex:self.batch_info['results']=copy.deepcopy(results)
            with self.mutex:
                failed=any(r['status']=='error' for r in results)
                self.job.update(id=jid,status='cancelled' if self.cancel.is_set() else 'error' if failed else 'done',phase='complete',preview=False,
                    batch=copy.deepcopy(self.batch_info),detail='전체 버전 생성 취소' if self.cancel.is_set() else '일부 버전 실패 · 완료된 영상은 유지' if failed else f'{len(results)}개 출력 버전을 완성했습니다.',finishedAt=time.time())
        finally:
            with self.mutex:
                self.batch_running=False
                self.store.write_json('last-job.json',self.job)

    def posting_data(self,p,vid):
        v=next((v for v in p['variants'] if v['id']==vid),None)
        if not v:raise ValueError('출력 버전이 없습니다.')
        rows=[];seen=set();images=[]
        for r in v['scenes']:
            m=self.by_id.get(r['source_id'])
            if m and m['kind']=='image' and m['id'] not in seen:
                seen.add(m['id']);images.append({'source_id':m['id'],'path':str(self.source_path(m['id'])),'name':m['relative_path'],'caption':r.get('caption','')})
        video=self.store.root/f'generated/{vid}/video.mp4'
        caption_lines=list(dict.fromkeys(s['caption'].strip() for s in v['scenes'] if s.get('caption','').strip()))
        note=p.get('publicNote','')
        for ch,label in CHANNELS.items():
            captions=caption_lines[:1] if ch in ('x','threads') else caption_lines
            body=p.get('posts',{}).get(vid,{}).get(ch)
            if body is None:body='\n\n'.join(x for x in [p['title'],note,'\n'.join(captions)] if x.strip())
            files=[{'path':str(video),'role':'video','exists':video.is_file()}]
            if ch=='naver_blog':files += images
            if ch=='naver_clip_mixed':files += images[:9]
            warnings=[]
            if not video.is_file():warnings.append('아직 최종 영상이 생성되지 않았습니다.')
            if ch=='naver_clip_mixed' and len(images)>9:warnings.append('게시 묶음에는 사진 9장까지 포함합니다. 나머지 원본은 보존됩니다.')
            rows.append({'id':ch,'label':label,'title':p['title'],'body':body,'attachments':files,'warnings':warnings})
        return {'variantId':vid,'channels':rows,'ready':video.is_file(),'note':'원본 미디어는 복사하지 않습니다. 문구는 복사하고 파일은 원래 위치에서 직접 첨부하세요.'}

    def write_posting(self,p,v):
        # Preserve the simple gallery, then replace internal-concept text with approved public copy.
        public=copy.deepcopy(p);public['description']=p.get('publicNote','')
        super().write_posting(public,v)
        data=self.posting_data(p,v['id'])
        for ch in data['channels']:
            root=f'sns/{v["id"]}/{ch["id"]}/'
            self.store.write(root+'post.txt',ch['body'])
            self.store.write(root+'title.txt',ch['title'])
            self.store.write_json(root+'attachments.json',ch['attachments'])
            self.store.write(root+'attachment-paths.txt','\n'.join(a['path'] for a in ch['attachments']))
            self.store.write(root+'instructions.md','# '+ch['label']+'\n\n본문을 복사한 뒤 표시된 로컬 파일을 첨부하세요.\n\n'+'\n'.join(ch['warnings']))
        self.store.write_json(f'sns/{v["id"]}/posting.json',data)
        self.write_posting_html(p)

    def write_posting_html(self,p):
        cards=[]
        for v in p['variants']:
            data=self.posting_data(p,v['id'])
            for c in data['channels']:
                cards.append('<section><h2>'+html.escape(v['name']+' · '+c['label'])+'</h2><textarea readonly>'+html.escape(c['body'])+'</textarea><button onclick="copyText(this)">문구 복사</button><details><summary>첨부할 로컬 파일</summary><pre>'+html.escape('\n'.join(a['path'] for a in c['attachments']))+'</pre></details></section>')
        self.store.write('posting.html','<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NORN · 게시 준비</title><style>body{max-width:1000px;margin:32px auto;padding:20px;background:#161a16;color:#eee7d3;font:15px/1.6 system-ui}section{padding:18px;margin:16px 0;border:1px solid #49503e;border-radius:12px}textarea{box-sizing:border-box;width:100%;min-height:160px;padding:12px;background:#252a21;color:inherit;border:1px solid #5a604a}button{padding:10px;margin:10px 0;background:#eabb65;border:0;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>'+html.escape(p['title'])+' · 게시 준비</h1><p>원본은 기존 폴더에 있습니다. 파일 경로와 문구가 포함되므로 이 페이지를 공개 배포하기 전에 확인하세요.</p>'+''.join(cards)+'<script>async function copyText(b){const t=b.previousElementSibling;try{await navigator.clipboard.writeText(t.value);b.textContent="복사됨"}catch{t.focus();t.select();b.textContent="Command+C / Ctrl+C로 복사"}}</script></html>')

    def export_text_bundle(self,vid):
        identifier(vid);v=next(v for v in self.project['variants'] if v['id']==vid)
        self.write_posting(self.project,v)
        target=self.store.path(f'exports/{vid}-posting.zip');pending=target.with_suffix('.pending')
        base=self.store.root/f'sns/{vid}'
        with zipfile.ZipFile(pending,'w',zipfile.ZIP_DEFLATED) as z:
            for f in sorted(base.rglob('*')):
                if f.is_file() and f.suffix in ('.txt','.json','.md'):z.write(f,str(f.relative_to(base)))
            z.writestr('README.txt','이 ZIP에는 게시 문구와 로컬 첨부 경로만 들어 있습니다. 원본 이미지·영상과 생성 MP4는 복제하지 않습니다.\n')
        os.replace(pending,target);return {'path':f'/bundle/{vid}-posting.zip','bytes':target.stat().st_size}

class WorkspaceHandler(Handler):
    def do_GET(self):
        route=urllib.parse.urlsplit(self.path).path
        if route in ('/api/health','/api/posting','/api/artifacts') or route.startswith('/bundle/'):
            if not self.authorized():return self.send_json(403,{'error':'연결 권한이 없습니다.'})
            app=self.server.app
            try:
                query=urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                if route=='/api/health':return self.send_json(200,{'version':VERSION,'ffmpeg':app.runtime['version'],'sourceCount':len(app.media),'localOnly':True})
                if route=='/api/artifacts':return self.send_json(200,{'artifacts':app.artifacts()})
                if route=='/api/posting':return self.send_json(200,app.posting_data(app.project,query.get('variant',[app.project['activeVariant']])[0]))
                return self.file(core.safe_path(app.store.root,'exports/'+urllib.parse.unquote(route[len('/bundle/'):])) )
            except (OSError,ValueError,KeyError) as e:return self.send_json(400,{'error':str(e)})
        return super().do_GET()

    def do_POST(self):
        route=urllib.parse.urlsplit(self.path).path
        if route not in ('/api/export','/api/posting-save','/api/render-batch','/api/transition-preview','/api/music'):return super().do_POST()
        if not self.authorized():return self.send_json(403,{'error':'연결 권한이 없습니다.'})
        try:
            if self.headers.get('Content-Type','').split(';')[0]!='application/json':raise ValueError('JSON만 허용합니다.')
            size=int(self.headers.get('Content-Length',0))
            if not 1<=size<=2*1024*1024:raise ValueError('요청 크기 오류')
            body=json.loads(self.rfile.read(size));app=self.server.app
            with app.mutex:
                if route=='/api/music':return self.send_json(200,app.prepare_music())
                if route=='/api/render-batch':return self.send_json(202,app.start_batch(body['project']))
                if route=='/api/transition-preview':return self.send_json(202,app.start({'project':body['project'],'preview':True,'boundaryId':identifier(body['sceneId'])},'render'))
                if app.job.get('status')=='running' or app.batch_running:raise ValueError('현재 작업 완료 후 게시 자료를 저장하세요.')
                if 'project' in body:app.save(body['project'])
                vid=identifier(body.get('variantId',app.project['activeVariant']))
                if route=='/api/export':result=app.export_text_bundle(vid)
                else:
                    v=next(v for v in app.project['variants'] if v['id']==vid);app.write_posting(app.project,v);result=app.posting_data(app.project,vid)
                return self.send_json(200,{'project':app.project,**result})
        except (ValueError,TypeError,KeyError,StopIteration) as e:self.send_json(400,{'error':str(e)})

class WorkspaceServer(Server):
    def __init__(self,app,port,origins):
        super().__init__(app,port,origins);self.RequestHandlerClass=WorkspaceHandler
