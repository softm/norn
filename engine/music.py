"""Procedural short instrumental loops. No downloaded music or third-party samples."""
from __future__ import annotations
from array import array
import hashlib, math, os, sys, wave
from pathlib import Path
CATALOG=[('sunny','밝은 오후',100,[60,64,67,72]),('quiet','잔잔한 기록',76,[57,60,64,69]),('pulse','가벼운 리듬',112,[60,67,69,64]),('warm','따뜻한 저녁',88,[53,57,60,65])]
def synthesize(root):
    root=Path(root);root.mkdir(parents=True,exist_ok=True);files=[]
    for key,title,bpm,notes in CATALOG:
        path=root/(key+'.wav');rate=22050;seconds=16*60/bpm
        if not path.exists():
            values=array('h');beat=60/bpm
            for n in range(round(seconds*rate)):
                t=n/rate;phase=t%beat;index=int(t/beat)%len(notes);frequency=440*2**((notes[index]-69)/12)
                envelope=(1-math.exp(-phase*70))*math.exp(-phase*4)
                tone=math.sin(2*math.pi*frequency*t)+.24*math.sin(2*math.pi*frequency*2*t)
                bass=.22*math.sin(2*math.pi*(frequency/2)*t)*math.exp(-phase*2)
                fade=min(1,t/.02,max(0,(seconds-t)/.03));value=int(max(-1,min(1,(tone*envelope+bass)*.2*fade))*32767)
                values.append(value)
            if sys.byteorder!='little':values.byteswap()
            temp=path.with_suffix('.pending')
            with wave.open(str(temp),'wb') as out:out.setnchannels(1);out.setsampwidth(2);out.setframerate(rate);out.writeframes(values.tobytes())
            os.replace(temp,path)
        files.append({'key':key,'title':title,'path':path,'duration':seconds})
    return files
