import type { VisualizationDocument } from '@pi-meme/contracts/visualize'
/** 生成内容在不具备同源权限的 iframe 内执行。 */
export function previewDocument(document: VisualizationDocument, token: string) {
  const html = JSON.stringify(document.html).replace(/</g, '\\u003c')
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>body{margin:0;color:var(--foreground);background:var(--background);font:14px system-ui}*{box-sizing:border-box}button,input,select,textarea{font:inherit;max-width:100%}</style></head><body><div id="visualization-root"></div><script>
  (() => {
    let port, state = {}, sequence = -1, next = 0;
    const listeners = new Set(), pending = new Map();
    window.piVisualize = {
      getState: () => ({...state}),
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      setState: patch => new Promise((resolve,reject) => { const requestId=++next; pending.set(requestId,{resolve,reject}); port.postMessage({type:'patch',patch,requestId}) })
    };
    const report = message => port && port.postMessage({type:'error',message:String(message).slice(0,2000)});
    window.addEventListener('error', e => report(e.message));
    window.addEventListener('unhandledrejection', e => report(e.reason));
    window.addEventListener('message', function initialize(event) {
      if(event.source!==parent || event.data?.token!==${JSON.stringify(token)} || !event.ports[0]) return;
      window.removeEventListener('message',initialize); port=event.ports[0];
      port.onmessage=({data})=>{
        if(data.type==='state' && data.sequence>sequence){sequence=data.sequence;state=data.state;listeners.forEach(fn=>fn({...state}));}
        if(data.type==='reply'){const request=pending.get(data.requestId);if(request){pending.delete(data.requestId);data.error?request.reject(new Error(data.error)):request.resolve(data.state)}}
        if(data.type==='theme') for(const [key,value] of Object.entries(data.values)) document.documentElement.style.setProperty(key,value);
      };
      state=event.data.state; sequence=event.data.sequence;
      for(const [key,value] of Object.entries(event.data.theme)) document.documentElement.style.setProperty(key,value);
      const root=document.getElementById('visualization-root');root.innerHTML=${html};
      root.querySelectorAll('script').forEach(old=>{const script=document.createElement('script');script.textContent=old.textContent;old.replaceWith(script)});
      new ResizeObserver(()=>port.postMessage({type:'height',height:Math.ceil(Math.max(root.scrollHeight,root.getBoundingClientRect().height))})).observe(root);
    });
  })();</script></body></html>`
}
