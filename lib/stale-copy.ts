// An outdated copy of the app must never leave a broken page (#61). After an
// update the server no longer has the files of the previous build
// (/_next/static/…), so a page of that build – kept by the service worker
// (public/sw.js), the iPhone and iPad app's offline copy, a back/forward
// cache or a proxy – loads without its styles and scripts: a white page
// with plain buttons and fields.
//
// - Every answer of the server names its build (BUILD_HEADER, set in
//   proxy.ts), every page carries it (BUILD_META, app/layout.tsx); stored
//   copies keep it with the page.
// - SELF_HEAL_SCRIPT runs inline in <head> of every page, before and
//   independent of the app's own scripts: when the page's style sheets or
//   scripts do not load (or later parts of an older build), it loads the
//   live page once, past stored copies; if that does not help either, it
//   shows a plain message with "Reload" and "Clear cache" instead of a white
//   page. The app (flowplan-app) hears it as { type: "staleCopy" }.
export const BUILD_HEADER = "X-Flowplan-Build";
export const BUILD_META = "flowplan-build";
// Set in app/globals.css: the page's styles are there when it is.
export const STYLE_SENTINEL = "--flowplan-styles";
// Added to the address of the reload (past caches on the way), removed
// again once the page works.
export const FRESH_PARAM = "flowplan-fresh";
// sessionStorage: when the page last reloaded itself – at most once per
// HEAL_WINDOW, so a page that cannot work never reloads in a loop.
export const HEAL_KEY = "flowplan-heal";
export const HEAL_WINDOW = 2 * 60_000;
// Parts of the app that failed to load on demand (components/view-fallback.tsx).
export const STALE_CHUNK_EVENT = "flowplan:stale-chunk";

export type HealKind =
  // The page's own style sheets and scripts did not load.
  | "boot"
  // Later: a part loaded on demand failed, the page came back from the
  // back/forward cache, or a service worker served it.
  | "later";
export type HealStep = "reload" | "message" | "none";

// What the page does. `server` is the live server's answer (null: none,
// the device is offline); a reload happened recently when `recent`.
export function healStep(kind: HealKind, page: string, server: { build: string | null } | null, recent: boolean): HealStep {
  if (kind === "later") {
    // Only a newer build is a reason to load the page again; otherwise the
    // part shows its own message (view-fallback.tsx).
    const newer = !!server?.build && !!page && server.build !== page;
    return newer && !recent ? "reload" : "none";
  }
  // Offline a reload brings the same incomplete copy back.
  if (!server) return "message";
  return recent ? "message" : "reload";
}

// The inline script (app/layout.tsx, with the nonce of the page). Plain
// ES2017 without the app's code: it must work when every file of the app is
// missing. healStep is repeated here (tests/stale-copy.test.ts runs both).
//
// - "boot": an error event of one of the page's /_next/static scripts or
//   style sheets, or after "load" the styles are missing (STYLE_SENTINEL),
//   the app's scripts did not run (window.next) or a style sheet of the
//   page has none.
// - "later": a script or style sheet of the app failing after "load", a
//   ChunkLoadError, STALE_CHUNK_EVENT, a page from the back/forward cache,
//   and once after "load" a page a service worker answered.
// - The live server's build comes from the health check's BUILD_HEADER.
//   The reload drops the stored "/" of the service worker's copy when it is
//   of another build ("Clear cache": the copy's files as well), asks
//   registered workers to update and loads the address with FRESH_PARAM;
//   the parameter goes again once the page works – unless sessionStorage is
//   blocked, then it is the guard against a second reload.
// - The stored copy of the iPhone and iPad app (meta flowplan-offline-copy)
//   is left to the app: it hears { type: "staleCopy", copy: true }.
export function selfHealScript(build: string) {
  return `(function(){
var BUILD=${JSON.stringify(build).replace(/</g, "\\u003c")},KEY=${JSON.stringify(HEAL_KEY)},PARAM=${JSON.stringify(FRESH_PARAM)},WINDOW=${HEAL_WINDOW};
var de=/^de\\b/i.test(document.documentElement.lang||"");
var say=function(d,e){return de?d:e};
var loaded=false,busy=false,done=false;
var isCopy=function(){return !!document.querySelector('meta[name="flowplan-offline-copy"]')};
var post=function(m){try{window.ReactNativeWebView.postMessage(JSON.stringify(m));return true}catch(e){return false}};
var fresh=function(){try{return new URL(location.href).searchParams.has(PARAM)}catch(e){return false}};
var recent=function(){var t=0;try{t=Number(sessionStorage.getItem(KEY))||0}catch(e){}var d=Date.now()-t;return fresh()||(t>0&&d>=0&&d<WINDOW)};
var appPath=function(v){try{var u=new URL(v,location.href);return u.origin===location.origin&&u.pathname.indexOf("/_next/static/")===0}catch(e){return false}};
var appFile=function(el){if(!el||el.nodeType!==1)return false;var t=el.localName;if(t==="script")return appPath(el.getAttribute("src")||"");return t==="link"&&/(^|\\s)stylesheet(\\s|$)/i.test(el.getAttribute("rel")||"")&&appPath(el.getAttribute("href")||"")};
var styled=function(){try{return getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(STYLE_SENTINEL)}).trim()!==""}catch(e){return true}};
var initial=[];addEventListener("DOMContentLoaded",function(){initial=[].slice.call(document.querySelectorAll('link[rel~="stylesheet"]'))});
var inline=function(l){try{var u=new URL(l.href);return !!document.querySelector('style[data-flowplan-href="'+CSS.escape(u.pathname+u.search)+'"]')}catch(e){return false}};
var sheetsLoaded=function(){for(var i=0;i<initial.length;i++){var l=initial[i];if(l.isConnected&&appFile(l)&&!l.sheet&&!inline(l))return false}return true};
var canStore=function(){try{sessionStorage.setItem(KEY+"-test","1");sessionStorage.removeItem(KEY+"-test");return true}catch(e){return false}};
var server=function(){return new Promise(function(done){var timer=setTimeout(function(){done(null)},5000);fetch("/api/health?"+PARAM+"="+Date.now(),{cache:"no-store",credentials:"omit"}).then(function(r){clearTimeout(timer);done({build:r.headers.get(${JSON.stringify(BUILD_HEADER)})})},function(){clearTimeout(timer);done(null)})})};
var step=function(kind,page,answer,recent){if(kind==="later"){var newer=!!(answer&&answer.build)&&!!page&&answer.build!==page;return newer&&!recent?"reload":"none"}if(!answer)return "message";return recent?"message":"reload"};
var drop=function(all,shell){var jobs=[];try{if(window.caches)jobs.push(caches.keys().then(function(names){return Promise.all(names.map(function(n){if(n==="flowplan-data-v1"&&(all||shell))return caches.open(n).then(function(c){return c.delete("/")});if(all&&n.indexOf("flowplan-static-")===0)return caches.delete(n)}))}));if(navigator.serviceWorker)jobs.push(navigator.serviceWorker.getRegistrations().then(function(list){return Promise.all(list.map(function(r){return r.update()}))}))}catch(e){}return Promise.race([Promise.all(jobs).catch(function(){}),new Promise(function(r){setTimeout(r,3000)})])};
var reload=function(all,shell){try{sessionStorage.setItem(KEY,String(Date.now()))}catch(e){}post({type:"staleCopy",build:BUILD,clear:!!all});drop(all,shell).then(function(){var u=new URL(location.href);u.searchParams.set(PARAM,String(Date.now()));location.replace(u.href)})};
var message=function(offline){if(document.getElementById("flowplan-stale"))return;var box=document.createElement("div");box.id="flowplan-stale";box.setAttribute("role","alert");box.style.cssText="position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:24px;background:Canvas;color:CanvasText;color-scheme:light dark;font:16px/1.5 system-ui,-apple-system,sans-serif;text-align:center";
var inner=document.createElement("div");inner.style.maxWidth="420px";var h=document.createElement("p");h.style.cssText="margin:0 0 8px;font-size:18px;font-weight:600";h.textContent=say("Flowplan konnte nicht vollständig geladen werden.","Flowplan could not be loaded completely.");
var p=document.createElement("p");p.style.margin="0 0 20px";p.textContent=offline?say("Keine Verbindung – und die gespeicherte Kopie auf diesem Gerät ist unvollständig. Versuche es wieder, wenn du online bist.","No connection – and the copy stored on this device is incomplete. Try again when you are online."):say("Wahrscheinlich wurde Flowplan aktualisiert, während dieses Gerät noch eine ältere Kopie gespeichert hatte.","Flowplan was probably updated while this device still kept an older copy.");
var button=function(text,all){var b=document.createElement("button");b.type="button";b.textContent=text;b.style.cssText="margin:4px;padding:8px 16px;font:inherit;border-radius:8px;cursor:pointer";b.addEventListener("click",function(){reload(all,true)});return b};
inner.appendChild(h);inner.appendChild(p);inner.appendChild(button(say("Neu laden","Reload"),false));inner.appendChild(button(say("Zwischenspeicher leeren","Clear cache"),true));box.appendChild(inner);document.documentElement.appendChild(box)};
var fail=function(kind){if(done||busy)return;if(isCopy()){if(kind==="boot"){done=true;post({type:"staleCopy",build:BUILD,copy:true});setTimeout(function(){message(navigator.onLine===false)},3000)}return}busy=true;server().then(function(answer){busy=false;var s=step(kind,BUILD,answer,recent());if(s==="none")return;done=true;if(s==="reload")reload(false,!!(answer&&answer.build&&answer.build!==BUILD));else message(!answer)})};
addEventListener("error",function(e){if(appFile(e.target))fail(loaded?"later":"boot");else if(e.error&&e.error.name==="ChunkLoadError")fail("later")},true);
addEventListener("unhandledrejection",function(e){if(e.reason&&e.reason.name==="ChunkLoadError")fail("later")});
addEventListener(${JSON.stringify(STALE_CHUNK_EVENT)},function(){fail("later")});
addEventListener("pageshow",function(e){if(e.persisted&&!isCopy())fail("later")});
addEventListener("load",function(){setTimeout(function(){loaded=true;var copy=isCopy();if(!styled()||(!copy&&(!window.next||!sheetsLoaded()))){fail("boot");return}
if(fresh()&&canStore()){try{var u=new URL(location.href);u.searchParams.delete(PARAM);history.replaceState(history.state,"",u.pathname+u.search+u.hash)}catch(e){}}
if(!copy&&navigator.serviceWorker&&navigator.serviceWorker.controller)fail("later")},300)});
})()`;
}
