# 前后端接口约定

所有时间 ISO 字符串；JSON 错误 {error:string}。服务器端口 3001，开发 Vite 将 /api 代理到它。

报告可选字段 `facts` 为仅含聚合信息的结构化事实列表；AI 发现可附带可选的 `kind`、`evidenceRefs` 和 `unverified`。旧报告没有这些字段时维持原有展示。引用只验证 ID 存在，不能证明模型论述在语义上正确；无有效引用的发现标为未经核实。`factContext.incomplete` 的行数按归一化后的记录统计，时区标记表示无时区输入采用项目时区，并不证明数据源实际时区。

GET /api/bootstrap -> {project: Project, tasks: Task[], datasets: Dataset[], wallet: Wallet, walletVersion?:number, skills: Skill[], domains: Domain[], settings: Settings}
POST /api/datasets/demo -> {dataset: Dataset}
POST /api/datasets/upload multipart 文件字段 files（可重复）-> {dataset: Dataset}
GET /api/datasets/:id -> {dataset: Dataset}
DELETE /api/datasets/:id -> {ok:true}
POST /api/tasks {title,goal,mode:'collaborative'|'automatic',datasetId,domain:'game',useAI:boolean,clientRequestId?:string,sourceTaskId?:string,inheritContext?:boolean} -> {task:Task,wallet:Wallet,walletVersion?:number}
GET /api/tasks/summary -> {summaries:TaskSummary[],wallet:Wallet,walletVersion?:number}
GET /api/tasks/events -> text/event-stream（同源 Cookie 认证，snapshot / heartbeat 事件）
GET /api/tasks/:id -> {task:Task,wallet:Wallet,walletVersion?:number}
PUT /api/tasks/:id/metadata {favorite?:boolean,pinned?:boolean,tags?:string[]} -> {task:Task}
POST /api/tasks/:id/explore {start:string,end:string,channels?:string[],comparePrevious?:boolean} -> {report:Report,scope:ExploreScope,previous?:Report,previousScope?:ExploreScope,comparison:ExploreComparison}
POST /api/tasks/:id/retry {strategy:'restart'|'resume',useAI:boolean,mode?:'collaborative'|'automatic',skipSteps?:string[],clientRequestId?:string} -> {task:Task,wallet:Wallet,walletVersion?:number}（新任务）
POST /api/tasks/:id/skip {stepId:'retention'|'monetization'|'insights'} -> {task:Task,wallet:Wallet,walletVersion?:number}
POST /api/tasks/:id/approve {message?:string,stepId?:string} -> {task:Task,wallet:Wallet,walletVersion?:number}; 前端传入当前确认步骤plan/report，用于延迟请求防重。
POST /api/tasks/:id/message {message:string} -> {task:Task}
POST /api/tasks/:id/cancel -> {task:Task,wallet:Wallet,walletVersion?:number}
GET /api/tasks/:id/report.md -> Markdown 下载
GET /api/wallet -> {wallet:Wallet,walletVersion?:number,transactions:Transaction[]}
GET /api/settings -> {settings:Settings}
PUT /api/settings {provider,baseUrl,model,apiKey?:string,clearKey?:boolean} -> {settings:Settings}
POST /api/settings/test -> {ok:true,message:string} 或错误。
POST /api/settings/models {baseUrl:string,apiKey?:string} -> {baseUrl:string,models:[{id:string,name:string}],partial:boolean}
GET /api/health -> {ok:true}
GET /api/runtime -> {mode:'local'|'cloud',authRequired:boolean,serviceName:string,version:string,modelHosts?:string[],capabilities?:{taskEvents?:boolean,taskRecovery?:boolean,taskSkip?:boolean,taskSummaries?:boolean,idempotentTasks?:boolean,walletVersion?:boolean,reportExplore?:boolean,reportMetadata?:boolean,reportContinuation?:boolean}}

Project {id,name,domain,description}
Dataset {id,name,source:'demo'|'upload',createdAt,rowCount,tableCount,tables:[{name,type,columns:string[],rowCount,preview:object[]}],warnings:string[],dateRange:{start,end},channelCount,inspection?:Inspection}
Inspection {version:1,mappings:[{table:string,source:string,field:string,sourceColumn:string|null,origin:'automatic'|'generated',required:boolean}],coverage:[{table:string,start:string|null,end:string|null,validRows:number}],missingTables:string[],issues:InspectionIssue[],quality:{score:number|null,rule:string},analyzable:boolean,rawRows:number,validRows:number}
InspectionIssue {code:string,severity:'error'|'warning'|'info',problem:string,metrics:string[],fix:string,location?:{table?:string,column?:string,rows?:number[]}}
Wallet {balance:number,frozen:number,spent:number} balance=可用额度；任务固定20额度，冻结时 balance-20 frozen+20，成功 frozen-20 spent+20，失败释放。
walletVersion 为响应顶层可选非负整数，不加入 Wallet 三字段对象。当前 local/cloud 的所有钱包响应及 SSE snapshot 均返回此字段，并通过 capabilities.walletVersion=true 声明支持；值取该账号 SQLite transactions 的最大 rowid（无流水时为 0）。赠送、冻结、释放、结算提交后递增；任务进度、消息、批准、跳过及幂等重放不改变版本，回滚不推进，进程重启后保留。账本 API 不删除流水；wallet 与 walletVersion 由同一条同步 SELECT 在同一个 SQLite 读取快照内取得，不能将分别读取的旧钱包与新版本拼接。
客户端应在同一账号/服务范围内统一比较所有来源的钱包版本：较旧版本的钱包不得覆盖已接收的新版本，即使较旧 bootstrap 或任务 HTTP 响应最后到达。相同版本代表同一钱包状态；任务内容可按自身状态更新时间更新。跨账号/服务切换须清空比较基准；缺少版本的旧服务按兼容策略处理，不得把缺省值猜成最新版本。SSE heartbeat 不携带钱包，也不推进版本。
Transaction {id,type:'grant'|'freeze'|'settle'|'release',amount,taskId?:string,description,createdAt}
Settings {provider,baseUrl,model,hasKey:boolean} 永远不回传 apiKey。
Domain {id,name,description,enabled:boolean}
Skill {id,name,description,category,version,enabled:boolean}
Task {id,title,goal,mode,domain,datasetId,datasetName,status:'running'|'awaiting_approval'|'completed'|'failed'|'cancelled',currentStep:number,progress:number,createdAt,updatedAt,useAI,model,cost:20,steps:Step[],events:Event[],messages:Message[],report?:Report,metadata?:ReportMetadata,error?:string,errorCode?:string,sourceTaskId?:string,sourceKind?:'continuation',clientRequestId?:string,skippedSteps?:string[]}
ReportMetadata {favorite:boolean,pinned:boolean,tags:string[],revision:number}
TaskSummary {id,title,mode,domain,datasetId,datasetName,status,currentStep,progress,createdAt,updatedAt,useAI,model,cost,sourceTaskId?,sourceKind?:'continuation',errorCode?,skippedSteps:string[],steps:[{id,name,status}]}
Step {id,name,description,skillId,status:'pending'|'running'|'completed'|'awaiting_approval'|'skipped'|'failed',summary?:string}
Event {id,type:'start'|'complete'|'info'|'approval'|'error',title,detail,stepId?,createdAt}
Message {id,role:'user'|'assistant'|'system',content,createdAt}
Report {title,period,generatedAt,currency,summary:string,findings:[{title,detail,severity:'positive'|'warning'|'neutral',evidence:string}],recommendations:string[],metrics:[{id,label,value:number|null,unit:string,change:number|null,note:string}],daily:[{date,dau:number|null,newUsers:number|null,revenue:number|null,payers:number|null}],retention:[{date,users,d1:number|null,d7:number|null}],channels:[{name,users:number|null,revenue,d1:number|null}],quality:{rows,issues:string[],score:number},methodology:string[],source:'local'|'ai'}

daily字段在所属表实际覆盖区间之外为null；不能补零。金额指标包含revenue/arppu/arpdau，unit根据币种返回。AI请求已发出后 POST /tasks/:id/message 返回409并不保存。任务锁定创建时的供应商/模型/Key，Key快照仅内存。

新上传和新生成示例数据返回可选 inspection；旧历史数据没有该字段时不补造源列映射，旧客户端仍可创建任务。公开数据集不返回 records；已有 rowCount、tables、preview、warnings、dateRange、channelCount 的语义保持不变。inspection.rawRows 是解析出的非空源数据行数（不含表头），validRows 是全量归一化后记录数：注册用户按标识合并、相同支付订单去重，活跃事件按原有语义保留。coverage 按每张标准表的全量有效记录计算最早和最晚上海日期与有效行数，包含当日及未来记录，不由最多 5 行预览推断；它不同于报告仅完整自然日的指标覆盖。

mappings 在 CSV / XLSX 解析时捕获，table 为 users、activity 或 payments，field 为标准字段，sourceColumn 为真实识别到的源列名，source 为 CSV 文件名或“文件名 / 工作表名”。自动识别来源标为 automatic；示例数据及缺失可选渠道列时生成的字段标为 generated、sourceColumn=null。required=false 仅用于可缺省的 channel。缺整表允许部分分析，missingTables 和 issues 明确指标限制；缺少支付表时收入、ARPPU、付费人数均不可计算，活跃付费率和 ARPDAU 也无数据。已有表缺少必填字段仍拒绝上传。

结构化问题包含问题、影响指标和修复建议；有解析定位证据时附标准表、源列及最多 5 个示例原始行号。CSV 行号是记录起始物理行，XLSX 是实际工作表行号。结构化问题与标准错误不含玩家标识、订单标识或原始单元格值；重复记录用行号定位。没有源位置证据时不伪造行号。

inspection.quality.score 直接复用 analyze 的 quality.score，规则 max(0,100-计分提示数×5)，rule 给出说明。计分提示为分析器去重输出前的 warnings、缺表、当日或未来、无完整覆盖、跨表覆盖不一致、非成功订单和未匹配注册用户提示；结构化问题可按类别合并或细化，数量不作为评分依据。无法分析时 score=null、analyzable=false；只有当日或未来记录的文件仍可上传查看识别结果，但不可创建分析任务。POST /api/tasks 在冻结额度前使用持久化真实 records 重新运行分析校验，不信任客户端或历史 inspection.analyzable；拒绝时无冻结、释放或新建任务。上传与任务创建的业务错误仍使用兼容的状态码和 {error:string}，可额外返回 issues:InspectionIssue[]，所有错误文本继续脱敏 Key。

模型发现不修改已保存设置，也不保存传入的临时 Key。未传 Key 时只复用当前登录会话中绑定到同一规范基础地址的 Key；更换地址或同账号另一会话改变地址后，不能转发旧凭据。云端目录请求同样需要登录并满足 HTTPS 精确白名单，禁用重定向。供应商 401/403 转换为业务 400 并提示检查 Key，避免误触发平台退出登录。目录最多返回 1000 项，Claude 分页最多 10 页，每次响应最多 2 MiB，默认总超时 15 秒。

连接测试输出上限 1024 Token，不自动重试；允许明确标注只有推理、尚无最终答案的有效响应。正式报告输出上限 8192 Token，截断或空最终文本按失败处理，不返回内部推理文本。测试兼容字符串和 text/output_text 分块响应。

Bootstrap 首次创建示例数据并计算一份 completed 报告；初始 wallet balance=500 frozen=0 spent=0，示例历史不扣费。监控优先使用 SSE 与轻量摘要；旧任务详情接口继续兼容。步骤顺序 quality,plan,activity,retention,monetization,insights,report,verify；协作模式在 plan 与 report 运行前显示 awaiting_approval，批准后继续。输入 useAI=true 但没 Key 时拒绝创建、不冻结。

任务摘要严格按 TaskSummary 白名单返回，不含报告、消息、业务目标、事件正文、预览、Key 或内部缓存。摘要包含最近 100 条任务以及未包含在其中的全部 running/awaiting_approval 任务；正常账本下云端最多 102 条，本地试用最多 125 条。summary/events 路由位于 /:id 之前。SSE 初连和每次重连均发送 `event: snapshot`，data 是与摘要 GET 相同的 `{summaries,wallet,walletVersion?}`；无历史事件重放。每 3 秒发送 `event: heartbeat`，data 为 `{timestamp:ISO字符串}`，无需读取或发送报告。任务状态与账本仅在 SQLite 提交后触发摘要快照，无全量 bootstrap 轮询。事件允许用户开启后台完成/失败提醒，但前端须按任务 ID 去重通知。

云端 SSE 使用当前同源 HttpOnly Cookie，不接受 URL 令牌；每次推送及心跳重新校验会话，退出、密码变更或过期后至多一个心跳周期内停流。每账号默认最多 4 个连接（可配置但硬上限 8），超限 429；客户端断开、服务器关闭均清理连接和排空监听器。长连接不占普通请求并发槽，但仍阻止其工作空间被驱逐；慢连接不累积无限快照，排空后发送最新快照或关闭并由客户端重连。反向代理应允许 SSE 长连接并关闭响应缓冲，响应包含 `X-Accel-Buffering:no`。

创建与恢复的 clientRequestId 可选，须为 1–100 位字母、数字、下划线或连字符；同账号同编号与相同规范化输入返回原任务（重放 200，新建 201），不会重复创建、冻结或调用模型。编号在创建/恢复操作间共享命名空间；相同编号配不同输入返回 409。幂等记录随任务持久化，不使用无限内存缓存，事务内再次校验并用唯一索引保护。旧客户端不传编号仍按每次请求创建新任务。

retry 仅接受 failed/cancelled 来源任务，始终创建新 ID、以 sourceTaskId 指向直接来源；不改来源记录、报告和旧账本。新尝试再次冻结 20 额度，成功结算，失败/取消释放。保留来源 title/goal/messages；mode 缺省继承来源，可显式更换。restart 从质量检查开始；resume 仅沿用连续已完成的确定性步骤摘要，分支改变时重算依赖洞察，报告、外部模型调用和最终核验始终重新执行；报告聚合可重新计算，绝不伪造恢复了旧模型输出。协作模式仍在尚未确认的计划及重新生成报告前等待确认，自动模式按原模式继续。skipSteps 缺省继承来源用户跳过列表，显式传数组则替换。所有恢复都使用持久化真实 records 重新验证可分析性、当前余额和并发；AI 必须验证当前会话 Key 与当前 HTTPS 白名单，新的模型/地址/凭据快照仅在内存绑定。重启仍将中断任务标为失败并释放冻结；不会恢复丢失 Key 或自动重试任何外部请求。

报告整理仅接受当前账号 completed 且有 report 的任务；未完成、失败、取消或缺报告返回 409，任务不存在或属于其他账号返回 404。favorite/pinned 只接受布尔值；tags 只接受最多 8 项的字符串数组，每项 trim 后最多 20 个 Unicode 字符，去空与去重后保存，非法类型/超长返回 400。未传字段保留原值；客户端提供的 revision、报告及其他额外字段全部忽略。元数据保存为当前工作空间 Store 中独立的 report-metadata 实体，不覆写原 Task、report、updatedAt、数据集或历史账本；不创建流水、不推进 walletVersion、不调用模型。同账号会话共享并在重启后保留，不跨账号读取。首次实际变化的 revision=1，之后每次变化递增，相同规范值不推进；未整理旧报告可省略 metadata，按 {favorite:false,pinned:false,tags:[],revision:0} 展示。所有完整 Task 响应在序列化时读取当前元数据；客户端必须独立比较 metadata.revision，不能用 Task.updatedAt 判断整理先后，也不能让迟到任务响应覆盖较新元数据。

基于报告继续分析沿用普通 POST /api/tasks，sourceTaskId 只接受当前账号已完成且有报告的任务（无报告/非 completed 为 409，不存在/越权为 404）；新任务记录 sourceTaskId 和 sourceKind='continuation'，可继续指向上一份 continuation 报告形成直接来源链。此标识不改变 retry 已有 sourceTaskId 语义。inheritContext 有来源时缺省 true；显式 false 不继承消息，非法类型为 400；无来源应省略此字段，单独传入返回 400。创建仍使用本次明确输入的 title、goal、mode、datasetId、useAI 及当前会话模型配置与 Key；允许更换数据集，但实际 records 必须重新通过可分析校验。服务端不拼接原目标、不复制原报告、模型结论、Key、内部分析缓存、跳过选择或整理元数据。用户需在创建前明确确认本次目标、数据和收费；新任务重新冻结 20 额度并按原流程结算/释放，来源任务、报告和原流水保持不变。

inheritContext=true 仅复制来源 messages 中 role=user 的正文，为每条重新生成 ID/创建时间，并添加系统继承说明；不复制原 assistant/system 消息。继承后初始 messages（含本次系统说明）最多 100 条，每条用户正文最多 3000 字，用户正文合计最多 300000 字；超过返回明确 400，请用户关闭继承再整理本次背景，不静默截断，不产生新任务或流水。sourceTaskId 与规范化 inheritContext 均纳入 clientRequestId 指纹，省略继承选项和 true 等价；同编号重放返回原任务、不重复冻结，换来源/继承选项返回 409。即使来源数据已删除，仍可明确选择其他有效数据集继续；不更换则按普通数据集校验返回 404。AI 每次新建验证当前会话凭据和云端当前 HTTPS 精确白名单，不能借来源任务绕过；重启后不会恢复旧 Key。reportMetadata/reportContinuation capabilities 在 local/cloud 均为 true，旧客户端无新增必填项。

skip 仅允许尚未执行的 retention、monetization、insights，通常在协作计划等待时选择；quality、plan、activity、report、verify 均拒绝跳过。已执行步骤与结束任务返回 409，结束任务需用新尝试选择分支；同一活跃任务重复跳过同一步幂等。用户跳过与缺表的自动跳过均有明确步骤说明，用户选择另记录 skippedSteps。每次本地分析和 AI 增强后重新应用掩码：商业化计算移除 payments 输入，所有商业化指标、每日收入/付费人数及渠道收入为 null；留存指标为 null、cohort 列表为空、渠道 d1 为 null，同时移除对应洞察/建议；跳过 insights 后 findings/recommendations 为空。发送给模型的聚合已排除上述结果；最终报告保留原数据质量审计、币种和自然日统计口径，并在摘要及方法中明确“由用户选择跳过”。API 不暴露内部分析缓存、请求指纹或凭据。

模型失败可额外返回受控 code，失败任务持久化 errorCode；摘要只包含 errorCode，不包含错误原文。白名单为 INVALID_KEY、NO_PERMISSION、RATE_LIMITED、MODEL_UNSUPPORTED、OUTPUT_TRUNCATED、REASONING_ONLY、EMPTY_RESPONSE、REFUSED、PROTOCOL_ERROR、UNREACHABLE、TIMEOUT、CANCELLED、KEY_REQUIRED、RESPONSE_TOO_LARGE、INVALID_REPORT、REQUEST_REJECTED。供应商原始错误码、响应及推理文本不透传。

runtime 在 local/cloud 均无需登录，旧字段保留。当前实现声明 capabilities 九项为 true；客户端仅在对应标记明确为 true 时启用摘要、SSE、恢复、跳过、幂等请求、钱包版本校验、报告探索、服务端报告整理和基于报告继续分析。旧服务缺少 capabilities 或对应字段时表示未声明支持，应降级为读取已知任务详情，隐藏恢复/跳过/探索操作；报告整理可明确标为“仅此设备”并按服务及账号保存，继续分析降级为普通新任务且不冒充已记录来源，避免反复请求不存在的接口；不能按版本号推测能力。

合法的仅支付表数据集在跳过商业化后仍完成质量审计与核验：报告保留原记录行数、币种及完整自然日日期，全部运营指标和每日运营值为 null，运营洞察与建议为空，并明确“全部可计算运营分支已跳过，仅保留质量检查”。真实支付金额、付费结果和对应叙述不进入报告或模型输入。SSE 同源检查绑定实际连接入口，Express 接受的尾斜杠及大小写路径变体执行相同检查；云端预期 origin 来自已校验的服务地址，Cookie 会话校验保持不变。

Report 可选 `aiUsage:{protocol:'anthropic'|'chat-completions',provider:string,model:string,inputTokens:number|null,outputTokens:number|null,totalTokens:number|null,cacheReadInputTokens:number|null,cacheCreationInputTokens:number|null,reasoningTokens:number|null}`。仅保留供应商返回的非负安全整数计数；未返回的字段为 null，不通过相加假造 totalTokens。无可用计数时不提供 aiUsage，旧报告与确定性分析继续兼容。usage 不含 Key、供应商原始响应或推理文本，报告页明确区分服务额度与模型费用；手填参考单价计算的金额仅为估算，不代表实际账单。

官方网关 api.anthropic.com 使用 Claude Messages（`/v1/messages`、`x-api-key`、`anthropic-version`），system 与 messages 分开；OpenAI / DeepSeek 使用现有 Chat Completions 协议。网关响应体限制 2 MiB，整个读取过程继续受超时和取消约束；不透传供应商错误响应。模型连接测试与生成均由用户动作触发。前端配置档案仅保存地址、模型名和非敏感供应商标识，按 origin/runtime/userId 分区；切换地址清空临时输入的 Key，服务器继续执行同地址会话凭据与 HTTPS 主机白名单约束。

报告探索为兼容的只读扩展：仅接受当前账号 completed 且已有报告的任务，不创建任务、不保存派生报告、不更改原任务/报告/源数据、不冻结或结算额度，也不调用模型。失败/取消/未完成任务或缺少报告返回 409；任务不存在或属于其他账号返回 404；源数据集已删除返回带明确说明的 404，真实 records 缺失/损坏返回脱敏 409。云端继续使用当前同源 Cookie，不接受外部账号的任务或数据；本地继续执行原有环回及来源校验。

探索源 records 必须是非数组对象，每个存在的键必须属于当前 users、activity、payments 标准表且值必须为数组，并至少有一张非空标准表；未知表、字符串/对象形式的表、空结构等均在共享源校验中返回脱敏 409，不忽略损坏表或把字符串长度/未知表行数计入样本。接口、worker 调度与计算层复用相同校验；行内容归一化失败同样返回脱敏 409，源质量行数不会以 NaN/null 伪装成功。

start/end 必须为合法 YYYY-MM-DD，开始日不晚于结束日，含首尾最多 3660 天，结束日不得晚于原报告 generatedAt 在上海时区的前一个自然日。截止日锁定原报告生成时刻，不随探索当天变化。channels 缺省或 [] 表示全部渠道；否则最多 50 项，每项 1–100 字，去重并规范顺序，必须来自真实注册表。缺少注册表时拒绝渠道筛选。comparePrevious 缺省 false，非布尔值返回 400；其他非法范围和渠道条件也返回 400。

ExploreScope {start:string,end:string,channels:string[],timeZone:'Asia/Shanghai',statisticsVersion:'report-explore-v1',generatedAt:string,coverage:{users:ExploreCoverage|null,activity:ExploreCoverage|null,payments:ExploreCoverage|null},sample:{sourceRows:number,selectedRows:number,selectedRowsByTable:{users:number,activity:number,payments:number},registeredUsers:number|null,payingUsers:number|null},skippedSteps:string[]}
ExploreCoverage {start:string,end:string}
ExploreComparison {requested:boolean,comparable:boolean,reasons:string[],previousRange?:{start:string,end:string},metrics:[{id:string,comparable:boolean,reason:string|null,current:number|null,previous:number|null,absoluteChange:number|null,percentChange:number|null}]}

coverage 由每张完整源表的有效记录独立推导，截止原报告的完整自然日；计算覆盖后才筛选日期及渠道。各表范围外的 daily 值为 null，覆盖范围内没有所选渠道事件时为真实零，不能用筛后首末事件缩短覆盖。sample.sourceRows 是持久化 records 三表行数之和（并非上传前 inspection.rawRows）；selectedRows/selectedRowsByTable 是在本次日期和注册渠道内、归一化和去重后的三表行数，支付包括成功与非成功订单。注册表归因用全表，留存可读期外活跃记录，这些期外辅助行不混入 selectedRows。registeredUsers 只数期间注册，缺注册覆盖时为 null；payingUsers 只数所选期间成功支付的唯一玩家，缺支付覆盖或原任务跳过商业化时为 null，不能把每日付费人数相加。报告 quality.rows 继续描述源 records 总行数；quality.issues 和 methodology 明确筛选范围、样本和有限覆盖，派生说明不作为额外质量扣分。

新增与留存 cohort 仅包含期间注册玩家；渠道订单收入使用完整注册映射下该渠道全部已注册玩家在期间的成功订单，包含期前注册者。未知玩家仅参与无渠道筛选的总事件，不归入任何已知渠道。ARPPU 为期间成功订单收入/期间真实唯一付费人数。D1/D7 在原全量活跃记录里观察目标自然日，可以超出所选末日，但该目标日必须成熟且有完整活跃覆盖；不能把筛选截断当作未回访。DAU、活跃付费率和 ARPDAU 仍取筛选范围内最后完整活跃覆盖日，口径在 metric.note 给出。原任务 skippedSteps 在当前期与上期同时应用，跳过分支的指标、每日值、cohort、渠道结果和对应叙述不会恢复；仅支付数据且跳过商业化时保留质量审计，运营指标全部 null。

只有新探索返回的派生报告会在注册表完全不覆盖所选期时将 channels[].users 返回 null，不能将未知新增写成零，也不能把 null 当作零参与排序或样本合计；原任务完整 Report 的 channels[].users 继续保持既有 number 语义。若注册覆盖内没有所选渠道注册，派生渠道新增才为零；渠道收入和成熟留存各自按对应表覆盖独立判断。

派生报告的渠道名单、筛选事件和渠道收入共享完整源注册表的玩家标识映射，即使源记录中的事件早于对应注册时间，也不会把已匹配的渠道事件静默移除或从渠道表漏掉；新增仍只计期间注册。此归因只说明源表标识匹配，不证明异常时间顺序有效，不能据此推断玩家生命周期或注册前行为。发现此类顺序异常时提供通用质量提示，不包含玩家或订单标识。

派生 Report.source 恒为 local；summary/findings/recommendations 由确定性统计生成，绝不把原 AI 摘要与洞察当作筛选结果，也不复制 aiUsage。报告 generatedAt 保留原报告的冻结统计时刻，scope.statisticsVersion 标识统计口径；前端应明确展示“确定性派生/有限数据”，不能称为重新生成的 AI 报告。所有派生 metric.change 恒为 null，上期比较只读 comparison.metrics。

comparePrevious=true 时，上期为紧邻当前期之前、含首尾等长的自然日区间，按相同渠道、原截止时刻和跳过掩码真正重算。previous 是直接的 Report（趋势读取 previous.daily），previousScope 结构与 scope 相同；未请求比较时这两字段省略。previous.daily 保留自身真实日期及 null，可按相对日序画虚线，但必须注明上期实际区间及有限覆盖，不跨 null 连线。comparison.comparable 表示至少有一项指标可比，各指标独立检查两期完整源表覆盖；留存还要求两期 cohort 均成熟且有样本。覆盖不足、不成熟、无指标/无有效分母、上期值为零或原任务跳过时，comparable=false，reason 明确原因，absoluteChange/percentChange 均为 null。即使两期原值能显示，也不能据此渲染增减结论；reasons 汇总全部不可比原因。可比时 absoluteChange=current-previous，percentChange=(current-previous)/previous×100，按两位小数显示。

探索计算位于 Node worker_threads，默认每账号最多两个 worker（可下调，硬上限二），超限 429；不建立无界缓存或等待队列。真实 records 仅在服务端及计算 worker 之间传递，不返回前端，不传 Key、模型配置或原 AI 叙述。请求取消和服务关闭均终止 worker 并释放并发槽；活跃探索纳入工作空间 busy 状态，防止云端驱逐正在使用的工作空间。统计不占用主事件循环，SSE 心跳和轻量摘要可继续响应。任何源数据异常错误均不透出玩家或订单标识。

探索渠道聚合按完整注册映射单遍建索引，期间注册 cohort 和成功订单分别累计；不会为每个渠道重新遍历全量用户、订单或全部 cohort。完整映射中的未来注册渠道仍保留，并按原覆盖分别返回真实零或 null；不通过丢弃渠道或降低原有数据支持上限规避计算。

每次探索的计算时限默认 30 秒，服务端可通过 reportExploreTimeoutMs 下调，硬上限始终为 30000ms；本地与云端一致。时限包含 worker 创建及源数据复制启动耗时；到期终止 worker、清理定时器并释放账号并发槽，返回 503 和“报告探索计算超时，请缩小日期或渠道范围后重试”。服务不自动重试，不更改原任务、报告或账本；调用者可调整范围后明确发起新请求。取消、正常完成、worker 错误和服务关闭也会清除同一时限定时器。

## 项目工作区（/api/work/projects、/api/work/chats）

需 `DATAAGENT_WORK_ENABLED=1`；CLI 项目对话还需要 `DATAAGENT_ALLOW_EXTERNAL_EXECUTORS=1` 并在执行器策略中勾选对应执行器。所有写操作仍经工单审批，不新增绕过审批的入口。

### 本机 Agent 适配器（opencode / gemini / qwen / cursor-agent / dsh）

`server/work/executors/local-agent.js` 把探测到的命令行 Agent 变成可调度执行器，统一按「stdout 即最终答复」解析（非零退出才判失败，stderr 记为错误；`dsh` 会把推理写进 stderr，退出码为 0 时不算失败）。参数按写入模式切换：

| id | 只读 | 写入 |
| --- | --- | --- |
| `opencode` | `run --dir <workspace> <prompt>` | 追加 `--auto` |
| `gemini` | `-p <prompt> --output-format text` | 追加 `--yolo` |
| `qwen` | `-p <prompt> --output-format text` | 追加 `--yolo` |
| `cursor-agent` | `-p <prompt> --output-format text` | 追加 `--force` |
| `dsh` | `--profile headless <prompt>` | 同左（没有单独写入开关，按 CLI 自身默认权限运行） |

- 可执行文件按 PATH/PATHEXT 解析，`.cmd/.bat` 垫片会自动换成 `node <入口>` 执行；找不到时该执行器 `available:false`，直接派活返回 503。
- 子进程环境仍走 CLI 白名单，API Key 默认不继承；本机 Agent 自带 provider 时需要 `DATAAGENT_CLI_ENV_PASSTHROUGH=OPENCODE_API_KEY,ANTHROPIC_API_KEY` 显式点名。
- 超时与输出上限与 codex/claude 一致（默认 900000ms / 8MB，可用 `DATAAGENT_CLI_TIMEOUT_MS` 覆盖）。
- 这些 id 同时加入 `policy.allowedExecutors` 白名单与项目工作区执行器清单；Agent 页的开关写的就是 `allowedExecutors`。

国内 Agent 沿用同一套约定（`-p` 问答 + 写入自动批准），命令名与开关可覆盖：

| id | 名称 | 只读 | 写入 |
| --- | --- | --- | --- |
| `codebuddy` | CodeBuddy Code（腾讯） | `-p <prompt>` | 追加 `--dangerously-skip-permissions` |
| `qoder` | Qoder CLI（阿里） | `-p <prompt>` | 追加 `--dangerously-skip-permissions` |
| `iflow` | iFlow CLI（心流） | `-p <prompt>` | 追加 `--dangerously-skip-permissions` |
| `kimi` | Kimi CLI（月之暗面） | `--print <prompt>` | 追加 `--yes` |

- 参数模板可用 `DATAAGENT_CLI_ARGS_<ID>` 覆盖，值是 JSON 字符串数组，`{prompt}` 占位符会被替换（例如 `DATAAGENT_CLI_ARGS_KIMI=["-p","{prompt}"]`）；用户级环境变量覆盖失败时请检查是否为合法 JSON 数组。
- Trae Agent、文心快码 Comate、通义灵码、CodeGeeX、WorkBuddy 目前只做识别（`executorId: null`）：本机装了 CLI 会显示版本与路径，没装则按运行中的桌面窗口匹配，提示用「窗口 · <进程名>」发送指令。要变成可调度执行器，需要在 `server/work/executors/local-agent.js` 补一档参数模板，并加入 `EXTERNAL_EXECUTORS` 与 `PROJECT_CHAT_EXECUTORS`。
- `GET /api/work/bootstrap` 额外返回 `workspace`：未绑定工作文件夹的对话，Agent 就在这个目录里读写（本地模式默认是仓库根目录）。项目对话始终以项目路径为 cwd。

### 内置模型 Agent（model）

不依赖本机安装任何 CLI：只要在「设置 → 规划设置」里选定默认模型，`model` 执行器就可用。它按 `kind:'cli'` 走同一个 CLI 通道（工单执行、`artifacts.cli`、项目会话、计划落盘、项目记忆都复用），区别只在于「CLI 进程」换成了「模型 + 工具循环」。

| 工具 | 说明 |
| --- | --- |
| `list_files {path?}` | 列目录，跳过 `node_modules`、`.git`、`dist`、`build`、`.dataagent`、`data`、`.venv`、`__pycache__`、`coverage`，最多 120 项 |
| `read_file {path,offset?,limit?}` | 读文本文件，单文件上限 400KB，默认返回 8000 字符，超出返回 `truncated:true` |
| `search_code {pattern,path?}` | 正则搜索，跳过 >200KB 与二进制文件，最多 40 条命中，返回 `{file,line,text}` |
| `write_file {path,content}` | 仅在 `write:true` 时可用；单次上限 200KB，自动建父目录，返回 `{path,created,before,after}` |
| `replace_in_file {path,find,replace,all?}` | 精确文本替换；命中多处又没传 `all:true` 时报错并提示，0 处命中报「没有找到」 |
| `move_path {from,to}` | 移动或重命名，目标已存在时报错 |
| `delete_path {path,recursive?,dryRun?}` | 删除文件或目录；目录必须显式 `recursive:true`，工作目录本身不允许删；`dryRun:true` 只返回将删清单 |
| `run_command {command}` | 只读白名单：`git status/diff/log/show/branch` 与 `node --check`，不经 shell，15 秒超时；白名单外的命令确认后经系统 shell 执行，60 秒超时，返回 `{command,exitCode,output}` |

- 模型必须每一步只输出一个 JSON：`{"tool":"read_file","args":{...}}` 或 `{"final":{"summary":"...","files":["..."]}}`。解析失败会把原回复与「请只输出 JSON」压回上下文重试；步数上限 12（默认 8）。
- **权限分区**：①工作目录内 —— 直接执行；②策略 `limits.extraRoots`（最多 10 个绝对路径，不能是磁盘根）里登记的目录 —— 直接执行；③其余路径 —— 执行器把 `task.status` 置为 `awaiting_approval` 并挂起工具调用，工单变成「待确认」，用户在弹窗里批准（`POST /api/work/tickets/:id/actions {action:'approve'}`）或拒绝（`reject`），5 分钟不回答按拒绝。同一任务里同一位置只问一次；批准结论只对当前任务有效。
- 危险动作即使目录已授权也要再问一次：递归删除（策略 `limits.confirmDanger`，默认 `true`）与白名单外的命令。
- 永远拒绝、不给授权机会：系统目录（`C:\Windows`、`Program Files*`、`ProgramData`，POSIX 的 `/etc`、`/usr` 等）、`.git`、`.ssh`、`.env*`、`id_rsa|dsa|ed25519`、`*.pem|p12|pfx|key`，报错「拒绝访问受保护路径」。
- 访问确认的待确认项带 `kind:'access'`、`accessMode`（`read|write|delete|command`）与 `accessPath`，界面据此弹授权弹窗并从 `options` 取「允许这次…／拒绝」。
- 所有路径都经 `pathGuard.resolve` 校验（`isForbiddenPath` + 是否在已知根内）；未配置模型或没有 Key 时 `start` 直接 503，不会留下假运行的任务。
- 执行器输入可带 `profileId` 指定这条工单用哪个模型配置（团队协作里「内置 Agent 用哪个模型」就靠它），不传则用工作流默认模型；也可带 `effort`（`default|low|medium|high|xhigh|max`），供应商不认这个档位时自动按默认档重试一次并在摘要里注明。
- CLI 类执行器（`claude-code`、`codex`）的 `executorInput.model` 会转成 `--model <id>` / `-m <id>`，用于「同一个 Agent 在不同团队里用不同模型」；其余 CLI 没有统一开关，留空即用它们自己的配置。
- 写权限由执行器策略 `limits.modelWrites`（默认 `false`）控制：关闭时 `write_file`/`replace_in_file`/`move_path`/`delete_path` 一律不可用，模型只读取与检索并给结论；项目对话还要求 `chat.writable !== false`。
- 过程流：执行器把每一步写进 `task.activity`（`{kind:'tool'|'observation'|'error'|'result', text, detail?, at}`，保留 60 条）。`GET /api/work/tickets/:id` 的 `detail` 在有过程时附带 `activity`（最近 40 条）；SSE `GET /api/work/events` 在过程变化时推送 `{type:'activity',ticketId,payload:{activity,status}}`，前端据此渲染时间线。`result` 与「结果」块内容相同，界面只显示 `tool/observation/error`。

- `GET /api/work/projects` → `{projects:[ProjectWorkspace]}`；`POST /api/work/projects {path,name?}` → `201/200 {project,created}`。path 必须是存在的绝对目录，服务端取 realpath 后拒绝磁盘根目录与 `Windows`、`Program Files*`、`ProgramData`；同路径重复导入返回 `created:false` 与原记录。只保存记录，不复制、移动或删除本地文件。最多 100 个项目。
- `POST /api/work/command {text,executorId,executorInput}` 的浏览器执行器受 `policy.limits.browserHosts` 约束：列表为空时不限制；非空时目标主机必须等于其中一项或以 `.<项>` 结尾，否则 403「浏览器只允许访问 …」。
- `github` 执行器不再要求 `GITHUB_TOKEN`：无 token 时匿名读取公开仓库，新增 `search` 动作（`GET https://api.github.com/search/repositories?q=&sort=stars&order=desc&per_page=`，返回 `{action:'search',query,total,count,items:[{fullName,stars,language,description,url,updatedAt}]}`，`limit` 1–20，默认 5）。计划/指挥里只给一句话时，默认动作是 `search`，中文句子会先被压成英文关键词再检索。
- `GET /api/work/files?path=` → `{path,parent,roots,entries:[{name,path,isDir}],truncated}`，仅供浏览器端选择项目目录。仅本地模式启用（云端返回 404）；省略 path 返回可用盘符，否则只返回子文件夹，最多 500 项，不读取或返回任何文件内容。浏览器无法调用系统目录对话框，桌面客户端使用 `pickFolder()` 打开系统对话框。
- `GET /api/work/projects/:id` → `{project}`；`DELETE /api/work/projects/:id` → `{id}`，同时删除该项目下的项目对话记录，不影响 Agent 端会话文件。
- `GET /api/work/projects/:id/sessions?executor=claude-code|codex` → `{sessions:[{executorId,sessionId,title,updatedAt,imported}]}`。扫描 `~/.claude/projects/<路径编码目录>/*.jsonl` 与 `~/.codex/sessions/**/rollout-*.jsonl`，只保留记录中 `cwd` 与项目路径一致的会话，每个来源最多读取 200 个文件头（64KB），返回最多 60 条；不返回会话正文。
- `POST /api/work/projects/:id/sessions {executorId,sessionId}` → `{chat,created}`。会话必须能在该项目的扫描结果中找到，否则 404；重复导入返回原对话。导入的对话 `source:'imported'`，后续消息用该 sessionId 续接。
- `POST /api/work/projects/:id/chats {executorId:'claude-code'|'codex'|'window',title?,writable?,handle?,process?}` → `{chat,project}`。window 需要有效 `handle`；非法执行器 400。每个项目最多 50 个对话。
- `DELETE /api/work/chats/:id` → `{id}`。
- `POST /api/work/chats/:id/messages {text,clientRequestId?}` → `{ticket}`。text 去空白后须为 1–3000 字。创建 `awaiting_review` 工单，`ticket.projectChatId` 指向该对话，执行器固定为对话绑定的 Agent；批准后 CLI 以项目目录为 cwd、在写入模式运行，并在已有 sessionId 时使用 `--resume` / `exec resume`。窗口对话把指令发送到绑定窗口。
- `GET /api/work/chats/:id/tickets` → `{tickets:[WorkTicket]}`，按创建时间升序，只含该对话的工单。
- `POST /api/work/projects/:id/dispatch {text,executorIds:[...],window?:{handle,process?,title?}}` → `201 {project,tickets}`。项目内多 Agent 并行分派：text 1–3000 字，executorIds 去重后 1–4 个，接受 `claude-code`、`codex`、`claude-acp`、`dsh-acp`、`codex-acp` 与 `window`。已存在同执行器的项目对话则复用，否则自动创建；每个执行器各生成一张 `awaiting_review` 工单。`window` 与其它执行器可以一起分派，但必须同时传 `window.handle`（正整数的窗口句柄）；窗口对话按 `handle` 复用，指令以 `submit:true` 发送到该窗口，`window.process`/`window.title` 只作定位提示，不作为会话标题。ACP 执行器的 `session/new` 以项目目录为 cwd，且只在项目工单内接受 `fs/read_text_file` 与 `fs/write_text_file`（路径限制在项目目录内，越界报错；`terminal/*` 仍一律拒绝），`artifacts.acp.cwd` 记录本次运行的目录。ACP 的文件写入受执行器策略 `limits.acpWrites`（默认 `true`）约束：关闭后项目工单仍以项目目录为 cwd，但只开放 `fs/read_text_file`，写文件与权限请求一律拒绝。
- `GET /api/work/tickets/:id` 的 `detail` 在工单属于项目时额外返回 `project:{id,name,path,gitBranch}` 与 `projectChat:{id,title,executorId}`，非项目工单不出现这两个字段。
- `POST /api/work/plans {goal,steps,projectChatId?}`、`POST /api/work/plans/suggest {goal,executors,projectChatId?}`：带 `projectChatId` 时只允许该对话绑定的执行器，规划器输入附带 `{name,path,gitBranch}`，其它执行器步骤返回 400；计划与步骤工单都记录 `projectChatId`。
- `POST /api/work/plans {goal,steps:[{executorId,text,dependsOn?}],projectId?,autoRun?}`：带 `projectId` 时每一步可指定不同 Agent。项目里已有该 Agent 的对话则复用，没有则自动创建；窗口 Agent 必须先在项目中绑定窗口对话，否则该步 400；执行器须属于 `claude-code`、`codex` 及其 ACP 变体与 `window`。规划器输入附带 `{name,path,gitBranch,chats:[{executorId,title,window}]}`。计划记录 `projectId`，每步工单记录各自的 `projectChatId`，`GET /api/work/plans/:id` 可读取 `plan.projectId` 与 `steps[].projectChatId`。
- `GET /api/work/projects/:id/brief` → `{brief:ProjectBrief}`；`PUT /api/work/projects/:id/brief {goal?,summary?,keyPoints?,decisions?,constraints?}` → `{brief}`。按 projectId 存储；数组项 trim 去空去重，正文与条目有长度上限。

### 协作任务（软件拆分 → 分派 → 组装）

软件的职责是搭骨架、定契约、验收、组装；Agent 只各写一份文件。

- `POST /api/work/projects/:id/teamwork {goal,executorIds}` → `201 {teamwork,tickets}`。goal 1–600 字；executorIds 去重后 1–3 个，必须属于项目工作区执行器清单且不含 `window`。服务端把目标固定拆成三份——`rules`（`coop/rules.js`，定义 `Coop.rules`）、`view`（`coop/view.js`，定义 `Coop.view`）、`hud`（`coop/hud.js`，定义 `Coop.hud`）——按顺序轮流分给所选执行器，各生成一张 `awaiting_review` 工单；同时写入 `coop/contract.md`（世界与输入形状、绘制顺序）和 `coop/skeleton.js`（画布、主循环、输入、`Coop.util`）。同一执行器复用标题以 `协作 · ` 开头的项目对话。
- `GET /api/work/projects/:id/teamworks` → `{teamworks:[Teamwork]}`；`GET /api/work/teamworks/:id` → `{teamwork}`。每份 `parts[]` 带 `status`（工单状态）、`summary`、`fileExists`、`fileSize`，供前端判断进度。
- `POST /api/work/teamworks/:id/assemble` → `{ok:true,outputPath,relativePath,bytes,teamwork}` 或 `400 {ok:false,problems:[{part,message}],teamwork}`。验收规则：三份文件都存在、≥120 字节、定义了约定的全局（`Coop.rules` / `Coop.view` / `Coop.hud`）、不含 `<script` 与 `http(s)://` 外链。通过后把三份内联进 `coop/index.html`（单文件、无外链），记录 `status:'assembled'` 与字节数；不通过则记录 `status:'blocked'` 与逐条问题，不覆盖已有产物。
- 组装产物每帧按 `rules.update → view.draw → hud.draw` 执行；三份绘制各自在 `save/restore` 与阴影归零的干净状态下进行，一份的状态泄漏不会影响另外两份。

### 指挥台（软件自己拆解并分配任务）

软件在这里是「指挥官」：把一句话目标拆成带依赖的步骤，按能力分给不同 Agent，执行后把各步结果汇总成一份结论。

- `POST /api/work/commander {goal,executors,projectChatId?,projectId?,autoRun?}` → `201 {plan,steps}`。goal 1–300 字；executors 必须在可用执行器里（缺省时由服务端取可用的）。`projectChatId` 与 `projectId` 二选一即可绑定工作文件夹：绑定后每一步都以该目录为 cwd 且带写权限（CLI 类走项目对话；`github`/`browser`/`analysis` 这类不写文件的执行器不需要项目对话，直接参与），未绑定时每一步只读、只出结论。拆解优先走已配置的规划模型；没有配置或调用失败时，回退到**用本机已安装的 Agent 自己拆**（依次尝试 `dsh --profile headless`、`claude -p`、`codex exec`，只取它返回的 JSON 步骤）。规划必须给出 2–5 步，每步含 `executorId`、`text`（1–500 字）、可选 `dependsOn`、可选 `executorInput`（结构化输入，例如交给 `github` 的 `{action:'search',query:'英文关键词',limit:5}`）。生成的工单按依赖放行：无依赖步骤为 `awaiting_review`（`autoRun:true` 时为 `queued`），有依赖步骤为 `waiting`，由 `advancePlan` 在依赖完成后自动放行。
- 步骤产出会落盘：每一步完成时把「第 N 步 + 工单 + 状态 + 产出」写到 `<项目路径>/.dataagent/runs/<planId>/NN-<executor>.md`（未绑定工作文件夹时写到系统临时目录的 `dataagent-runs/`）。下游步骤放行时，前面已完成步骤的文件内容（截 4000 字，拿不到文件才退回摘要 1500 字）会以「【前序步骤材料 · 由 DataAgent 汇总，供你直接使用】」为标题注入到它的 `executorInput.prompt` 前面，所以后一步能直接读到前一步的完整材料。
- `GET /api/work/commander/:id/report` → `{plan,rows,completed,total,markdown}`。markdown 为 `# 指挥汇总：<目标>`，逐条列出「执行 / 状态 / 产出说明」，未完成步骤单列在「需要你处理」下；只读拼装，不写文件、不改工单状态。
- 步骤失败只影响依赖它的后续步骤（`advancePlan` 会把这些步骤标为 `blocked` 并写明依赖未完成），其余步骤照常推进。
- `POST /api/work/analyze {goal,executors?,projectId?,projectChatId?}` → `{goal,category,categoryLabel,project,needs,understanding,conflicts,steps}`。这是**本地的任务理解**，不联网、不调用模型：先从目标里判类型（游戏/前端/数据/文档/修缺陷/调研/自动化），再根据关键词推断要改的目录（`src/**`、`server/**`、`docs/**`、`tests/**`），最后排出「调研 → 写文件 → 验证」的步骤。`steps[i].kind` 为 `research|write|verify`，`scope` 是它被允许改的目录，`readOnly` 表示不要写权限。分工规则：不同目录的写步骤交给不同 Agent（`claude-code`/`codex` 轮转）并行执行；同目录只排一个写步骤；验证步骤优先交给没参与写代码的执行器。未绑定工作文件夹时所有步骤降级为只读，`understanding` 里会明说「只出结论」。`conflicts` 列出目录重叠、已被改成串行的步骤对。`commander` 的内部拆解会把这份理解作为「预设理解」传给规划模型，并在响应里带上 `analysis`。

  配置了模型（「模型与 API」里的默认规划模型）时，`POST /api/work/analyze` 会先让模型带着工具想一想：响应里 `source` 为 `model`，并带 `model:{provider,model}`、`thoughts:string[]`、`toolCalls:{name,query,ok,summary}[]`，`steps` 换成模型给出的分工；调用失败时退回本地规则并给 `modelError`。没有配置模型时 `source` 为 `local`、`modelAvailable=false`。模型可用三个只读工具：`github_search`（匿名搜索仓库）、`fetch_page`（只读 https 页面，受 `limits.browserHosts` 白名单约束）、`project_files`（列绑定工作文件夹内的目录，越界拒绝）。

- `GET /api/work/projects/:id/memory?limit=20` → `{digest:string, entries:ProjectMemoryEntry[]}`。`ProjectMemoryEntry` 为 `{id,projectId,ticketId,projectChatId,executorId,title,status,summary,files,improvements,openQuestions,source:'local'|'model',model,createdAt,updatedAt}`。每次项目工单结束（completed/failed/blocked）自动写一条：先按报告摘要与改动文件生成 `source:'local'`，配置了模型时再异步升级成模型总结（`source:'model'`，带 improvements/openQuestions）。`digest` 是给 Agent 读的纯文本（最近 6 条 + 聚合后的待办），会注入项目会话的 prompt：首条消息带完整简报 + 记忆，后续消息只带记忆，因此新会话不必从头开始；同时作为 `project.memory` 传给规划器与 `work_project_memory` MCP 工具。
- `DELETE /api/work/projects/:id/memory/:memoryId` → `{removed:boolean}`。
- 执行期的冲突闸门：`advancePlan` 放行一个有 `scope` 的步骤前，会先看同一计划里是否还有另一个带 `scope` 的步骤在 `working`/`awaiting_review`/`queued` 且目录重叠；有就继续等，避免两个 Agent 同时改同一批文件。

### 团队协作（内置 Agent 统筹 → 分派 → 回收）

- `POST /api/work/collaborate {goal,agentIds,projectId?,projectChatId?,profileId?,models?,autoRun?}` → `201 {plan,steps,analysis}`。goal 1–300 字；`agentIds` 去重后 1–4 个，为空返回 400「团队协作至少选择一个 Agent」。服务端先跑一次任务理解（与 `/api/work/analyze` 同一套规则），取前 3 个非 `model` 步骤作为分工，然后固定生成三段式计划：
  1. **第 0 步 `model`**：理解并拆解（prompt 明确「这一步不要修改任何文件」），`profileId` 指定内置 Agent 用哪个模型配置；
  2. **中间每步一个外部 Agent**：`dependsOn:[0]`，因此彼此可并行；`models[executorId]` 会写进该步 `executorInput.model`，由 `claude-code`（`--model`）与 `codex`（`-m`）转成 CLI 参数，其它 CLI 没有这个开关、留空即用它们自己的配置；
  3. **最后一步 `model`**：汇总各步结果，写「每个人做了什么、是否达成、还差什么」，并给出「下一步建议交给谁、做什么」。
- 计划与工单复用指挥台机制：`autoRun:false`（默认）时全部停在 `awaiting_review` 等你确认；步骤产出照常落盘到 `<项目>/.dataagent/runs/<planId>/`，并在放行下一步时注入 `executorInput.prompt`。
- 内置 Agent 的模型来自 `profileId`（缺省用工作流默认模型）；未配置模型时 `model` 执行器不可用，接口按执行器校验返回 400/503，不会产生假运行。


- `GET /api/work/projects/:id/brief.md` → `{project,brief,changes,markdown}`，markdown 为 `# 项目简报：<名称>` 的只读汇总，含目标、进展、任务要点、关键决定、约束与变更记录。
- `GET /api/work/projects/:id/changes` → `{changes:[ProjectChange]}`；`POST /api/work/projects/:id/changes {title?,summary?,files?,executorId?,ticketId?}` → `201 {change}`。工单完成/失败时自动写入 `source:'auto'`，同一 ticketId 幂等对应同一条记录；项目工单创建时会用 `git status --porcelain` 拍一张执行前快照，完成后只把**本次新增**的改动文件写进 `files`（调用方显式传 `files` 时以传入值为准，不再异步覆盖）；非项目工单仍按旧的异步采集回填（最多 100 项），采集失败不影响工单。`DELETE /api/work/projects/:id/changes/:changeId` → `{id}`。
- 删除项目级联删除其 project-chat、project-change 与 project-brief；MCP 工具 `work_list_projects`、`work_project_brief`（返回 brief.md 文本）、`work_update_project_brief`、`work_record_change` 供外部 Agent 读取档案与回写变更。

ProjectWorkspace `{id,name,path,gitBranch,createdAt,updatedAt,chatCount,chats:[ProjectChat]}`；ProjectChat `{id,projectId,executorId,title,sessionId,writable,source:'manual'|'imported',window?:{handle,process,title},lastTicketId?,lastSummary?,createdAt,updatedAt}`；ProjectBrief `{projectId,goal,summary,keyPoints:string[],decisions:string[],constraints:string[],updatedAt}`；ProjectChange `{id,projectId,projectChatId,ticketId,executorId,title,summary,files:string[],sessionId,status,source:'auto'|'manual',createdAt,updatedAt?}`。CLI 完成且处于项目模式时才回写 `sessionId` 与该次 CLI 摘要；非项目对话的执行器输入禁止 `workspace`、`resume`、`write`，返回 400。CLI 执行器是一次性进程，不会打开 Claude Code / Codex 桌面端的会话界面。

`GET /api/work/providers` 在找不到 CLI 但窗口桥检出运行中的 DeepSeek Harness 时，把 `dsh` 标记为 `{kind:'desktop',installed:true,status:'ready',command:'DeepSeek Harness'}`，消息提示改用「窗口 · DeepSeek Harness」；`dsh-acp` 仍为 `not_installed`，但消息说明桌面版可用窗口 Agent，无需安装适配器。桌面探测失败时静默降级为原有 PATH 探测，不影响其它 provider。

## 云端报告分享（capabilities.reportSharing）

仅 cloud 支持。所有管理接口需要会话及既有同源校验，公开接口匿名；分享为创建时固定的只读快照，不提供下载接口。

- `POST /api/tasks/:id/shares`：`{expiresInDays:1|7|30,hideRevenue:boolean}`；已完成且有报告的任务返回 201 `{share:{id,expiresAt,hideRevenue,views:0,registrations:0},token}`。token 为 32 字节随机数的 base64url，仅此响应返回；服务端只存 SHA-256 摘要。无权限/不存在任务 404，未完成 409，参数错误 400。
- `GET /api/tasks/:id/shares`：`{shares:[{id,expiresAt,hideRevenue,revoked,views,registrations}]}`，不返回 token；`DELETE /api/shares/:id` 撤销，返回 `{ok:true}`；其他账号不可管理。
- `POST /api/public/shares/read`，`{token}`：`{report:{source:'ai'|'local',hideRevenue,currency?:string|null,metrics:[{id,label,value:number|null,unit}],daily:[{date,dau,newUsers,revenue?,payers?}],retention:[{date,users,d1,d7}],methodology:string[]}}`。快照仅含明确白名单字段与服务端固定文字，无标题、渠道、自由文本、AI 叙述、原始记录及标识；隐藏收入时无币种、收入、付费指标及相关文字。货币代码仅认服务端固定白名单，其他显示 null；daily/retention 各最多 366 条。无效、过期及撤销统一返回 404 `{error:'分享不可用'}`。读取不计访问。
- 页面访问后主动 `POST /api/public/shares/visit`，`{token,visitorToken}`，返回 `{ok:true}`。visitorToken 为客户端生成的 32 字节随机 base64url 字符串（43 位），同一分享与访客标识只记一次；仅存其哈希，计数不使用 IP，不代表自然人数量。每个分享最多记录 10000 个访问标识；达到上限的新标识返回 429。匿名请求限流，不存 IP 到数据库。
- 站内主动注册可在原有注册请求中附带 `{shareToken,visitorToken}`。用户创建与有效分享归因同一 SQLite 事务；只有注册提交时分享仍有效才计数，同一分享/访客标识最多一次，最多 10000 个归因。无效、过期、撤销、字段缺失、重复或达到上限均不影响注册且不计数；旧客户端不传字段行为不变。计数为成功注册时唯一标识数，非访问转化率或真实人数。
- 每报告最多 20 条、每账号最多 100 条分享记录；到期 30 天后定期清理记录及关联去重数据。撤销记录同样在到期 30 天后清理。公开 API 和分享页面响应 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`；分享链接格式为 `/share#<token>`，片段不会发送给服务器；反向代理及应用禁止记录请求体和分享令牌。创建或访问分享不调用模型、不改变额度。

分享快照补充字段：`period:{start,end}|null` 是严格匹配有效日期的报告期间；每个指标的 `coverage:{start,end}|null` 和 `method:string|null` 仅在已识别的确定性计算口径中提供，无法确认或无数据时为 null，应显示未知。留存指标没有可确认的覆盖日期。`dailyTruncated` 与 `retentionTruncated` 分别表示相应数组因 366 条上限被截断；完整指标并不局限于展示的图表片段。`sample:true|false|null` 依据该任务对应数据集 source 为 demo、upload 或缺失/未知得到，`sampleNotice` 是固定说明；不得将 null 解释为真实数据。以上信息均在创建快照时确定，已有分享快照保持不变。

输入格式契约的唯一来源为 src/input-contract.json，server/datasets.js 导出 SUPPORTED_FORMATS 与 REQUIRED_COLUMNS。生产默认且固定最多 3 个文件；仅非生产环境设置 DATAAGENT_ENABLE_MULTI_SHARD=1 时服务端允许 20 文件实验，生产环境忽略该开关；总大小 20MB、行数 200000 仍然生效。同表分片须有一致的映射后列结构。新增可选 shardManifest、rowSources 与 inspection.unrecognizedColumns；重叠、日期缺口进入 warnings。Parquet 需先运行 node scripts/convert-parquet.mjs input.parquet output.csv，ORC/Avro/JSONL 不支持。转换只转换文件格式，不自动将任意业务字段映射成标准表。

模型报告生成、恢复重跑与连接测试默认超时为 300000ms（5 分钟），local/cloud 共用此默认值；服务端 modelTimeoutMs 显式覆盖仍有效。取消操作仍立即中断模型请求。模型列表检测与报告探索计算时限不变。


## 多模型中心与 PDF

`GET /api/model-hub` 返回当前账号的 credentials、profiles、workflow、skills、vault；凭据仅含脱敏尾号，不含明文或密文。`POST/PUT/DELETE /api/model-credentials[/:id]` 管理凭据；`POST /api/model-credentials/:id/models` 检测目录。`POST/PUT/DELETE /api/model-profiles[/:id]` 管理引用凭据的模型配置；`POST /api/model-profiles/:id/test` 触发可能收费的连接测试。**第一个模型配置会自动成为工作流默认模型**（`defaultProfileId`），删除默认配置时自动把剩下的第一个补回默认——否则「规划设置」留空、内置模型 Agent 会一直显示「未就绪」。

`PUT /api/workflow-config` 保存 `{version:1,defaultProfileId,stages}`，阶段项为 `{profileId,skillId,effort,maxTokens,timeoutMs}`；defaultProfileId=null关闭新工作流。`POST/PUT/DELETE /api/workflow-skills[/:id]` 管理账号私人文本Skill。服务端验证阶段、模型能力、工具权限、预算和Skill版本，客户端不能覆盖能力表。

新AI任务在账号启用默认工作流后使用13阶段快照；旧任务仍可读取。任务返回 workflowSnapshot 与 artifacts，均不包含Key；每次模型请求重新验证凭据引用和版本。`settings.hasKey` 表示任一可用模型模式，`settings.sessionHasKey` 单独表示旧会话Key，`settings.workflowEnabled` 表示新工作流已配置。runtime.capabilities新增modelHub/reportPdf。

`GET /api/tasks/:id/report.pdf` 仅能下载当前账号已完成的旧报告，或新工作流已核验报告；返回application/pdf附件。缓存按任务隔离，重试仅排版，不产生额外模型调用或钱包结算。匿名分享接口不提供此下载路径。
