"""Real Chromium ↔ loopback engine E2E. No live Google account or Ollama model.
Run in GitHub Actions, where localhost navigation is allowed. Never fake a pass.
"""
import base64,copy,json,os,sys,tempfile,threading,time,urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'engine'))
import media_core as core
from workspace import WorkspaceApp,WorkspaceServer
from server import new_scene
out=Path(sys.argv[1] if len(sys.argv)>1 else '/tmp/norn-ui');out.mkdir(parents=True,exist_ok=True)
checks=[];errors=[]
with tempfile.TemporaryDirectory() as temp:
 source=Path(temp)/'테스트 원본';source.mkdir();Image.new('RGB',(320,240),(135,154,100)).save(source/'사진.jpg')
 core.run_command(['ffmpeg','-nostdin','-v','error','-y','-f','lavfi','-i','testsrc2=size=192x144:rate=4','-t','8','-c:v','libx264','-threads','1',str(source/'영상.mp4')],30)
 original={p.name:core.file_hash(p) for p in source.iterdir()}
 app=WorkspaceApp(source);v=app.project['variants'][0];v['settings']={'width':240,'height':320,'fps':20};v['name']='시험 영상';v['scenes'][0]['duration']=1
 server=WorkspaceServer(app,0,[]);threading.Thread(target=server.serve_forever,daemon=True).start()
 try:
  with sync_playwright() as pw:
   b=pw.chromium.launch(headless=True,**({'executable_path':os.environ['NORN_CHROMIUM']} if os.environ.get('NORN_CHROMIUM') else {}));page=b.new_page(viewport={'width':1440,'height':1000});page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:d.accept())
   # Test the unconfigured-login branch deliberately; never use production OAuth in CI.
   page.route('**/firebase-config.json',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps({'enabled':False,'firebase':None,'appCheckSiteKey':''})))
   page.goto(server.origin,wait_until='networkidle');page.screenshot(path=str(out/'home.png'),full_page=True);checks.append('homepage loads from actual Python HTTP server')
   page.locator('[data-action=account]').first.click();page.locator('[data-action=login]').click();page.wait_for_selector('.error-box');assert 'Firebase' in page.locator('.error-box').inner_text();page.locator('[data-action=guest]').click();assert page.locator('.clip').count()==3;checks.append('unconfigured Google login fails honestly; explicit local trial works')
   page.goto('about:blank')
   page.goto(server.origin+'/#connect='+urllib.parse.quote(server.origin+'|'+app.token),wait_until='networkidle');page.wait_for_selector('#workflow-nav');assert page.locator('.clip').count()==2;checks.append('authenticated browser-engine pairing loads actual folder')
   page.locator('#library-search').fill('영상');assert page.locator('.asset:visible').count()==1;page.locator('#library-search').fill('');checks.append('resource name filtering')
   page.locator('.asset .view').first.click();assert page.locator('.modal img').count()==1;page.locator('[data-action=view-next]').click();assert page.locator('.modal video').count()==1;page.locator('[data-action=close]').click();checks.append('original photo and video lightbox navigation')
   page.locator('#scene-title').fill('노른 테스트');page.locator('#scene-caption').fill('직접 수정한 문구');page.locator('[data-bind=style]').select_option('editorial');page.wait_for_timeout(450);assert page.locator('#scene-title').input_value()=='노른 테스트';checks.append('scene title/caption editing with native overlay')
   page.locator('[data-action=duplicate]').click();assert page.locator('.clip').count()==3;page.locator('[data-action=delete]').click();assert page.locator('.clip').count()==2;checks.append('duplicate/delete without source deletion')
   page.locator('.clip').last.click();page.wait_for_selector('#trimbar');page.locator('[data-action=speed][data-value="8"]').click();assert page.locator('[data-timing=speed]').input_value()=='8';checks.append('speed and visual trim controls')
   # Use whole source at 8x, one second output.
   page.locator('[data-timing=start][type=number]').fill('0');page.locator('[data-timing=start][type=number]').press('Tab');page.locator('[data-timing=end][type=number]').fill('8');page.locator('[data-timing=end][type=number]').press('Tab');
   page.locator('[data-action=preview]').click();page.wait_for_function("document.querySelector('#player')?.src.includes('/output/')",timeout=60000);page.wait_for_function("document.querySelector('#player')?.readyState>=2",timeout=30000);assert page.evaluate('document.querySelector("#player").duration')<1.2;checks.append('8x preview is a real generated playable MP4')
   page.locator('[data-action=original]').click();page.locator('[data-action=variant-settings]').click();page.locator('#variant-name').fill('완성본');page.locator('[data-action=variant-save]').click();checks.append('editable variant metadata')
   oldjob=app.job.get('id');page.locator('[data-action=render]').click();
   deadline=time.time()+60
   while time.time()<deadline and (app.job.get('id')==oldjob or app.job.get('status')=='running'):page.wait_for_timeout(100)
   assert app.job.get('status')=='done',app.job
   page.wait_for_function("document.querySelector('.progress-rail [data-action=result]') != null",timeout=60000);page.locator('.progress-rail [data-action=result]').click();page.wait_for_selector('.modal video');checks.append('final native encoding verified and playable output offered')
   page.locator('[data-action=close]').click();page.locator('[data-action=posting]').first.click();page.locator('#public-note').fill('공개 소개');page.locator('#post-text').fill('직접 작성한 SNS 문구');page.locator('[data-action=channel][data-channel=x]').click();page.locator('#post-text').fill('X 전용 문구');page.locator('[data-action=posting-save]').click();page.wait_for_timeout(500);assert (app.store.root/'sns/short/x/post.txt').read_text()=='X 전용 문구';checks.append('editable per-channel copy saved to actual text files')
   with page.expect_download() as d:page.locator('[data-action=export-posting]').click()
   assert d.value.suggested_filename.endswith('.zip');checks.append('text-only SNS bundle is downloadable')
   page.locator('[data-action=close]').click();page.screenshot(path=str(out/'studio.png'),full_page=True)
   page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(300);page.evaluate('scrollTo(0,650)');r=page.locator('#progress').bounding_box();assert r and 55<=r['y']<=65;assert page.evaluate('document.documentElement.scrollWidth')<=395;page.screenshot(path=str(out/'mobile.png'),full_page=True);checks.append('mobile layout and always-visible progress panel')
   assert not errors,errors;b.close()
  assert {p.name:core.file_hash(p) for p in source.iterdir()}==original;checks.append('all original file hashes unchanged')
 finally:
  (out/'partial-checks.json').write_text(json.dumps({'checks':checks,'count':len(checks),'pageErrors':errors},ensure_ascii=False,indent=2))
  server.shutdown();server.server_close()
(out/'result.json').write_text(json.dumps({'checks':checks,'count':len(checks),'pageErrors':errors,'scope':'real browser + loopback FFmpeg; Firebase config disabled by a test-only route; live Google OAuth and Ollama not tested'},ensure_ascii=False,indent=2));print(json.dumps(checks,ensure_ascii=False,indent=2))
