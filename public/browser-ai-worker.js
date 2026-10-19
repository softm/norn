/** Optional on-device AI. Downloads model weights, never uploads source frames. Experimental. */
let busy=false;
self.onmessage=async({data})=>{if(busy)return;busy=true;let vision,textModel;
 try{
  if(!navigator.gpu||!await navigator.gpu.requestAdapter())throw Error('WebGPU를 사용할 수 없습니다. 표본 직접 검토·수동 편집은 그대로 사용할 수 있습니다.');
  const T=await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.web.js');
  T.env.allowLocalModels=false;T.env.backends.onnx.wasm.numThreads=1;
  const progress=x=>self.postMessage({type:'progress',detail:'모델 다운로드 · '+(x.file||x.status||''),percent:Number.isFinite(x.progress)?Math.floor(x.progress):null});
  const modelId='HuggingFaceTB/SmolVLM-256M-Instruct';const processor=await T.AutoProcessor.from_pretrained(modelId,{progress_callback:progress});
  vision=await T.AutoModelForVision2Seq.from_pretrained(modelId,{device:'webgpu',dtype:'fp32',progress_callback:progress});
  const observations=[];
  for(const [i,item]of data.items.entries()){
   self.postMessage({type:'progress',detail:`표본 분석 ${i+1}/${data.items.length}`,percent:null});
   const urls=item.frames.map(b=>URL.createObjectURL(b));
   try{const images=await Promise.all(urls.map(u=>T.load_image(u)));const messages=[{role:'user',content:[...images.map(()=>({type:'image'})),{type:'text',text:'Describe only what is visibly present in these sampled frames. Do not infer audio, full-video events, dates or prices. User context (do not replace user-specified names): '+data.title+' '+data.description}]}];
    const prompt=processor.apply_chat_template(messages,{add_generation_prompt:true}),input=await processor(prompt,images,{do_image_splitting:false});
    let observed='';const streamer=new T.TextStreamer(processor.tokenizer,{skip_prompt:true,skip_special_tokens:true,callback_function:t=>{observed+=t;}});
    await vision.generate({...input,max_new_tokens:100,do_sample:false,streamer});observations.push({source_id:item.id,observed:observed.slice(0,1200)});
   }finally{urls.forEach(URL.revokeObjectURL);}
  }
  await vision.dispose();vision=null;
  textModel=await T.pipeline('text-generation','onnx-community/Qwen2.5-0.5B-Instruct',{device:'webgpu',dtype:'q4',progress_callback:progress});
  const prompt='한국어 영상 편집 초안을 JSON으로 작성. 사용자 설명과 지정한 대상 이름을 우선하고 없는 사건을 발명하지 않는다. 자료의 순서는 제안만 한다. JSON만 출력: {"summary":"짧은 대본","scenes":[{"source_id":"제공된 ID","name":"장면명","title":"짧은 타이틀","caption":"짧은 문구","reason":"배치 이유"}]}. 설명: '+data.title+' '+data.description+' 관찰: '+JSON.stringify(observations);
  self.postMessage({type:'progress',detail:'한국어 대본·배열 초안 작성',percent:null});
  const answer=await textModel([{role:'user',content:prompt}],{max_new_tokens:700,do_sample:false,return_full_text:false});
  const text=typeof answer[0].generated_text==='string'?answer[0].generated_text:answer[0].generated_text.at(-1).content;
  const start=text.indexOf('{'),end=text.lastIndexOf('}');if(start<0||end<start)throw Error('AI가 유효한 편집안을 반환하지 않았습니다. 기존 편집은 변경하지 않았습니다.');
  const result=JSON.parse(text.slice(start,end+1));if(!Array.isArray(result.scenes))throw Error('AI 편집안 형식 오류');const ids=new Set(data.items.map(x=>x.id)),seen=new Set();
  result.scenes=result.scenes.filter(s=>ids.has(s.source_id)&&!seen.has(s.source_id)&&seen.add(s.source_id)).map(s=>{const out={source_id:s.source_id};for(const [key,n]of [['name',100],['title',100],['caption',240],['reason',400]])out[key]=String(s[key]||'').slice(0,n);if(data.title.includes('낙지')&&!data.description.includes('오징어'))for(const k of ['name','title','caption'])if(/오징어|문어/.test(out[k]))out[k]='';return out;});
  if(!result.scenes.length)throw Error('원본과 연결되는 AI 장면이 없습니다.');self.postMessage({type:'done',proposal:{summary:String(result.summary||'').slice(0,3000),scenes:result.scenes,observations}});
 }catch(e){self.postMessage({type:'error',message:e.message||String(e)});}finally{await vision?.dispose().catch(()=>{});await textModel?.dispose().catch(()=>{});busy=false;}
};
