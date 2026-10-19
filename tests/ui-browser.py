"""One short, real Chromium workflow against public/ static files only.

Run in CI: python tests/ui-browser.py [output-directory]
Requires Pillow, ffmpeg/ffprobe and Playwright Chromium. No engine process, OAuth,
renderer mock or uploaded originals. Firebase is disabled only by a browser route.
The exported video is about 8.5 seconds. NORN_HEADED=1 uses a real headed browser
(run with xvfb-run in CI). Test-only asynchronous delays postpone one native
source play and rAF delivery; decoding, audio, recording and clocks remain real.
"""
import array
import functools
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "out/ui-browser").resolve()
OUT.mkdir(parents=True, exist_ok=True)
REPORT = {"status": "failed", "checks": [], "pageErrors": [], "consoleErrors": [],
          "failedResponses": [], "engineRequests": [], "unexpectedRequests": [],
          "consoleWarnings": [], "scope": "real browser + public static server; test-only Firebase disabled"}
STARTED = time.monotonic()
HEADED = os.environ.get("NORN_HEADED") == "1"
REPORT["headed"] = HEADED


def command(args, timeout=12):
    completed = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    assert completed.returncode == 0, completed.stderr.decode("utf-8", "replace")[-4000:]
    return completed.stdout


def hashes(source):
    return {str(path.relative_to(source)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(source.rglob("*")) if path.is_file()}


def fixture(source):
    (source / "nested").mkdir(parents=True)
    for path, color in [(source / "01-photo.jpg", (210, 90, 45)),
                        (source / "nested/03-photo.png", (35, 90, 200))]:
        photo = Image.new("RGB", (640, 480), color)
        ImageDraw.Draw(photo).rectangle((50, 50, 190, 190), fill=(235, 235, 120))
        photo.save(path)
    command(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
             "testsrc2=size=640x480:rate=100", "-f", "lavfi", "-i",
             "sine=frequency=880:sample_rate=48000", "-t", "2.51", "-c:v", "libx264",
             "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-movflags", "+faststart", str(source / "02-video.mp4")])
    command(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
             "sine=frequency=330:sample_rate=16000", "-t", "2.51", "-c:a", "pcm_s16le",
             str(source / "nested/04-tone.wav")])
    (source / "nested/notes.txt").write_text("Unsupported document must be skipped.\n", encoding="utf-8")


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def watch(context, base):
    def route_request(route):
        request = route.request
        address = urlsplit(request.url)
        if address.scheme not in ("http", "https"):
            route.continue_()
            return
        local = address.hostname in ("localhost", "127.0.0.1", "::1")
        if address.path.startswith("/api/") or (local and address.netloc != urlsplit(base).netloc):
            REPORT["engineRequests"].append(request.url)
            route.abort()
        elif address.netloc != urlsplit(base).netloc or request.method not in ("GET", "HEAD"):
            REPORT["unexpectedRequests"].append({"method": request.method, "url": request.url})
            route.abort()
        elif address.path == "/firebase-config.json":
            # Fetch the real file first: a missing configuration is never masked.
            response = route.fetch()
            assert response.status == 200, f"Firebase config HTTP {response.status}"
            data = response.json()
            assert isinstance(data, dict)
            route.fulfill(response=response, json={**data, "enabled": False, "firebase": None})
        else:
            route.continue_()

    context.route("**/*", route_request)

    def watch_page(page):
        page.set_default_timeout(6000)
        page.on("dialog", lambda dialog: dialog.accept())
        page.on("pageerror", lambda error: REPORT["pageErrors"].append(str(error)))
        page.on("console", lambda message: REPORT["consoleErrors" if message.type == "error"
                                                  else "consoleWarnings"].append(message.text)
                if message.type in ("error", "warning") else None)
        page.on("response", lambda response: REPORT["failedResponses"].append(
            {"status": response.status, "url": response.url}) if response.status >= 400 else None)

    context.on("page", watch_page)


def choose(page, selector, paths, folder=False):
    with page.expect_file_chooser() as event:
        page.locator(selector).first.click()
    chooser = event.value
    assert chooser.element.evaluate("e => !!e.webkitdirectory") == folder
    chooser.set_files(str(paths) if isinstance(paths, Path) else [str(path) for path in paths])


def idle(page):
    page.wait_for_function("!document.querySelector('#progress [data-action=cancel]')")
    assert page.locator(".error-box").count() == 0, page.locator("body").inner_text()[-2000:]


def reveal(page, selector):
    control = page.locator(selector)
    parent = control.locator("xpath=ancestor::details[1]")
    if parent.count() and parent.get_attribute("open") is None:
        parent.locator("summary").first.click()
    return page.locator(selector)


def fill(page, selector, value):
    reveal(page, selector).fill(value)
    page.locator(selector).press("Tab")


def project(page):
    return page.evaluate("JSON.parse(localStorage.getItem('norn.guest.project'))")


def active(data):
    return next(item for item in data["variants"] if item["id"] == data["activeVariant"])


def download(page, selector, name=None):
    with page.expect_download(timeout=8000) as event:
        page.locator(selector).first.click()
    item = event.value
    target = OUT / (name or item.suggested_filename)
    item.save_as(target)
    assert target.is_file() and target.stat().st_size > 0
    return target


def delay_next_video_start(page, milliseconds=600):
    # Delay the actual native call, not just its returned Promise. The old renderer
    # started this video at its timeline boundary and drifted/failed before 600ms.
    # Prepared playback must absorb this latency before recording starts.
    page.evaluate("""milliseconds => {
      const nativePlay = HTMLMediaElement.prototype.play;
      const state = window.__nornPlaybackDelay = {
        requestedMs: milliseconds, applied: 0, actualMs: null, nativeCalls: 0, resolved: false
      };
      HTMLMediaElement.prototype.play = function (...args) {
        const source = this instanceof HTMLVideoElement && this.dataset.nornRenderSource === 'video';
        if (!source) return nativePlay.apply(this, args);
        if (state.applied) { state.nativeCalls++; return nativePlay.apply(this, args); }
        state.applied++;
        const element = this, started = performance.now();
        return new Promise((resolve, reject) => setTimeout(() => {
          state.actualMs = performance.now() - started;
          state.nativeCalls++;
          try {
            Promise.resolve(nativePlay.apply(element, args)).then(value => {
              state.resolved = true;
              resolve(value);
            }, reject);
          } catch (error) { reject(error); }
        }, milliseconds));
      };
    }""", milliseconds)


def delay_animation_frames(page, milliseconds=1000):
    # Model a visible surface whose repaint callbacks arrive at about 1 Hz.
    # Native rAF still runs; only callback delivery waits on a nonblocking timer.
    # Timer pacing, media playback and performance.now() are never replaced.
    page.evaluate("""milliseconds => {
      const nativeRequest = window.requestAnimationFrame;
      const nativeCancel = window.cancelAnimationFrame;
      const pending = new Map();
      const state = window.__nornRafDelay = {
        requestedMs: milliseconds, requested: 0, delivered: 0, cancelled: 0,
        minimumDelayMs: null, maximumDelayMs: 0, probes: [], active: true, restored: false
      };
      window.requestAnimationFrame = callback => {
        if (typeof callback !== 'function') return nativeRequest.call(window, callback);
        const entry = { callback, started: performance.now(), timer: null };
        const id = nativeRequest.call(window, () => {
          if (!pending.has(id)) return;
          entry.timer = setTimeout(() => {
            if (!pending.delete(id)) return;
            const delay = performance.now() - entry.started;
            state.delivered++;
            state.minimumDelayMs = Math.min(state.minimumDelayMs ?? delay, delay);
            state.maximumDelayMs = Math.max(state.maximumDelayMs, delay);
            callback.call(window, performance.now());
          }, milliseconds);
        });
        pending.set(id, entry);
        state.requested++;
        return id;
      };
      window.cancelAnimationFrame = id => {
        const entry = pending.get(id);
        if (entry) { clearTimeout(entry.timer); pending.delete(id); state.cancelled++; }
        nativeCancel.call(window, id);
      };
      window.__nornRestoreRaf = () => {
        if (!state.active) return;
        state.active = false;
        window.requestAnimationFrame = nativeRequest;
        window.cancelAnimationFrame = nativeCancel;
        // Preserve pending UI callbacks when restoring normal delivery.
        for (const [id, entry] of pending) {
          clearTimeout(entry.timer);
          nativeCancel.call(window, id);
          nativeRequest.call(window, entry.callback);
        }
        pending.clear();
        state.restored = true;
      };
    }""", milliseconds)


def probe_animation_frame_delay(page, label):
    probe = page.evaluate("""label => new Promise(resolve => {
      const state = window.__nornRafDelay, started = performance.now();
      requestAnimationFrame(() => {
        const probe = { label, actualMs: performance.now() - started,
          visibility: document.visibilityState, active: state.active };
        state.probes.push(probe);
        resolve(probe);
      });
    })""", label)
    assert probe["active"] and probe["visibility"] == "visible" and probe["actualMs"] >= 950, probe


def restore_animation_frames(page):
    return page.evaluate("""() => {
      window.__nornRestoreRaf?.();
      return window.__nornRafDelay || null;
    }""")


def inspect_video(path, expected, video_start, video_duration):
    probe = json.loads(command(["ffprobe", "-v", "error", "-show_format", "-show_streams",
                                "-show_packets", "-of", "json", str(path)]))
    container = probe["format"]["format_name"].split(",")
    assert path.suffix in (".mp4", ".webm"), path
    assert ("mp4" in container) if path.suffix == ".mp4" else ("webm" in container), container
    video = next(stream for stream in probe["streams"] if stream["codec_type"] == "video")
    audio = next(stream for stream in probe["streams"] if stream["codec_type"] == "audio")
    if path.suffix == ".mp4":
        assert (video["codec_name"], audio["codec_name"]) == ("h264", "aac"), (video, audio)
    assert (video["width"], video["height"]) == (720, 1280), video
    # MediaRecorder WebM may omit a header duration; use actual packet timestamps.
    packet_end = max(float(packet.get("pts_time", 0)) + float(packet.get("duration_time", 0))
                     for packet in probe["packets"])
    duration = float(probe["format"].get("duration", packet_end))
    assert abs(duration - expected) < 0.45, (duration, expected)
    pcm = array.array("h", command(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path),
                                    "-map", "0:a:0", "-ar", "8000", "-ac", "1", "-f", "s16le", "pipe:1"]))
    if sys.byteorder != "little":
        pcm.byteswap()
    assert pcm, "Audio stream decoded no samples"
    rms = math.sqrt(sum(value * value for value in pcm) / len(pcm))
    assert rms > 100, f"Expected audible source audio, got RMS={rms}"
    def window_rms(start, end):
        samples = pcm[round(start * 8000):round(end * 8000)]
        assert samples, (start, end, len(pcm))
        return math.sqrt(sum(value * value for value in samples) / len(samples))
    # A widened drift guard must not pass with the first 600ms of video/audio lost.
    # The preceding/following stills have no soundtrack; only the video is audible.
    early_audio = window_rms(video_start + .15, video_start + .45)
    before_audio = window_rms(video_start - .45, video_start - .15)
    after_audio = window_rms(video_start + video_duration + .15, video_start + video_duration + .45)
    assert early_audio > 100, f"Video audio starts late after delayed play: RMS={early_audio}"
    assert max(before_audio, after_audio) < max(100, early_audio * .08), (before_audio, early_audio, after_audio)
    frames = command(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-an", "-vf",
                      "fps=1,scale=48:48", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"])
    size = 48 * 48 * 3
    samples = [frames[offset:offset + size] for offset in range(0, len(frames), size)]
    assert len(samples) >= 4 and all(len(frame) == size for frame in samples)
    difference = sum(abs(a - b) for a, b in zip(samples[0], samples[-1])) / size
    assert difference > 12, f"Expected distinct photo/video frames, difference={difference}"
    return {"container": container, "videoCodec": video["codec_name"], "audioCodec": audio["codec_name"],
            "width": video["width"], "height": video["height"], "duration": duration,
            "expectedDuration": expected, "audioRms": round(rms, 2), "frameDifference": round(difference, 2),
            "videoStart": video_start, "earlyVideoAudioRms": round(early_audio, 2),
            "precedingStillAudioRms": round(before_audio, 2), "followingStillAudioRms": round(after_audio, 2)}


server = None
try:
    with tempfile.TemporaryDirectory(prefix="norn-browser-ui-") as temp:
        source = Path(temp) / "browser-originals"
        fixture(source)
        before = hashes(source)
        # Only static public/ assets are served. Never import or start engine/.
        server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(ROOT / "public")))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_port}"
        with sync_playwright() as playwright:
            launch = {"executable_path": os.environ["NORN_CHROMIUM"]} if os.environ.get("NORN_CHROMIUM") else {}
            browser = playwright.chromium.launch(headless=not HEADED, **launch)
            context = browser.new_context(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
            watch(context, base)
            page = context.new_page()
            try:
                page.goto(base + "/", wait_until="networkidle", timeout=12000)
                choose(page, ".hero [data-action=addfiles]", [source / "01-photo.jpg", source / "02-video.mp4"])
                page.wait_for_function("document.querySelectorAll('.clip').length === 2")
                idle(page)
                assert "브라우저에서 편집" in page.locator("#connection-label").inner_text()
                choose(page, "#local-import-buttons [data-action=addfolder]", source, folder=True)
                page.wait_for_selector(".import-issues")
                assert "notes.txt" in page.locator(".import-issues").inner_text()
                page.locator("[data-action=close]").first.click()
                idle(page)
                assert page.locator(".asset").count() == 3 and page.locator(".clip").count() == 3
                assert "nested/03-photo.png" in page.locator(".library-grid").inner_text()
                assert len(project(page)["assets"]) == 4  # WAV is a resource, never a visual scene.
                REPORT["checks"].append("native file chooser + recursive folder selection, duplicate skip and document exclusion")

                page.locator(".clip").nth(0).click()
                fill(page, "#scene-title", "로컬 자료로 만든 영상")
                fill(page, "#scene-caption", "사진·영상·원음을 직접 편집했습니다.")
                fill(page, '[data-bind="duration"]', "3")
                page.locator(".clip").nth(1).click()
                reveal(page, '[data-bind="keep_audio"]').check()
                reveal(page, "#mute-all").uncheck()
                reveal(page, "#music")
                assert page.locator('#music option:not([value=""])').count() == 1
                assert page.locator("#music").input_value() == ""  # Prove audio comes from the video.
                page.locator(".clip").nth(2).click()
                fill(page, '[data-bind="duration"]', "3")
                page.locator("[data-action=moveleft]").click()
                page.locator("[data-action=moveleft]").click()
                assert "03-photo" in page.locator(".clip-top").first.inner_text()
                page.locator(".clip").nth(2).click()
                page.locator("[data-action=moveleft]").click()
                assert "02-video" in page.locator(".clip-top").nth(1).inner_text()
                saved = download(page, "[data-action=save]", "project.json")
                snapshot = json.loads(saved.read_text(encoding="utf-8"))
                variant = active(snapshot)
                assert variant["scenes"][2]["caption"] == "사진·영상·원음을 직접 편집했습니다."
                assert variant["scenes"][1]["keep_audio"] and not variant["audio"]["mute_original"]
                expected = sum(row["duration"] for row in variant["scenes"])
                assert 8.45 <= expected <= 8.60, expected
                REPORT["fixture"] = {"sourceWidth": 640, "sourceHeight": 480,
                                     "sceneDurations": [row["duration"] for row in variant["scenes"]]}
                assert "blob:" not in saved.read_text(encoding="utf-8")
                page.screenshot(path=str(OUT / "edited.png"), full_page=True)
                REPORT["checks"].append("scene order, caption, fractional video duration and source-audio settings persist to JSON")

                page.locator("[data-action=render]").click()
                page.locator("[data-action=start-browser-export]").click()
                page.wait_for_function("document.querySelector('#progress .label')?.textContent.includes('장면 굽는 중')", timeout=12000)
                page.locator("#progress [data-action=cancel]").click()
                page.wait_for_function("document.querySelector('#progress .label')?.textContent.includes('중지됨')")
                idle(page)
                assert page.locator("#browser-result-player").count() == 0
                delay_next_video_start(page)
                page.locator("[data-action=render]").click()
                delay_animation_frames(page)
                try:
                    probe_animation_frame_delay(page, "before-export")
                    page.locator("[data-action=start-browser-export]").click()
                    probe_animation_frame_delay(page, "during-export")
                    # This wait must not depend on the rAF service being exercised.
                    page.wait_for_function("document.querySelector('#browser-result-player') || document.querySelector('.error-box') || document.querySelector('#progress .error')", polling=50, timeout=25000)
                finally:
                    REPORT["rafDelay"] = restore_animation_frames(page)
                assert page.locator("#browser-result-player").count() == 1, page.locator("body").inner_text()[-2000:]
                assert REPORT["rafDelay"]["restored"] and REPORT["rafDelay"]["delivered"] >= 2, REPORT["rafDelay"]
                REPORT["playbackDelay"] = page.evaluate("window.__nornPlaybackDelay")
                delay = REPORT["playbackDelay"]
                assert delay["applied"] == 1 and delay["resolved"] and delay["actualMs"] >= 550, delay
                video_path = download(page, "[data-action=download-video]")
                REPORT["video"] = inspect_video(video_path, expected, variant["scenes"][0]["duration"], variant["scenes"][1]["duration"])
                page.screenshot(path=str(OUT / "completed.png"), full_page=True)
                REPORT["checks"].append("real export cancellation and retry; downloaded container, dimensions, timing, audio and changing frames verified")
                REPORT["checks"].append("600ms native video-start delay is absorbed before recording; original audio starts at its planned scene boundary")
                REPORT["checks"].append("visible-page rAF callbacks delayed at least 1000ms before and during real export; timer-paced output retains timing and source audio")

                page.locator(".modal [data-action=posting]").click()
                page.locator("#public-note").fill("공개할 짧은 소개")
                page.locator("#post-text").fill("직접 입력한 게시문입니다.")
                package = download(page, "[data-action=export-posting]", "posting.zip")
                idle(page)
                with zipfile.ZipFile(package) as archive:
                    assert archive.testzip() is None, "ZIP CRC failure"
                    entries = archive.namelist()
                    roots = {entry.split("/")[0] for entry in entries}
                    assert roots == {"browser-originals업로드준비"}, roots
                    prefix = next(iter(roots)) + "/"
                    assert archive.read(prefix + "video" + video_path.suffix) == video_path.read_bytes()
                    assert archive.read(prefix + "sns/instagram/post.txt").decode("utf-8") == "직접 입력한 게시문입니다."
                    attachments = json.loads(archive.read(prefix + "attachments.json"))
                    assert len(attachments["originals"]) == 3 and all(not row["included"] for row in attachments["originals"])
                    assert not any(Path(entry).name in {Path(name).name for name in before} for entry in entries)
                    assert all(hashlib.sha256(archive.read(entry)).hexdigest() not in before.values() for entry in entries)
                    assert json.loads(archive.read(prefix + "norn-project.json"))["id"] == snapshot["id"]
                    REPORT["zipEntries"] = entries
                REPORT["checks"].append("posting ZIP passes CRC; contains identical generated video, JSON and edited text, no original bytes")

                # A fresh browser context has neither guest storage nor source handles.
                recovery_context = browser.new_context(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
                watch(recovery_context, base)
                recovery = recovery_context.new_page()
                recovery.goto(base + "/#studio", wait_until="networkidle")
                assert recovery.locator(".clip").count() == 0
                choose(recovery, "[data-action=import]", saved)
                recovery.wait_for_selector("#local-relink-banner")
                assert recovery.locator(".clip").count() == 3 and recovery.locator(".asset").count() == 0
                choose(recovery, "#local-relink-banner [data-action=relink-files]",
                       [source / "01-photo.jpg", source / "02-video.mp4", source / "nested/03-photo.png", source / "nested/04-tone.wav"])
                recovery.wait_for_function("document.querySelectorAll('.asset').length === 3 && !document.querySelector('#local-relink-banner')")
                idle(recovery)
                assert active(project(recovery))["scenes"] == variant["scenes"], "Relinking changed saved scene edits/order/timing"
                recovery.screenshot(path=str(OUT / "recovered.png"), full_page=True)
                REPORT["checks"].append("downloaded JSON opens in clean context; reselected originals preserve all scenes and edits without duplication")
                recovery_context.close()
                assert hashes(source) == before, "Original filenames or content changed"
                REPORT["originalHashes"] = before
                REPORT["checks"].append("all original SHA-256 hashes unchanged; no local-engine or upload request")
                for key in ("pageErrors", "consoleErrors", "failedResponses", "engineRequests", "unexpectedRequests"):
                    assert not REPORT[key], {key: REPORT[key]}
                REPORT["status"] = "passed"
            except Exception:
                try:
                    REPORT["rafDelay"] = restore_animation_frames(page)
                    REPORT["playbackDelay"] = page.evaluate("window.__nornPlaybackDelay || null")
                    if page.locator("#progress").count():
                        REPORT["browserProgress"] = page.locator("#progress").inner_text()
                    if page.locator("#progress .error").count() and not page.locator(".modal").count():
                        page.locator("#progress [data-action=log]").click(timeout=1500)
                    if page.locator("#browser-error-details").count():
                        REPORT["rendererErrorDetails"] = page.locator("#browser-error-details").inner_text()
                    page.screenshot(path=str(OUT / "failure.png"), full_page=True, timeout=3000)
                except Exception:
                    pass
                raise
            finally:
                browser.close()
except Exception:
    REPORT["failure"] = traceback.format_exc()
    raise
finally:
    if server:
        server.shutdown()
        server.server_close()
    REPORT["elapsedSeconds"] = round(time.monotonic() - STARTED, 2)
    (OUT / "result.json").write_text(json.dumps(REPORT, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(REPORT, ensure_ascii=False, indent=2))
