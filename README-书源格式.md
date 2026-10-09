# 书源格式文档（v2）

书源是"某个网站怎么抓"的完整描述，全部为数据（JSON），引擎零改动适配新站点。  
参考灵感：Legado（阅读）书源体系。

## 文件结构

`book-source.json` 顶层为 `{ "bookSources": [书源1, 书源2, ...] }`，  
支持导入多个书源，每个书源对应一个站点。

## 书源字段

| 字段                | 必填 | 说明                                                        |
| ----------------- | -- | --------------------------------------------------------- |
| `bookSourceName`  | 是  | 书源显示名（界面上可见）                                              |
| `bookSourceGroup` | 否  | 分组标签                                                      |
| `bookSourceUrl`   | 是  | 站点根 URL，也是书源的唯一标识                                         |
| `enabled`         | 是  | 启用/禁用；禁用的书源不参与搜索                                          |
| `searchUrl`       | 是  | 搜索页地址，`{{key}}` 为搜索词占位符，如 `/search?q={{key}}`             |
| `ruleSearch`      | 是  | 搜索结果解析规则（见下）                                              |
| `ruleBookInfo`    | 否  | 书籍详情页解析：`tocUrl`（目录页地址）、`chapterTotal`（总章数，可选）            |
| `ruleToc`         | 否  | 目录页解析；不填时要求书籍详情页 `tocUrl` 与目录为同一地址                        |
| `ruleContent`     | 是  | 正文抽取规则                                                    |
| `option`          | 否  | 抓取参数：`concurrency` 并发、`minIntervalMs` 限速、`maxRetries` 重试等 |

## 规则语法

规则是 **JS 表达式字符串**，在受控上下文求值（`new Function`，拿不到引擎内部变量）。  
上下文注入：`html`（页面文本）、`m`（bookList/chapterList 迭代到的当前匹配）、`source`（书源对象）。

| 规则字段                                               | 说明                                                |
| -------------------------------------------------- | ------------------------------------------------- |
| `ruleSearch.bookList`                              | 返回可迭代序列（推荐 `[...html.matchAll(/.../g)]`），每项进入 `m` |
| `ruleSearch.bookUrl / bookName / author`           | 从 `m` 中取值：`m[1]`、`m[2]`…                          |
| `ruleToc.chapterList`                              | 同 bookList，匹配目录页所有章节链接                            |
| `ruleToc.chapterUrl / chapterName / chapterNumber` | 章节地址、标题、序号                                        |
| `ruleContent.content`                              | 返回正文原始 HTML 片段（通常先 match 出容器）                     |
| `ruleContent.replaceRegex`                         | 行级过滤：每条为正则或子串，命中的行被丢弃（去广告）                        |

相对地址（如 `/book/1/`）自动以站点根 URL 解析为绝对地址。

## 编码与传输

HTTP 头 charset → HTML meta charset → UTF-8 严格解码失败判 GBK，三级自动探测，  
GBK/UTF-8 站点均无需配置；gzip 自动解压。

## 最小示例

见 `book-source.json` 中"本地模拟站"。  
适配新站点 = 复制一份书源对象，改 `bookSourceUrl`、`searchUrl` 和各 rule 的正则，  
保存后在书源管理面板重新导入即可，引擎与界面零改动。

## 版权提醒

本工具仅供学习 HTTP 抓取与电子书打包技术。请为有权访问的站点编写书源；  
不得用于批量复制受版权保护的作品。
