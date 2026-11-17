# Lumo · 文件上下文增强版

在 Lumo 1.0.0（Electron 桌面 AI 客户端）基础上加了两件事：

1. **文件上下文** —— 把本地文件喂给模型，让它基于文件内容回答问题；
2. **可自定义数据目录** —— 聊天记录和配置可以放到任意磁盘（比如 D:\Lumo），还能随时切回来。

> 本仓库只放源码，不含 Electron 运行时和打包产物。原版 exe 与打包产物请在 Release / 本地构建获取。

---

## 一、相比原版新增了什么

### 1. 添加文件作为上下文

| 入口 | 说明 |
|---|---|
| 回形针按钮 | 输入框左下角「添加文件」，支持多选 |
| 拖拽 | 把文件拖进窗口任意位置，出现蓝色虚线遮罩，松手即添加 |
| 粘贴 | 复制文件后在输入框 Ctrl+V |

- 附件以标签展示（类型徽标 + 文件名 + 大小 + 字符数），可单个移除，末尾显示总字符数
- 只发文件不打字也能发送
- 发送时把文件正文拼成 `【文件 N：xxx】+ 正文` 的上下文块；**界面只显示提问和文件标签**，历史消息不会反复堆正文（`apiContent` 与 `content` 分开存储）
- 解析失败的文件会显示红色警告标签并在 tooltip 给出原因

### 2. 支持的文件格式

| 类型 | 支持情况 |
|---|---|
| PDF | 尽力解析（文字版可读；扫描件/纯图片会提示无法提取） |
| Word `.docx` | 完整支持，含表格单元格与实体还原 |
| Excel `.xlsx` | 支持，共享字符串 + 多工作表，每表最多 3000 行 |
| PPT `.pptx` | 支持，按页提取文本 |
| 文本/代码 | txt、md、csv、tsv、json、xml、yml、log、ini 及常见源码后缀 |
| 编码 | 自动识别 UTF-8 / UTF-16 / GBK / BIG5 |

限制：单文件最多 20 万字符（超出截断并提示）；旧版 `.doc/.xls/.ppt` 不支持；图片不做 OCR。

### 3. 自定义数据目录

设置 → 数据：

- **更改目录**：选任意文件夹，数据存到 `<所选文件夹>\LumoData`
- **打开目录**：在资源管理器里打开当前目录
- **恢复默认**：回到 exe 同级 `LumoData`

切换**立即生效、不需要重启**，现有 `lumo-data.json` 会自动复制过去，界面数据同步刷新。
自定义目录记录在 exe 同级的 `lumo-data-dir.txt`（不放 userData，避免先有鸡还是先有蛋）；该目录不可用时自动回退默认目录，不影响启动。

---

## 二、目录结构

```
package.json
src/
  main/
    main.js       主进程：窗口、存储、IPC（聊天流 / 文件解析 / 数据目录）
    preload.js    contextBridge 暴露的 API
    providers.js  各家模型服务的流式适配（OpenAI / Claude / Gemini / Ollama）
    files.js      文件解析：自写 ZIP 读取 + docx/xlsx/pptx/pdf/文本
  renderer/
    index.html
    app.js
    styles.css
    vendor/       marked / DOMPurify / highlight.js（不入库，由 npm run vendor 生成）
```

## 三、开发运行

```bash
npm install          # 装 electron + 三个前端库，并自动执行 prepare 钩子把 vendor 拷好
npm start            # 等价于 electron .
```

`src/renderer/vendor/` 里的 marked / DOMPurify / highlight.js 不入库（属于第三方产物），
由 `scripts/prepare-vendor.mjs` 从 node_modules 拷过去；`npm install` 后自动执行，
也可以单独 `npm run vendor`。便携版成品里这些文件是预先放好的，无需此步。

## 四、打包成便携目录版

1. 取一份原版便携版解包后的目录（含 `Lumo.exe`、`*.dll`、`resources`）；
2. 删除 `resources/app.asar`，把本仓库内容放到 `resources/app/`；
3. 双击 `Lumo.exe` 即可。

> Electron 会优先加载 `resources/app.asar`，没有才加载 `resources/app` 目录。
> 用目录方式的好处：源码明文、改完重启即生效，且绕开 asar 完整性校验。

注意：当前 shell 若存在 `ELECTRON_RUN_AS_NODE=1`（某些 AI 工具链会注入），启动会被当成 node 执行，需要清掉该环境变量。

## 五、隐私说明

所有请求由主进程直接发往你在设置里配置的模型服务；文件正文会随消息发送。
用本地 Ollama 则完全不出内网；用云端 API 等于把文件内容交给了该服务商，涉密文件请自行判断。
密钥与聊天记录只存在本地 `lumo-data.json`。

## 六、已知问题

- PDF 解析是尽力而为，遇到 CID 字体或扫描件拿不到文字
- `.xlsx` 不保留公式与样式，只取计算结果文本；空行会跳过
- 大于 80MB 的文件不允许导入

## License

原应用 `package.json` 声明为 MIT；仓库内 `src/renderer/vendor/` 下的第三方库版权归各自作者所有。
