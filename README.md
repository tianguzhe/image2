# 墨境工坊

图片生成、编辑与会话微调页面。默认模型为 `gpt-image-2.5-sunburst`，支持流式图片预览。

## 打开页面

双击 `image_generator_optimized.html`，填写自己的 Base URL 和 API Key。

页面使用本地 CSS 和按顺序加载的普通 JavaScript 脚本，无需安装依赖或运行构建命令。复制、移动或分享页面时，请同时携带整个 `assets/` 目录，保持它与 HTML 的相对位置。

字体使用设备已有的宋体、楷体和衬线字体，不请求 Google Fonts。字体回退顺序统一配置在 `assets/css/base.css` 的 `--font-body`、`--font-heading`、`--font-seal` 中。

图片历史、会话和设置继续使用原有 IndexedDB / localStorage；本地图片文件夹仍通过页面中的“设置文件夹”授权。拆分没有修改数据库名称、版本或数据格式。

## 修改位置

| 需要修改的内容 | 文件 |
| --- | --- |
| 页面结构、按钮、表单选项 | `image_generator_optimized.html` |
| 模型名称、超时、存储键、允许的格式 | `assets/js/config.js` |
| 共享运行状态、请求控制器、图片缓存 | `assets/js/state.js` |
| 转义、图片格式、Base64 / Blob / File 转换 | `assets/js/utils.js` |
| 数据库连接、图片历史、会话持久化 | `assets/js/storage.js` |
| 文件夹权限、图片写入、迁移、空间统计 | `assets/js/filesystem.js` |
| 设置保存与恢复、表单联动、状态提示 | `assets/js/settings.js` |
| 请求头、生成和编辑接口、SSE、超时与取消 | `assets/js/api.js` |
| 画廊、筛选、排序、灯箱、图片操作 | `assets/js/gallery.js` |
| 上传预览、生成和编辑流程、快捷键 | `assets/js/editor.js` |
| 备份导入、导出和校验 | `assets/js/backup.js` |
| 会话创建、删除、连续微调、请求结果保存 | `assets/js/chat.js` |
| 会话渲染、流式预览、历史菜单、界面事件 | `assets/js/chat-ui.js` |
| 应用初始化、启动失败提示和退出清理 | `assets/js/app.js` |

模型只需修改 `config.js` 中的 `IMAGE_MODEL`。生成、编辑、会话微调和页面上的模型名称都从这里读取。

## 样式

| 文件 | 内容 |
| --- | --- |
| `assets/css/base.css` | 色彩变量、字体、基础布局、左侧面板 |
| `assets/css/gallery.css` | 画廊、图片卡片、筛选和排序 |
| `assets/css/controls.css` | 表单、选项卡、按钮、状态和加载动画 |
| `assets/css/overlays.css` | 灯箱、响应式布局、上传、设置面板、流式预览 |
| `assets/css/chat.css` | 视图切换、会话布局、历史菜单和消息 |

HTML 中的 CSS 加载顺序保留了原有规则的覆盖顺序，调整时请注意响应式样式与基础样式的关系。

## 加载与依赖约定

- HTML 中的脚本均使用 `defer`，按声明顺序运行。`config.js`、`state.js` 最先加载，`app.js` 最后启动应用。
- 功能文件定义函数；事件绑定集中在各自的 `initSettings()`、`initGallery()`、`initEditor()`、`initChat()` 中，由 `app.js` 调用。
- 表单事件先绑定，再恢复保存的设置，使尺寸、压缩率等关联控件同步更新。
- 为兼容直接打开本地 HTML 和已有按钮事件，函数与状态使用普通脚本的共享作用域。新增共享状态放在 `state.js`，避免在多个文件重复声明同名变量。
- 功能之间通过函数调用协作：界面调用业务流程，业务流程调用 API / 存储，异步启动集中在 `app.js`。不要在功能文件加载时直接发请求、迁移数据或启动渲染。
- 现有入口文件名保持不变。无需为了这次拆分迁移图片或清空浏览器数据。

## 回归检查

需要支持 `node:test`、`File` 和 `FormData` 的 Node.js 20 或更新版本：

```sh
node --test tests/regression.cjs
```

`tests/regression.cjs` 是统一入口。用例按 `structure`、`storage`、`api`、`editor`、`chat` 分布在 `tests/cases/`，共享环境位于 `tests/support/harness.cjs`。

测试会按 HTML 中的真实加载顺序执行各个依赖文件，检查启动和事件绑定，以及图片缓存、存储、请求参数、流式解析、取消、会话删除和异步状态。网络、DOM 和存储由测试环境模拟，不使用真实 API Key，也不产生图片生成费用。浏览器布局和服务商实际响应仍需在页面中验证。
