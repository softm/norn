// Loaded only for explicitly configured Firebase. Demo never falls through authentication.
import {cloudProject} from './domain.js';
let services=null;let configuration=null;
export async function config(){if(!configuration){configuration=await fetch('./firebase-config.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('설정 파일을 읽지 못했습니다.');return r.json()})}return configuration}
export async function firebase(){if(services)return services;const c=await config();if(!c.enabled||!c.firebase?.projectId||!c.firebase?.apiKey||!c.firebase?.authDomain||!c.firebase?.appId)throw Error('Firebase 운영 프로젝트가 아직 연결되지 않았습니다. 체험은 별도로 이용할 수 있습니다.');
 const root='https://www.gstatic.com/firebasejs/12.4.0/';
 const [a,auth,db]=await Promise.all([import(root+'firebase-app.js'),import(root+'firebase-auth.js'),import(root+'firebase-firestore.js')]);
 const app=a.initializeApp(c.firebase);const authentication=auth.getAuth(app);authentication.languageCode='ko';
 const database=db.initializeFirestore(app,{localCache:db.memoryLocalCache()});
 if(c.appCheckSiteKey){const check=await import(root+'firebase-app-check.js');check.initializeAppCheck(app,{provider:new check.ReCaptchaEnterpriseProvider(c.appCheckSiteKey),isTokenAutoRefreshEnabled:true})}
 services={app,auth,db,authentication,database};return services;
}
export async function login(){const s=await firebase();await s.auth.setPersistence(s.authentication,s.auth.browserSessionPersistence);const provider=new s.auth.GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});return (await s.auth.signInWithPopup(s.authentication,provider)).user}
export async function observe(cb){const c=await config();if(!c.enabled)return ()=>{};const s=await firebase();return s.auth.onAuthStateChanged(s.authentication,cb)}
export async function logout(){const s=await firebase();await s.auth.signOut(s.authentication)}
export async function saveCloud(p,expected=0){const s=await firebase(),u=s.authentication.currentUser;if(!u)throw Error('Google 로그인이 필요합니다.');const data=cloudProject(p);if(new TextEncoder().encode(JSON.stringify(data)).length>700000)throw Error('편집 정보가 너무 큽니다. 출력 버전을 나눠 저장하세요.');
 const ref=s.db.doc(s.database,'users',u.uid,'projects',p.id);
 return s.db.runTransaction(s.database,async tx=>{const snap=await tx.get(ref),old=snap.exists()?snap.data().revision:0;if(old!==expected)throw Error('다른 기기의 편집과 충돌합니다. 클라우드 목록에서 최신본을 불러오세요.');tx.set(ref,{schema_version:2,title:data.title,description:data.description,activeVariant:data.activeVariant,frames:data.frames,targetDuration:data.targetDuration,revision:old+1,updatedAt:s.db.serverTimestamp(),variantIds:data.variants.map(v=>v.id)});for(const v of data.variants)tx.set(s.db.doc(ref,'variants',v.id),{schema_version:2,...v});return old+1})
}
export async function listCloud(){const s=await firebase(),u=s.authentication.currentUser;if(!u)throw Error('먼저 로그인하세요.');const snap=await s.db.getDocs(s.db.query(s.db.collection(s.database,'users',u.uid,'projects'),s.db.orderBy('updatedAt','desc'),s.db.limit(50)));return snap.docs.map(d=>({id:d.id,...d.data()}))}
export async function loadCloud(id){const s=await firebase(),u=s.authentication.currentUser;if(!u)throw Error('먼저 로그인하세요.');const ref=s.db.doc(s.database,'users',u.uid,'projects',id),snap=await s.db.getDoc(ref);if(!snap.exists())throw Error('프로젝트가 없습니다.');const data=snap.data();const variants=await Promise.all(data.variantIds.map(async vid=>{const r=await s.db.getDoc(s.db.doc(ref,'variants',vid));if(!r.exists())throw Error('출력 버전이 누락됐습니다.');return r.data()}));return {schema_version:2,id,...data,variants}}
export async function savePreferences(value){const s=await firebase(),u=s.authentication.currentUser;if(!u)throw Error('로그인이 필요합니다.');await s.db.setDoc(s.db.doc(s.database,'users',u.uid,'settings','defaults'),{frames:Number(value.frames)||5,theme:'warm',updatedAt:s.db.serverTimestamp()})}

export async function loadPreferences(){const s=await firebase(),u=s.authentication.currentUser;if(!u)return null;const d=await s.db.getDoc(s.db.doc(s.database,'users',u.uid,'settings','defaults'));return d.exists()?d.data():null}
