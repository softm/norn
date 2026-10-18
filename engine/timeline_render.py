"""V8 speed-aware frame-timed renderer. Real per-boundary xfade, bounded-size filter graphs.

Intermediates carry PCM audio to avoid accumulating AAC priming delays. A scene's
outgoing transition overlaps its tail with the next scene's head. All times in
render-plan.json / SRT account for those overlaps. Sources are read-only.
"""
from __future__ import annotations
import copy
import math
import os
from pathlib import Path
import shutil
import tempfile
from typing import Any
from PIL import Image
import editor_features as fx
import speed_tools as speedfx


def render_timeline(media, context, editorial, store, args) -> dict[str, Any]:
    import media_core as core
    rows=copy.deepcopy(args._edit_scenes);by_id={m['id']:m for m in media}
    if not rows:return {'status':'no_usable_media','path':None}
    width,height,fps=args.width,args.height,args.fps
    fades=fx.overlaps(rows,fps)
    supported=fx.supported_transitions()
    for i,s in enumerate(rows[:-1]):
        if s['transition'] not in supported:
            raise ValueError(f'{i+1}번 전환 {s["transition"]}: 설치된 FFmpeg에서 지원하지 않습니다. 다른 전환을 직접 선택하세요.')
    audio=fx.audio_defaults(getattr(args,'_edit_audio',None))
    music_path=getattr(args,'_music_path',None)
    if audio['music_id'] and not music_path:raise ValueError('선택한 음악 파일이 없습니다. 음악을 다시 선택하세요.')
    total=sum(s['duration'] for s in rows)-sum(fades)
    total_frames=round(total*fps)
    progress=getattr(args,'_progress_fn',lambda *a:None)
    work=Path(tempfile.mkdtemp(prefix='v9-render-',dir=store.path('.cache/work/.keep').parent))
    output=store.path('generated/sns-video.mp4');cover=store.path('generated/cover.jpg')
    plan=[];entries=[];warnings=[];story={'format_version':4,'caption_density':'manual','hook':getattr(args,'_edit_hook',''),
        'outro':getattr(args,'_edit_outro',''),'manual_overrides_applied':True,'scenes':[]}
    cmd0=['ffmpeg','-nostdin','-hide_banner','-v','error','-y','-threads',str(args.threads),'-filter_threads','1','-filter_complex_threads','1']
    enc=['-c:v','libx264','-preset',args.preset,'-crf','20','-threads',str(args.threads),'-pix_fmt','yuv420p','-r',str(fps),'-c:a','pcm_s16le','-ar','48000','-ac','2','-map_metadata','-1','-map_chapters','-1']
    def run(cmd):return getattr(args,'_run_command',core.run_command)(cmd,timeout=args.render_timeout)
    scene_files=[];start_time=0.
    try:
        for i,s in enumerate(rows):
            m=by_id[s['source_id']];duration=s['duration'];nframes=round(duration*fps)
            speed=speedfx.speed_of(s) if m['kind']=='video' else 1.0
            span=speedfx.source_span(s) if m['kind']=='video' else duration
            s=fx.default_scene_fields(s)
            p={'id':m['id'],'instance_id':s['id'],'original_relative_path':m['relative_path'],'sha256':m['sha256'],
               'kind':m['kind'],'video_text':s['caption'],'title':s['title'],'caption_source':'user_timeline',
               'start_seconds':s['start'],'duration_seconds':duration,
               'source_duration_seconds':span,'source_end_seconds':round(s['start']+span,6),
               'playback_speed':speed,'speed_audio':s.get('speed_audio','auto'),'timeline_start_seconds':round(start_time,6),
               'transition_seconds':fades[i],**{k:s[k] for k in ('style','transition','motion','keep_audio','font_size','title_size','font_family','text_position')}}
            plan.append(p); story['scenes'].append({'id':m['id'],'instance_id':s['id'],'text':s['caption'],
                'title':s['title'],'visible':bool(s['title'] or s['caption']),'source':'user_timeline'})
            progress('encoding',i,len(rows),m['relative_path']+(f' · 원본 {span:.1f}초 → {duration:.2f}초 · {speed:g}배속 (원본 해독 중)' if m['kind']=='video' else ''))
            original=store.source/m['relative_path'];cmd=cmd0.copy()
            if m['kind']=='image':
                still=core.make_slide(original,work,i+1,width,height,s['style'])
                cmd+=['-loop','1','-framerate',str(fps),'-i',str(still)]
            else:cmd+=['-ss',str(s['start']),'-t',f'{span:.9f}','-i',str(original)]
            cmd+=['-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000']
            layers=[]
            # A user's scene title is a label of their own, never generated SCENE 01.
            if s['title'] or s['caption']:layers.append(('scene',s,0.,duration))
            if i==0 and story['hook'] and duration>=.25:
                hook={**s,'title':'','caption':story['hook'],'font_size':max(s['font_size'],68)}
                layers.append(('hook',hook,0.,min(1.4,duration*.58)))
            if i==len(rows)-1 and story['outro'] and duration>=.4:
                out={**s,'title':'','caption':story['outro']}
                layers.append(('outro',out,max(duration*.52,duration-1.1),duration))
            metadata=[]
            for j,(role,data,begin,end) in enumerate(layers):
                im,meta=fx.title_card(width,height,data,args.font,role)
                path=work/f'title-{i:03d}-{j}.png';im.save(path);metadata.append(meta)
                warnings.extend(meta['warnings']);cmd+=['-loop','1','-framerate',str(fps),'-i',str(path)]
                text='\n'.join(t for t in (data.get('title',''),data.get('caption','')) if t)
                entries.append((start_time+begin,start_time+end,text))
            if m['kind']=='image':
                if s['motion']=='zoom':
                    source_filter=(f"[0:v]zoompan=z='min(zoom+0.0012,1.14)':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s={width}x{height}:fps={fps},setsar=1,setpts=PTS-STARTPTS[base]")
                else:source_filter=f'[0:v]fps={fps},setsar=1,setpts=PTS-STARTPTS[base]'
            else:
                source_filter=(f'[0:v]trim=duration={span:.9f},settb=AVTB,setpts=(PTS-STARTPTS)/{speed:.12g},fps=fps={fps}:start_time=0:eof_action=pass,scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,'
                   f'pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=0x0c1422,setsar=1,tpad=stop_mode=clone:stop_duration={duration:.6f}[base]')
            filters=[source_filter];previous='base'
            for j,((role,data,begin,end),meta) in enumerate(zip(layers,metadata)):
                fin=min(.18,(end-begin)*.3);fout=min(.12,(end-begin)*.25)
                filters.append(f'[{j+2}:v]format=rgba,fade=t=in:st={begin:.6f}:d={fin:.6f}:alpha=1,fade=t=out:st={end-fout:.6f}:d={fout:.6f}:alpha=1[txt{j}]')
                x,y=str(meta['x']),str(meta['y']);move=min(.22,(end-begin)*.3)
                if s['style'] in ('bold_shortform','sticker'):
                    x=f'if(lt(t,{begin+move:.6f}),{meta["x"]}+{width*.12:.3f}*(1-(t-{begin:.6f})/{move:.6f}),{meta["x"]})'
                elif s['style'] in ('info_card','lower_third'):
                    y=f'if(lt(t,{begin+move:.6f}),{meta["y"]}+{height*.04:.3f}*(1-(t-{begin:.6f})/{move:.6f}),{meta["y"]})'
                filters.append(f"[{previous}][txt{j}]overlay=x='{x}':y='{y}':enable='between(t,{begin:.6f},{end:.6f})'[v{j}]")
                previous=f'v{j}'
            filters.append(f'[{previous}]format=yuv420p,trim=end_frame={nframes},setpts=N/({fps}*TB)[v]')
            keep = m['kind']=='video' and speedfx.original_audio_enabled(s, m['analysis'].get('has_audio',False), audio['mute_original'])
            p['original_audio_used'] = keep
            if m['kind']=='video' and s['keep_audio'] and m['analysis'].get('has_audio') and not audio['mute_original'] and not keep:
                warnings.append(f'{i+1}번 장면: 배속 원음 설정에 따라 원음을 음소거했습니다. 배경음악은 정상 속도입니다.')
            ain='0:a:0' if keep else '1:a:0'
            timing = f'atrim=duration={span:.9f},asetpts=PTS-STARTPTS,{speedfx.atempo_filter(speed)},' if keep else 'asetpts=PTS-STARTPTS,'
            filters.append(f'[{ain}]aresample=48000,aformat=channel_layouts=stereo,{timing}apad,atrim=end_sample={round(duration*48000)},asetpts=N/SR/TB,volume={audio["original_volume"] if keep else 0}[a]')
            seg=work/f'scene-{i:03d}.mkv'
            run(cmd+['-filter_complex',';'.join(filters),'-map','[v]','-map','[a]','-t',str(duration)]+enc+[str(seg)])
            scene_files.append(seg)
            if i==0:
                run(['ffmpeg','-nostdin','-v','error','-y','-ss',str(0 if duration<=2/fps else min(duration*.5,.65)),'-i',str(seg),'-frames:v','1','-pix_fmt','yuvj420p','-threads','1','-q:v','3',str(cover)])
            start_time+=duration-fades[i]
        pieces=[]
        for i,seg in enumerate(scene_files):
            incoming=fades[i-1] if i else 0.;outgoing=fades[i];dur=rows[i]['duration']
            body_frames=round((dur-incoming-outgoing)*fps)
            progress('transitions',i,len(rows),fx.TRANSITIONS[rows[i]['transition']][0] if outgoing else '장면 연결')
            if body_frames>0:
                body=work/f'body-{i:03d}.mkv'
                if not incoming and not outgoing:body=seg
                else:
                    length=body_frames/fps
                    flt=f'[0:v]trim=start_frame={round(incoming*fps)}:end_frame={round(incoming*fps)+body_frames},setpts=N/({fps}*TB),fps={fps},format=yuv420p[v];[0:a]atrim=start_sample={round(incoming*48000)}:end_sample={round((incoming+length)*48000)},asetpts=N/SR/TB,apad,atrim=end_sample={round(length*48000)}[a]'
                    run(cmd0+['-i',str(seg),'-filter_complex',flt,'-map','[v]','-map','[a]','-t',str(length)]+enc+[str(body)])
                pieces.append(body)
            if outgoing:
                # Only two scenes are decoded concurrently, even for a 120-scene project.
                trans=work/f'transition-{i:03d}.mkv';next_file=scene_files[i+1];start=dur-outgoing
                flt=(f'[0:v]trim=start_frame={round(start*fps)}:end_frame={round(dur*fps)},setpts=N/({fps}*TB),settb=AVTB,fps={fps},format=yuv444p[a0];'
                     f'[1:v]trim=end_frame={round(outgoing*fps)},setpts=N/({fps}*TB),settb=AVTB,fps={fps},format=yuv444p[a1];'
                     f'[a0][a1]xfade=transition={rows[i]["transition"]}:duration={outgoing:.6f}:offset=0,format=yuv420p[v];'
                     f'[0:a]atrim=start_sample={round(start*48000)}:end_sample={round(dur*48000)},asetpts=N/SR/TB,apad,atrim=end_sample={round(outgoing*48000)}[b0];'
                     f'[1:a]atrim=end_sample={round(outgoing*48000)},asetpts=N/SR/TB,apad,atrim=end_sample={round(outgoing*48000)}[b1];'
                     # Exact-length segments can make acrossfade wait for a packet beyond EOF.
                     # Fade the two already aligned overlap streams, then mix exactly N samples.
                     f'[b0]afade=t=out:ss=0:ns={round(outgoing*48000)}:curve=tri[fo];'
                     f'[b1]afade=t=in:ss=0:ns={round(outgoing*48000)}:curve=tri[fi];'
                     f'[fo][fi]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad,atrim=end_sample={round(outgoing*48000)},asetpts=N/SR/TB[a]')
                run(cmd0+['-i',str(seg),'-i',str(next_file),'-filter_complex',flt,'-map','[v]','-map','[a]','-t',str(outgoing)]+enc+[str(trans)])
                pieces.append(trans)
        (work/'concat.txt').write_text(''.join(f"file '{p.name}'\n" for p in pieces),encoding='utf-8')
        assembled=work/'assembled.mkv'
        run(cmd0+['-f','concat','-safe','1','-i',str(work/'concat.txt'),'-map','0:v:0','-map','0:a:0','-c','copy','-t',str(total),str(assembled)])
        pending=work/'final.mp4';cmd=cmd0+['-i',str(assembled)]
        if music_path:
            if audio['loop']:cmd+=['-stream_loop','-1']
            cmd+=['-ss',str(audio['music_start']),'-i',str(music_path)]
            fin=min(audio['fade_in'],total/2);fout=min(audio['fade_out'],total/2)
            effects=(f'[1:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,apad,atrim=duration={total:.6f},volume={audio["music_volume"]}')
            if fin:effects+=f',afade=t=in:st=0:d={fin:.6f}'
            if fout:effects+=f',afade=t=out:st={total-fout:.6f}:d={fout:.6f}'
            effects+=f'[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:latency=1[a]'
            cmd+=['-filter_complex',effects,'-map','0:v:0','-map','[a]']
        else:cmd+=['-map','0:v:0','-map','0:a:0']
        run(cmd+['-c:v','copy','-c:a','aac','-b:a','160k','-t',str(total),'-map_metadata','-1','-map_chapters','-1','-movflags','+faststart',str(pending)])
        progress('verifying',len(rows),len(rows),'전환·오디오·전체 디코딩 확인')
        meta=core.probe(pending)
        if meta['width']!=width or meta['height']!=height:raise ValueError('출력 해상도 불일치')
        if abs(meta['duration']-total)>max(.08,2/fps):raise ValueError(f'전환 포함 길이 불일치: 계획 {total:.3f}, 실제 {meta["duration"]:.3f}')
        test=run(['ffmpeg','-nostdin','-v','error','-i',str(pending),'-f','null','-'])
        if test.stderr.strip():raise ValueError('디코딩 오류: '+test.stderr[-800:])
        # Check exact video frame count, not container duration alone.
        count=run(['ffprobe','-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=nb_read_frames','-of','default=nw=1:nk=1',str(pending)])
        if int(count.stdout.strip())!=total_frames:raise ValueError(f'출력 프레임 수가 편집 계획과 다릅니다. 계획 {total_frames}, 실제 {count.stdout.strip()}. 상세 로그를 확인하세요.')
        os.replace(pending,output)
        entries.sort(key=lambda e:(e[0],e[1]))
        core_subs='\n'.join(f'{i}\n{core.srt_time(a)} --> {core.srt_time(b)}\n{text}\n' for i,(a,b,text) in enumerate(entries,1))
        store.write('generated/subtitles.srt',core_subs)
        store.write_json('generated/storyboard.json',story)
        store.write('generated/video-script.txt','\n'.join((x['title']+'\n'+x['text']).strip() for x in story['scenes']))
        store.write_json('render-plan.json',{'selection':'user_timeline','scenes':plan,'selected_count':len(rows),
            'total_available_media':len(media),'storyboard':story,'total_duration_seconds':total,
            'total_frames':total_frames,'transition_engine':'xfade/afade-amix','overlap_seconds':sum(fades),
            'audio_settings':audio,'warnings':sorted(set(warnings))})
        return {'status':'created_verified','path':'generated/sns-video.mp4','cover':'generated/cover.jpg',
            'subtitles':'generated/subtitles.srt','storyboard':'generated/storyboard.json','metadata':meta,
            'sha256':core.file_hash(output),'size':output.stat().st_size,'scene_count':len(rows),
            'decode_verified':True,'frame_count_verified':True,'planned_duration':total,'planned_frames':total_frames,
            'cache_hit':False,'audio':'background_music' if music_path else 'original_when_available' if any(s['keep_audio'] for s in rows) and not audio['mute_original'] else 'silent',
            'audio_settings':audio,'music_credit':getattr(args,'_music_credit',''),'style_preset':context['style_preset'],
            'caption_density':'manual','burned_in_captions':True,'font_warning':None,'warnings':sorted(set(warnings))}
    finally:
        if not args.keep_work:shutil.rmtree(work,ignore_errors=True)
