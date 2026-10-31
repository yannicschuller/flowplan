// The Android app (flowplan-app) shows the page between bars of its own above
// and below the web view, in the colours of the page's edges, and so keeps
// the page clear of the status bar and the navigation bar itself. Newer
// Android System WebViews (Chromium 136 and later) report those system bars
// as env(safe-area-inset-*) all the same, so the page made room for them a
// second time: empty space at the top and bottom (#61).
//
// Inside the Android app the page therefore sets its own insets to zero
// (app/globals.css: data-app-bars on <html>), before the first paint so
// nothing jumps – unless the app hands the safe areas to the page and draws
// no bars of its own (data-app-safe-areas="page", set by the app's bridge
// from version 1.0.4 on, when its web view reports the bars). The iOS app
// (it hands them over whenever the page draws edge to edge), the browsers
// (Chrome on Android draws edge to edge from 135 on and reports the
// navigation bar once) and the home screen app keep the insets as they are.
//
// Every version of the app names itself in the user agent
// ("FlowplanMobile/<version>"), so the page knows before the app's bridge
// (window.FlowplanApp) is there.
export const APP_BARS_ATTRIBUTE = "data-app-bars";

export function appDrawsBars(userAgent: string) {
  return /\bFlowplanMobile\//.test(userAgent) && /\bAndroid\b/i.test(userAgent);
}

// The same rule as appDrawsBars(), for <head> (app/layout.tsx).
export const APP_BARS_SCRIPT = `(function(){try{var u=navigator.userAgent||"";if(/\\bFlowplanMobile\\//.test(u)&&/\\bAndroid\\b/i.test(u))document.documentElement.setAttribute(${JSON.stringify(APP_BARS_ATTRIBUTE)},"")}catch(e){}})()`;
