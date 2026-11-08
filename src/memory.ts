export interface MemoryItem {id:string;scope:'user'|'project';type:'preference'|'glossary'|'decision'|'finding'|'constraint';key:string;value:string;status:'candidate'|'confirmed'|'rejected';enabled:boolean;updatedAt:string;sourceTaskId?:string}
export function memoryError(key:string,value:string){return !key.trim()||key.length>120?'名称需为1–120字':!value.trim()||value.length>2000?'内容需为1–2000字':'';}
export function filterMemory(items:MemoryItem[],scope:string,type:string){return items.filter(m=>(!scope||m.scope===scope)&&(!type||m.type===type));}
