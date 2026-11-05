/** 固定预览壳不包含草图数据；每个 iframe 通过随机 token 和独立端口接收内容。 */
export const visualizationPreviewPath = '/visualization-preview'

export const visualizationPreviewCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts"

export const visualizationPreviewPage = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;color:var(--foreground);background:var(--background);font:14px system-ui}*{box-sizing:border-box}button,input,select,textarea{font:inherit;max-width:100%}</style></head><body><div id="visualization-root"></div><script>
(() => {
  const token = location.hash.slice(1);
  if (!/^[a-f0-9-]{36}$/.test(token) || parent === window) return;
  let port, state = {}, sequence = -1, next = 0;
  const listeners = new Set(), pending = new Map();
  window.piVisualize = {
    getState: () => ({...state}),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    setState: patch => new Promise((resolve,reject) => {
      if (!port) { reject(new Error('草图尚未连接')); return; }
      const requestId=++next; pending.set(requestId,{resolve,reject}); port.postMessage({type:'patch',patch,requestId});
    })
  };
  const report = message => port && port.postMessage({type:'error',message:String(message).slice(0,2000)});
  window.addEventListener('error', e => report(e.message));
  window.addEventListener('unhandledrejection', e => report(e.reason));
  window.addEventListener('message', function initialize(event) {
    if(event.source!==parent || event.data?.token!==token || event.ports.length!==1 || typeof event.data.html!=='string') return;
    window.removeEventListener('message',initialize); port=event.ports[0];
    port.onmessage=({data})=>{
      if(!data || typeof data!=='object') return;
      if(data.type==='state' && data.sequence>sequence){sequence=data.sequence;state=data.state;listeners.forEach(fn=>fn({...state}));}
      if(data.type==='reply'){const request=pending.get(data.requestId);if(request){pending.delete(data.requestId);data.error?request.reject(new Error(data.error)):request.resolve(data.state)}}
      if(data.type==='theme') for(const [key,value] of Object.entries(data.values)) document.documentElement.style.setProperty(key,value);
    };
    state=event.data.state; sequence=event.data.sequence;
    for(const [key,value] of Object.entries(event.data.theme)) document.documentElement.style.setProperty(key,value);
    try {
      const root=document.getElementById('visualization-root');root.innerHTML=event.data.html;
      root.querySelectorAll('script').forEach(old=>{const script=document.createElement('script');script.textContent=old.textContent;old.replaceWith(script)});
      new ResizeObserver(()=>port.postMessage({type:'height',height:Math.ceil(Math.max(root.scrollHeight,root.getBoundingClientRect().height))})).observe(root);
      port.postMessage({type:'ready'});
    } catch (cause) { report(cause); }
  });
})();</script></body></html>`

export function visualizationPreviewResponse() {
  return new Response(visualizationPreviewPage, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': visualizationPreviewCsp,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  })
}
