import * as Cloud from './firebase-v2.js?v=0.6.0';
import {configStatus,authMessage} from './firebase-config-utils.js';
const el=id=>document.getElementById(id);
function status(id,text,ok=null){const n=el(id);n.textContent=text;n.className=ok===null?'':ok?'ok':'bad';}
el('current-host').textContent=location.hostname||'file:// · 웹 서버로 실행하세요';
async function check(){
  try{const c=await Cloud.config(),s=configStatus(c);status('config-state',s.message,s.ready);el('check-login').disabled=!s.ready;el('project-id').textContent=s.projectId||'미연결';
    if(s.ready){el('console-link').href=`https://console.firebase.google.com/project/${encodeURIComponent(s.projectId)}/authentication/providers`;}
  }catch(e){status('config-state',authMessage(e),false);el('check-login').disabled=true;}
}
el('check-config').onclick=()=>location.reload();
el('check-login').onclick=async()=>{
  el('check-login').disabled=true;
  try{await Cloud.login();status('auth-state','실제 Google 인증 성공. 계정에 프로젝트를 저장하거나 원본을 업로드하지 않았습니다.',true);el('check-db').disabled=false;}
  catch(e){status('auth-state',authMessage(e),false);el('check-db').disabled=true;}
  finally{el('check-login').disabled=false;}
};
el('check-db').onclick=async()=>{
  el('check-db').disabled=true;
  try{const s=await Cloud.firebase();if(!s.authentication.currentUser)throw Error('Google 로그인을 먼저 완료하세요.');const result=await Cloud.loadPreferences();status('db-state',result?'본인의 기본 설정 읽기 성공.':'읽기 권한 확인 완료. 저장한 기본 설정은 아직 없습니다.',true);}
  catch(e){status('db-state',authMessage(e),false);}
  finally{el('check-db').disabled=false;}
};
await check();

const probe=document.createElement('section');probe.className='setup-section';probe.innerHTML='<h2>저장·복원·이력 검사</h2><p>본인 계정에 작은 임시 검사 문서와 임시 프로젝트를 만들고 읽기·이력 저장·복원 후 삭제합니다. 원본과 실제 편집 프로젝트는 변경하지 않습니다.</p><button id="probe-storage">저장·읽기·삭제 검사</button><p id="probe-status" role="status"></p>';document.querySelector('main').append(probe);el('probe-storage').onclick=async()=>{el('probe-storage').disabled=true;try{await Cloud.testConnection();await Cloud.testProjectHistory();status('probe-status','실제 임시 문서 저장·읽기·삭제와 프로젝트 이력 저장·복원에 성공했습니다.',true)}catch(e){status('probe-status',authMessage(e),false)}finally{el('probe-storage').disabled=false}};
