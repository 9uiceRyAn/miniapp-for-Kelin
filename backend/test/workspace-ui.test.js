const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=process.env.MINIPROGRAM_ROOT||path.join(__dirname,'../../miniprogram');
function load(file,learning={},pages=[],drafts={}) {
 let config; const calls=[];
 const l={query:o=>new URLSearchParams(Object.entries(o).filter(([,v])=>v!==''&&v!==undefined)).toString(),url:x=>x,error:e=>{throw e},go:p=>calls.push(p),guard:()=>true,...learning};
 vm.runInNewContext(fs.readFileSync(path.join(root,'pages',file+'.js'),'utf8'),{Page:x=>config=x,require:n=>n.includes('workspace')?require(path.join(root,'utils/workspace.js')):n.includes('learning')?l:n.includes('storage')?{getUser:()=>({id:1,role:'student'})}:{},getCurrentPages:()=>pages,wx:{redirectTo:x=>calls.push(x.url),navigateBack:x=>calls.push(x),setStorageSync:(k,v)=>drafts[k]=v,getStorageSync:k=>drafts[k],showToast:()=>{}},console,setTimeout:()=>0,clearTimeout:()=>{},Math,Date,JSON});
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
