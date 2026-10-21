"""Project persistence regression checks in a real browser and real IndexedDB.

Run in CI: python tests/ui-persistence.py [output-directory]
Only Firebase's adapter is replaced with a labelled, local metadata fixture.
File selection, image/audio decoding, IndexedDB, reloads and UI are real. No
production OAuth, Firebase access or cloud-origin upload claim is made here.
"""
import array
import functools
import hashlib
import json
import math
import os
import sys
import tempfile
import threading
import time
import traceback
import wave
from contextlib import contextmanager
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from PIL import Image
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "out/ui-persistence").resolve()
OUT.mkdir(parents=True, exist_ok=True)
REPORT = {"status": "failed", "checks": [], "pageErrors": [], "externalRequests": [],
          "scope": "real browser/IndexedDB; test-only Firebase metadata adapter"}
STARTED = time.monotonic()
OWNER = "persistence-user"

# This fixture behaves like the revision-checked adapter and keeps its own
# records separate from app storage. It intentionally never stores source bytes.
CLOUD_FIXTURE = r"""
import {cloudData} from './workspace.js';
let observer = null;
const uid = () => localStorage.getItem('norn.test.uid') || '';
const key = () => 'norn.test.cloud.' + uid();
const read = () => JSON.parse(localStorage.getItem(key()) || '{}');
const write = rows => localStorage.setItem(key(), JSON.stringify(rows));
const user = () => uid() ? {uid:uid(),displayName:'저장 회귀검사'} : null;
export async function observe(callback){observer=callback;await callback(user());return ()=>{observer=null};}
export async function login(){localStorage.setItem('norn.test.uid','persistence-user');const next=user();await observer?.(next);return next;}
export async function logout(){localStorage.setItem('norn.test.uid','');await observer?.(null);}
export async function loadPreferences(){return null;}
export async function savePreferences(){return;}
export async function saveCloud(project,expected=0,event='autosave'){
 if(!uid())throw Error('검사 계정이 없습니다.');
 const log=JSON.parse(localStorage.getItem('norn.test.calls')||'[]');
 log.push({id:project.id,event,expected});localStorage.setItem('norn.test.calls',JSON.stringify(log));
 if(localStorage.getItem('norn.test.offline')==='true')throw Error('검사: Firebase 연결을 사용할 수 없습니다.');
 const rows=read(),before=rows[project.id],revision=before?.revision||0;
 if(revision!==expected)throw Error('다른 창·기기의 저장과 충돌합니다.');
 const next=revision+1;
 rows[project.id]={project:cloudData(project),revision:next,savedAt:Date.now()};write(rows);return next;
}
export async function listCloud(){
 if(localStorage.getItem('norn.test.listFailure')==='true')throw Error('검사: 프로젝트 목록을 읽지 못했습니다.');
 return Object.entries(read()).map(([id,row])=>({id,title:row.project.title,
 assets:row.project.assets,variantIds:row.project.variants.map(v=>v.id),revision:row.revision,
 updatedAt:{toDate:()=>new Date(row.savedAt)}}));}
export async function loadCloud(id){const row=read()[id];if(!row)throw Error('프로젝트가 없습니다.');return {...row.project,revision:row.revision};}
export async function deleteCloud(id,expected){const rows=read();if(rows[id]&&rows[id].revision!==expected)throw Error('삭제 충돌');delete rows[id];write(rows);}
export async function listHistory(){return [];}
export async function loadHistory(){throw Error('검사 이력이 없습니다.');}
export async function testConnection(){return {write:true,read:true,delete:true};}
export async function testProjectHistory(){return {project:true,history:true};}
"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def fixture(directory):
    directory.mkdir()
    Image.new("RGB", (320, 240), (185, 80, 35)).save(directory / "project-a.png")
    Image.new("RGB", (320, 240), (25, 100, 185)).save(directory / "project-b.png")
    Image.new("RGB", (320, 240), (55, 175, 75)).save(directory / "quota-test.png")
    samples = array.array("h", [int(12000 * math.sin(2 * math.pi * 330 * i / 16000))
                               for i in range(16000)])
    if sys.byteorder != "little":
        samples.byteswap()
    with wave.open(str(directory / "music.wav"), "wb") as output:
        output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        output.writeframes(samples.tobytes())


def watch(context, base, owner=""):
    # Runs on reload too; an existing owner switch must remain effective.
    context.add_init_script("if(localStorage.getItem('norn.test.uid')===null)"
                            "localStorage.setItem('norn.test.uid'," + json.dumps(owner) + ");")

    def route_request(route):
        address = urlsplit(route.request.url)
        if address.scheme not in ("http", "https"):
            route.continue_()
        elif address.netloc != urlsplit(base).netloc or route.request.method not in ("GET", "HEAD"):
            REPORT["externalRequests"].append(route.request.url)
            route.abort()
        elif address.path == "/firebase-v2.js":
            route.fulfill(status=200, content_type="text/javascript; charset=utf-8", body=CLOUD_FIXTURE)
        else:
            route.continue_()

    context.route("**/*", route_request)

    def watch_page(page):
        page.set_default_timeout(7000)
        page.on("dialog", lambda dialog: dialog.accept())
        page.on("pageerror", lambda error: REPORT["pageErrors"].append(str(error)))

    context.on("page", watch_page)


def choose(page, paths):
    with page.expect_file_chooser() as event:
        page.locator("[data-action=addfiles]").first.click()
    event.value.set_files([str(path) for path in paths])


def idle(page):
    page.wait_for_function("!document.querySelector('#progress [data-action=cancel]')")
    assert not page.locator(".error-box").count(), page.locator("body").inner_text()[-2000:]


def reveal(page, selector):
    # Open each enclosing panel once with its native summary. In particular,
    # caption blur must not swallow the first click; no Tab or retry hides that
    # interaction regression. Re-resolve ancestors after any outer panel opens.
    count = page.locator(selector).locator("xpath=ancestor::details").count()
    for index in range(count):
        panel = page.locator(selector).locator("xpath=ancestor::details").nth(index)
        if panel.get_attribute("open") is None:
            panel.locator(":scope > summary").click()
    control = page.locator(selector)
    control.wait_for(state="visible")
    return control


def stored(page, owner, identifier):
    """Read independent restored File objects and verify their real bytes."""
    return page.evaluate("""async ([owner,id]) => {
      const {localProjectStore}=await import('/local-project-store.js');
      const record=await localProjectStore.load(owner,id);
      if(!record)return null;
      const files=[];
      for(const item of record.media){
        const bytes=await item.file.arrayBuffer();
        const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
        files.push({id:item.id,name:item.relative_path,kind:item.kind,hash,size:bytes.byteLength});
        for(const url of [item.url,item.thumb_url])if(url?.startsWith('blob:'))URL.revokeObjectURL(url);
      }
      return {project:record.project,files,cloudDirty:record.cloudDirty,cloudRevision:record.cloudRevision,
        missingAssets:record.missingAssets};
    }""", [owner, identifier])


def wait_cloud_caption(page, identifier, caption):
    page.wait_for_function("""([id,caption])=>{
      const uid=localStorage.getItem('norn.test.uid');
      const row=JSON.parse(localStorage.getItem('norn.test.cloud.'+uid)||'{}')[id];
      return row?.project.variants[0].scenes[0]?.caption===caption;
    }""", arg=[identifier, caption])


def assert_sources(record, paths):
    assert record and not record["missingAssets"], record
    expected = sorted(hashlib.sha256(path.read_bytes()).hexdigest() for path in paths)
    actual = sorted(item["hash"] for item in record["files"])
    assert actual == expected, (actual, expected)
    assert len(record["project"]["assets"]) == len(paths)


def open_project(page, identifier):
    page.locator('[data-action=project-open][data-id="' + identifier + '"]').click()
    page.wait_for_selector(".studio")


def workspace(page):
    page.locator('.topbar [data-action=home]').first.click()
    page.wait_for_selector(".project-workspace")


def assert_single_account_project(page, owner):
    page.wait_for_function("document.querySelector('#save-status')?.dataset.state==='saved'")
    rows = page.evaluate("""async owner=>{
      const {localProjectStore}=await import('/local-project-store.js');
      return {active:sessionStorage.getItem('norn.cloud.project'),
        cloud:Object.keys(JSON.parse(localStorage.getItem('norn.test.cloud.'+owner)||'{}')),
        local:(await localProjectStore.list(owner)).map(row=>row.id)};
    }""", owner)
    assert rows["active"] and rows["cloud"] == [rows["active"]] and rows["local"] == [rows["active"]], rows
    return rows["active"]


@contextmanager
def browser_runtime():
    """Capture evidence and close the browser before Playwright stops its loop."""
    global browser
    with sync_playwright() as playwright:
        try:
            yield playwright
        except Exception:
            REPORT["failure"] = traceback.format_exc()
            if page:
                try:
                    page.screenshot(path=str(OUT / "failure.png"), full_page=True, timeout=3000)
                    REPORT["visibleFailureState"] = page.locator("body").inner_text()[-5000:]
                except Exception as error:
                    REPORT["artifactError"] = str(error)
            raise
        finally:
            if browser:
                try:
                    browser.close()
                except Exception as error:
                    REPORT.setdefault("cleanupErrors", []).append(str(error))
                browser = None


server = None
browser = None
page = None
try:
    with tempfile.TemporaryDirectory(prefix="norn-persistence-") as directory:
        source = Path(directory) / "originals"
        fixture(source)
        originals = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in source.iterdir()}
        server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(ROOT / "public")))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_port}"
        with browser_runtime() as playwright:
            launch = {"executable_path": os.environ["NORN_CHROMIUM"]} if os.environ.get("NORN_CHROMIUM") else {}
            browser = playwright.chromium.launch(headless=True, **launch)

            # Guest: real Save retains a project; JSON export remains separate.
            context = browser.new_context(viewport={"width": 1280, "height": 950}, accept_downloads=True)
            watch(context, base)
            page = context.new_page()
            downloads = []
            page.on("download", lambda download: downloads.append(download.suggested_filename))
            page.goto(base + "/", wait_until="networkidle")
            choose(page, [source / "project-a.png", source / "music.wav"])
            page.wait_for_selector(".clip")
            idle(page)
            identifier = page.evaluate("JSON.parse(localStorage.getItem('norn.guest.project')).id")
            page.locator("#scene-caption").fill("새로고침 뒤에도 남는 게스트 자막")
            reveal(page, "#music").select_option(index=1)
            page.locator('[data-action=save]').first.click()
            page.wait_for_function("document.querySelector('#save-status')?.textContent.includes('저장됨')")
            before = stored(page, "guest", identifier)
            assert_sources(before, [source / "project-a.png", source / "music.wav"])
            assert not downloads, "Save incorrectly downloaded a JSON instead of saving the project"
            page.reload(wait_until="networkidle")
            page.wait_for_function("document.querySelectorAll('.asset').length===1 && document.querySelectorAll('.clip').length===1")
            assert not page.locator("#local-relink-banner").count()
            assert page.locator("#scene-caption").input_value() == "새로고침 뒤에도 남는 게스트 자막"
            after = stored(page, "guest", identifier)
            assert_sources(after, [source / "project-a.png", source / "music.wav"])
            assert after["project"] == before["project"], "Reload changed persisted editing state"
            assert after["project"]["variants"][0]["audio"]["music_id"]
            page.wait_for_function("[...document.querySelectorAll('.asset img')].every(i=>i.complete&&i.naturalWidth>0)")
            REPORT["checks"].append("guest Save does not download; same-browser reload restores captions, selected soundtrack and byte-identical originals")
            context.close()

            # Signed-in: a cloud fixture exercises integration and failure recovery
            # without claiming that a production Google account was authenticated.
            context = browser.new_context(viewport={"width": 1280, "height": 950}, accept_downloads=True)
            watch(context, base, OWNER)
            page = context.new_page()
            downloads = []
            page.on("download", lambda download: downloads.append(download.suggested_filename))
            page.goto(base + "/", wait_until="networkidle")
            # An empty signed-in account starts one project automatically. The
            # auth observer and route initialization must not each create one.
            page.wait_for_selector(".studio")
            first_id = assert_single_account_project(page, OWNER)
            assert not page.locator(".asset").count() and not page.locator(".clip").count()
            REPORT["checks"].append("empty signed-in workspace automatically creates exactly one durable project and opens its editor")
            choose(page, [source / "project-a.png", source / "music.wav"])
            page.wait_for_selector(".clip")
            idle(page)
            assert first_id == page.evaluate("sessionStorage.getItem('norn.cloud.project')")
            manual_before = page.evaluate("""id=>JSON.parse(localStorage.getItem('norn.test.calls')||'[]')
              .filter(call=>call.id===id&&call.event==='manual').length""", first_id)
            page.locator("#scene-caption").fill("Firebase에 직접 저장한 자막")
            page.locator('[data-action=save]').first.click()
            wait_cloud_caption(page, first_id, "Firebase에 직접 저장한 자막")
            assert not downloads, "Signed-in Save only exported a JSON"
            calls = page.evaluate("JSON.parse(localStorage.getItem('norn.test.calls')||'[]')")
            assert sum(call["id"] == first_id and call["event"] == "manual" for call in calls) == manual_before + 1, calls
            REPORT["checks"].append("signed-in Save invokes cloud adapter with manual event and does not download a JSON")

            # Close immediately after editing, while the cloud still has the old
            # version. The local journal must win over that stale remote record.
            page.evaluate("localStorage.setItem('norn.test.offline','true')")
            page.locator("#scene-caption").fill("저장 대기 중 나갔다가 복원한 자막")
            page.reload(wait_until="networkidle")
            page.wait_for_function("document.querySelectorAll('.asset').length===1 && document.querySelectorAll('.clip').length===1")
            assert page.locator("#scene-caption").input_value() == "저장 대기 중 나갔다가 복원한 자막"
            row = stored(page, OWNER, first_id)
            assert_sources(row, [source / "project-a.png", source / "music.wav"])
            assert row["cloudDirty"], "Recovery falsely claimed stale cloud data was synchronized"
            remote_caption = page.evaluate("""id=>JSON.parse(localStorage.getItem('norn.test.cloud.persistence-user'))[id].project.variants[0].scenes[0].caption""", first_id)
            assert remote_caption == "Firebase에 직접 저장한 자막"
            page.evaluate("localStorage.setItem('norn.test.offline','false')")
            page.locator('[data-action=save]').first.click()
            wait_cloud_caption(page, first_id, "저장 대기 중 나갔다가 복원한 자막")
            REPORT["checks"].append("reload before cloud debounce restores newest local caption and original bytes; later Save retries cloud synchronization")

            workspace(page)
            page.locator('[data-action=new-project]').first.click()
            page.wait_for_selector(".studio")
            assert not page.locator(".asset").count(), "New project inherited another project's originals"
            choose(page, [source / "project-b.png"])
            page.wait_for_selector(".clip")
            idle(page)
            second_id = page.evaluate("sessionStorage.getItem('norn.cloud.project')")
            assert second_id and second_id != first_id
            page.locator("#scene-caption").fill("두 번째 프로젝트의 자막")
            # Exercise native URL/history navigation, not only app buttons:
            # removing the hash must flush the current project's pending edit.
            page.evaluate("location.hash=''")
            page.wait_for_selector(".project-workspace")
            page.go_back(wait_until="domcontentloaded")
            page.wait_for_selector(".studio")
            assert page.locator("#scene-caption").input_value() == "두 번째 프로젝트의 자막"
            assert_sources(stored(page, OWNER, second_id), [source / "project-b.png"])
            workspace(page)
            open_project(page, first_id)
            page.wait_for_function("document.querySelectorAll('.asset').length===1")
            assert "project-a.png" in page.locator(".library-grid").inner_text()
            assert "project-b.png" not in page.locator(".library-grid").inner_text()
            assert page.locator("#scene-caption").input_value() == "저장 대기 중 나갔다가 복원한 자막"
            assert_sources(stored(page, OWNER, first_id), [source / "project-a.png", source / "music.wav"])
            workspace(page)
            open_project(page, second_id)
            page.wait_for_function("document.querySelectorAll('.asset').length===1")
            assert page.locator("#scene-caption").input_value() == "두 번째 프로젝트의 자막"
            assert_sources(stored(page, OWNER, second_id), [source / "project-b.png"])
            REPORT["checks"].append("project A/B switching, native hash/back navigation and immediate workspace navigation retain separate resources and captions, including unused audio")
            page.screenshot(path=str(OUT / "restored-project.png"), full_page=True)

            # A different account gets a distinct workspace even on this device.
            page.evaluate("localStorage.setItem('norn.test.uid','other-persistence-user');sessionStorage.removeItem('norn.cloud.project')")
            page.goto(base + "/", wait_until="networkidle")
            page.wait_for_selector(".studio")
            other_id = assert_single_account_project(page, "other-persistence-user")
            assert other_id not in (first_id, second_id)
            assert not page.locator(".asset").count() and not page.locator(".clip").count()
            assert stored(page, "other-persistence-user", first_id) is None
            REPORT["checks"].append("account namespace isolation starts one independent empty project and keeps previous account projects/originals hidden")
            context.close()

            # Interactive login invokes the observer before login() resolves, as
            # a real auth SDK can. Only the interactive path may create a draft.
            context = browser.new_context(viewport={"width": 1280, "height": 950})
            watch(context, base)
            page = context.new_page()
            page.goto(base + "/", wait_until="networkidle")
            page.locator('.topbar [data-action=account]').first.click()
            page.locator('.modal [data-action=login]').click()
            page.wait_for_selector(".studio")
            assert_single_account_project(page, OWNER)
            REPORT["checks"].append("interactive login with auth observer notification creates exactly one project, without duplicate automatic drafts")
            context.close()

            # An unavailable list is not evidence of an empty account. Creating
            # a draft here would hide the failure and accumulate bogus projects.
            context = browser.new_context(viewport={"width": 1280, "height": 950})
            watch(context, base, OWNER)
            context.add_init_script("localStorage.setItem('norn.test.listFailure','true')")
            page = context.new_page()
            page.goto(base + "/", wait_until="networkidle")
            page.wait_for_selector(".project-workspace")
            assert not page.locator(".studio").count()
            assert page.evaluate("JSON.parse(localStorage.getItem('norn.test.calls')||'[]')") == []
            rows = page.evaluate("""async()=>{
              const {localProjectStore}=await import('/local-project-store.js');
              return await localProjectStore.list('persistence-user');
            }""")
            assert not rows, rows
            REPORT["checks"].append("failed cloud listing never creates a spurious empty project")
            context.close()

            # Force a real IndexedDB write failure after normal application boot.
            # The metadata journal may survive, but original bytes did not commit:
            # the UI must explicitly report that distinction.
            context = browser.new_context(viewport={"width": 1280, "height": 950})
            watch(context, base)
            page = context.new_page()
            page.goto(base + "/", wait_until="networkidle")
            page.evaluate("""()=>{
              const original=IDBObjectStore.prototype.put;
              IDBObjectStore.prototype.put=function(...args){
                if(window.__nornForceQuota)throw new DOMException('Quota fixture','QuotaExceededError');
                return original.apply(this,args);
              };
              window.__nornForceQuota=true;
            }""")
            choose(page, [source / "quota-test.png"])
            page.wait_for_function("""()=>{
              const status=document.querySelector('#save-status')?.textContent||'';
              const detail=document.querySelector('#progress')?.textContent||'';
              return /실패|부족|확인 필요|공간/.test(status+' '+detail);
            }""")
            status = page.locator("#save-status").inner_text()
            assert "저장됨" not in status, status
            page.screenshot(path=str(OUT / "quota-error.png"), full_page=True)
            REPORT["checks"].append("forced IndexedDB quota failure is visible and never reported as saved original media")
            context.close()

            assert {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in source.iterdir()} == originals
            assert not REPORT["pageErrors"], REPORT["pageErrors"]
            assert not REPORT["externalRequests"], REPORT["externalRequests"]
            REPORT["status"] = "passed"
            browser.close()
            browser = None
except Exception:
    REPORT.setdefault("failure", traceback.format_exc())
    raise
finally:
    if browser:
        try:
            browser.close()
        except Exception as error:
            REPORT.setdefault("cleanupErrors", []).append(str(error))
    if server:
        server.shutdown()
        server.server_close()
    REPORT["elapsedSeconds"] = round(time.monotonic() - STARTED, 2)
    (OUT / "result.json").write_text(json.dumps(REPORT, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(REPORT, ensure_ascii=False, indent=2))
