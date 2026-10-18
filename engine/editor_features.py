"""NORN editor capabilities. No source writes, no font distribution, no AI calls."""
from __future__ import annotations
import base64
from functools import lru_cache
import io
import math
from pathlib import Path
import re
import shutil
import subprocess
from typing import Any
from PIL import Image, ImageDraw, ImageFont, ImageFilter

# Fixed allowlists, never pass user-supplied FFmpeg expressions.
TRANSITIONS = {
 'cut': ('바로 전환', '기본'), 'fade': ('크로스 디졸브', '디졸브'),
 'fadeblack': ('검정으로 전환', '디졸브'), 'fadewhite': ('흰색으로 전환', '디졸브'),
 'dissolve': ('입자 디졸브', '디졸브'), 'pixelize': ('픽셀 모자이크', '디졸브'),
 'wipeleft': ('왼쪽 와이프', '와이프'), 'wiperight': ('오른쪽 와이프', '와이프'),
 'wipeup': ('위로 와이프', '와이프'), 'wipedown': ('아래로 와이프', '와이프'),
 'slideleft': ('왼쪽 슬라이드', '슬라이드'), 'slideright': ('오른쪽 슬라이드', '슬라이드'),
 'slideup': ('위로 슬라이드', '슬라이드'), 'slidedown': ('아래로 슬라이드', '슬라이드'),
 'smoothleft': ('부드럽게 왼쪽', '슬라이드'), 'smoothright': ('부드럽게 오른쪽', '슬라이드'),
 'circleopen': ('원형 열기', '도형'), 'circleclose': ('원형 닫기', '도형'),
 'radial': ('시계 방향 펼치기', '도형'), 'diagtl': ('대각선 왼쪽 위', '도형'),
 'diagbr': ('대각선 오른쪽 아래', '도형'), 'hblur': ('가로 블러', '특수'),
 'squeezeh': ('가로 압축', '특수'), 'squeezev': ('세로 압축', '특수'),
 'zoomin': ('줌 인', '특수'),
}
STYLES = {
 'bold_shortform': 'Bold · 대담한 강조', 'clean': 'Clean · 담백한 자막',
 'info_card': 'Card · 정보 카드', 'emotional': 'Mood · 감성 자막',
 'outline': 'Outline · 굵은 외곽선', 'neon': 'Neon · 네온 글로우',
 'sticker': 'Sticker · 스티커 라벨', 'cinema': 'Cinema · 시네마 타이틀',
 'lower_third': 'Lower third · 방송형 바', 'editorial': 'Editorial · 잡지형',
}
FONT_GROUPS = {
 'default': ('기본 고딕', ['/System/Library/Fonts/AppleSDGothicNeo.ttc','C:/Windows/Fonts/malgun.ttf','/usr/share/fonts/truetype/nanum/NanumGothic.ttf','/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc']),
 'bold': ('굵은 고딕', ['/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf','C:/Windows/Fonts/malgunbd.ttf','/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc','/System/Library/Fonts/AppleSDGothicNeo.ttc']),
 'serif': ('명조 / 세리프', ['/System/Library/Fonts/Supplemental/AppleMyungjo.ttf','/usr/share/fonts/truetype/nanum/NanumMyeongjo.ttf','/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc','C:/Windows/Fonts/batang.ttc']),
 'rounded': ('손글씨 / 부드러운 글씨', ['/usr/share/fonts/truetype/nanum/NanumPen.ttf','/Library/Fonts/NanumPen.ttf','/Library/Fonts/NanumBrush.ttf','C:/Windows/Fonts/HANBatang.ttf']),
}
MUSIC = [
 {'id':'sunny-day','title':'Sunny Day','mood':'밝은 일상 · 가벼운 피아노와 비트','bpm':100},
 {'id':'quiet-notes','title':'Quiet Notes','mood':'차분한 기록 · 잔잔한 건반','bpm':76},
 {'id':'city-pulse','title':'City Pulse','mood':'활기찬 쇼츠 · 전자 비트','bpm':116},
 {'id':'warm-evening','title':'Warm Evening','mood':'따뜻한 풍경 · 부드러운 아르페지오','bpm':88},
]
MUSIC_ROOT = Path(__file__).with_name('music_assets')

@lru_cache(maxsize=1)
def supported_transitions() -> set[str]:
    supported = {'cut'}
    if shutil.which('ffmpeg'):
        p = subprocess.run(['ffmpeg','-hide_banner','-h','filter=xfade'],capture_output=True,text=True,timeout=15)
        for name in TRANSITIONS:
            if re.search(r'^\s+'+re.escape(name)+r'\s+\d+\s',p.stdout,re.M): supported.add(name)
    return supported


@lru_cache(maxsize=32)
def font_path(family: str, explicit: str | None = None) -> str | None:
    if family not in FONT_GROUPS: raise ValueError('지원하지 않는 글꼴 종류입니다.')
    paths = ([explicit] if family=='default' and explicit else []) + FONT_GROUPS[family][1]
    for path in paths:
        if path and Path(path).is_file():
            try: ImageFont.truetype(path,24); return path
            except OSError: pass
    return None


@lru_cache(maxsize=32)
def collection_index(path: str, family: str) -> int:
    if not path.lower().endswith('.ttc'): return 0
    preferred = ('bold',) if family=='bold' else ('regular','normal','medium')
    for index in range(20):
        try:
            name = ImageFont.truetype(path,18,index=index).getname()[1].lower()
            if any(term==name or term in name for term in preferred): return index
        except OSError: break
    return 0


def load_font(path: str, size: int, family: str) -> Any:
    return ImageFont.truetype(path,size,index=collection_index(path,family))


def font_catalog(explicit: str | None = None) -> list[dict[str, Any]]:
    return [{'id':key,'label':val[0], 'available':bool(font_path(key,explicit))} for key,val in FONT_GROUPS.items()]


def default_scene_fields(scene: dict[str, Any]) -> dict[str, Any]:
    return {**scene, 'title':scene.get('title',''), 'font_size':scene.get('font_size',60),
            'title_size':scene.get('title_size',32), 'font_family':scene.get('font_family','default'),
            'text_position':scene.get('text_position','bottom'),
            'transition_duration':scene.get('transition_duration',.3)}


def audio_defaults(value: dict[str, Any] | None = None) -> dict[str, Any]:
    return {'mute_original':False,'original_volume':1.0,'music_id':'', 'music_volume':.22,
            'music_start':0.,'loop':True,'fade_in':.6,'fade_out':1., **(value or {})}


def wrap_literal(text: str, font: Any, draw: ImageDraw.ImageDraw, width: int) -> list[str]:
    lines = []
    for paragraph in text.split('\n'):
        line = ''
        for ch in paragraph:
            if line and draw.textlength(line+ch,font=font) > width:
                lines.append(line); line = ch
            else: line += ch
        lines.append(line)
    return lines if text else []


def title_card(width: int, height: int, row: dict[str, Any], explicit: str | None = None,
               role: str = 'scene') -> tuple[Image.Image, dict[str, Any]]:
    """Exact same bitmap used in browser and encoder; no auto SCENE/RECORD wording."""
    s = default_scene_fields(row)
    title, text, style = s['title'],s.get('caption',''),s.get('style','clean')
    cw = max(60,round(width*.88)); pad = max(5,round(width*.027))
    im = Image.new('RGBA',(cw,4),(0,0,0,0))
    if not title and not text:
        return im,{'x':(width-cw)//2,'y':round(height*.63),'width':cw,'height':4,'empty':True,'warnings':[]}
    path = font_path(s['font_family'],explicit)
    if not path:
        raise ValueError('선택한 한글 글꼴이 없습니다. 설치된 글꼴을 선택하세요. 글자를 생략하지 않습니다.')
    ratio = width/1080
    requested, small_requested = max(7,round(s['font_size']*ratio)),max(6,round(s['title_size']*ratio))
    fs, ts = requested, small_requested
    test = ImageDraw.Draw(Image.new('RGBA',(2,2)))
    # Large fonts are reduced only when the box would exceed the frame. Report it, never truncate text.
    for _ in range(100):
        font=load_font(path,fs,s['font_family']);small=load_font(path,ts,s['font_family'])
        lines=wrap_literal(text,font,test,cw-2*pad); titles=wrap_literal(title,small,test,cw-2*pad)
        lineh=math.ceil(fs*1.45); titleh=math.ceil(ts*1.5)
        gap=round(width*.013) if titles and lines else 0
        ch=2*pad+len(lines)*lineh+len(titles)*titleh+gap
        if ch<=height*.48 and len(lines)<=4 and len(titles)<=3: break
        fs=max(6,fs-1);ts=max(5,ts-1)
    ch=max(ch,pad*2+8)
    im=Image.new('RGBA',(cw,ch),(0,0,0,0));d=ImageDraw.Draw(im)
    edge=max(1,round(width*.003)); ink=(255,255,255,255);accent=(205,243,99,255)
    centered=style in ('clean','emotional','outline','neon','cinema')
    radius=max(6,round(width*.02)); y=pad
    if style=='bold_shortform':
        d.rounded_rectangle((0,0,cw-1,ch-1),radius,fill=(13,18,28,227));d.rectangle((pad,0,min(cw-pad,pad+cw//4),edge*2),fill=accent)
    elif style=='clean':
        d.rounded_rectangle((0,0,cw-1,ch-1),radius,fill=(10,16,26,175))
    elif style=='info_card':
        accent=(73,231,208,255);d.rounded_rectangle((0,0,cw-1,ch-1),radius,fill=(6,31,39,226),outline=accent,width=edge);d.rectangle((2,8,edge*2,ch-8),fill=accent)
    elif style=='emotional':
        ink=(255,244,222,255);accent=(247,205,157,255);d.rounded_rectangle((0,0,cw-1,ch-1),radius,fill=(22,24,31,95));d.line((cw*.42,ch-3,cw*.58,ch-3),fill=accent,width=edge)
    elif style=='sticker':
        ink=(20,25,35,255);accent=(32,48,65,255);d.rounded_rectangle((0,0,cw-1,ch-1),radius,fill=(231,252,157,248))
    elif style=='cinema':
        accent=(238,207,137,255);d.line((cw*.35,2,cw*.65,2),fill=accent,width=edge)
    elif style=='lower_third':
        accent=(128,198,255,255);d.rectangle((0,0,cw-1,ch-1),fill=(14,41,72,223));d.rectangle((0,0,edge*3,ch-1),fill=accent)
    elif style=='editorial':
        ink=(22,23,26,255);accent=(191,64,44,255);d.rectangle((0,0,cw-1,ch-1),fill=(250,245,231,243));d.line((pad,ch-pad//2,cw-pad,ch-pad//2),fill=accent,width=edge)
    textlayer=Image.new('RGBA',(cw,ch),(0,0,0,0));td=ImageDraw.Draw(textlayer)
    for values,f,lh,color in [(titles,small,titleh,accent),(lines,font,lineh,ink)]:
        for line in values:
            x=round((cw-td.textlength(line,font=f))/2) if centered else pad
            outline=max(1,round(f.size*.065)) if style in ('outline','cinema','neon') else 0
            td.text((x,y),line,font=f,fill=color,anchor='lt',stroke_width=outline,stroke_fill=(5,8,15,245))
            y+=lh
        if values is titles and values: y+=gap
    if style=='neon':
        glow=Image.new('RGBA',im.size,(0,0,0,0));glow.paste((74,230,250,220),mask=textlayer.getchannel('A'));glow=glow.filter(ImageFilter.GaussianBlur(max(2,width*.006)));im.alpha_composite(glow)
    elif style in ('outline','cinema'):
        shadow=textlayer.filter(ImageFilter.GaussianBlur(max(1,width*.002)));im.alpha_composite(shadow,(0,min(3,ch-1)))
    im.alpha_composite(textlayer)
    pos=s['text_position']; factors={'top':.12,'middle':.42,'bottom':.66}
    yf = .15 if role=='hook' else .39 if role=='outro' else factors.get(pos,.66)
    yfinal=max(0,min(round(height*yf),height-ch-round(height*.09)))
    warnings=[]
    if fs<requested or ts<small_requested: warnings.append('문구가 화면을 벗어나지 않도록 크기를 자동 맞춤했습니다.')
    return im,{'x':(width-cw)//2,'y':yfinal,'width':cw,'height':ch,'empty':False,
               'effective_font_size':round(fs/ratio,1),'effective_title_size':round(ts/ratio,1),'warnings':warnings}


def overlay_response(width: int, height: int, row: dict[str, Any], explicit: str | None = None) -> dict[str, Any]:
    image, meta=title_card(width,height,row,explicit)
    buffer=io.BytesIO(); image.save(buffer,format='PNG')
    return {**meta,'canvas_width':width,'canvas_height':height,'image':'data:image/png;base64,'+base64.b64encode(buffer.getvalue()).decode()}


def overlaps(scenes: list[dict[str, Any]], fps: int) -> list[float]:
    result=[]
    for i,row in enumerate(scenes):
        if i==len(scenes)-1 or row['transition']=='cut': result.append(0.);continue
        d=round(float(row.get('transition_duration',.3))*fps)/fps
        maximum=math.floor(min(row['duration'],scenes[i+1]['duration'])*fps/2+1e-5)/fps
        if d<1/fps-1e-6 or d>maximum+1e-6:
            raise ValueError(f'{i+1}번 전환은 인접 장면 길이 때문에 {1/fps:.3f}~{maximum:.3f}초여야 합니다. 전환 길이를 줄이거나 바로 전환을 선택하세요.')
        result.append(d)
    return result
