import { saveMemory, visibleMemories } from './memory.js';
export function registerMemory(app,store,ownerId='local'){
 app.get('/api/memory',(req,res)=>res.json({memories:visibleMemories(store.list('memory'),{scope:req.query.scope,type:req.query.type,status:req.query.status,ownerId,includeExpired:req.query.includeExpired==='true'})}));
 app.post('/api/memory',(req,res)=>res.status(201).json({memory:store.put('memory',saveMemory(req.body,{ownerId,memories:store.list('memory')}))}));
 const edit=(req,res,deleted=false)=>{const existing=store.get('memory',req.params.id);if(!existing||existing.ownerId!==ownerId)return res.status(404).json({error:'记忆不存在'});res.json({memory:store.put('memory',saveMemory(deleted?{enabled:false}:req.body,{ownerId,existing,memories:store.list('memory')}))});};
 app.patch('/api/memory/:id',(req,res)=>edit(req,res));app.delete('/api/memory/:id',(req,res)=>edit(req,res,true));
}
