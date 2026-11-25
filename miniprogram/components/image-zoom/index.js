// 题图预览：双指和按钮共用缩放状态，切图及复位恢复适应屏幕。
const MIN_SCALE = 1;
const MAX_SCALE = 6;
function boundedScale(value) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}
Component({
  properties: {
    images: { type: Array, value: [] },
    initialIndex: { type: Number, value: 0 },
  },
  data: {
    currentIndex: 0, activeImage: [], label: '',
    imageWidth: 1, imageHeight: 1, x: 0, y: 0,
    zoom: 1, percent: 100, ready: false, error: '', safeTop: 0,
  },
  lifetimes: {
    ready() {
      this.measureStage();
    },
  },
  pageLifetimes: {
    resize() { this.measureStage(); },
  },
  methods: {
    measureStage() {
      const update = (this._measurement || 0) + 1;
      this._measurement = update;
      const safeTop = wx.getWindowInfo ? wx.getWindowInfo().statusBarHeight || 0 : 0;
      this.setData({ safeTop }, () => {
        this.createSelectorQuery().select('.image-zoom-stage').boundingClientRect(rect => {
          if (update !== this._measurement || !rect?.width || !rect?.height) return;
          const changed = this._area?.width !== rect.width || this._area?.height !== rect.height;
          this._area = { width: rect.width, height: rect.height };
          if (!this.data.activeImage.length) this.showImage(this.data.initialIndex);
          else if (changed && this._imageSize) this.fitImage();
        }).exec();
      });
    },
    showImage(index) {
      const image = this.data.images[index];
      if (!image || !this._area) return;
      this._imageSize = null;
      const request = (this._imageRequest || 0) + 1;
      this._imageRequest = request;
      this.setData({
        currentIndex: index, activeImage: [{ url: image.url, request }], label: image.label || '图片',
        imageWidth: this._area.width, imageHeight: this._area.height,
        x: 0, y: 0, zoom: 1, percent: 100, ready: false, error: '',
      });
    },
    imageLoaded(event) {
      const { width, height } = event.detail;
      if (Number(event.currentTarget.dataset.request) !== this._imageRequest || !width || !height) return;
      this._imageSize = { width, height };
      this.fitImage();
    },
    fitImage() {
      const { width, height } = this._imageSize;
      const fit = Math.min(this._area.width / width, this._area.height / height);
      const imageWidth = width * fit, imageHeight = height * fit;
      this.setData({ imageWidth, imageHeight, ready: true, error: '', zoom: 1, percent: 100,
        x: (this._area.width - imageWidth) / 2, y: (this._area.height - imageHeight) / 2 });
    },
    imageFailed(event) {
      if (Number(event.currentTarget.dataset.request) !== this._imageRequest) return;
      this._imageSize = null;
      this.setData({ error: '图片暂不可用，请关闭后重试', ready: false });
    },
    scaleChanged(event) {
      const scale = Number(event.detail.scale);
      if (!this.data.ready || !Number.isFinite(scale)) return;
      const zoom = boundedScale(scale);
      if (this.data.zoom !== zoom) this.setData({ zoom, percent: Math.round(zoom * 100) });
      this.moved(event);
    },
    moved(event) {
      if (!this.data.ready) return;
      const changes = {};
      for (const axis of ['x', 'y']) if (Number.isFinite(event.detail[axis]) && event.detail[axis] !== this.data[axis]) changes[axis] = event.detail[axis];
      if (Object.keys(changes).length) this.setData(changes);
    },
    zoomBy(event) {
      if (!this.data.ready) return;
      const zoom = boundedScale(Math.round((this.data.zoom + Number(event.currentTarget.dataset.step)) * 100) / 100);
      this.setData({ zoom, percent: Math.round(zoom * 100) });
    },
    reset() {
      if (this._imageSize && this.data.ready) this.fitImage();
    },
    previous() { if (this.data.currentIndex > 0) this.showImage(this.data.currentIndex - 1); },
    next() { if (this.data.currentIndex < this.data.images.length - 1) this.showImage(this.data.currentIndex + 1); },
    close() { this.triggerEvent('close'); },
  },
});
