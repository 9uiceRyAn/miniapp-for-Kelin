function decodeUploadName(name) {
  return Buffer.from(name || '', 'latin1').toString('utf8');
}
module.exports = { decodeUploadName };
