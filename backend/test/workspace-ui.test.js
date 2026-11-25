const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=process.env.MINIPROGRAM_ROOT||path.join(__dirname,'../../miniprogram');
function load(file,learning={},pages=[],drafts={}) {
 let config; const calls=[];
 const l={query:o=>new URLSearchParams(Object.entries(o).filter(([,v])=>v!==''&&v!==undefined)).toString(),url:x=>x,error:e=>{throw e},go:p=>calls.push(p),guard:()=>true,...learning};
 vm.runInNewContext(fs.readFileSync(path.join(root,'pages',file+'.js'),'utf8'),{Page:x=>config=x,require:n=>n.includes('input-hints')?require(path.join(root,'utils/input-hints.js')):n.includes('usage')?require(path.join(root,'utils/usage.js')):n.includes('workspace')?require(path.join(root,'utils/workspace.js')):n.includes('markdown')?require(path.join(root,'utils/markdown.js')):n.includes('utils/file')?require(path.join(root,'utils/file.js')):n.includes('learning')?l:n.includes('storage')?{getUser:()=>({id:1,role:'student'})}:{},getCurrentPages:()=>pages,wx:{redirectTo:x=>calls.push(x.url),navigateBack:x=>calls.push(x),setStorageSync:(k,v)=>drafts[k]=v,getStorageSync:k=>drafts[k],showToast:()=>{}},console,setTimeout:()=>0,clearTimeout:()=>{},Math,Date,JSON});
 return {...config,data:structuredClone(config.data),calls,setData(values){for(const[k,v]of Object.entries(values)){const parts=k.replace(/\[(\d+)\]/g,'.$1').split('.');let n=this.data;for(const p of parts.slice(0,-1))n=n[p];n[parts.at(-1)]=v;}}};
}
const facets=[{subject:'math',subjectLabel:'数学',collection:'math-a',collectionLabel:'数学 A',skill:'p1'},{subject:'math',subjectLabel:'数学',collection:'math-b',collectionLabel:'数学 B',skill:'p2'},{subject:'physics',subjectLabel:'物理',collection:'physics',skill:'p1'}];
const event=index=>({currentTarget:{dataset:{index}}});
function api(url){if(url.includes('/facets'))return facets;if(url.includes('/taxonomy'))return [{code:'1.1',label:url.includes('physics')?'力学':'函数'}];return {items:[],total:0};}
test('subject selection resets old filters and exposes collection-scoped tags',async()=>{
 const p=load('learning/index',{request:async url=>api(url)});await p.facets();p.setData({collection:'old',skill:'old',tag:'old',q:'old',page:5});
 assert.equal(typeof p.selectSubject,'function');await p.selectSubject(event(1));
 assert.equal(p.data.subject,'math');assert.equal(p.data.skill,'');assert.equal(p.data.tag,'');assert.equal(p.data.q,'');assert.equal(p.data.page,1);
 assert.equal(p.data.tags.length,3);assert.notEqual(p.data.tags[1].key,p.data.tags[2].key);
});
test('a tag with a shared code filters its own dataset',async()=>{
 const urls=[];const p=load('learning/index',{request:async url=>{urls.push(url);return api(url)}});await p.facets();
 assert.equal(typeof p.selectSubject,'function');await p.selectSubject(event(1));await p.selectTag(event(2));
 const u=new URL(urls.at(-1),'http://test');assert.equal(u.searchParams.get('collection'),'math-b');assert.equal(u.searchParams.get('tag'),'1.1');
});
test('stale taxonomy cannot overwrite a newer subject selection',async()=>{
 const pending=[];const p=load('learning/index',{request:async url=>url.includes('/taxonomy')?new Promise(resolve=>pending.push({url,resolve})):api(url)});await p.facets();
 assert.equal(typeof p.selectSubject,'function');const a=p.selectSubject(event(1));const b=p.selectSubject(event(2));
 pending.find(x=>x.url.includes('physics')).resolve([{code:'p',label:'力学'}]);await b;
 pending.filter(x=>!x.url.includes('physics')).forEach(x=>x.resolve([{code:'old',label:'旧标签'}]));await a;
 assert.equal(p.data.subject,'physics');assert.equal(p.data.tags[1].label,'力学');assert.equal(p.data.loading,false);
});
test('profile navigation does not request usage and returning to bank preserves filters',async()=>{
 const urls=[];const p=load('learning/index',{request:async url=>{urls.push(url);return api(url)}});p.setData({subject:'math',tag:'1.1',collection:'math-a',q:'积分'});
 assert.equal(typeof p.selectMain,'function');await p.selectMain({currentTarget:{dataset:{id:'profile'}}});
 assert.equal(p.data.mainTab,'profile');assert.ok(!urls.some(u=>u.includes('usage')));
 await p.selectMain({currentTarget:{dataset:{id:'bank'}}});assert.equal(p.data.subject,'math');assert.equal(p.data.tag,'1.1');assert.equal(p.data.q,'积分');
});
test('tag grouping retains true resources and handles missing taxonomy',async()=>{
 const p=load('learning/index',{request:async()=>({items:[{resourceId:'r1',primary_tag:'1',primary_tag_name:'积分'},{resourceId:'r2',primary_tag:'1',primary_tag_name:'积分'},{resourceId:'r3'}],total:3})});await p.load(true);
 assert.ok(Array.isArray(p.data.questionGroups));assert.equal(p.data.questionGroups.length,2);assert.equal(p.data.questionGroups[0].items.length,2);assert.equal(p.data.questionGroups[1].items[0].resourceId,'r3');
});
test('chat landing requires an available agent and forwards the entered first message',async()=>{
 const requests=[];const p=load('learning/index',{request:async(u,m,b)=>{requests.push({u,m,b});return{id:'conv-1'}}});p.setData({landingText:'讲解 & 积分?',items:[]});
 assert.equal(typeof p.startChat,'function');await p.startChat();assert.equal(requests.length,0);
 p.setData({items:[{id:'agent-1'}],agentIndex:0});await p.startChat();assert.equal(requests[0].b.agentId,'agent-1');assert.match(p.calls[0],/initialText=/);assert.ok(decodeURIComponent(p.calls[0]).includes('讲解 & 积分?'));
});
test('bottom navigation out of a conversation uses redirect and keeps its saved messages',()=>{
 const p=load('chat/chat');p.data.id='existing';p.data.messages=[{id:1}];assert.equal(typeof p.selectMain,'function');p.selectMain({currentTarget:{dataset:{id:'bank'}}});assert.match(p.calls[0],/section=bank/);assert.equal(p.data.messages.length,1);
});
test('bottom navigation reuses the existing learning page',async()=>{
 const selected=[];const pages=[{route:'pages/learning/index',selectMain:async e=>selected.push(e.currentTarget.dataset.id)}, {route:'pages/question/detail'}, {route:'pages/chat/chat'}];const p=load('chat/chat',{},pages);await p.selectMain({currentTarget:{dataset:{id:'bank'}}});
 assert.deepEqual(selected,['bank']);assert.equal(p.calls[0].delta,2);
});
test('an unsent draft survives leaving and reopening a conversation',async()=>{
 const drafts={};const first=load('chat/chat',{},[],drafts);first.setData({id:'c',text:'我的草稿',question:{resourceId:'q',revisionId:'r'},questionTitle:'题目'});first.onHide();
 const second=load('chat/chat',{request:async url=>url.startsWith('/api/ai/conversations?')||url==='/api/ai/conversations'?[]:{conversation:{owner_id:1},messages:[],assets:[]},renderMessage:async x=>x},[],drafts);await second.onLoad({id:'c'});assert.equal(second.data.text,'我的草稿');assert.equal(second.data.question.resourceId,'q');
});
test('recent conversations group by agent identity, not a shared display name',async()=>{
 const p=load('learning/index',{request:async()=>[{id:'c1',agent_id:'a',name:'数学助手',mode:'student',updated_at:'2026-10-28T12:00:00Z'},{id:'c2',agent_id:'b',name:'数学助手',mode:'student'},{id:'c3',agent_id:'a',name:'数学助手',mode:'test'}]});await p.loadRecent();assert.ok(p.data.conversationGroups);assert.equal(p.data.conversationGroups.length,2);assert.equal(p.data.conversationGroups[0].items.length,2);
});
test('older conversations append within agent groups and preserve expansion',async()=>{
 const p=load('learning/index',{request:async url=>new URL(url,'http://test').searchParams.get('page')==='2'?[{id:'older',agent_id:'a',name:'数学'}]:Array.from({length:20},(_,i)=>({id:'c'+i,agent_id:'a',name:'数学'}))});await p.loadRecent();assert.equal(p.data.recentHasMore,true);p.toggleAgentGroup({currentTarget:{dataset:{id:'a'}}});await p.moreRecent();assert.equal(p.data.conversationGroups[0].items.length,21);assert.equal(p.data.conversationGroups[0].expanded,false);assert.equal(p.data.recentHasMore,false);
});
test('returning after a cancelled taxonomy request restores the subject tags',async()=>{
 let release;let count=0;const p=load('learning/index',{request:async url=>url.includes('/taxonomy')&&++count===1?new Promise(r=>release=r):api(url)});await p.facets();const selection=p.selectSubject(event(2));await p.selectMain({currentTarget:{dataset:{id:'profile'}}});release([{code:'p',label:'力学'}]);await selection;await p.selectMain({currentTarget:{dataset:{id:'bank'}}});assert.ok(p.data.tags.length>1);
});
test('a dataset selected under all subjects still has taxonomy',async()=>{
 const p=load('learning/index',{request:async u=>api(u)});await p.facets();await p.filter({currentTarget:{dataset:{field:'collection'}},detail:{value:1}});assert.ok(p.data.tags.length>1);
});
test('the assistant picker retains access to later pages',async()=>{
 const p=load('learning/index',{request:async u=>({items:[{id:new URL(u,'http://test').searchParams.get('page')}],total:21})});p.data.section='agents';await p.load(true);await p.more();assert.equal(p.data.items.length,2);
 const wxml=fs.readFileSync(path.join(root,'pages/learning/index.wxml'),'utf8');assert.match(wxml,/class="agent-more"[^>]*bindtap="more"/);
});

const usageView=require(path.join(root,'utils/usage.js'));
test('fee display preserves small decimals and distinguishes zero from unknown',()=>{
 const displayAmount = amount => usageView.row({status:'estimated', currency:'USD', amount}).amount;
 assert.equal(displayAmount('0.000094200000'),'0.0000942');
 assert.equal(displayAmount('0.000000000001'),'0.000000000001');
 assert.equal(displayAmount('9007199254740993.120000'),'9007199254740993.12');
 assert.equal(displayAmount('0.000000000000'),'0');
 assert.equal(displayAmount(null),null);
});
test('fee overview separates currencies and excludes pending amounts',()=>{
 const view=usageView.overview([{currency:'USD',status:'estimated',amount:'0.000094200000',calls:3},{currency:'USD',status:'pending',amount:null,calls:8},{currency:'CNY',status:'estimated',amount:'1.230000',calls:2},{currency:null,status:'pending',amount:null,calls:2}]);
 assert.equal(view.totalCalls,15);assert.equal(view.pendingCalls,10);assert.equal(view.unpricedCalls,2);
 assert.deepEqual(view.currencies.map(x=>[x.currency,x.amount]),[['USD','0.0000942'],['CNY','1.23']]);
 const pending=usageView.row({status:'pending',amount:null,currency:'USD',purpose:'student',created_at:'2026-10-31T12:41:21.000Z'});
 assert.equal(pending.amount,null);assert.equal(pending.status,'待核实');assert.equal(pending.purpose,'作业辅导');assert.equal(pending.time,'2026/10/31 8:41 PM');
 assert.equal(usageView.row({status:'estimated',amount:'0.000000',currency:'USD'}).amount,'0');
});
test('fee date filter includes the selected end day in Beijing time and rejects reversed dates',async()=>{
 const urls=[];const p=load('learning/index',{request:async u=>{urls.push(u);return{items:[],summary:[]}}});
 p.setData({section:'usage',from:'2026-11-02',to:'2026-11-01'});await p.applyUsageFilters();assert.equal(urls.length,0);assert.ok(p.data.usageFilterError);
 p.setData({from:'2026-10-31',to:'2026-10-31'});await p.applyUsageFilters();
 const q=new URL(urls[0],'http://test').searchParams;assert.equal(q.get('from'),'2026-10-31T00:00:00+08:00');assert.equal(q.get('to'),'2026-10-31T23:59:59.999+08:00');
 assert.equal(p.data.usagePeriod,'2026-10-31 至 2026-10-31');assert.equal(p.data.usageFiltersOpen,false);
});
test('fee rows format actual data and returning to self clears hidden user filters',async()=>{
 const urls=[];const p=load('learning/index',{request:async u=>{urls.push(u);return{summary:[{currency:'USD',status:'estimated',amount:'0.10',calls:1}],items:[{id:'record',purpose:'parse',amount:'0.10',currency:'USD',status:'estimated',created_at:'2026-10-31T12:41:21.000Z',data:{usage:{input:10,output:2,cached:0}}}]}}});
 p.setData({section:'usage',scope:'admin',userId:'42'});p.scope({currentTarget:{dataset:{id:'self'}}});await p.load(true);
 assert.equal(p.data.userId,'');assert.ok(urls.every(u=>u.startsWith('/api/ai/usage?')));assert.equal(p.data.items[0].usage.purpose,'资料识别');assert.equal(p.data.items[0].usage.amount,'0.1');
 p.toggleUsageDetails({currentTarget:{dataset:{id:'record'}}});assert.equal(p.data.expandedUsageId,'record');
});

test('RMB reference conversion retains tiny amounts, zero and large decimal precision',()=>{
 const displayCny = (amount,currency) => usageView.row({status:'estimated', currency, amount}).cnyAmount;
 assert.equal(displayCny('0.000094200000','USD'),'0.00063243996');
 assert.equal(displayCny('0.000000000001','USD'),'0.0000000000067138');
 assert.equal(displayCny('9007199254740993.12','USD'),'60472534356480079.609056');
 assert.equal(displayCny('0.000000','USD'),'0');
 assert.equal(displayCny('1.230000','CNY'),'1.23');
 assert.equal(displayCny(null,'USD'),null);
 assert.equal(displayCny('1.00','EUR'),null);
});
test('RMB total combines supported estimates and exposes unsupported currency coverage',()=>{
 const view=usageView.overview([{currency:'USD',status:'estimated',amount:'0.1',calls:1},{currency:'CNY',status:'estimated',amount:'1.23',calls:2},{currency:'USD',status:'pending',amount:'9',calls:3},{currency:'EUR',status:'estimated',amount:'4',calls:5}]);
 assert.equal(view.cnyAmount,'1.90138');assert.equal(view.cnyExcludedCalls,5);assert.equal(view.pendingCalls,3);
 assert.match(view.exchangeNote,/6.7138/);assert.match(view.exchangeNote,/2026-10-30/);
 assert.equal(usageView.overview([]).cnyAmount,null);
 assert.equal(usageView.overview([{currency:'USD',status:'pending',amount:null,calls:1}]).cnyAmount,null);
 assert.equal(usageView.overview([{currency:'USD',status:'estimated',amount:'0',calls:1}]).cnyAmount,'0');
 assert.equal(usageView.row({status:'pending',amount:'1',currency:'USD'}).cnyAmount,null);
 assert.equal(usageView.row({status:'estimated',amount:'0.1',currency:'USD'}).cnyAmount,'0.67138');
});

test('question management does not query managed questions for a non-admin account',async()=>{
 const urls=[];const page=load('home/home',{request:async url=>{urls.push(url);return{user:{id:2,role:'student'},admin:false}}});
 await page.onLoad();assert.equal(page.data.admin,false);assert.deepEqual(urls,['/api/ai/me']);
});
test('a stale management filter response cannot replace the latest question results',async()=>{
 let release;let requests=0;const urls=[];
 const page=load('home/home',{request:async url=>{urls.push(url);if(++requests===1)return new Promise(resolve=>release=resolve);return{items:[{resourceId:'new',title:'new'}],total:1}}});
 page.setData({admin:true});const first=page.load(true);page.setData({q:'latest'});await page.load(true);
 release({items:[{resourceId:'old',title:'old'}],total:99});await first;
 assert.equal(page.data.items[0].resourceId,'new');assert.equal(page.data.total,1);assert.equal(page.data.loading,false);
 assert.equal(new URL(urls[1],'http://test').searchParams.get('q'),'latest');
});

test('chat landing attaches, removes, and uploads pending files on startChat',async()=>{
 const uploaded=[];let seq=0;
 const p=load('learning/index',{
  id:()=>'id-'+(++seq),
  pickFiles:async()=>[{path:'/tmp/a.pdf',name:'讲义.pdf'},{path:'/tmp/b.png',name:'题图.png'}],
  request:async(u,m,b)=>({id:'conv-99'}),
  upload:async(u,f)=>{uploaded.push({u,f});return{resourceId:'res-'+uploaded.length};},
 });
 p.setData({items:[{id:'agent-1'}],agentIndex:0,landingText:'帮我看看'});
 await p.attachLandingFiles();
 assert.equal(p.data.landingFiles.length,2);
 p.removeLandingFile({currentTarget:{dataset:{index:0}}});
 assert.equal(p.data.landingFiles.length,1);
 assert.equal(p.data.landingFiles[0].name,'题图.png');
 await p.startChat();
 assert.equal(uploaded.length,1);
 assert.equal(uploaded[0].u,'/api/ai/conversations/conv-99/assets');
 assert.match(p.calls[0],/initialAssets=res-1/);
 assert.equal(p.data.landingFiles.length,0);
});

test('chat page selects initialAssets and attaches multiple files via pickFiles',async()=>{
 const sent=[];const uploaded=[];
 const p=load('chat/chat',{
  id:()=>'req-1',
  pickFiles:async()=>[{path:'/tmp/1.pdf',name:'1.pdf'},{path:'/tmp/2.png',name:'2.png'}],
  upload:async(u,f)=>{uploaded.push(f.name);return{resourceId:'r-'+uploaded.length,revisionId:'v-'+uploaded.length};},
  request:async(u,m,b)=>{
   if(m==='POST'&&u.endsWith('/messages')){sent.push(b);return{runId:'run-1'};}
   if(u.startsWith('/api/library/'))return{status:'ready'};
   if(u==='/api/ai/conversations'||u.startsWith('/api/ai/conversations?'))return[];
   return{conversation:{owner_id:1,agent_id:'a1'},messages:[],assets:[{resourceId:'r0',revisionId:'v0',status:'ready',data:{title:'附件0'}}]};
  },
  subscribe:()=>({abort:()=>{}}),
  renderMessage:async x=>x,
 });
 await p.onLoad({id:'c1',initialAssets:'r0'});
 assert.equal(sent.length,1);
 assert.deepEqual(sent[0].assets,['r0']);
 p.setData({running:false,sending:false,uploading:false});
 await p.attach();
 assert.deepEqual(uploaded,['1.pdf','2.png']);
});

test('chat UI removes speaker label, hides arrow during send loading, and enables rich-text user-select',()=>{
 const landingWxml=fs.readFileSync(path.join(root,'pages/learning/index.wxml'),'utf8');
 assert.match(landingWxml,/bindtap="attachLandingFiles"/);
 assert.match(landingWxml,/wx:if="\{\{!startingChat\}\}">↑/);
 const chatJson=JSON.parse(fs.readFileSync(path.join(root,'pages/chat/chat.json'),'utf8'));
 assert.equal(chatJson.usingComponents['mp-html'],'../../components/mp-html/index');
 const chatWxml=fs.readFileSync(path.join(root,'pages/chat/chat.wxml'),'utf8');
 assert.doesNotMatch(chatWxml,/class="speaker"/);
 assert.match(chatWxml,/<mp-html[^>]*markdown="\{\{true\}\}"[^>]*selectable="\{\{true\}\}"/);
 assert.match(chatWxml,/loading="\{\{sending\}\}"[^>]*><text wx:if="\{\{!sending\}\}">↑<\/text>/);
 assert.match(chatWxml,/pendingText/);
});

test('chat run-completed renders pendingText immediately with completion timestamp and clears on mergeMessages',async()=>{
 const p=load('chat/chat',{
  request:async()=>({conversation:{owner_id:1,agent_id:'a1'},messages:[],assets:[]}),
  renderMessage:async x=>x,
 });
 p._sequence=1;
 p.setData({running:true,partial:'# 标题\\(x^2\\)\n\n**加粗**'});
 p.consume({seq:2,type:'run-completed',created_at:'2026-11-25T14:47:00.000Z',data:{}});
 assert.equal(p.data.running,false);
 assert.equal(p.data.pendingText,'# 标题$x^2$\n\n**加粗**');
 assert.equal(p.data.progress,'2026/11/25 10:47 PM');
 assert.notEqual(p.data.progress,'回答完成');
 await p.mergeMessages({messages:[{id:'m1',seq:1,role:'assistant',created_at:'2026-11-25T14:47:00.000Z',data:{text:'# 标题\\(x^2\\)\n\n**加粗**'}}]});
 assert.equal(p.data.pendingText,'');
 assert.equal(p.data.messages[0].renderText,'# 标题$x^2$\n\n**加粗**');
});

test('miniprogram learning.js renders assistant messages locally without calling backend /render',()=>{
 const learningJs=fs.readFileSync(path.join(root,'utils/learning.js'),'utf8');
 assert.doesNotMatch(learningJs,/\/render/);
});
