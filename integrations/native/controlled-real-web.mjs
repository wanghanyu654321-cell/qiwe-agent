// Only the disposable local trial candidate changes its server binding.
export function restrictPilotWebLoopback(source){
 const anchor='httpServer = serve(\n    {\n      fetch: app.fetch,\n      port: WEB_PORT,';
 if(typeof source!=='string'||source.split(anchor).length!==2)throw Error('CONTROLLED_REAL_WEB_SOURCE_CHANGED');
 return source.replace(anchor,anchor+"\n      hostname: '127.0.0.1',");
}
