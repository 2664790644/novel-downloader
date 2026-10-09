# novel-downloader

> 书源驱动的小说下载工作台 —— 一个用于**学习网络爬虫工程化**的练手项目。

搜索、下载、导出（TXT / EPUB），带 Web 界面、并发限速、断点续传、反爬应对。
引擎与站点解耦：新增一个站点只需写一份 JSON 书源，**不用改一行引擎代码**。

> ⚠️ 免责声明：本项目仅供学习网络请求、并发调度、EPUB 生成等技术用途。
> 请勿用于商业目的或大规模抓取。使用本项目产生的一切后果由使用者自行承担。
> 作者不提供、不附带任何书源，请自行合法获取内容来源。

---

## 特性

| 模块 | 说明 |
| --- | --- |
| **书源引擎** | JSON 描述站点抓取规则，`searchUrl` / `ruleSearch` / `ruleBookInfo` / `ruleToc` / `ruleContent` |
| **Legado 兼容层** | 直接导入「阅读（Legado）」书源包，链式选择器 + JSONPath 子集，自动评级 full / partial / none |
| **并发池** | 可配并发数、按 host 分桶限速、每分钟窗口总量上限、自适应降速（×2 升 / ×0.9 回落） |
| **反爬应对** | 浏览器请求头套件、Cookie 会话罐、429/403/503 熔断降速、代理出口（HTTP / HTTPS CONNECT） |
| **断点续传** | manifest 记录已抓章节，中断后可续，只补新章 |
| **导出** | TXT（流式）+ EPUB 2.0（含算法生成封面），头部附缺失章清单 |
| **本地导入** | 已有 TXT / EPUB 文件直接入库，TXT 自动切章 |
| **手动链接模式** | 无书源时粘贴目录页 URL，启发式解析目录 + 正文 |
| **Web 界面** | 单文件三主题（墨夜 / 宣纸 / 竹青），搜索聚合、书架管理、内置阅读器、追更提醒 |

## 快速开始

```bash
# 需要 Node.js >= 18
npm install

# 启动 Web 界面（默认 http://localhost:8735）
npm start

# 命令行模式
npm run cli -- --help

# 运行测试
npm test
```

首次启动会生成本地模拟站点夹具（`mock-novel-site.js`），用于在**不访问任何真实站点**的情况下
跑通「搜索 → 目录 → 抓章 → 导出」全链路。

## 打包为单文件 exe

```bash
npm run build
# 产物：dist/novel-downloader.exe
```

打包态会在 exe 所在目录读写 `output/`（书架数据）与 `user-book-sources.json`。

## 书源

书源即数据。格式说明见 **[README-书源格式.md](README-书源格式.md)**。

本仓库**不附带任何真实站点书源**。使用方式二选一：

1. 导入自己的 Legado 书源包（Web 界面的「书源管理」→ 导入）
2. 手写 JSON 书源，放进 `user-book-sources.json`

## 项目结构

```
novel-downloader.js   核心引擎（CLI + 库双入口）：书源解析、并发池、反爬、导出
web-ui.js             HTTP 服务：REST API + SSE 进度推送
web-ui.html           单文件前端（含全部样式与逻辑）
legado-adapter.js     Legado 书源兼容层
legado-rules.js       Legado 规则翻译
source-health.js      书源健康度（探测 / 熔断 / 自愈）
local-import.js       本地 TXT / EPUB 导入
mock-novel-site.js    本地模拟站点夹具（注入 GBK / gzip / 500 / 限流干扰）
gbk-decoder.js        GBK 查表解码（pkg 裁剪 ICU 后的兜底）
gbk-table.json        GBK 码表（打包必需）
gen-gbk-table.js      码表构建脚本
test/engine.test.js   引擎测试
```

## 技术要点

- **零运行时依赖**：仅用 Node 原生模块（`http` / `https` / `zlib` / `fs`），唯一 devDependency 是 `@yao-pkg/pkg` 用于打包
- **规则即数据**：书源规则在受控作用域求值（`new Function` 白名单），拿不到引擎内部变量
- **编码探测**：meta charset → HTTP 头 → GBK 查表三级兜底
- **重试分类**：4xx 与 DNS / 连接类确定性错误不重试，仅网络抖动与 5xx 重试；429 可恢复且尊重 `Retry-After`
- **路径安全**：书源名与书名经 `safeFsName` 清洗，防目录穿越

## License

MIT
