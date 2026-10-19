/** The same Canvas typography is used for the editor overlay and exported PNG. */
import {canvasBlob} from './browser-media.js';
function lines(ctx,text,width,max=5){const out=[];for(const paragraph of String(text||'').split('\n')){let line='';for(const c of paragraph){if(line&&ctx.measureText(line+c).width>width){out.push(line);line=c;}else line+=c;}out.push(line);}return out.length>max?[...out.slice(0,max-1),out[max-1].slice(0,-1)+'…']:out;}
export function paintText(canvas,scene,width,height){canvas.width=width;canvas.height=height;const c=canvas.getContext('2d');c.clearRect(0,0,width,height);if(!scene.title&&!scene.caption)return canvas;
 const scale=width/1080,margin=width*.07,maxWidth=width-margin*2,style=scene.style,serif=scene.font_family==='serif'||style==='emotional',family=serif?'Georgia, "Noto Serif KR", serif':'system-ui, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
 const titleSize=Math.max(10,Math.min(200,scene.title_size||52)*scale),bodySize=Math.max(9,Math.min(200,scene.font_size||42)*scale);
 c.font=`800 ${titleSize}px ${family}`;const title=scene.title?lines(c,scene.title,maxWidth-24*scale):[];
 c.font=`500 ${bodySize}px ${family}`;const caption=scene.caption?lines(c,scene.caption,maxWidth-24*scale):[];
 const th=title.length*titleSize*1.28,bh=caption.length*bodySize*1.4,gap=title.length&&caption.length?bodySize*.35:0,total=th+bh+gap,pad=Math.max(8,20*scale);
 let y=scene.text_position==='top'?height*.12:scene.text_position==='middle'?(height-total)/2:height*.84-total;y=Math.max(margin,Math.min(height-total-margin,y));
 const card=['info_card','sticker','lower_third','editorial'].includes(style),left=['lower_third','editorial'].includes(style),x=left?margin+pad:width/2;
 if(card){c.fillStyle=style==='sticker'?'#f3dd84':style==='info_card'?'rgba(15,20,15,.88)':'rgba(15,20,15,.72)';c.beginPath();c.roundRect(margin,y-pad,maxWidth,total+pad*2,style==='sticker'?18*scale:8*scale);c.fill();}
 if(style==='editorial'||style==='lower_third'){c.fillStyle='#eabb65';c.fillRect(margin,y-pad,Math.max(3,6*scale),total+pad*2);}
 c.textAlign=left?'left':'center';c.textBaseline='top';
 const ink=style==='sticker'?'#242719':'#fffbed';c.fillStyle=ink;c.lineJoin='round';
 if(style==='neon'){c.shadowColor='#a9edc5';c.shadowBlur=14*scale;}else{c.shadowColor='#000';c.shadowBlur=5*scale;c.shadowOffsetY=2*scale;}
 const draw=(line,yy,size,bold)=>{c.font=`${bold?800:500} ${size}px ${family}`;if(['outline','bold_shortform','cinema'].includes(style)){c.strokeStyle='#101510';c.lineWidth=Math.max(2,5*scale);c.strokeText(line,x,yy);}c.fillText(line,x,yy);};
 title.forEach((line,i)=>draw(line,y+i*titleSize*1.28,titleSize,true));caption.forEach((line,i)=>draw(line,y+th+gap+i*bodySize*1.4,bodySize,false));return canvas;
}
export async function textPNG(scene,width,height){await document.fonts.ready;const canvas=paintText(document.createElement('canvas'),scene,width,height);const blob=await canvasBlob(canvas);canvas.width=canvas.height=1;return blob;}
