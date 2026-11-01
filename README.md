# 遥感格式转换

学号：2024012606

在网页中打开 Landsat 影像，预览波段，并完成 BSQ、BIL、BIP 之间的转换。程序使用 HTML、CSS、JavaScript，所有依赖均包含在本目录内，可直接部署到 GitHub Pages。

## 使用

1. 选择一个 GeoTIFF，或同时选择 ENVI 数据文件与配套 .hdr 文件。
2. 查看预览；可在“预览波段”中输入三个波段编号。
3. 选择 BSQ、BIL 或 BIP，点击“转换并下载”。
4. 解压下载的 ZIP，即可得到数据文件和 .hdr 头文件。

页面中的 Landsat 样例为 512 × 512、6 波段的真实影像裁剪。

## 发布到 GitHub Pages

1. 登录 GitHub，新建仓库，名称建议为 rs-converter，选择 Public，并开启 Add README。
2. 解压发布包，在仓库中选择 Add file → Upload files。
3. 将本目录内的所有文件和子文件夹拖入上传区，点击 Commit changes。
4. 打开仓库 Settings → Pages。
5. 在 Build and deployment 中，Source 选择 Deploy from a branch。
6. Branch 选择 main，文件夹选择 / (root)，点击 Save。
7. 等待部署完成，在 Pages 页面点击 Visit site，即可获得访问网址。

上传后的仓库首页应直接显示 index.html、app.js、converter.js、worker.js、styles.css、vendor 和 sample。index.html 应位于仓库根目录。

项目网站的网址形式为 https://你的GitHub用户名.github.io/rs-converter/ 。以 Pages 页面显示的实际网址为准。

发布后打开网站，点击 Landsat 样例，分别导出 BSQ、BIL、BIP；再用导出的数据和头文件测试互转。

官方说明：https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site

## 文件结构

    index.html       页面入口
    styles.css       页面样式
    app.js           文件选择、预览交互和下载
    converter.js     影像读取与三种存储排列
    worker.js        在工作线程中执行转换并生成 ZIP
    icon.svg         图标
    vendor/          GeoTIFF.js、fflate 及许可证
    sample/          Landsat 样例及裁剪信息
    .nojekyll        GitHub Pages 静态文件配置

## 核心方法

程序分块读取影像，每次取得各波段的一组行数据，再按目标顺序写出：

- BSQ：波段 → 行 → 列。逐个波段写完全部行，再处理下一个波段。
- BIL：行 → 波段 → 列。逐行写出该行的各波段。
- BIP：行 → 列 → 波段。逐个像元写出各波段值。

对应函数为 converter.js 中的 writeBSQ、writeBIL、writeBIP，分块循环位于 convert。转换保持原数据类型，预览拉伸只影响显示。

## 输入和下载

- 数据类型：uint8、int16、uint16、int32、uint32、float32、float64。
- ENVI 输入：支持 BSQ、BIL、BIP，以及大、小端字节序和头偏移。
- GeoTIFF 输入：支持北向上、采用 WGS84 UTM 或 WGS84 经纬度坐标的栅格。
- 输出：小端 ENVI 数据及配套头文件，保留 NoData 和坐标信息。
- 电脑 Chrome、Edge 可将转换结果分块保存到磁盘；其他浏览器使用普通下载，输出上限为 256 MB。
- ZIP 使用标准 ZIP32，影像数据大小须小于约 4 GB。

用户选择的影像由浏览器读取和转换。

## 校验

已在 Edge 浏览器中完成真实 Landsat 样例的 9 组转换：GeoTIFF → BSQ/BIL/BIP，以及三种 ENVI 格式的 6 个互转方向。使用 Rasterio/GDAL 独立读取结果，每组 1,572,864 个波段值均一致，坐标系、仿射变换和 NoData 一致。

核心算法另通过 126 组检查，覆盖 7 种数据类型、两种输入字节序、非零头偏移和跨分块排列。

## 第三方库

- GeoTIFF.js 2.1.3：https://github.com/geotiffjs/geotiff.js
- fflate 0.8.2：https://github.com/101arrowz/fflate

许可证见 vendor/LICENSES.txt。
