# TeachForge 官网

静态 HTML + CSS，无构建、无 JS、无后端。规划见 `docs/source/官网规划.md`。

- 站点：https://www.helloyuchen.com.cn
- 安装包：https://preview.helloyuchen.com.cn/TechForge-latest.exe

## 本地预览

```bash
cd apps/website
python -m http.server 4173
# 打开 http://127.0.0.1:4173/
```

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` | 落地页：首屏、五步学习循环、差异、真实场合、本地与隐私、三步上手、下载区、FAQ |
| `privacy.html` | 隐私说明（客户端数据、模型调用边界、网站统计） |
| `changelog.html` | 版本记录 |
| `404.html` | 404 页（nginx `error_page 404`） |
| `styles.css` | 全部样式；`:root` 变量对齐桌面端 skin 的 brand/ink/honey 色阶 |
| `robots.txt` / `sitemap.xml` | 搜索引擎入口 |
| `deploy/nginx.conf.example` | 自托管参考配置 |
| `assets/*.webp` | 官网加载的八张实机截图（含一张细节裁切） |
| `assets/*.png` | 截图原件（2152×1263）、`logo.png`、`og.png`（1200×630） |
| `assets/favicon.ico` | 16/32/48 图标 |

## 部署（阿里云服务器）

两个站点：

```text
/www/wwwroot/techforge/          官网 www.helloyuchen.com.cn
  index.html privacy.html changelog.html 404.html
  styles.css robots.txt sitemap.xml
  assets/            webp 截图、og.png、favicon.ico

/www/wwwroot/techforge-preview/  安装包 preview.helloyuchen.com.cn
  TechForge-latest.exe
```

1. 上传本目录（`deploy/` 除外）到官网站点根目录。
2. 把 `release/TeachForge-0.1.0-setup.exe` 上传到 preview 站点根目录并改名为 `TechForge-latest.exe`。
3. 按 `deploy/nginx.conf.example` 配置官网（缓存与 404）；preview 站点关闭 gzip、保留 Range。
4. `https://preview.helloyuchen.com.cn/TechForge-latest.exe` 应返回 200，`content-length` 为 303139741。

安装包文件名固定，版本号靠页面与 SHA256 区分，所以每次覆盖上传都要同步改页面。安装包不进 Git。

## 发版清单

| 步骤 | 位置 |
|---|---|
| 1. 构建安装包 | `npm run package:win` |
| 2. 上传到 preview 站点，覆盖为 `TechForge-latest.exe` | 服务器 |
| 3. 取新大小与 SHA256 | `sha256sum TeachForge-Setup-x64.exe` |
| 4. 改下载区：版本 / 日期 / 大小 / SHA256 | `index.html` |
| 5. 改 JSON-LD 的 `softwareVersion`、`fileSize` | `index.html` `<head>` |
| 6. 新增版本小节 | `changelog.html` |
| 7. 改 `lastmod` | `sitemap.xml` |

## 校验

当前 0.1.0：303,139,741 字节，
SHA256 `293eca584fb00efede8a83265df86523fea6d351017303eb9c58834867c46c96`。

```bash
# 线上文件应与页面一致
curl -I https://preview.helloyuchen.com.cn/TechForge-latest.exe
curl -L -o TeachForge-Setup-x64.exe https://preview.helloyuchen.com.cn/TechForge-latest.exe
certutil -hashfile TeachForge-Setup-x64.exe SHA256
```
