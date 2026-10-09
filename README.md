# 书阁 · novel-downloader

> 书源驱动的小说下载工作台 —— 一个用于**学习*的练手项目。

搜索、下载、导出（TXT / EPUB），带 Web 界面、并发限流、断点续传、反爬应对。
引擎与站点解耦：新增一个站点只需写一份 JSON 书源，**不用改一行引擎代码**。

---

## ⚠️ 免责声明（请先阅读）

**本项目是纯粹的技术学习项目**，目的是练习以下工程问题：

- HTTP 抓取、编码探测（UTF-8 / GBK 自动识别）、gzip 解压
- 并发池调度、按域名限流、自适应降速
- 断点续传与状态持久化
- EPUB 2.0 打包（含 ZIP 构建与 PNG 封面生成）
- 前后端分离的单文件 Web 界面

**明文声明：**

1. **本仓库不附带任何书源。** 仓库中的书源文件为空模板，所有真实站点规则均由使用者自行编写或导入。
2. **不鼓励、不协助抓取盗版内容。** 请仅为**你有权访问**的站点编写书源，遵守目标站点的 robots.txt 与服务条款。
3. **禁止用于大规模批量复制受版权保护的作品**，或任何违反当地法律法规的用途。
4. 项目自带**本地模拟站点**（`mock-novel-site.js`），提供虚构书籍《雲海之書》《風月記》《書海拾遺》与注入的编码/限流干扰，**无需访问任何真实站点**即可完整跑通全链路。建议学习和演示都基于它进行。
5. 使用本项目产生的一切后果由使用者自行承担。

## 界面预览

> 以下截图来自项目自带的**本地模拟站**，书籍与作者均为虚构内容。

**搜索页** —— 多书源并行检索，结果按「书名+作者」聚合：

![搜索页](docs/screenshots/01-search.png)

**搜索结果** —— 点击书籍卡进入目录预载与下载：

![搜索结果](docs/screenshots/02-search-result.png)

**我的书架** —— 已下载书籍管理，支持阅读、导出、追更、标签：

![我的书架](docs/screenshots/03-library.png)

## 特性

| 模块 | 说明 |
| --- | --- |
| **书源引擎** | JSON 描述站点抓取规则：`searchUrl` / `ruleSearch` / `ruleBookInfo` / `ruleToc` / `ruleContent` |
| **Legado 兼容层** | 可导入「阅读（Legado）」书源包，链式选择器 + JSONPath 子集，自动评级 full / partial / none |
| **并发池** | 可配并发数、按 host 分桶限速、每分钟窗口总量上限、自适应降速（×2 升 / ×0.9 回落） |
| **反爬应对** | 浏览器请求头套件、Cookie 会话罐、429/403/503 熔断降速、代理出口（HTTP / HTTPS CONNECT） |
| **断点续传** | manifest 记录已抓章节，中断后可续，只补新章 |
| **导出** | TXT（流式）+ EPUB 2.0（含算法生成封面），头部附缺失章清单 |
| **本地导入** | 已有 TXT / EPUB 文件直接入库，TXT 自动切章 |
| **手动链接模式** | 无书源时粘贴目录页 URL，启发式解析目录与正文 |
| **Web 界面** | 单文件四主题（墨夜 / 宣纸 / 竹青 / 波奇），搜索聚合、书架管理、内置阅读器、追更提醒 |

## 快速开始

```bash
# 需要 Node.js >= 18
npm install

# 启动 Web 界面（默认 http://localhost:8735，会自动拉起本地模拟站 :8734）
npm start

# 命令行模式
npm run cli -- --help

# 运行测试
npm test
```

启动后打开 `http://localhost:8735`，自带的模拟站会提供三本虚构书籍，可直接体验
「搜索 → 目录 → 抓章 → 导出」全链路，**全程不访问任何真实站点**。

## 打包为单文件 exe

```bash
npm run build
# 产物：dist/novel-downloader.exe
```

打包态会在 exe 所在目录读写 `output/`（书架数据）与 `user-book-sources.json`。

## 书源

书源即数据。格式说明见 **[README-书源格式.md](README-书源格式.md)**。

**本仓库不提供任何真实站点书源。** 使用方式二选一：

1. 导入自己的 Legado 书源包（Web 界面「书源管理」→ 导入）
2. 参照格式文档手写 JSON 书源

仓库内的 `book-source.json` 为空模板，可直接填入自己编写的书源。

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
- **编码探测**：HTTP 头 charset → HTML meta charset → GBK 查表，三级自动兜底
- **重试分类**：4xx 与 DNS / 连接类确定性错误不重试，仅网络抖动与 5xx 重试；429 可恢复且尊重 `Retry-After`
- **限流与熔断**：按 host 分桶限速，连续失败触发熔断停领新章，避免把站点打挂
- **路径安全**：书源名与书名经 `safeFsName` 清洗，防目录穿越

## License

[MIT](LICENSE)
