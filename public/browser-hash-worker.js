import {SHA256} from './browser-sha.js';
self.onmessage=async({data:{id,file}})=>{try{const sha=new SHA256(),chunk=2**20;for(let pos=0;pos<file.size;pos+=chunk){sha.update(new Uint8Array(await file.slice(pos,pos+chunk).arrayBuffer()));self.postMessage({id,progress:Math.min(1,(pos+chunk)/file.size)});}self.postMessage({id,hash:sha.hex()});}catch(e){self.postMessage({id,error:e.message});}};
