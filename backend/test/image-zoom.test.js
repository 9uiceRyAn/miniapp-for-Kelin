const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function viewer(){
 let config;vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../miniprogram/components/image-zoom/index.js'),'utf8'),{Component:value=>config=value,wx:{},Math,Number,Object});
 const view = {
  ...config.methods,
  data: { ...structuredClone(config.data), initialIndex: config.properties.initialIndex.value },
  viewport: { width: 390, height: 600 },
  setData(values, done) { Object.assign(this.data, values); done?.(); },
  createSelectorQuery() {
   return {
    select: () => ({
     boundingClientRect: (callback) => ({ exec: () => callback(this.viewport) }),
    }),
   };
  },
  resize() { config.pageLifetimes.resize.call(this); },
  triggerEvent(name) { this.event = name; },
 };
 view.data.images=[{url:'test-first',label:'题目'},{url:'test-second',label:'答案'}];config.lifetimes.ready.call(view);return view;
}
const active=(v)=>v.data.activeImage[0];
const eventFor=(image)=>({ currentTarget: { dataset: { request: image.request } } });
const loaded=(v,width,height)=>v.imageLoaded({...eventFor(active(v)),detail:{width,height}});
test('wide and tall question images fit the viewport without distortion or clipping',()=>{
 const wide=viewer();loaded(wide,1200,200);assert.equal(wide.data.imageWidth,390);assert.equal(wide.data.imageHeight,65);assert.equal(wide.data.y,267.5);
 const tall=viewer();loaded(tall,1000,2000);assert.equal(tall.data.imageWidth,300);assert.equal(tall.data.imageHeight,600);assert.equal(tall.data.x,45);
});
test('zoom buttons continue from the actual pinch scale and reset restores fit and position',()=>{
 const v=viewer();loaded(v,1000,2000);v.scaleChanged({detail:{scale:2.4,x:-80,y:-100}});v.zoomBy({currentTarget:{dataset:{step:.5}}});assert.equal(v.data.zoom,2.9);assert.equal(v.data.percent,290);
 v.reset();assert.equal(v.data.zoom,1);assert.equal(v.data.percent,100);assert.equal(v.data.x,45);assert.equal(v.data.y,0);
});
test('zoom is bounded and changing images resets zoom without changing the supplied gallery',()=>{
 const v=viewer();loaded(v,1200,200);for(let i=0;i<20;i++)v.zoomBy({currentTarget:{dataset:{step:.5}}});assert.equal(v.data.zoom,6);
 for(let i=0;i<20;i++)v.zoomBy({currentTarget:{dataset:{step:-.5}}});assert.equal(v.data.zoom,1);
 v.next();assert.equal(v.data.currentIndex,1);assert.equal(active(v).url,'test-second');assert.equal(v.data.zoom,1);assert.equal(v.data.images[0].url,'test-first');v.next();assert.equal(v.data.currentIndex,1);v.previous();assert.equal(active(v).url,'test-first');
 v.close();assert.equal(v.event,'close');
});
test('resizing the preview refits the open image and subsequent images', () => {
 const v = viewer();
 loaded(v, 1000, 1000);
 v.zoomBy({ currentTarget: { dataset: { step: .5 } } });
 v.viewport = { width: 600, height: 260 };
 v.resize();
 assert.equal(v.data.imageWidth, 260);
 assert.equal(v.data.x, 170);
 assert.equal(v.data.y, 0);
 assert.equal(v.data.zoom, 1);
 v.next();
 loaded(v, 1000, 1000);
 assert.equal(v.data.imageWidth, 260);
});
test('events from an earlier image selection cannot change the active image', () => {
 const v = viewer();
 const old = active(v);
 v.next();
 v.previous();
 loaded(v, 1000, 1000);
 assert.equal(active(v).url, old.url);
 v.imageFailed(eventFor(old));
 v.imageLoaded({ ...eventFor(old), detail: { width: 1000, height: 2000 } });
 assert.equal(v.data.ready, true);
 assert.equal(v.data.imageWidth, 390);
 assert.equal(v.data.error, '');
 v.imageFailed(eventFor(active(v)));
 assert.equal(v.data.ready, false);
 assert.match(v.data.error, /图片暂不可用/);
});
