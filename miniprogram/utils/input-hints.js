// 统一输入提示：聚焦时隐藏，失焦或离开页面时恢复，不改动输入值。
function hintId(event) {
  return event?.currentTarget?.dataset?.hintId || '';
}
function resetInputHints() {
  if (this.data.inputHintFocus) this.setData({ inputHintFocus: '' });
}
function onInputHintFocus(event) {
  this.setData({ inputHintFocus: hintId(event) });
}
function onInputHintBlur(event) {
  const id = hintId(event);
  if (id && this.data.inputHintFocus === id) this.resetInputHints();
}
module.exports = function withInputHints(definition) {
  const originalOnHide = definition.onHide;
  return {
    ...definition,
    data: { ...definition.data, inputHintFocus: '' },
    resetInputHints,
    onInputHintFocus,
    onInputHintBlur,
    onHide(...args) {
      this.resetInputHints();
      return originalOnHide?.apply(this, args);
    },
  };
};
