"""Offline DOM/layout smoke checks. Network, OAuth and browser persistence are NOT verified.
The environment blocks browser navigation. Application modules are combined in-memory;
only the disabled Firebase configuration and browser storage are replaced for this test.
Native HTTP and FFmpeg are covered independently by test_engine.py.
"""
import json,re,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1];out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
def bundle(name,src,imports=''):
 exports=re.findall(r'export\s+(?:(?:async\s+)?function|const)\s+(\w+)',src)
 src=re.sub(r'^import .*?;\s*$','',src,flags=re.M).replace('export ','')
 return f'const {name}=(()=>{{{imports}\n{src}\nreturn {{{",".join(exports)}}};}})();'
domain=bundle('D',(root/'public/domain.js').read_text())
settings=bundle('Settings',(root/'public/firebase-config-utils.js').read_text())
cloud=bundle('Cloud',(root/'public/firebase.js').read_text(),'const {cloudProject}=D; const {normalizeConfig,authMessage}=Settings;')
app=re.sub(r'^import .*?;\s*$','',(root/'public/app.js').read_text(),flags=re.M)
setup="""
const store=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)}};
Object.defineProperty(window,'localStorage',{value:store()});Object.defineProperty(window,'sessionStorage',{value:store()});
if(!crypto.randomUUID)crypto.randomUUID=()=>{const b=crypto.getRandomValues(new Uint8Array(16));return Array.from(b,x=>x.toString(16).padStart(2,'0')).join('')};
window.fetch=async url=>{if(url==='./firebase-config.json')return new Response(JSON.stringify({enabled:false,firebase:null}),{status:200,headers:{'Content-Type':'application/json'}});throw Error('Offline smoke test: external requests disabled')};
"""
html='<html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>'+(root/'public/style.css').read_text()+'</style></head><body><div id="app"></div><div id="modal-root"></div><div id="toast"></div></body></html>'
checks=[];errors=[]
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']);t=b.new_page(viewport={'width':1440,'height':1000});t.on('pageerror',lambda e:errors.append(str(e)));t.set_content(html);t.add_script_tag(content=setup+domain+settings+cloud+app);t.wait_for_timeout(500)
 if errors: print('START_ERRORS',errors,flush=True)
 t.screenshot(path=str(out/'home-desktop.png'),full_page=True);checks.append('landing renders with bundled local samples')
 t.locator('[data-action=account]').first.click();t.locator('[data-action=login]').click();t.wait_for_selector('.error-box');assert 'Firebase' in t.locator('.error-box').inner_text();checks.append('unconfigured Firebase shows error instead of false login')
 t.locator('[data-action=guest]').click();t.wait_for_selector('.track');assert t.locator('.clip').count()==3;checks.append('explicit sample trial')
 t.locator('#scene-title').fill('노른노른한 오후');t.locator('#scene-caption').click();assert t.locator('#scene-title').input_value()=='노른노른한 오후';checks.append('editable scene titles')
 t.locator('[data-action=duplicate]').click();assert t.locator('.clip').count()==4;t.locator('[data-action=delete]').click();assert t.locator('.clip').count()==3;checks.append('duplicate/delete scene')
 t.locator('[data-action=moveleft]').click();checks.append('scene reordering')
 t.locator('[data-action=newvariant]').click();t.locator('#new-name').fill('가로형 이야기');t.locator('#new-ratio').select_option('1920,1080');t.locator('[data-action=create-variant]').click();assert t.locator('#variant option').count()==2;checks.append('new independent 16:9 variant')
 t.locator('#variant').select_option('short');t.wait_for_timeout(200);t.screenshot(path=str(out/'studio-desktop.png'),full_page=True)
 t.locator('[data-action=concept]').click();t.locator('#concept-title').fill('빛이 머무는 오후');t.locator('#concept-note').fill('샘플 그래픽으로 엮는 짧은 기록.');t.locator('#frames').fill('5');t.locator('[data-action=concept-save]').click();checks.append('concept and configurable sample count')
 t.locator('[data-action=posting]').click();t.locator('[data-action=channel][data-value="5"]').click();assert '빛이 머무는 오후' in t.locator('#post-text').input_value();t.locator('[data-action=close]').click();checks.append('SNS-specific copy preparation')
 t.set_viewport_size({'width':390,'height':844});t.wait_for_timeout(200);t.screenshot(path=str(out/'studio-mobile.png'),full_page=True);t.evaluate('scrollTo(0,700)');r=t.locator('.progress-rail').bounding_box();assert r and 58<=r['y']<=65;checks.append('progress rail stays visible while mobile page scrolls')
 assert t.evaluate('document.documentElement.scrollWidth')<=395;checks.append('no horizontal overflow at 390px')
 assert not errors,errors;b.close()
(out/'ui-results.json').write_text(json.dumps({'checks':checks,'count':len(checks),'pageErrors':errors,'scope':'offline UI; actual OAuth/network and real browser storage not verified'},ensure_ascii=False,indent=2));print(json.dumps(checks,ensure_ascii=False,indent=2))
