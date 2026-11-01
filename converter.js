/* 作业二核心算法：统一按波段读取，再写为 BSQ、BIL、BIP。 */
(function (root) {
  'use strict';
  const TYPES = {
    1: { name: 'uint8', bytes: 1, ctor: Uint8Array, get: 'getUint8' },
    2: { name: 'int16', bytes: 2, ctor: Int16Array, get: 'getInt16' },
    3: { name: 'int32', bytes: 4, ctor: Int32Array, get: 'getInt32' },
    4: { name: 'float32', bytes: 4, ctor: Float32Array, get: 'getFloat32' },
    5: { name: 'float64', bytes: 8, ctor: Float64Array, get: 'getFloat64' },
    12: { name: 'uint16', bytes: 2, ctor: Uint16Array, get: 'getUint16' },
    13: { name: 'uint32', bytes: 4, ctor: Uint32Array, get: 'getUint32' },
  };
  const HOST_LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  const cleanName = name => name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_');
  function checkAbort(signal) {
    if (signal && signal.aborted) throw new Error('已取消');
  }
  function parseHeader(text) {
    text = text.replace(/^\uFEFF/, '');
    if (!/^\s*ENVI\b/i.test(text)) throw new Error('头文件应以 ENVI 开头。');
    const result = {};
    const pattern = /^\s*([^\r\n=]+?)\s*=\s*(\{[^}]*\}|[^\r\n]*)/gm;
    for (const match of text.matchAll(pattern)) result[match[1].trim().toLowerCase()] = match[2].trim();
    return result;
  }
  function validateSize(width, height, count, type, offset = 0) {
    if (![width, height, count].every(x => Number.isSafeInteger(x) && x > 0)) throw new Error('影像的行、列和波段数必须为正整数。');
    if (!type) throw new Error('支持 uint8、int16、uint16、int32、uint32、float32、float64。');
    const bytes = width * height * count * type.bytes;
    if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(offset) || offset < 0) throw new Error('影像大小或头偏移无效。');
    return bytes;
  }
  async function readValues(file, start, length, type, little) {
    const buffer = await file.slice(start, start + length * type.bytes).arrayBuffer();
    if (buffer.byteLength !== length * type.bytes) throw new Error('影像数据长度不足。');
    if (little === HOST_LITTLE || type.bytes === 1) return new type.ctor(buffer);
    const data = new type.ctor(length), view = new DataView(buffer);
    for (let i = 0; i < length; i++) data[i] = view[type.get](i * type.bytes, little);
    return data;
  }
  function enviSource(file, header) {
    const width = Number(header.samples), height = Number(header.lines), count = Number(header.bands);
    const typeId = Number(header['data type']), type = TYPES[typeId];
    const offset = Number(header['header offset'] || 0), order = Number(header['byte order'] || 0);
    const format = String(header.interleave || '').replace(/[{}]/g, '').toLowerCase();
    const rawBytes = validateSize(width, height, count, type, offset);
    if (!['bsq', 'bil', 'bip'].includes(format)) throw new Error('头文件中的 interleave 应为 bsq、bil 或 bip。');
    if (![0, 1].includes(order)) throw new Error('byte order 应为 0 或 1。');
    if (file.size < offset + rawBytes) throw new Error('数据文件与头文件的尺寸不一致。');
    const nodataText = header['data ignore value'];
    const nodata = nodataText === undefined ? null : Number(nodataText);
    const source = { name: file.name, width, height, count, typeId, type, rawBytes, header, nodata, format: format.toUpperCase() };
    source.crs = header['map info'] ? header['map info'].replace(/[{}]/g, '').split(',')[0] : '未指定';
    source.readRows = async (row, rows, bands) => {
      if (format === 'bsq') {
        return Promise.all(bands.map(band => readValues(file, offset + ((band * height + row) * width) * type.bytes, rows * width, type, order === 0)));
      }
      const data = await readValues(file, offset + row * width * count * type.bytes, rows * width * count, type, order === 0);
      return bands.map(band => {
        const result = new type.ctor(rows * width);
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < width; x++) {
            const index = format === 'bil' ? (y * count + band) * width + x : (y * width + x) * count + band;
            result[y * width + x] = data[index];
          }
        }
        return result;
      });
    };
    return source;
  }
  function utmWKT(zone, north) {
    const epsg = (north ? 32600 : 32700) + zone;
    return 'PROJCS["WGS 84 / UTM zone ' + zone + (north ? 'N' : 'S') + '",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",' + (zone * 6 - 183) + '],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",' + (north ? 0 : 10000000) + '],UNIT["metre",1],AUTHORITY["EPSG","' + epsg + '"]]';
  }
  function geoHeader(image) {
    const fd = image.getFileDirectory ? image.getFileDirectory() : image.fileDirectory;
    const keys = (image.getGeoKeys ? image.getGeoKeys() : image.geoKeys) || {};
    const scale = fd.ModelPixelScale, tie = fd.ModelTiepoint, matrix = fd.ModelTransformation;
    let x, y, sx, sy;
    if (matrix) {
      if (Math.abs(matrix[1]) > 1e-12 || Math.abs(matrix[4]) > 1e-12 || matrix[0] <= 0 || matrix[5] >= 0) throw new Error('当前网页支持北向上的规则 GeoTIFF 栅格。');
      [x, y, sx, sy] = [matrix[3], matrix[7], matrix[0], -matrix[5]];
    } else if (scale && tie) {
      sx = scale[0]; sy = scale[1]; x = tie[3] - tie[0] * sx; y = tie[4] + tie[1] * sy;
    } else return { header: {}, crs: '未指定' };
    if (!(sx > 0 && sy > 0)) throw new Error('GeoTIFF 像元尺寸无效。');
    if (keys.GTRasterTypeGeoKey === 2) { x -= sx / 2; y += sy / 2; }
    const projected = Number(keys.ProjectedCSTypeGeoKey || 0), geographic = Number(keys.GeographicTypeGeoKey || 0);
    const header = {};
    if ((projected >= 32601 && projected <= 32660) || (projected >= 32701 && projected <= 32760)) {
      const zone = projected % 100, north = projected < 32700;
      header['map info'] = '{UTM, 1, 1, ' + [x, y, sx, sy, zone, north ? 'North' : 'South', 'WGS-84', 'units=Meters'].join(', ') + '}';
      header['coordinate system string'] = '{' + utmWKT(zone, north) + '}';
      return { header, crs: 'EPSG:' + projected };
    }
    if (!projected && geographic === 4326) {
      header['map info'] = '{Geographic Lat/Lon, 1, 1, ' + [x, y, sx, sy, 'WGS-84', 'units=Degrees'].join(', ') + '}';
      header['coordinate system string'] = '{GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]}';
      return { header, crs: 'EPSG:4326' };
    }
    throw new Error('此 GeoTIFF 的坐标系暂未支持，请使用 WGS84 经纬度或 WGS84 UTM 影像。');
  }
  async function tiffSource(file) {
    const tiff = await root.GeoTIFF.fromBlob(file, { cache: false });
    const image = await tiff.getImage(), width = image.getWidth(), height = image.getHeight(), count = image.getSamplesPerPixel();
    const fd = image.getFileDirectory ? image.getFileDirectory() : image.fileDirectory;
    const toArray = (value, fallback) => value == null ? [fallback] : typeof value === 'number' ? [value] : Array.from(value);
    const bits = toArray(fd.BitsPerSample, 8), formats = toArray(fd.SampleFormat, 1);
    if (new Set(bits).size > 1 || new Set(formats).size > 1) throw new Error('各波段应使用相同的数据类型。');
    const bit = bits[0], sample = formats[0];
    const typeId = ({ '1/8': 1, '1/16': 12, '1/32': 13, '2/16': 2, '2/32': 3, '3/32': 4, '3/64': 5 })[sample + '/' + bit];
    const type = TYPES[typeId], rawBytes = validateSize(width, height, count, type);
    const geo = geoHeader(image), nodata = image.getGDALNoData();
    const source = { name: file.name, width, height, count, typeId, type, rawBytes, header: geo.header, crs: geo.crs, nodata, format: 'GeoTIFF' };
    source.readRows = (row, rows, bands) => image.readRasters({ window: [0, row, width, row + rows], samples: bands, interleave: false });
    source.close = () => tiff.close();
    return source;
  }
  async function openFiles(files) {
    const tiffs = files.filter(x => /\.tiff?$/i.test(x.name));
    if (tiffs.length === 1 && files.length === 1) return tiffSource(tiffs[0]);
    const headers = files.filter(x => /\.hdr$/i.test(x.name));
    const data = files.filter(x => !/\.hdr$/i.test(x.name));
    if (headers.length !== 1 || data.length !== 1) throw new Error('请选择一个 GeoTIFF，或同时选择 ENVI 数据文件和 .hdr 文件。');
    return enviSource(data[0], parseHeader(await headers[0].text()));
  }
  function makeHeader(source, format) {
    const base = { samples: source.width, lines: source.height, bands: source.count, 'header offset': 0, 'file type': 'ENVI Standard', 'data type': source.typeId, interleave: format, 'byte order': 0 };
    const extra = { ...source.header };
    for (const key of [...Object.keys(base), 'data file', 'file name']) delete extra[key];
    if (source.nodata !== null && source.nodata !== undefined) extra['data ignore value'] = String(source.nodata);
    const entries = Object.entries({ ...base, ...extra });
    return 'ENVI\n' + entries.map(([key, value]) => key + ' = ' + value).join('\n') + '\n';
  }
  // 三个排列函数分别对应 Python 版的 write_bsq、write_bil、write_bip。
  function writeBSQ(block, width, rows, type) {
    const result = new type.ctor(width * rows * block.length);
    block.forEach((band, i) => result.set(band, i * width * rows));
    return new Uint8Array(result.buffer);
  }
  function writeBIL(block, width, rows, type) {
    const result = new type.ctor(width * rows * block.length);
    let k = 0;
    for (let row = 0; row < rows; row++) {
      for (let band = 0; band < block.length; band++) {
        result.set(block[band].subarray(row * width, (row + 1) * width), k);
        k += width;
      }
    }
    return new Uint8Array(result.buffer);
  }
  function writeBIP(block, width, rows, type) {
    const result = new type.ctor(width * rows * block.length);
    let k = 0;
    for (let pixel = 0; pixel < width * rows; pixel++) {
      for (let band = 0; band < block.length; band++) result[k++] = block[band][pixel];
    }
    return new Uint8Array(result.buffer);
  }
  async function convert(source, format, onChunk, onProgress, signal) {
    if (!['bsq', 'bil', 'bip'].includes(format)) throw new Error('请选择目标格式。');
    if (!HOST_LITTLE) throw new Error('当前设备的字节序暂未支持。');
    const rowsPerBlock = Math.max(1, Math.min(128, Math.floor(4 * 1024 * 1024 / (source.width * source.count * source.type.bytes))));
    const allBands = Array.from({ length: source.count }, (_, i) => i);
    let written = 0;
    const groups = format === 'bsq' ? allBands.map(x => [x]) : [allBands];
    const order = { bsq: writeBSQ, bil: writeBIL, bip: writeBIP }[format];
    for (const bands of groups) {
      for (let row = 0; row < source.height; row += rowsPerBlock) {
        checkAbort(signal);
        const rows = Math.min(rowsPerBlock, source.height - row);
        const block = await source.readRows(row, rows, bands);
        checkAbort(signal);
        const bytes = order(block, source.width, rows, source.type);
        const length = bytes.byteLength;
        await onChunk(bytes);
        written += length;
        if (onProgress) onProgress(written / source.rawBytes);
      }
    }
    return written;
  }
  async function preview(source, bands, signal) {
    if (bands.length !== 3 || bands.some(x => !Number.isInteger(x) || x < 0 || x >= source.count)) throw new Error('请输入三个有效的波段编号。');
    const size = Math.min(384 / Math.max(source.width, source.height), 1);
    const width = Math.max(1, Math.round(source.width * size)), height = Math.max(1, Math.round(source.height * size));
    const unique = [...new Set(bands)], values = unique.map(() => new Float64Array(width * height));
    // 按行抽样，避免为了缩略图一次读入整幅影像。
    for (let y = 0; y < height; y++) {
      checkAbort(signal);
      const row = Math.min(source.height - 1, Math.floor(y * source.height / height));
      const data = await source.readRows(row, 1, unique);
      for (let b = 0; b < unique.length; b++) {
        for (let x = 0; x < width; x++) values[b][y * width + x] = data[b][Math.min(source.width - 1, Math.floor(x * source.width / width))];
      }
    }
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let c = 0; c < 3; c++) {
      const channel = values[unique.indexOf(bands[c])];
      const valid = Array.from(channel).filter(v => Number.isFinite(v) && (source.nodata === null || v !== source.nodata));
      valid.sort((a, b) => a - b);
      const low = valid.length ? valid[Math.floor((valid.length - 1) * 0.02)] : 0;
      const high = valid.length ? valid[Math.floor((valid.length - 1) * 0.98)] : 1;
      for (let i = 0; i < channel.length; i++) {
        const v = channel[i];
        rgba[i * 4 + c] = !Number.isFinite(v) || v === source.nodata ? 0 : high > low ? Math.max(0, Math.min(255, Math.round((v - low) * 255 / (high - low)))) : 127;
        rgba[i * 4 + 3] = 255;
      }
    }
    return { width, height, rgba };
  }
  function info(source) {
    return { name: source.name, width: source.width, height: source.height, count: source.count, dtype: source.type.name, rawBytes: source.rawBytes, format: source.format, crs: source.crs, nodata: source.nodata };
  }
  const api = { TYPES, cleanName, parseHeader, enviSource, tiffSource, openFiles, makeHeader, writeBSQ, writeBIL, writeBIP, convert, preview, info };
  root.RS = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
