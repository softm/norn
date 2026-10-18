#!/usr/bin/env node
/** NORN setup: authenticated CLI reads, explicit project/app selection, no secret exports.
 * Does NOT install the ChatGPT plugin and never authorizes Google on the user's behalf.
 */
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,rename,mkdir,copyFile} from 'node:fs/promises';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {normalizeConfig,projectId} from '../public/firebase-config-utils.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const pkg=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
const version=pkg.devDependencies['firebase-tools'];
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('firebase-tools는 정확한 버전을 지정해야 합니다.');
if (process.argv.includes('--help') || process.argv.includes('--dry-run')) {
  console.log(`NORN Firebase 연결 도우미 (firebase-tools ${version})
사용: bash scripts/connect-firebase.command
순서: 본인 Google 승인 → 프로젝트 조회/선택 → 웹 앱 조회/등록 → 공개 설정 자동 검증/저장
      → Console에서 Google 제공자·Firestore·허용 도메인 확인 → 선택한 사이트에 배포
새 프로젝트/앱 생성과 운영 Rules·Hosting 교체는 각각 확인 후 실행합니다.
관리자 키, 결제 연결, 사용자 원본 업로드, ChatGPT 플러그인 설치는 하지 않습니다.
--dry-run / --help는 외부 호출·파일 변경 없이 이 안내만 출력합니다.`);
  process.exit(0);
}
if (Number(process.versions.node.split('.')[0])<22) throw Error('Node.js 22 이상이 필요합니다.');
if (!process.stdin.isTTY) throw Error('사용자 승인과 선택이 필요하므로 로컬 터미널에서 실행하세요.');
const q=createInterface({input:process.stdin,output:process.stdout});
async function ask(text){return (await q.question(text)).trim();}
async function confirm(text){return (await ask(text+' [yes/N] '))==='yes';}
function cli(args,json=false) {
  const cmd=process.platform==='win32'?'npx.cmd':'npx';
  const all=['--yes',`firebase-tools@${version}`,...args,...(json?['--json','--non-interactive']:[])];
  const r=spawnSync(cmd,all,{cwd:root,encoding:'utf8',shell:false,stdio:json?['inherit','pipe','inherit']:'inherit',maxBuffer:16*1024*1024});
  if(r.error)throw Error('Firebase CLI를 실행하지 못했습니다. Node.js/npm과 인터넷 연결을 확인하세요.');
  if(r.status!==0)throw Error(`${args[0]} 실패. 위 CLI 오류를 확인하세요. 배포 성공으로 처리하지 않았습니다.`);
  if(!json)return;
  let value;try{value=JSON.parse(r.stdout);}catch{throw Error('Firebase CLI가 JSON 응답을 주지 않았습니다. 응답 내용을 설정으로 저장하지 않았습니다.');}
  if(value.status && value.status!=='success')throw Error('Firebase CLI 요청이 성공하지 않았습니다.');
  return value.result ?? value;
}
function chooseArray(value,key){const a=Array.isArray(value)?value:value?.[key];if(!Array.isArray(a))throw Error('CLI 목록 응답 형식을 확인하세요. 임의 ID를 사용하지 않았습니다.');return a;}
async function choose(items,label,show){
  if(!items.length)throw Error(label+' 목록이 비어 있습니다.');
  console.log('\n'+label);items.forEach((x,i)=>console.log(`${i+1}. ${show(x)}`));
  const n=Number(await ask('번호 선택: '));if(!Number.isInteger(n)||n<1||n>items.length)throw Error('유효한 번호를 선택하세요.');return items[n-1];
}
async function atomic(file,value){const temp=file+'.tmp';await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temp,file);}
async function backup(file){try{await copyFile(file,resolve(root,'.norn',file.split('/').pop()+'.'+Date.now()+'.bak'));}catch(e){if(e.code!=='ENOENT')throw e;}}
try {
  console.log('\n노른노른하게, 영상을 굽다. · Firebase 연결\n원본은 업로드하지 않습니다. Google 승인은 브라우저에서 본인이 완료하세요.');
  cli(['login']);
  let projects=chooseArray(cli(['projects:list'],true),'projects');
  const create=await confirm('기존 프로젝트 대신 노른 전용 Firebase 프로젝트를 새로 만들까요?');
  let selected;
  if(create){
    const id=projectId(await ask('새 프로젝트 ID (전역 고유·소문자/숫자/하이픈, 6~30자): '));
    if(!await confirm(`프로젝트 ${id}를 생성할까요? 결제 계정은 연결하지 않습니다.`))throw Error('사용자가 프로젝트 생성을 취소했습니다.');
    cli(['projects:create',id,'--display-name','NORN']);
    projects=chooseArray(cli(['projects:list'],true),'projects');selected=projects.find(p=>p.projectId===id);
    if(!selected)throw Error('생성한 프로젝트를 목록에서 확인하지 못했습니다. 잠시 후 다시 실행하세요.');
  }else selected=await choose(projects,'사용할 전용 프로젝트',p=>`${p.displayName||''} (${p.projectId})`);
  const id=projectId(selected.projectId);
  console.log(`\n선택: ${id}\n다른 서비스와 공유한 데이터베이스/Hosting은 선택하지 않는 것이 좋습니다.`);
  if(await ask('노른 전용 프로젝트임을 확인하고 위 프로젝트 ID를 다시 입력: ')!==id)throw Error('프로젝트 확인이 취소됐습니다.');
  let apps=chooseArray(cli(['apps:list','WEB','--project',id],true),'apps');
  if(!apps.length){
    if(!await confirm('이 프로젝트에 NORN 웹 앱을 등록할까요?'))throw Error('웹 앱 등록이 취소됐습니다.');
    cli(['apps:create','WEB','NORN','--project',id]);
    apps=chooseArray(cli(['apps:list','WEB','--project',id],true),'apps');
  }
  const app=await choose(apps,'Firebase 웹 앱',a=>`${a.displayName||''} (${a.appId})`);
  if(typeof app.appId!=='string')throw Error('웹 앱 ID가 없습니다.');
  const sdk=normalizeConfig(cli(['apps:sdkconfig','WEB',app.appId,'--project',id],true),id);
  if(sdk.appId!==app.appId)throw Error('선택한 웹 앱과 설정이 다릅니다.');
  if(selected.projectNumber && sdk.appId.split(':')[1]!==String(selected.projectNumber))throw Error('프로젝트 번호가 일치하지 않습니다.');
  await mkdir(resolve(root,'.norn'),{recursive:true});
  const configFile=resolve(root,'public/firebase-config.json');
  let old={};try{old=JSON.parse(await readFile(configFile,'utf8'));}catch{}
  console.log('\n공개 웹 설정을 가져왔습니다. apiKey는 출력하지 않습니다.');
  if(!await confirm('public/firebase-config.json에 검증한 웹 설정을 저장할까요?'))throw Error('설정 저장이 취소됐습니다.');
  await backup(configFile);
  await atomic(configFile,{enabled:true,firebase:sdk,appCheckSiteKey:old.firebase?.projectId===id?(old.appCheckSiteKey||''):'',note:'원본은 로컬에 보관합니다. 공개 웹 SDK 설정이며 관리자 자격증명은 포함하지 않습니다.'});
  console.log(`\n설정 저장 완료 (실제 Google 로그인 검증 완료라는 뜻은 아닙니다).
다음 Console 항목을 확인하세요:
Google 로그인 활성화: https://console.firebase.google.com/project/${id}/authentication/providers
허용 도메인: https://console.firebase.google.com/project/${id}/authentication/settings
Firestore: https://console.firebase.google.com/project/${id}/firestore
필요 도메인: 실제 Firebase Hosting 도메인 / 사용할 커스텀 도메인 / softm.github.io (Pages 이용 시)
로컬 점검 시 localhost도 직접 승인 목록에 추가하세요.
Firestore가 없으면 기본 데이터베이스를 만들고 잠금/프로덕션 모드를 사용하세요. 테스트 모드로 열지 마세요.
이 스크립트는 Google 제공자·허용 도메인·데이터베이스 생성 확인을 대신했다고 표시하지 않습니다.`);
  if(!await confirm('위 Console 설정을 확인했고, 이제 Rules와 Hosting을 배포할까요?')){
    console.log('운영 배포는 실행하지 않았습니다. 설정만 저장했습니다.');
  }else{
    const sites=chooseArray(cli(['hosting:sites:list','--project',id],true),'sites');
    const site=await choose(sites,'배포할 Hosting 사이트',s=>`${s.name} ${s.defaultUrl||''}`);
    const siteId=String(site.name||'').split('/').pop();
    if(!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(siteId))throw Error('Hosting 사이트 ID 형식을 확인하세요.');
    if(!await confirm(`주의: ${id} 기본 Firestore Rules 전체와 ${siteId}의 현재 웹사이트가 노른 설정으로 교체됩니다. 진행할까요?`))throw Error('배포를 취소했습니다.');
    const deploy=JSON.parse(await readFile(resolve(root,'firebase.json'),'utf8'));
    deploy.hosting.site=siteId;
    const deployFile=resolve(root,'firebase.norn.local.json');
    await atomic(deployFile,deploy);
    cli(['deploy','--project',id,'--config','firebase.norn.local.json','--only','firestore:rules,hosting']);
    console.log('\nFirebase CLI가 배포 성공을 반환했습니다. 실제 로그인과 다른 계정의 접근 거부를 확인하세요.');
    const link=String(site.defaultUrl||'');if(/^https:\/\/[a-z0-9.-]+\/?$/.test(link))console.log('서비스: '+link+'\n연결 점검: '+link.replace(/\/$/,'')+'/setup.html');
    console.log('Firestore 색인·다른 프로젝트·결제 설정은 변경하지 않았습니다.');
  }
}catch(e){console.error('\n중단: '+e.message);process.exitCode=1;}
finally{q.close();}
