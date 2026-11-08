import {randomUUID} from 'node:crypto';
const fail=message=>{throw Object.assign(new Error(message),{code:'TEAM_BUDGET'});};
const PROPOSAL_KINDS=new Set(['chart','clean']);
const PROPOSAL_STATUSES=new Set(['proposed','needsApproval','accepted','rejected']);
const INITIAL_PROPOSAL_STATUSES=new Set(['proposed','needsApproval']);
const NODE_STATUSES=new Set(['pending','running','completed','failed','accepted','blocked','cancelled']);
const EVENT_TYPES=new Set(['node.created','node.updated','node.reviewed','proposal.recorded','proposal.updated']);
const cleanText=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):'';
export function safeTeamProposal(value){
 if(!value||typeof value!=='object'||!PROPOSAL_KINDS.has(value.kind)||!PROPOSAL_STATUSES.has(value.status))return null;
 const id=cleanText(value.id,120),summary=cleanText(value.summary,300);
 return id&&summary?{id,kind:value.kind,status:value.status,summary}:null;
}
export function safeTeamEvent(value){
 if(!value||typeof value!=='object'||!EVENT_TYPES.has(value.type)||!NODE_STATUSES.has(value.status))return null;
 const nodeId=cleanText(value.nodeId,120);if(!nodeId)return null;
 const event={type:value.type,nodeId,status:value.status};
 if(value.type==='proposal.recorded'||value.type==='proposal.updated'){
   const proposal=safeTeamProposal(value.proposal);if(!proposal)return null;event.proposal=proposal;
 }
 if(Number.isSafeInteger(value.seq)&&value.seq>0)event.seq=value.seq;
 const createdAt=cleanText(value.createdAt,40);
 if(createdAt&&!Number.isNaN(Date.parse(createdAt)))event.createdAt=createdAt;
 return event;
}
export function createTeamRuntime(options={},parentSignal){
 const bounded=(key,fallback,max)=>options[key]===undefined?fallback:Number.isSafeInteger(options[key])&&options[key]>0&&options[key]<=max?options[key]:fail('团队预算配置无效');
 const limits={maxDepth:bounded('maxDepth',3,3),maxNodes:bounded('maxNodes',12,12),maxConcurrent:bounded('maxConcurrent',3,3),maxCalls:bounded('maxCalls',48,100),maxTokens:bounded('maxTokens',65536,262144),timeoutMs:bounded('timeoutMs',600000,1800000)};
 limits.maxSubtasks=limits.maxNodes;
 const controller=new AbortController(),signal=AbortSignal.any([controller.signal,...(parentSignal?[parentSignal]:[]),AbortSignal.timeout(limits.timeoutMs)]),nodes=new Map(),reservations=new Map();let calls=0,totalTokens=0;
 const check=()=>signal.throwIfAborted();
 const nodeById=id=>{const node=nodes.get(id);if(!node)fail('团队节点不存在');return node;};
 let eventSeq=0;
 const emit=(type,node,extra={})=>{
   const event=safeTeamEvent({...extra,type,nodeId:node.id,status:node.status,seq:++eventSeq,createdAt:new Date().toISOString()});
   if(event&&typeof options.onEvent==='function')try{options.onEvent(structuredClone(event));}catch{/* 观察者不得影响团队执行。 */}
 };
 const setDependencies=(id,dependsOn)=>{const node=nodeById(id);if(!Array.isArray(dependsOn)||dependsOn.length>3||new Set(dependsOn).size!==dependsOn.length)fail('依赖最多3项且不得重复');for(const dep of dependsOn){const other=nodeById(dep);if(!(node.parentId===other.parentId||node.parentId===dep||other.parentId===id))fail('依赖仅允许同层或父子');}
 const visit=(current,path=new Set())=>{if(path.has(current))fail('依赖存在环');const next=new Set(path);next.add(current);for(const dep of current===id?dependsOn:nodeById(current).dependsOn||[])visit(dep,next);};visit(id);node.dependsOn=[...dependsOn];};
 let active=0;const waiters=[];
 const drain=()=>{while(active<limits.maxConcurrent&&waiters.length){const item=waiters.shift();item.start();}};
 return {signal,limits:Object.freeze(limits),
  setDependencies,
  ready(id){return (nodeById(id).dependsOn||[]).every(dep=>['accepted','completed'].includes(nodeById(dep).status));},
  review(parentId,id,decision){check();const node=nodeById(id);if(node.parentId!==parentId)fail('仅父节点可以验收');if(!['accept','reject'].includes(decision)||!['completed','failed'].includes(node.status))fail('节点尚不可验收');if(decision==='reject'){if(node.retries>=1)fail('拒绝重试最多一次');node.retries=(node.retries||0)+1;node.status='pending';}else node.status='accepted';emit('node.reviewed',node);return structuredClone(node);},
  acquire(id){check();nodeById(id);return new Promise((resolve,reject)=>{const item={start:()=>{signal.removeEventListener('abort',abort);if(signal.aborted){reject(signal.reason);return;}active++;let done=false;resolve(()=>{if(!done){done=true;active--;drain();}});}};const abort=()=>{const i=waiters.indexOf(item);if(i>=0)waiters.splice(i,1);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});waiters.push(item);drain();});},
  updateNode(id,status){check();if(!NODE_STATUSES.has(status))fail('团队节点状态无效');const node=nodeById(id);if(node.status===status)return structuredClone(node);node.status=status;emit('node.updated',node);return structuredClone(node);},
  createNode(parentId,metadata={}){check();const parent=parentId?nodes.get(parentId):null;if(parentId&&!parent)fail('父节点不存在');const depth=(parent?.depth||0)+1;if(depth>limits.maxDepth||parentId && [...nodes.values()].filter(n=>n.parentId!==null).length>=limits.maxSubtasks)fail('团队层级或节点数量超限');const node={id:randomUUID(),parentId:parentId||null,depth,name:String(metadata.name||'子任务').slice(0,100),status:'pending',dependsOn:[],retries:0,proposals:[]};nodes.set(node.id,node);try{setDependencies(node.id,metadata.dependsOn||[]);}catch(error){nodes.delete(node.id);throw error;}emit('node.created',node);return structuredClone(node);},
  reserveCall(id,maxOutputTokens){check();nodeById(id);if(!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1)fail('Token预留无效');if(reservations.has(id))fail('节点已有未结算调用');if(calls>=limits.maxCalls||totalTokens+[...reservations.values()].reduce((a,b)=>a+b,0)+maxOutputTokens>limits.maxTokens)fail('团队调用或Token预算不足');reservations.set(id,maxOutputTokens);calls++;},
  completeCall(id,usage){nodeById(id);if(!reservations.has(id))fail('调用未预留或已结算');const reserved=reservations.get(id);reservations.delete(id);const actual=usage?.totalTokens;totalTokens+=Number.isSafeInteger(actual)&&actual>=0?actual:reserved;if(totalTokens>limits.maxTokens){controller.abort(new DOMException('团队Token预算耗尽','AbortError'));fail('团队Token预算超限');}},
  cancel(){controller.abort(new DOMException('团队已停止','AbortError'));},
  recordProposals(id,rows){
    check();
    const node=nodeById(id);
    if(!Array.isArray(rows)||!rows.length)throw Object.assign(new Error('提案格式无效'),{code:'TEAM_BUDGET'});
    const safe=rows.map(row=>{
      if(!row||typeof row!=='object'||!INITIAL_PROPOSAL_STATUSES.has(row.status))throw Object.assign(new Error('提案格式无效'),{code:'TEAM_BUDGET'});
      const proposal=safeTeamProposal(row);if(!proposal)throw Object.assign(new Error('提案格式无效'),{code:'TEAM_BUDGET'});return proposal;
    });
    check();
    const previous=node.proposals||[],available=Math.max(0,20-previous.length),retained=available?safe.slice(-available):[];
    node.proposals=[...previous,...safe].slice(-20);
    for(const proposal of retained)emit('proposal.recorded',node,{proposal});
    return structuredClone(node.proposals);
  },
  snapshot(){return structuredClone({limits,nodes:[...nodes.values()],usage:{calls,totalTokens,reservedTokens:[...reservations.values()].reduce((a,b)=>a+b,0)},cancelled:signal.aborted});}
 };
}