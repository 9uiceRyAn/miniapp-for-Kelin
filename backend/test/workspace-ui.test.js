const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=process.env.MINIPROGRAM_ROOT||path.join(__dirname,'../../miniprogram');
const { createCache } = require(path.join(root, 'utils/cache.js'));
function load(file,learning={},pages=[],drafts={},sharedCache=null) {
 let config; const calls=[];
 const user={id:1,role:'student'};
 const wxMock={redirectTo:x=>calls.push(x.url),navigateBack:x=>calls.push(x),setStorageSync:(k,v)=>drafts[k]=v,getStorageSync:k=>drafts[k],removeStorageSync:k=>delete drafts[k],showToast:()=>{}};
 const cache=sharedCache||createCache({storage:{getUser:()=>user},wx:wxMock});
 const wsMod={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'utils/workspace.js'),'utf8'),{module:wsMod,exports:wsMod.exports,require:n=>n.includes('cache')?cache:{},console,Map,Set,Array,String,Number,Boolean,Math,Date,JSON});
 const l={query:o=>new URLSearchParams(Object.entries(o).filter(([,v])=>v!==''&&v!==undefined)).toString(),url:x=>x,error:e=>{throw e},go:p=>calls.push(p),guard:()=>true,confirm:async()=>true,getMe:async fn=>{const m=await l.request('/api/ai/me');fn(m);return m;},...learning};
 vm.runInNewContext(fs.readFileSync(path.join(root,'pages',file+'.js'),'utf8'),{Page:x=>config=x,require:n=>n.includes('usage')?require(path.join(root,'utils/usage.js')):n.includes('workspace')?wsMod.exports:n.includes('markdown')?require(path.join(root,'utils/markdown.js')):n.includes('utils/file')?require(path.join(root,'utils/file.js')):n.includes('utils/drive')?{formatSize:x=>String(x||0),isDesktop:()=>false}:n.includes('cache')?cache:n.includes('learning')?l:n.includes('storage')?{getUser:()=>user}:{},getCurrentPages:()=>pages,wx:wxMock,console,setTimeout:()=>0,clearTimeout:()=>{},Math,Date,JSON});
 return {...config,cache,data:structuredClone(config.data),calls,setData(values){for(const[k,v]of Object.entries(values)){const parts=k.replace(/\[(\d+)\]/g,'.$1').split('.');let n=this.data;for(const p of parts.slice(0,-1))n=n[p];n[parts.at(-1)]=v;}}};
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
 const second=load('chat/chat',{request:async url=>url.startsWith('/api/ai/conversations?')||url==='/api/ai/conversations'?[]:{conversation:{owner_id:1},messages:[],assets:[]}},[],drafts);await second.onLoad({id:'c'});assert.equal(second.data.text,'我的草稿');assert.equal(second.data.question.resourceId,'q');
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
 const wxml=fs.readFileSync(path.join(root,'pages/learning/index.wxml'),'utf8');assert.match(wxml,/class="ws-btn ws-btn-secondary ws-load-more"[^>]*bindtap="more"/);
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
 assert.match(landingWxml,/wx:if="\{\{!startingChat\}\}"[^>]*class="ws-ico ws-ico-send"/);
 const chatJson=JSON.parse(fs.readFileSync(path.join(root,'pages/chat/chat.json'),'utf8'));
 assert.equal(chatJson.usingComponents['mp-html'],'../../components/mp-html/index');
 const chatWxml=fs.readFileSync(path.join(root,'pages/chat/chat.wxml'),'utf8');
 assert.doesNotMatch(chatWxml,/class="speaker"/);
 assert.match(chatWxml,/<mp-html[^>]*markdown="\{\{true\}\}"[^>]*selectable="\{\{true\}\}"/);
 assert.match(chatWxml,/loading="\{\{sending\}\}"[^>]*><view wx:if="\{\{!sending\}\}" class="ws-ico ws-ico-send"\/>/);
 assert.match(chatWxml,/pendingText/);
});

test('chat run-completed renders pendingText immediately with completion timestamp and clears on mergeMessages',async()=>{
 const p=load('chat/chat',{
  request:async()=>({conversation:{owner_id:1,agent_id:'a1'},messages:[],assets:[]}),
 });
 p._sequence=1;
 p._partial='# 标题\\(x^2\\)\n\n**加粗**';
 p.setData({running:true});
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

test('learning/index prevents initial bank flash and skips facets for non-bank landing',async()=>{
 const urls=[];
 const p=load('learning/index',{request:async url=>{urls.push(url);if(url==='/api/ai/me')return{user:{id:1,role:'student'},admin:false};if(url.startsWith('/api/ai/agents'))return{items:[{id:'a1',name:'助手'}],total:1};return[];}});
 assert.equal(p.data.sectionReady,false);
 assert.equal(p.data.mainTab,'');
 assert.equal(p.data.sectionTitle,'');
 p.onLoad({section:'agents'});
 assert.equal(p.data.sectionReady,true);
 assert.equal(p.data.section,'agents');
 assert.equal(p.data.mainTab,'chat');
 assert.equal(p.data.sectionTitle,'学习助手');
 await new Promise(r=>setTimeout(r,10));
 assert.ok(!urls.some(u=>u.includes('/api/question-bank/facets')));
 const wechatJs=fs.readFileSync(path.join(root,'utils/wechat.js'),'utf8');
 assert.match(wechatJs,/\/pages\/learning\/index\?section=agents/);
});

test('chat/chat batches text-delta fragments and uses path updates when appending messages',async()=>{
 const setDataCalls=[];
 const p=load('chat/chat',{request:async()=>({conversation:{owner_id:1,agent_id:'a1'},messages:[],assets:[]})});
 const origSetData=p.setData.bind(p);
 p.setData=values=>{setDataCalls.push(values);return origSetData(values);};
 p._sequence=0;
 p.setData({running:true});
 setDataCalls.length=0;
 p.consume({seq:1,type:'text-delta',data:{text:'你好'}});
 p.consume({seq:2,type:'text-delta',data:{text:'，世界'}});
 assert.equal(setDataCalls.length,0);
 p.flushStreamDelta();
 assert.equal(setDataCalls.length,1);
 assert.equal(p.data.streamHead,'');
 assert.equal(p.data.streamTail,'你好，世界');
 assert.equal(p.data.hasPartial,true);
 p.load=async()=>{};
 p.consume({seq:3,type:'text-delta',data:{text:'！'}});
 p.consume({seq:4,type:'run-completed',created_at:'2026-11-25T14:47:00.000Z',data:{}});
 assert.equal(p.data.pendingText,'你好，世界！');
 assert.equal(p.data.hasPartial,false);

 p.data.messages=[{id:'m1',seq:1,role:'user',data:{text:'hi'}}];
 p.setData({pendingText:''});
 setDataCalls.length=0;
 await p.mergeMessages({messages:[{id:'m1',seq:1,role:'user',data:{text:'hi'}}]});
 assert.equal(setDataCalls.length,0);
 await p.mergeMessages({messages:[{id:'m1',seq:1,role:'user',data:{text:'hi'}},{id:'m2',seq:2,role:'assistant',data:{text:'hello'}}]});
 assert.equal(setDataCalls.length,1);
 assert.ok('messages[1]' in setDataCalls[0]);
 assert.ok(!('messages' in setDataCalls[0]));
});

test('teacher library loads drive items and refreshes after creating a folder',async()=>{
 const requests=[];
 const p=load('learning/index',{request:async(u,m,b)=>{
  requests.push({u,m:m||'GET',b});
  if(m==='POST'&&u==='/api/drive/folders')return{id:10,name:b.name};
  if(u.startsWith('/api/drive/items'))return{breadcrumbs:[],folders:[{id:10,name:'新资料夹',canEdit:true}],files:[]};
  return{items:[],total:0};
 }});
 p.setData({section:'library',teacher:true,driveFolderId:''});
 p.openDriveNewFolder();
 p.setData({driveEditName:'新资料夹'});
 await p.submitDriveName();
 assert.equal(requests[0].m,'POST');
 assert.equal(requests[0].u,'/api/drive/folders');
 assert.equal(requests[0].b.name,'新资料夹');
 assert.ok(requests[1].u.startsWith('/api/drive/items'));
 assert.equal(p.data.driveFolders.length,1);
 assert.equal(p.data.driveFolders[0].name,'新资料夹');
 assert.equal(p.data.driveSheet,'');
});

test('driveGoUp returns to parent folder or root',async()=>{
 const urls=[];
 const p=load('learning/index',{request:async u=>{urls.push(u);return{breadcrumbs:[],folders:[],files:[]};}});
 p.setData({section:'library',driveFolderId:'20',driveBreadcrumbs:[{id:10,name:'父目录'},{id:20,name:'子目录'}]});
 await p.driveGoUp();
 assert.equal(p.data.driveFolderId,'10');
 assert.ok(urls.at(-1).includes('folderId=10'));
 p.setData({driveFolderId:'10',driveBreadcrumbs:[{id:10,name:'父目录'}]});
 await p.backSection();
 assert.equal(p.data.driveFolderId,'');
 assert.ok(!urls.at(-1).includes('folderId='));
});

test('cache utility supports memory/persisted hits, freshness, invalidation, and user isolation',()=>{
 let clock=1000;
 let currentUser={id:1};
 const store={};
 const wxStore={
  getStorageSync:k=>store[k],
  setStorageSync:(k,v)=>{store[k]=v;},
  removeStorageSync:k=>{delete store[k];},
 };
 const c=createCache({storage:{getUser:()=>currentUser},wx:wxStore,now:()=>clock});
 c.set('bank:items:math',{items:[{id:'q1'}]},{persist:true});
 const hit=c.get('bank:items:math',{maxAge:5000});
 assert.equal(hit.fresh,true);
 assert.deepEqual(hit.value,{items:[{id:'q1'}]});
 clock=7000;
 assert.equal(c.get('bank:items:math',{maxAge:5000}).fresh,false);
 // User isolation
 currentUser={id:2};
 assert.equal(c.get('bank:items:math',{maxAge:5000}),null);
 currentUser={id:1};
 // Re-hydrate from persisted storage on fresh cache instance
 const c2=createCache({storage:{getUser:()=>currentUser},wx:wxStore,now:()=>clock});
 assert.deepEqual(c2.get('bank:items:math',{maxAge:5000}).value,{items:[{id:'q1'}]});
 c2.invalidate('bank:');
 assert.equal(c2.get('bank:items:math'),null);
});

test('learning/index caches bank and library sections across tab switches without refetching while fresh',async()=>{
 let bankCalls=0;let driveCalls=0;
 const p=load('learning/index',{
  request:async url=>{
   if(url.startsWith('/api/question-bank/facets'))return[];
   if(url.startsWith('/api/question-bank/items')){bankCalls++;return{items:[{resourceId:'q1',title:'积分题',primary_tag:'1',primary_tag_name:'积分'}],total:1};}
   if(url.startsWith('/api/drive/items')){driveCalls++;return{breadcrumbs:[],folders:[{id:1,name:'讲义',canEdit:true}],files:[]};}
   return{items:[],total:0};
  },
 });
 p.setData({section:'bank'});
 await p.load(true);
 assert.equal(bankCalls,1);
 await p.selectSection({currentTarget:{dataset:{id:'library'}}});
 assert.equal(driveCalls,1);
 assert.equal(p.data.driveFolders.length,1);
 // Switch back to bank: should restore cached questionGroups immediately and skip network while fresh
 await p.selectSection({currentTarget:{dataset:{id:'bank'}}});
 assert.equal(bankCalls,1);
 assert.equal(p.data.questionGroups.length,1);
 assert.equal(p.data.bankItemCount,1);
 // Switch back to library: should restore cached driveFolders immediately and skip network while fresh
 await p.selectSection({currentTarget:{dataset:{id:'library'}}});
 assert.equal(driveCalls,1);
 assert.equal(p.data.driveFolders.length,1);
});

test('a fresh cached filter discards an earlier pending bank response', async () => {
 let finish;
 const page = load('learning/index', {request: () => new Promise(resolve => { finish = resolve; })});
 page.setData({section: 'bank', q: 'first'});
 const pending = page.load(true);
 page.setData({q: 'second'});
 const key = page.sectionCacheSpec('bank').key;
 page.cache.set(key, {items: [], questionGroups: [], total: 0, page: 1});
 await page.load(true);
 finish({items: [{resourceId: 'old'}], total: 1});
 await pending;
 assert.equal(page.data.bankItemCount, 0);
 assert.equal(page.data.total, 0);
});

test('chat/chat hydrates cached messages immediately on reopen before background sync',async()=>{
 const drafts={};
 const sharedCache=createCache({storage:{getUser:()=>({id:1,role:'student'})},wx:{getStorageSync:k=>drafts[k],setStorageSync:(k,v)=>{drafts[k]=v;},removeStorageSync:k=>{delete drafts[k];}}});
 const first=load('chat/chat',{
  request:async url=>url.startsWith('/api/ai/conversations?')||url==='/api/ai/conversations'?[]:{conversation:{owner_id:1,agent_id:'a1'},messages:[{id:'m1',seq:1,role:'user',data:{text:'你好'}}],assets:[]},
  renderMessage:async x=>x,
 },[],drafts,sharedCache);
 await first.onLoad({id:'conv-cache'});
 assert.equal(first.data.messages.length,1);

 let releaseSecond;
 const second=load('chat/chat',{
  request:async url=>url.startsWith('/api/ai/conversations?')||url==='/api/ai/conversations'?[]:new Promise(resolve=>{releaseSecond=resolve;}),
  renderMessage:async x=>x,
 },[],drafts,sharedCache);
 const loadingPromise=second.onLoad({id:'conv-cache'});
 assert.equal(second.data.messages.length,1);
 assert.equal(second.data.messages[0].data.text,'你好');
 releaseSecond({conversation:{owner_id:1,agent_id:'a1'},messages:[{id:'m1',seq:1,role:'user',data:{text:'你好'}},{id:'m2',seq:2,role:'assistant',data:{text:'你好呀'}}],assets:[]});
 await loadingPromise;
 assert.equal(second.data.messages.length,2);
});

test('question/detail caches item details while fresh and forces reload on imageError',async()=>{
 let calls=0;
 const drafts={};
 const sharedCache=createCache({storage:{getUser:()=>({id:1,role:'student'})},wx:{getStorageSync:k=>drafts[k],setStorageSync:(k,v)=>{drafts[k]=v;},removeStorageSync:k=>{delete drafts[k];}}});
 const makePage=()=>load('question/detail',{
  request:async()=>{calls++;return{resourceId:'q1',revisionId:'r1',title:'第1题',ownerId:1,visibility:'public',media:[]};},
 },[],drafts,sharedCache);
 const p1=makePage();
 await p1.onLoad({id:'q1',revisionId:'r1'});
 assert.equal(calls,1);
 const p2=makePage();
 await p2.onLoad({id:'q1',revisionId:'r1'});
 assert.equal(calls,1);
 assert.equal(p2.data.item.title,'第1题');
 await p2.imageError({currentTarget:{dataset:{id:'img1'}}});
 assert.equal(calls,2);
});
