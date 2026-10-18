"""Actual browser checks for branch-root, legacy public/, and flat dist/ routes. No OAuth or engine render claims."""
import functools,json,threading
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright
import os,sys
root=Path(__file__).resolve().parents[1]
out=Path(sys.argv[1] if len(sys.argv)>1 else '/tmp/norn-root-ui');out.mkdir(parents=True,exist_ok=True)
class Quiet(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
s=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Quiet,directory=str(root)))
threading.Thread(target=s.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{s.server_port}';results=[]
try:
 with sync_playwright() as p:
  b=p.chromium.launch(headless=True,**({'executable_path':os.environ['NORN_CHROMIUM']} if os.environ.get('NORN_CHROMIUM') else {}))
  for path in ['/', '/public/', '/dist/']:
   page=b.new_page(viewport={'width':1440,'height':1000});errs=[];bad=[]
   page.on('dialog',lambda d:d.accept())
   page.on('pageerror',lambda e:errs.append(str(e)))
   page.on('response',lambda r:bad.append([r.status,r.url]) if r.status>=400 else None)
   page.goto(base+path,wait_until='networkidle',timeout=15000)
   page.locator('.hero h1').wait_for(timeout=5000)
   assert page.url==base+path,page.url
   page.locator('[data-action=enter]').last.click()
   page.locator('.studio').wait_for();assert page.url==base+path+'#studio',page.url
   page.locator('#scene-title').fill('루트 편집 테스트')
   assert page.locator('#scene-title').input_value()=='루트 편집 테스트'
   page.screenshot(path=str(out/(("root" if path=="/" else path.strip("/"))+'-studio.png')))
   page.goto(base+path+'setup.html',wait_until='networkidle')
   page.wait_for_function("!document.querySelector('#config-state').textContent.includes('확인 중')")
   assert '미연결' in page.locator('#project-id').inner_text()
   assert not errs,errs
   assert not bad,bad
   results.append({'path':path,'home':True,'studio':True,'rootPathPreserved':True,'diagnostic':True,'pageErrors':errs,'failedResponses':bad})
   page.close()
  b.close()
finally:s.shutdown();s.server_close()
(out/'result.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
print(json.dumps(results,ensure_ascii=False,indent=2))
