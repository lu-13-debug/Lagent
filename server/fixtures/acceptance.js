export const NOW = '2026-10-30T12:00:00Z';
const day = n => `2026-10-${String(n).padStart(2,'0')}`;
export function matrixFixture(kind='full') {
 const records={users:[],activity:[],payments:[]};
 for(let n=1;n<=21;n++) {
  records.users.push({user_id:`u${n}`,registered_at:day(n),channel:'自然'});
  records.activity.push({user_id:`u${n}`,event_time:day(n)});
  for(const delta of [1,7]) if(n+delta<=21) records.activity.push({user_id:`u${n}`,event_time:day(n+delta)});
  records.payments.push({order_id:`o${n}`,user_id:`u${n}`,paid_at:day(n),amount:'10',currency:'CNY',status:'paid'});
 }
 records.payments.push({order_id:'failed',user_id:'u1',paid_at:day(1),amount:'100',currency:'CNY',status:'failed'});
 if(kind==='activity') {delete records.users;delete records.payments;}
 if(kind==='no-payments') delete records.payments;
 if(kind==='no-users') delete records.users;
 if(kind==='coverage') records.payments=records.payments.filter(r=>r.paid_at===day(1));
 if(kind==='future') records.activity.push({user_id:'u1',event_time:'2026-10-30'},{user_id:'u1',event_time:'2026-11-01'});
 if(kind==='mixed') records.activity[0].event_time='2026-09-30T16:00:00Z';
 const files=Object.entries(records).map(([table,rows])=>{const columns=Object.keys(rows[0]);return {originalname:table+'.csv',buffer:Buffer.from([columns.join(','),...rows.map(row=>columns.map(c=>row[c]).join(','))].join('\n'))};});
 return {files,options:{timezone:'Asia/Shanghai',completeness:{declared:kind==='partial'?'partial':'full'}}};
}
