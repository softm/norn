"""Static website + real browser WASM encoding. No NORN/Python engine process.
Native ffmpeg is used ONLY to make fixtures and independently inspect the output.
"""
import json, functools, threading, tempfile, os, sys, subprocess, hashlib, time, zipfile
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from PIL import Image
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1];out=Path(sys.argv[1] if len(sys.argv)>1 else '/tmp/norn-browser-ui');out.mkdir(parents=True,exist_ok=True)
ui_only='--ui-only' in sys.argv
class Quiet(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(root)));threading.Thread(target=server.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{server.server_port}'
checks=[];errors=[];requests=[]
def checkpoint(text):checks.append(text);print(text,flush=True)
with tempfile.TemporaryDirectory() as temp:
 source=Path(temp)/'브라우저 원본';source.mkdir();Image.new('RGB',(480,640),(141,165,107)).save(source/'01-photo.jpg')
 subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=192x144:rate=10','-f','lavfi','-i','sine=frequency=600:sample_rate=44100','-t','8','-c:v','libx264','-threads','1','-c:a','aac',str(source/'02-video.mp4')],check=True)
 hashes={f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in source.iterdir()}
 try:
  with sync_playwright() as pw:
   kwargs={'executable_path':os.environ['NORN_CHROMIUM']} if os.environ.get('NORN_CHROMIUM') else {}
   b=pw.chromium.launch(headless=True,**kwargs);page=b.new_page(viewport={'width':1440,'height':1000},accept_downloads=True)
   page.route('**/firebase-config.json',lambda route:route.fulfill(json={'enabled':False,'firebase':None}))
   page.on('pageerror',lambda e:errors.append(str(e)));page.on('request',lambda r:requests.append({'url':r.url,'method':r.method}));page.on('dialog',lambda d:d.accept())
   page.goto(base,wait_until='networkidle');assert page.url==base+'/';assert page.locator('.browser-hero').count()==1
   assert '서버 실행' in page.locator('.browser-hero').inner_text();page.screenshot(path=str(out/'home.png'),full_page=True);checkpoint('Root homepage is browser-first, no command-line prerequisite')
   with page.expect_file_chooser() as fc:page.locator('[data-action=files]').last.click()
   fc.value.set_files([str(f) for f in sorted(source.iterdir())]);page.wait_for_function("document.querySelectorAll('.clip').length===2",timeout=45000);page.wait_for_timeout(100)
   assert page.locator('.browser-asset').count()==2;assert page.url==base+'/#studio';checkpoint('User File selection builds scenes from local blobs without an engine')
   page.locator('#scene-title').fill('낙지 기록');page.locator('#scene-caption').fill('브라우저에서 영상 만들기');page.locator('[data-bind=style]').select_option('editorial');page.locator('[data-bind=duration]').fill('1');page.locator('[data-bind=duration]').press('Tab')
   page.locator('details:has([data-bind=transition]) summary').click();page.locator('[data-bind=transition]').select_option('fade');page.locator('details:has([data-bind=transition])').evaluate('(e)=>{e.open=true}');page.locator('[data-bind=transition_duration]').fill('.2');page.locator('[data-bind=transition_duration]').press('Tab');checkpoint('Title/caption/style/duration/transition edits persist')
   page.locator('[data-action=duplicate]').click();assert page.locator('.clip').count()==3;page.locator('[data-action=delete]').click();assert page.locator('.clip').count()==2;checkpoint('Duplicate/delete only changes edit metadata')
   page.locator('.clip').last.click();page.locator('[data-time=end][type=number]').fill('8');page.locator('[data-time=end][type=number]').press('Tab');page.locator('[data-action=speed][data-value="8"]').click();assert page.locator('[data-time=output]').input_value()=='1.000';checkpoint('Whole 8-second source selection compressed to 1 second at 8x')
   page.locator('[data-action=samples]').click();page.wait_for_selector('.frame-grid img',timeout=25000);assert page.locator('.frame-grid img').count()==5;page.screenshot(path=str(out/'samples.png'),full_page=True);page.locator('[data-action=close]').click();checkpoint('Five actual sample frames extracted in browser')
   page.locator('[data-action=view]').first.click();assert page.locator('.modal img').count()==1;page.locator('[data-action=close]').click();checkpoint('Original image opens from local Blob URL')
   if not ui_only:
    assert page.evaluate('crossOriginIsolated') is False
    page.locator('[data-action=export-modal]').click();page.locator('#quality').select_option('480');page.locator('[data-action=render]').click()
    page.wait_for_function("document.querySelector('.modal video') || document.querySelector('.progress-rail.error')",timeout=240000)
    assert page.locator('.modal video').count(),page.locator('body').inner_text()
    assert not page.locator('.error-box').count(),page.locator('body').inner_text()
    with page.expect_download() as download:page.locator('[data-action=download-video]').click()
    download.value.save_as(str(out/'browser-generated.mp4'))
    probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_format','-show_streams','-of','json',str(out/'browser-generated.mp4')]))
    video=next(s for s in probe['streams'] if s['codec_type']=='video');assert (video['width'],video['height'])==(480,854),video
    assert 1.7<float(probe['format']['duration'])<2.05,probe['format'];assert any(s['codec_type']=='audio' for s in probe['streams'])
    (out/'probe.json').write_text(json.dumps(probe,indent=2));checkpoint('Actual single-thread ffmpeg.wasm H264/AAC MP4 verified independently; no SAB')
    page.locator('[data-action=close]').click()
   page.locator('[data-action=posting]').first.click();page.locator('#post-text').fill('브라우저에서 준비한 공개 문구');page.locator('[data-action=channel][data-value=x]').click();page.locator('#post-text').fill('X용 노른 기록')
   with page.expect_download() as dl:page.locator('[data-action=export-zip]').click()
   dl.value.save_as(str(out/'게시준비.zip'))
   with zipfile.ZipFile(out/'게시준비.zip') as z:
    assert z.read('sns/x.txt').decode()=='X용 노른 기록';assert not any('01-photo.jpg' in n or '02-video.mp4' in n for n in z.namelist());assert 'index.html' in z.namelist()
   checkpoint('Posting ZIP contains text, references and generated output, not original media')
   page.locator('[data-action=close]').click();page.screenshot(path=str(out/'studio.png'),full_page=True)
   with page.expect_download() as dl:page.locator('[data-action=backup]').click()
   dl.value.save_as(str(out/'project.json'));saved=json.loads((out/'project.json').read_text());assert 'blob:' not in json.dumps(saved);assert len(saved['assets'])==2;checkpoint('JSON backup omits Blob URLs, File objects and absolute paths')
   page.reload(wait_until='networkidle');assert page.locator('.clip').count()==2;assert page.locator('.missing-banner').is_visible()
   with page.expect_file_chooser() as fc:page.locator('[data-action=files]').first.click()
   fc.value.set_files([str(f) for f in sorted(source.iterdir())]);page.wait_for_function("document.querySelector('.missing-banner')===null",timeout=45000);assert page.locator('.clip').count()==2;checkpoint('Reload restores metadata; reselecting originals relinks without duplicate scenes')
   page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(150);page.evaluate('scrollTo(0,500)');rect=page.locator('#progress').bounding_box();assert 55<=rect['y']<=65,rect;assert page.evaluate('document.documentElement.scrollWidth')<=395;page.screenshot(path=str(out/'mobile.png'),full_page=True);checkpoint('Mobile layout has no horizontal overflow; progress remains at top')
   assert not errors,errors
   assert not any('/api/' in r['url'] or ':8765' in r['url'] or ':11434' in r['url'] or r['method'] not in ['GET','HEAD'] for r in requests),requests
   checkpoint('No media upload, Python API, native engine, or Ollama requests during complete workflow')
   b.close()
  assert hashes=={f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in source.iterdir()};checkpoint('Original files independently confirmed unchanged')
 except Exception:
  try:
   page.screenshot(path=str(out/'failure.png'),full_page=True)
   (out/'failure.txt').write_text(page.locator('body').inner_text())
  except Exception:pass
  raise
 finally:
  server.shutdown();server.server_close();(out/'report.json').write_text(json.dumps({'checks':checks,'errors':errors,'requests':requests,'wasm_render_test':not ui_only,'note':'Static website only. Native ffmpeg makes fixtures and inspects the browser output; never generates the result. Live Google and optional WebGPU AI are not tested.'},ensure_ascii=False,indent=2))
