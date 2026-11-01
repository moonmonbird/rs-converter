/* 在工作线程中解码和转换，保持页面可以响应操作。 */
importScripts('vendor/geotiff.js', 'vendor/fflate.js', 'converter.js');
let source = null, controller = null, sequence = 0;
const acks = new Map();
function send(data) { self.postMessage(data); }
async function flush(chunks, job) {
  while (chunks.length) {
    const bytes = chunks.shift(), id = ++sequence;
    const promise = new Promise((resolve, reject) => acks.set(id, { resolve, reject }));
    self.postMessage({ type: 'chunk', job, id, bytes }, [bytes.buffer]);
    await promise;
    if (controller.signal.aborted) throw new Error('已取消');
  }
}
self.onmessage = async ({ data }) => {
  if (data.type === 'ack') {
    const ack = acks.get(data.id);
    if (ack) { data.error ? ack.reject(new Error(data.error)) : ack.resolve(); acks.delete(data.id); }
    return;
  }
  if (data.type === 'cancel') {
    if (controller) controller.abort();
    for (const item of acks.values()) item.reject(new Error('已取消'));
    acks.clear(); return;
  }
  const job = data.job;
  controller = new AbortController();
  try {
    if (data.type === 'open') {
      if (source && source.close) await source.close();
      source = null;
      source = await RS.openFiles(data.files);
      send({ type: 'opened', job, info: RS.info(source) });
      const image = await RS.preview(source, [0, 0, 0], controller.signal);
      self.postMessage({ type: 'preview', job, ...image }, [image.rgba.buffer]);
    } else if (data.type === 'preview') {
      const image = await RS.preview(source, data.bands, controller.signal);
      self.postMessage({ type: 'preview', job, ...image }, [image.rgba.buffer]);
    } else if (data.type === 'convert') {
      if (!source) throw new Error('请先打开影像。');
      if (source.rawBytes > 0xFFFFFFFF - 65536) throw new Error('当前 ZIP 输出支持小于 4 GB 的影像数据。');
      const chunks = [];
      const zip = new fflate.Zip((error, bytes) => { if (error) throw error; if (bytes.length) chunks.push(bytes.slice()); });
      const base = RS.cleanName(source.name) + '_' + data.format;
      const header = new fflate.ZipPassThrough(base + '.hdr');
      zip.add(header); header.push(fflate.strToU8(RS.makeHeader(source, data.format)), true);
      await flush(chunks, job);
      const raster = new fflate.ZipPassThrough(base + '.' + data.format);
      zip.add(raster);
      const length = await RS.convert(source, data.format, async bytes => {
        raster.push(bytes, false);
        await flush(chunks, job);
      }, value => send({ type: 'progress', job, value }), controller.signal);
      raster.push(new Uint8Array(0), true); zip.end();
      await flush(chunks, job);
      send({ type: 'complete', job, length, name: base + '.zip' });
    }
  } catch (error) { send({ type: 'error', job, message: error.message || String(error) }); }
};
