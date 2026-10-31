// crypto.randomUUID exists only in secure contexts (https, localhost). On an
// instance in the local network over plain http (the apps allow it, #62) the
// editor, whiteboards, comments and the offline queue would throw on their
// first new id. Runs before the app's scripts and adds a v4 UUID from
// getRandomValues, which every context has.
export const UUID_POLYFILL_SCRIPT = `(function(){var c=window.crypto;if(!c||typeof c.randomUUID==="function"||typeof c.getRandomValues!=="function")return;try{c.randomUUID=function(){var b=c.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var i=0;i<16;i++)h+=(b[i]+256).toString(16).slice(1);return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}}catch(e){}})()`;
