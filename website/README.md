# AQBot 官网

纯静态站点：由 Python 在构建时渲染全部页面（SSR 到 HTML），GitHub Actions
（`.github/workflows/deploy-website.yml`）将 `website/dist` 发布到 GitHub Pages。

## 本地开发

```bash
cd website
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

.venv/bin/python build.py serve            # 构建并在 http://127.0.0.1:4173 预览
.venv/bin/python build.py build            # 输出到 website/dist
.venv/bin/python build.py check            # 仅校验多语言文案完整性
```

常用参数：

- `--offline`：不请求 GitHub API，使用缓存或 `package.json` 版本号推导的下载文件名
- `--no-fonts`：跳过字体子集化（更快，使用系统字体回退）
- `--draft`：缺失的语言文件临时回退到英文，仅用于本地预览

设置 `GH_TOKEN` 或 `GITHUB_TOKEN` 可避免 GitHub API 限流：
`GH_TOKEN=$(gh auth token) .venv/bin/python build.py build`

## 目录

| 路径 | 内容 |
|------|------|
| `aqsite/` | 构建器：页面、Markdown、字体子集、截图、SEO / GEO 输出 |
| `templates/` | Jinja2 模板（`base.html`、`pages/`、`partials/`） |
| `static/` | CSS、JS、图片与截图原图 |
| `locales/` | 界面文案，`en.json` 与 `zh.json` 为语义源，其余 9 种语言保持相同键集 |
| `content/guides/<locale>/` | 使用指南 Markdown |

功能列表与截图说明直接取自仓库根目录的各语言 `README*.md`，
修改 README 后重新构建即可同步到官网。

## 多语言规则

- 新增文案先同时写入 `en.json` 与 `zh.json`，再补齐其他语言
- 所有语言的叶子键、`{{占位符}}` 必须一致，值不能为空
- 非英文语言不得直接照抄英文（品牌名等语言中立值见 `aqsite/locales.py` 的 `LANGUAGE_NEUTRAL`）
- `build.py build` 与 `build.py check` 会在校验失败时报错退出

## 构建产物

每种语言输出首页、功能、下载、FAQ 与 4 篇指南，另外生成：

- 每个页面的 `.md` 镜像，以及 `llms.txt`、`llms-full.txt`
- `sitemap.xml`（含 hreflang 互链）、`robots.txt`、`manifest.webmanifest`
- 每种语言的 Open Graph 图片 `og/<locale>.png`
- 按页面实际用字裁剪的 woff2 字体子集（来源 google/fonts，缓存在 `.cache/`）
