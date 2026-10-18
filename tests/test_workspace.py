import copy,json,sys,tempfile,threading,time,unittest,urllib.request,urllib.error,zipfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
from PIL import Image
import media_core as core
from server import new_scene
from workspace import WorkspaceApp,WorkspaceServer,boundary_variant
from story import sample_times,clean_caption,create_proposal

class WorkspaceTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.tmp=tempfile.TemporaryDirectory();cls.source=Path(cls.tmp.name)/'자료';cls.source.mkdir()
  Image.new('RGB',(320,240),(151,165,126)).save(cls.source/'사진.jpg')
  core.run_command(['ffmpeg','-nostdin','-v','error','-y','-f','lavfi','-i','testsrc2=size=192x144:rate=4','-t','8','-c:v','libx264','-threads','1',str(cls.source/'영상.mp4')],30)
  cls.hashes={p.name:(core.file_hash(p),p.stat().st_mtime_ns) for p in cls.source.iterdir()}
  cls.app=WorkspaceApp(cls.source);cls.server=WorkspaceServer(cls.app,0,['http://localhost:5173']);threading.Thread(target=cls.server.serve_forever,daemon=True).start()
 @classmethod
 def tearDownClass(cls):cls.server.shutdown();cls.server.server_close();cls.tmp.cleanup()
 def setUp(self):
  while self.app.batch_running or self.app.job['status']=='running':time.sleep(.05)
 def req(self,path,data=None):
  h={'X-Norn-Token':self.app.token}
  if data is not None:h['Content-Type']='application/json'
  r=urllib.request.Request(self.server.origin+path,None if data is None else json.dumps(data).encode(),h)
  with urllib.request.urlopen(r,timeout=20) as f:return json.loads(f.read())
 def project(self):
  p=copy.deepcopy(self.app.project);v=p['variants'][0];p['variants']=[v];p['activeVariant']=v['id'];v['mode']='short';v['settings']={'width':240,'height':320,'fps':20}
  a=new_scene(next(m for m in self.app.media if m['kind']=='image'));a.update(title='낙지 기록',caption='시험 자료',duration=1,transition='fade',transition_duration=.2)
  b=new_scene(next(m for m in self.app.media if m['kind']=='video'));b.update(title='8배속',start=0,duration=1,source_duration=8,playback_speed=8)
  v['scenes']=[a,b];v['audio'].update(music_id='');p['publicNote']='공개 소개';p['description']='비공개 내부 AI 지시';return p
 def wait(self):
  deadline=time.time()+60
  while (self.app.batch_running or self.app.job['status']=='running') and time.time()<deadline:time.sleep(.05)
  self.assertEqual(self.app.job['status'],'done',self.app.job)
 def test_01_health_is_authenticated_real_runtime(self):
  d=self.req('/api/health');self.assertTrue(d['localOnly']);self.assertIn('ffmpeg version',d['ffmpeg'])
  with self.assertRaises(urllib.error.HTTPError):urllib.request.urlopen(self.server.origin+'/api/health')
 def test_02_save_with_public_settings_and_restore(self):
  p=self.project();p['analysis']={'imageLimit':25,'scope':'folder'};p['token']='DO-NOT-SAVE';r=self.req('/api/save',{'project':p})['project'];self.assertEqual(r['analysis']['imageLimit'],25);self.assertNotIn('DO-NOT-SAVE',json.dumps(r));self.assertTrue(r['assets'])
 def test_03_invalid_id_or_variant_does_not_change_revision(self):
  p=self.project();old=self.app.project['revision'];p['id']='../../private'
  with self.assertRaises(ValueError):self.app.save(p)
  self.assertEqual(old,self.app.project['revision'])
 def test_04_render_and_artifact_metadata(self):
  self.req('/api/render',{'project':self.project()});self.wait();r=self.req('/api/artifacts')['artifacts']['short'];self.assertEqual(r['planned_frames'],36);self.assertAlmostEqual(r['planned_duration'],1.8,delta=.01);self.assertEqual(r['metadata']['width'],240)
 def test_05_preview_cache_reuses_real_render(self):
  p=self.project();sid=p['variants'][0]['scenes'][1]['id'];self.req('/api/render',{'project':p,'preview':True,'sceneId':sid});self.wait();self.assertFalse(self.app.job['result']['cache_hit'])
  p=copy.deepcopy(self.app.project);self.req('/api/render',{'project':p,'preview':True,'sceneId':sid});self.wait();self.assertTrue(self.app.job['result']['cache_hit']);self.assertEqual(len(self.app.project['variants'][0]['scenes']),2)
 def test_06_caption_change_invalidates_preview_cache(self):
  p=copy.deepcopy(self.app.project);row=p['variants'][0]['scenes'][1];row['caption']='다른 자막';self.req('/api/render',{'project':p,'preview':True,'sceneId':row['id']});self.wait();self.assertFalse(self.app.job['result']['cache_hit'])
 def test_07_transition_preview_preserves_original_project(self):
  p=self.project();sid=p['variants'][0]['scenes'][0]['id'];self.req('/api/transition-preview',{'project':p,'sceneId':sid});self.wait();self.assertTrue(self.app.job['transitionPreview']);self.assertEqual(self.app.project['variants'][0]['scenes'],p['variants'][0]['scenes'])
 def test_08_two_versions_batch_actually_renders(self):
  p=self.project();b=copy.deepcopy(p['variants'][0]);b['id']='wide';b['name']='롱폼 시험';b['settings']={'width':320,'height':240,'fps':20};p['variants'].append(b);self.req('/api/render-batch',{'project':p});self.wait();a=self.req('/api/artifacts')['artifacts'];self.assertEqual(set(a),{'short','wide'});self.assertEqual(a['wide']['metadata']['height'],240)
 def test_09_posting_keeps_private_prompt_out_and_never_copies_media(self):
  p=self.project();p['posts']={'short':{'x':'직접 수정한 X 문구'}};r=self.req('/api/posting-save',{'project':p,'variantId':'short'});c={x['id']:x for x in r['channels']};self.assertEqual(c['x']['body'],'직접 수정한 X 문구');self.assertNotIn('비공개',c['naver_blog']['body']);self.assertEqual(len(c['naver_blog']['attachments']),2)
  self.assertFalse(any(f.suffix in ('.jpg','.mp4') for f in (self.app.store.root/'sns').rglob('*')))
 def test_10_export_is_text_only(self):
  r=self.req('/api/export',{'project':self.project(),'variantId':'short'});path=self.app.store.root/'exports'/Path(r['path']).name
  with zipfile.ZipFile(path) as z:self.assertTrue(z.namelist());self.assertTrue(all(Path(n).suffix in ('.txt','.json','.md') for n in z.namelist()))
 def test_11_original_bytes_and_timestamps_preserved(self):
  self.assertEqual({p.name:(core.file_hash(p),p.stat().st_mtime_ns) for p in self.source.iterdir()},self.hashes)
 def test_12_old_revision_blocked_after_save(self):
  p=self.project();self.app.save(p)
  with self.assertRaises(ValueError):self.app.save(p)
 def test_13_metadata_never_exposes_engine_token_or_absolute_input_path(self):
  d=json.dumps(self.app.state());self.assertNotIn(self.app.token,d);self.assertNotIn(str(self.source),json.dumps(self.app.project))
 def test_14_stratified_samples_are_stable_configurable(self):
  a=sample_times(3600,5,'seed');self.assertEqual(a,sample_times(3600,5,'seed'));self.assertNotEqual(a,sample_times(3600,5,'other'));self.assertTrue(all(i*720<t<(i+1)*720 for i,t in enumerate(a)))
 def test_15_conflicting_caption_is_not_accepted(self):
  d=clean_caption({'name':'오징어','title':'문어','caption':'오징어 손질'},{'title':'낙지','description':'수산시장'});self.assertEqual(d,{'name':'','title':'','caption':''})
 def test_16_real_frames_with_mock_AI_and_cache(self):
  p=self.project();p['description']='사용자가 확인한 낙지 기록';p['frames']=3;p['analysis']={'imageLimit':10,'maxScenes':4}
  media=[m for m in self.app.media if m['kind']!='audio']
  def model(_model,prompt,images=None):
   if images:return {'observed':'합성 시험 표본','uncertain':'실제 대상 아님','relevance':'테스트'}
   return {'summary':'모의 대본','scenes':[{'source_id':m['id'],'name':'시험','title':'낙지','caption':'시험 자막','reason':'모의 판단','sample_index':0} for m in media]}
  with patch('story.ollama',return_value={'capabilities':['vision']}),patch('story.ask',side_effect=model):
   a=create_proposal(self.app,p,'local-test');b=create_proposal(self.app,p,'local-test')
  self.assertEqual(a['sample_count'],4);self.assertEqual(b['cache_hits'],2);self.assertTrue(b['plan_cache_hit']);self.assertTrue(all((self.app.store.root/'.cache/samples'/s['file']).exists() for o in a['observations'] for s in o['samples']))
 def test_17_builtin_music_stays_in_output_and_mixes(self):
  data=self.req('/api/music',{});music=[m for m in data['media'] if m.get('builtin')];self.assertEqual(len(music),4)
  p=self.project();p['variants'][0]['audio']['music_id']=music[0]['id'];self.req('/api/render',{'project':p});self.wait();self.assertEqual(self.app.job['result']['audio'],'background_music');self.assertEqual(set(f.name for f in self.source.iterdir()),set(self.hashes))

if __name__=='__main__':unittest.main()
