/* 界面只处理文件选择、预览和下载，转换算法在 converter.js。 */
'use strict';
const $ = id => document.getElementById(id);
const worker = new Worker(new URL('worker.js', document.baseURI));
let info = null, job = 0, busy = false, stream = null, parts = [], resultURL = null;
const MEMORY_LIMIT = 256 * 1024 * 1024;
function sizeLabel(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(2) + ' GB';
}
function status(text, state = '') { $('status').textContent = text; $('status').className = 'status ' + state; }
function setBusy(value, text = '', converting = false) {
  busy = value;
  ['open-main', 'sample-button', 'replace-button'].forEach(id => $(id).disabled = value);
  ['convert-button', 'preview-button', 'gray-button', 'rgb-button', 'bands'].forEach(id => $(id).disabled = value || !info);
  document.querySelectorAll('input[name=format]').forEach(x => x.disabled = value);
  $('loading').hidden = !value || converting;
  $('loading-text').textContent = text;
  $('progress-area').hidden = !converting;
}
function clearDownload() {
  if (resultURL) URL.revokeObjectURL(resultURL);
  resultURL = null; $('download-again').hidden = true;
}
function selectFiles() { if (!busy) $('files').click(); }
$('open-main').onclick = selectFiles; $('replace-button').onclick = selectFiles;
$('files').onchange = () => { if ($('files').files.length) openFiles(Array.from($('files').files)); $('files').value = ''; };
function openFiles(files) {
  if (busy) return;
  clearDownload(); info = null; job++;
  $('image-info').hidden = true; $('preview').hidden = true;
  $('empty-state').hidden = false; $('bands').value = '1,1,1';
  setBusy(true, '正在读取影像'); status('正在打开影像');
  worker.postMessage({ type: 'open', job, files });
}
$('sample-button').onclick = async () => {
  if (busy) return;
  setBusy(true, '正在读取样例'); status('正在读取 Landsat 样例');
  try {
    const response = await fetch(new URL('sample/landsat_crop.tif', document.baseURI));
    if (!response.ok) throw new Error('样例下载失败，请重试。');
    const file = new File([await response.blob()], 'landsat_crop.tif', { type: 'image/tiff' });
    setBusy(false); openFiles([file]);
  } catch (error) { setBusy(false); status(error.message, 'error'); }
};
function updatePreview() {
  if (busy || !info) return;
  const bands = $('bands').value.replaceAll('，', ',').split(',').map(x => Number(x.trim()) - 1);
  if (bands.length !== 3 || bands.some(x => !Number.isInteger(x) || x < 0 || x >= info.count)) {
    status('请输入三个 1—' + info.count + ' 范围内的波段编号。', 'error'); return;
  }
  job++; setBusy(true, '正在生成预览');
  worker.postMessage({ type: 'preview', job, bands });
}
$('preview-button').onclick = updatePreview;
$('gray-button').onclick = () => { $('bands').value = '1,1,1'; updatePreview(); };
$('rgb-button').onclick = () => { $('bands').value = info && info.count >= 3 ? '3,2,1' : '1,1,1'; updatePreview(); };
$('bands').onkeydown = event => { if (event.key === 'Enter') updatePreview(); };
$('convert-button').onclick = async () => {
  if (!info || busy) return;
  const format = document.querySelector('input[name=format]:checked').value;
  const name = info.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_') + '_' + format + '.zip';
  clearDownload(); parts = []; stream = null;
  try {
    if (typeof window.showSaveFilePicker === 'function' && window.isSecureContext) {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'ZIP 压缩包', accept: { 'application/zip': ['.zip'] } }] });
      stream = await handle.createWritable();
    } else if (info.rawBytes > MEMORY_LIMIT) {
      status('该影像输出为 ' + sizeLabel(info.rawBytes) + '。请在电脑 Chrome 或 Edge 中打开，以流式保存大文件。', 'error'); return;
    }
    job++; $('progress').value = 0; $('progress-label').textContent = '正在转换 0%';
    setBusy(true, '', true); status('正在转换为 ' + format.toUpperCase());
    worker.postMessage({ type: 'convert', job, format });
  } catch (error) { if (error.name !== 'AbortError') status(error.message, 'error'); }
};
$('cancel-button').onclick = async () => {
  worker.postMessage({ type: 'cancel' }); job++;
  if (stream) { try { await stream.abort(); } catch (_) {} }
  stream = null; parts = []; setBusy(false); status('已取消');
};
worker.onmessage = async ({ data }) => {
  if (data.job !== job) { if (data.type === 'chunk') worker.postMessage({ type: 'ack', id: data.id, error: '已取消' }); return; }
  if (data.type === 'opened') {
    info = data.info;
    $('file-name').textContent = info.name;
    $('dimensions').textContent = info.width + ' × ' + info.height;
    $('band-count').textContent = info.count;
    $('dtype').textContent = info.dtype;
    $('crs').textContent = info.crs;
    $('output-size').textContent = sizeLabel(info.rawBytes);
    $('preview-label').textContent = info.format;
    $('image-info').hidden = false;
    $('loading-text').textContent = '正在生成预览';
  } else if (data.type === 'preview') {
    const canvas = $('preview'); canvas.width = data.width; canvas.height = data.height;
    canvas.getContext('2d').putImageData(new ImageData(data.rgba, data.width, data.height), 0, 0);
    canvas.hidden = false; $('empty-state').hidden = true;
    setBusy(false); status('影像已打开');
  } else if (data.type === 'chunk') {
    try {
      if (stream) await stream.write(data.bytes); else parts.push(data.bytes);
      worker.postMessage({ type: 'ack', id: data.id });
    } catch (error) { worker.postMessage({ type: 'ack', id: data.id, error: error.message }); }
  } else if (data.type === 'progress') {
    $('progress').value = data.value; $('progress-label').textContent = '正在转换 ' + Math.round(data.value * 100) + '%';
  } else if (data.type === 'complete') {
    if (stream) { await stream.close(); stream = null; }
    else {
      resultURL = URL.createObjectURL(new Blob(parts, { type: 'application/zip' }));
      const link = $('download-again'); link.href = resultURL; link.download = data.name; link.hidden = false; link.click();
    }
    parts = []; setBusy(false); status('转换完成 · ' + data.name, 'success');
  } else if (data.type === 'error') {
    if (stream) { try { await stream.abort(); } catch (_) {} stream = null; }
    parts = []; setBusy(false); status(data.message, 'error');
  }
};
worker.onerror = event => { setBusy(false); status('程序加载失败，请刷新页面后重试。', 'error'); console.error(event.message); };
for (const name of ['dragenter', 'dragover']) $('drop-zone').addEventListener(name, event => { event.preventDefault(); if (!busy) $('drop-zone').classList.add('drag'); });
for (const name of ['dragleave', 'drop']) $('drop-zone').addEventListener(name, event => { event.preventDefault(); $('drop-zone').classList.remove('drag'); });
$('drop-zone').addEventListener('drop', event => { if (!busy && event.dataTransfer.files.length) openFiles(Array.from(event.dataTransfer.files)); });
