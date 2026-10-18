/** No demo fallback on authentication failure. Settings are metadata, never local file handles. */
import {normalizeConfig,authMessage} from './firebase-config-utils.js';
import {createCloudStore} from './cloud-store.js';
let services=null,configuration=null,initialization=null;
export async function config(){if(!configuration)configuration=await fetch(new URL('./firebase-config.json',import.meta.url),{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('Firebase 설정 파일을 읽지 못했습니다.');return r.json()});return configuration}
export async function firebase(){if(services)return services;if(!initialization)initialization=initialize().catch(e=>{initialization=null;throw Error(authMessage(e))});return initialization}
async function initialize(){const c=await config();if(!c.enabled)throw Error('Firebase 운영 프로젝트가 아직 연결되지 않았습니다. 로그인 없이 체험하기 또는 로컬 편집을 사용하세요.');const web=normalizeConfig(c),base='https://www.gstatic.com/firebasejs/13.0.0/';const [appSDK,auth,db]=await Promise.all([import(base+'firebase-app.js'),import(base+'firebase-auth.js'),import(base+'firebase-firestore.js')]);const app=appSDK.initializeApp(web),authentication=auth.getAuth(app);authentication.languageCode='ko';const database=db.initializeFirestore(app,{localCache:db.memoryLocalCache()});if(c.appCheckSiteKey){const check=await import(base+'firebase-app-check.js');check.initializeAppCheck(app,{provider:new check.ReCaptchaEnterpriseProvider(c.appCheckSiteKey),isTokenAutoRefreshEnabled:true})}const repo=createCloudStore({sdk:db,db:database,currentUid:()=>authentication.currentUser?.uid});services={app,auth,db,authentication,database,repo};return services}
export async function login(){try{const s=await firebase();await s.auth.setPersistence(s.authentication,s.auth.browserSessionPersistence);const provider=new s.auth.GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});return (await s.auth.signInWithPopup(s.authentication,provider)).user}catch(e){throw Error(authMessage(e))}}
export async function observe(callback){const c=await config();if(!c.enabled)return ()=>{};const s=await firebase();return s.auth.onAuthStateChanged(s.authentication,callback)}
export async function logout(){const s=await firebase();await s.auth.signOut(s.authentication)}
export async function saveCloud(project,expected=0){return (await firebase()).repo.save(project,expected)}
export async function listCloud(){return (await firebase()).repo.list()}
export async function loadCloud(id){return (await firebase()).repo.load(id)}
export async function deleteCloud(id,expected){return (await firebase()).repo.remove(id,expected)}
export async function savePreferences(value){return (await firebase()).repo.savePreferences(value)}
export async function loadPreferences(){const s=await firebase();if(!s.authentication.currentUser)return null;return s.repo.loadPreferences()}
export async function testConnection(){return (await firebase()).repo.probe()}
