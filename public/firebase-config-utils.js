// Shared by the browser and CLI. Never eval SDK snippets or persist admin credentials.
const publicKeys = ['apiKey', 'authDomain', 'projectId', 'appId', 'storageBucket', 'messagingSenderId', 'measurementId', 'databaseURL'];
const secretKey = /^(private_key(_id)?|privatekey|client_secret|clientsecret|refresh_?token|access_?token|id_?token|credential|credentials)$/i;
function rejectSecrets(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (secretKey.test(key) || (key === 'type' && item === 'service_account')) {
      throw new Error('관리자 키·개인키·로그인 토큰은 웹 설정으로 사용할 수 없습니다. Firebase 웹 앱의 공개 SDK 설정만 사용하세요.');
    }
    if (typeof item === 'string' && /-----BEGIN [^-]*PRIVATE KEY-----/.test(item)) throw new Error('개인키는 사용할 수 없습니다.');
    rejectSecrets(item);
  }
}
export function projectId(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value)) throw new Error('Firebase 프로젝트 ID를 확인하세요.');
  return value;
}
export function normalizeConfig(value, expectedProject = '') {
  rejectSecrets(value);
  let c = value?.result?.sdkConfig ?? value?.sdkConfig ?? value?.firebase ?? value;
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('Firebase 웹 SDK 설정 객체가 필요합니다.');
  const result = {};
  for (const key of publicKeys) {
    if (c[key] === undefined || c[key] === '') continue;
    if (typeof c[key] !== 'string' || c[key].length > 2048) throw new Error(`웹 설정 ${key} 형식을 확인하세요.`);
    result[key] = c[key].trim();
  }
  for (const key of ['apiKey','authDomain','projectId','appId']) if (!result[key]) throw new Error(`웹 설정 ${key} 값이 없습니다.`);
  projectId(result.projectId);
  if (expectedProject && result.projectId !== expectedProject) throw new Error('선택한 프로젝트와 SDK 설정의 프로젝트가 다릅니다. 변경하지 않았습니다.');
  if (!/^AIza[A-Za-z0-9_-]{20,}$/.test(result.apiKey)) throw new Error('Firebase Console에서 받은 실제 공개 웹 API 키를 사용하세요.');
  if (!/^1:\d+:web:[A-Za-z0-9]+$/.test(result.appId)) throw new Error('웹 앱 ID 형식이 올바르지 않습니다.');
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(result.authDomain)) throw new Error('authDomain에는 프로토콜·경로 없이 실제 인증 도메인만 넣으세요.');
  if (result.databaseURL && !result.databaseURL.startsWith('https://')) throw new Error('databaseURL은 HTTPS만 사용할 수 있습니다.');
  return result;
}
export function configStatus(c) {
  if (!c?.enabled) return {ready:false, message:'Firebase 운영 연결 전입니다. 로컬 편집·샘플 체험은 사용할 수 있습니다.'};
  try { const sdk = normalizeConfig(c); return {ready:true,projectId:sdk.projectId,authDomain:sdk.authDomain,message:'웹 설정 형식 확인 완료. 실제 로그인·데이터 권한은 별도 점검하세요.'}; }
  catch(e) { return {ready:false,message:e.message}; }
}
export function authMessage(error) {
  const code=String(error?.code || '');
  const messages={
    'auth/unauthorized-domain':'현재 사이트가 Firebase Authentication의 승인된 도메인에 없습니다. 프로젝트의 Authorized domains를 확인하세요.',
    'auth/operation-not-allowed':'Firebase Authentication에서 Google 로그인 제공자를 활성화하세요.',
    'auth/popup-blocked':'로그인 팝업이 차단됐습니다. 이 사이트의 팝업을 허용하고 Google 로그인 버튼을 다시 누르세요.',
    'auth/popup-closed-by-user':'로그인 창이 닫혔습니다. 로그인은 완료되지 않았습니다.',
    'auth/cancelled-popup-request':'다른 로그인 요청이 있습니다. 로그인 창 하나에서 완료하세요.',
    'auth/network-request-failed':'Google 로그인 서버에 연결하지 못했습니다. 네트워크·브라우저 차단 설정을 확인하세요.',
    'auth/invalid-api-key':'Firebase 공개 웹 API 키를 확인하세요.',
    'auth/configuration-not-found':'이 Firebase 프로젝트에서 Authentication 설정을 완료하세요.',
    'permission-denied':'Firestore 접근이 거부됐습니다. 현재 계정과 노른 보안 규칙 배포 상태를 확인하세요.',
    'unavailable':'Firebase 서버에 연결하지 못했습니다. 로컬 편집은 유지됩니다.',
    'failed-precondition':'Firestore 데이터베이스와 필요한 인덱스 설정을 확인하세요.'
  };
  return messages[code] || String(error?.message || '연결 중 오류가 발생했습니다.');
}
