"""Small I/O layer for the v10-derived renderer. No source writes or uploads."""
from __future__ import annotations
import hashlib, json, os, subprocess
from pathlib import Path
from PIL import Image, ImageOps, ImageFilter


def run_command(cmd, timeout=900):
    p = subprocess.run(list(map(str,cmd)), capture_output=True, text=True, errors='replace', timeout=timeout)
    if p.returncode:
        raise RuntimeError(p.stderr[-3000:] or '미디어 처리 실패')
    return p


def file_hash(p):
    h=hashlib.sha256()
    with Path(p).open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()


def probe(p):
    d=json.loads(run_command(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(p)],60).stdout)
    v=next((s for s in d.get('streams',[]) if s.get('codec_type')=='video'),{})
    return {'width':v.get('width',0),'height':v.get('height',0),
            'duration':float(d.get('format',{}).get('duration',v.get('duration',0)) or 0),
            'has_audio':any(s.get('codec_type')=='audio' for s in d.get('streams',[]))}


def make_slide(original,work,i,width,height,style):
    with Image.open(original) as src:
        photo=ImageOps.exif_transpose(src).convert('RGB')
        backdrop=ImageOps.fit(photo,(width,height)).filter(ImageFilter.GaussianBlur(max(2,width//70)))
        photo.thumbnail((width,height),Image.Resampling.LANCZOS)
        backdrop.paste(photo,((width-photo.width)//2,(height-photo.height)//2))
        target=Path(work)/f'still-{i}.png';backdrop.save(target)
    return target


def srt_time(t):
    ms=round(max(0,t)*1000);s,ms=divmod(ms,1000);m,s=divmod(s,60);h,m=divmod(m,60)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'


def safe_path(root,relative,must_exist=True):
    root=Path(root).resolve();rel=Path(relative)
    if rel.is_absolute() or '..' in rel.parts:raise ValueError('폴더 밖 경로는 허용되지 않습니다.')
    p=root
    for part in rel.parts:
        p/=part
        if p.is_symlink():raise ValueError('심볼릭 링크는 사용하지 않습니다.')
    p=p.resolve(strict=must_exist)
    if not p.is_relative_to(root):raise ValueError('폴더 밖 경로는 허용되지 않습니다.')
    return p


class Store:
    def __init__(self,source,root):self.source=Path(source).resolve();self.root=Path(root).resolve()
    def path(self,relative):
        p=safe_path(self.root,relative,False);p.parent.mkdir(parents=True,exist_ok=True);return p
    def write(self,relative,text):
        p=self.path(relative);t=p.with_name(p.name+'.pending');t.write_text(text,encoding='utf-8');os.replace(t,p)
    def write_json(self,relative,data):self.write(relative,json.dumps(data,ensure_ascii=False,indent=2))
