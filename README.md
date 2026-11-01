# 🎬 Lanbo 影视基地

只推荐**豆瓣评分 ≥ 7.3**（且评分人数 ≥ 5000）的近期热播电影与电视剧，每天 **8:00 / 13:00 / 18:00** 自动更新。

## 功能一览
- 🔍 搜索：片名 / 演员 / 导演
- 🏷️ 筛选：全部 / 电影 / 电视剧 / 正在热映
- 📊 排序：按评分 / 年份 / 热度
- 📄 详情页：评分、主创、剧情简介、**无剧透看点**、适合人群、观看渠道
- 📱 手机自适应 · 🌙 深色影院主题

## 本地使用
```powershell
# 1. 启动网站（在 lanbo-movies 目录下）
python -m http.server 8321
# 浏览器打开 http://127.0.0.1:8321

# 2. 手动更新一次数据（需要 Node.js）
node scripts/fetch.mjs

# 3. 注册每天三次自动更新（PowerShell 运行一次即可）
scripts/setup-schedule.ps1
```

## 部署到 GitHub Pages（免费，手机也能访问）
1. 注册 GitHub 账号，新建仓库 `lanbo-movies`
2. 把本目录所有文件推送上去
3. 仓库 Settings → Pages → 选择 main 分支根目录
4. 在 `.github/workflows/update.yml` 配置定时任务（每天 3 次运行 fetch 脚本并提交数据），届时找我可以帮你生成

## 目录结构
```
lanbo-movies/
├── index.html              # 网站本体（单文件前端）
├── data/movies.json        # 影片数据（脚本自动更新）
└── scripts/
    ├── fetch.mjs           # 豆瓣数据抓取 + 7.3 分过滤
    └── setup-schedule.ps1  # Windows 定时任务注册
```

## ⚠️ 说明
豆瓣无官方 API，抓取走非公开接口，可能失效；脚本已做容错——抓取失败时保留上次数据并在页脚标注实际更新时间。
