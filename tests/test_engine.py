import copy, hashlib, json, os, sys, tempfile, threading, time, unittest, urllib.request, urllib.error
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
from PIL import Image
import media_core as core
from server import App, Server, validate_variant, new_scene

class EngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();cls.source=Path(cls.tmp.name)/'media';cls.source.mkdir()
        Image.new('RGB',(320,240),(100,135,98)).save(cls.source/'first.jpg')
        core.run_command(['ffmpeg','-nostdin','-v','error','-y','-f','lavfi','-i','testsrc2=size=192x144:rate=4','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','8','-c:v','libx264','-threads','1','-c:a','aac',str(cls.source/'clip.mp4')],30)
        cls.hashes={p.name:core.file_hash(p) for p in cls.source.iterdir()}
        cls.app=App(cls.source);cls.server=Server(cls.app,0,['http://localhost:5173'])
        threading.Thread(target=cls.server.serve_forever,daemon=True).start()
    @classmethod
    def tearDownClass(cls):cls.server.shutdown();cls.server.server_close();cls.tmp.cleanup()
    def req(self,path,data=None,token=True,origin=None):
        headers={'X-Norn-Token':self.app.token} if token else {}
        if origin:headers['Origin']=origin
        if data is not None:headers['Content-Type']='application/json'
        r=urllib.request.Request(self.server.origin+path,json.dumps(data).encode() if data is not None else None,headers)
        with urllib.request.urlopen(r,timeout=15) as response:return response,json.loads(response.read())
    def wait(self):
        deadline=time.time()+50
        while self.app.job['status']=='running' and time.time()<deadline:time.sleep(.1)
        self.assertEqual(self.app.job['status'],'done',self.app.job)
    def test_01_anonymous_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as cm:self.req('/api/state',token=False)
        self.assertEqual(cm.exception.code,403)
    def test_02_bad_origin_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as cm:self.req('/api/state',origin='https://evil.example')
        self.assertEqual(cm.exception.code,403)
    def test_03_read_and_cors(self):
        r,d=self.req('/api/state',origin='http://localhost:5173');self.assertEqual(len(d['media']),2);self.assertEqual(r.headers['Access-Control-Allow-Origin'],'http://localhost:5173')
    def test_04_traversal_and_symlink(self):
        with self.assertRaises(ValueError):core.safe_path(self.source,'../secret')
        (self.source/'alias').symlink_to(self.source/'first.jpg')
        try:
            with self.assertRaises(ValueError):core.safe_path(self.source,'alias')
        finally:(self.source/'alias').unlink()
    def test_05_invalid_render_does_not_change_revision(self):
        p=copy.deepcopy(self.app.project);rev=p['revision'];p['variants'][0]['scenes'][0]['transition']='invalid-filter'
        with self.assertRaises(ValueError):self.app.start({'project':p},'render')
        self.assertEqual(self.app.project['revision'],rev)
    def test_06_render_real_speed_transition_title(self):
        p=copy.deepcopy(self.app.project);v=p['variants'][0];v['settings']={'width':240,'height':320,'fps':20}
        still=next(m for m in self.app.media if m['kind']=='image');video=next(m for m in self.app.media if m['kind']=='video')
        a=new_scene(still);a.update(title='노른',caption='샘플 영상',duration=1,transition='fade',transition_duration=.2)
        b=new_scene(video);b.update(title='8배속',source_duration=8,playback_speed=8,duration=1,keep_audio=True)
        v['scenes']=[a,b]
        self.app.start({'project':p},'render');self.wait();result=self.app.job['result'];meta=core.probe(self.app.store.root/result['path'])
        self.assertAlmostEqual(meta['duration'],1.8,delta=.06);self.assertEqual(result['planned_frames'],36)
        self.assertTrue((self.app.store.root/'sns/short/naver_blog/post.txt').exists())
        self.assertEqual({p.name:core.file_hash(p) for p in self.source.iterdir()},self.hashes)
    def test_07_single_preview_keeps_full_project(self):
        p=copy.deepcopy(self.app.project);n=len(p['variants'][0]['scenes']);sid=p['variants'][0]['scenes'][-1]['id']
        self.app.start({'project':p,'preview':True,'sceneId':sid},'render');self.wait()
        self.assertEqual(len(self.app.project['variants'][0]['scenes']),n)
        self.assertEqual(self.app.job['result']['scene_count'],1)
    def test_08_token_not_in_public_metadata(self):
        self.assertNotIn(self.app.token,json.dumps(self.app.project));self.assertNotIn(str(self.source),json.dumps(self.app.state()))
    def test_09_range_requests(self):
        m=next(m for m in self.app.media if m['kind']=='video');r=urllib.request.Request(self.server.origin+'/media/'+m['id'],headers={'X-Norn-Token':self.app.token,'Range':'bytes=0-99'})
        with urllib.request.urlopen(r) as res:self.assertEqual(res.status,206);self.assertEqual(len(res.read()),100)
    def test_10_invalid_timing(self):
        v=copy.deepcopy(self.app.project['variants'][0]);r=v['scenes'][-1];r['source_duration']=999
        with self.assertRaises(ValueError):validate_variant(v,self.app.by_id)

if __name__=='__main__':unittest.main()
