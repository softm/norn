// Identity UI only. Existing Norn Firebase users and workspace storage are not
// migrated or merged. The optional common vault keeps its existing bridge.
async function mount() {
  // The local engine has an existing no-external-requests startup contract.
  // Its origin is not an approved common-account production origin. Preserve
  // the explicit, lazy account entry there instead of contacting production
  // merely to open a local editor. Public web deployments mount automatically.
  if(location.protocol==='file:' || ['localhost','127.0.0.1','[::1]','appassets.androidplatform.net'].includes(location.hostname))return;
  try {
    const {mountRegisteredSite}=await import('https://softm.github.io/shared/platform/v1/boot.mjs?v=20261030-menu-1');
    // The legacy lazy entry can win the race if clicked during module loading.
    // Reuse it rather than creating a second account or vault instance.
    if(!window.SoftmAccounts?.has('norn'))mountRegisteredSite('norn');
    if(document.querySelector('softm-site-account[data-site="norn"][data-account-ui="icon-menu-v2"]')) {
      document.documentElement.dataset.nornAccountMenu='ready';
    }
  } catch {
    // Keep the previous account entry usable when the shared module is offline.
    console.warn('공통 계정 메뉴를 준비하지 못했습니다. 기존 계정 버튼과 기기 편집은 계속 사용할 수 있습니다.');
  }
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
