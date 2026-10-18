#!/usr/bin/env python3
"""Desktop entry point for NORN; no credentials or media are uploaded."""
import argparse, json, os, signal, sys, urllib.parse, webbrowser
from pathlib import Path
from workspace import WorkspaceApp, WorkspaceServer
from render_runtime import check_runtime

def choose_folder():
    if sys.platform=='darwin':
        import subprocess
        p=subprocess.run(['osascript','-e','POSIX path of (choose folder with prompt "NORN · 원본 사진·영상 폴더 선택")'],capture_output=True,text=True)
        return p.stdout.strip() if p.returncode==0 else ''
    try:
        import tkinter as tk
        from tkinter.filedialog import askdirectory
        root=tk.Tk();root.withdraw();folder=askdirectory(title='NORN · 원본 폴더');root.destroy();return folder
    except ImportError:raise ValueError('폴더 경로를 명령 뒤에 지정하세요. 예: python3 engine/main.py "/사진폴더"')

def main():
    ap=argparse.ArgumentParser(description='NORN · 노른노른하게 영상을 굽다')
    ap.add_argument('directory',nargs='?');ap.add_argument('--port',type=int,default=8765)
    ap.add_argument('--web-origin',action='append',default=[]);ap.add_argument('--no-browser',action='store_true')
    ap.add_argument('--diagnose',action='store_true',help='FFmpeg 설치만 확인, 원본 폴더를 읽지 않음')
    a=ap.parse_args()
    check=check_runtime()
    if a.diagnose:
        print(json.dumps({'python':sys.version.split()[0],'ffmpeg':check['version'],'local_only':True},ensure_ascii=False,indent=2));return
    origins=[]
    for origin in a.web_origin:
        u=urllib.parse.urlsplit(origin)
        if u.scheme not in ('https','http') or not u.hostname or u.username or u.password or u.query or u.fragment or u.path not in ('','/'):
            ap.error('--web-origin에는 정확한 사이트 출처만 지정하세요.')
        origins.append(origin.rstrip('/'))
    folder=a.directory or choose_folder()
    if not folder:return
    print('원본 조사 중입니다. 원본 파일은 수정하거나 복사하지 않습니다.',flush=True)
    app=WorkspaceApp(folder)
    try:server=WorkspaceServer(app,a.port,origins)
    except OSError as e:raise ValueError('엔진 포트가 사용 중입니다. 기존 엔진을 종료하거나 --port 8766을 지정하세요.') from e
    print(f'\nNORN 0.2 · 로컬 엔진 {server.origin}\n연결 코드: {app.token}\n연결 코드는 외부에 공유하지 마세요. 종료: Ctrl+C\n',flush=True)
    url=server.origin+'/#connect='+urllib.parse.quote(server.origin+'|'+app.token)
    if not a.no_browser:webbrowser.open(url)
    try:server.serve_forever(.2)
    except KeyboardInterrupt:app.cancel.set()
    finally:server.server_close()

if __name__=='__main__':
    try:main()
    except (ValueError,OSError) as e:print('실행 중단:',e,file=sys.stderr);sys.exit(1)
