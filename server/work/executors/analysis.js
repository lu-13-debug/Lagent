import { workError } from '../domain.js';
import { buildApprovalSnapshot } from '../../approval-snapshot.js';

export function analysisExecutor({store,workflow,create}) {
  return {
    id: 'analysis',
    name: '数据分析',
    kind: 'analysis',
    available: true,
    requiresDataset: true,
    capabilities: ['analysis', 'report', 'dataset', 'human-approval'],
    start(ticket, assignment, input) {
      const prior=store.list('task').find(task=>task.workAssignmentId===assignment.id);
      if(prior)return prior;
      const dataset=store.get('dataset',input?.datasetId || ticket.datasetId);
      if(!dataset)throw workError('请选择当前工作区的数据集');
      return create({ticket,assignment,dataset,useAI:input?.useAI===true});
    },
    get:id=>id&&store.get('task',id),
    approval:buildApprovalSnapshot,
    approve(task,input,snapshot) { return workflow.approve(task,typeof input?.message==='string'?input.message.slice(0,3000):'',snapshot?.stepId,snapshot); },
    stop:(task)=>workflow.cancel(task),
    resume:task=>{if(task.status==='running')workflow.schedule(task.id);}
  };
}