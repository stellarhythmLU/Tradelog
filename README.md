# TradeLog v2.0 — 云端版部署指南

## 项目结构

```
tradelog-v2/
├── index.html                    # 主入口页面
├── css/
│   └── style.css                 # 全部样式
├── src/
│   ├── firebase-config.js        # Firebase 配置（⚠️ 需填入）
│   ├── auth.js                   # GitHub OAuth 登录
│   ├── db.js                     # Firestore 数据层
│   ├── calc.js                   # 所有财务计算逻辑
│   ├── prices.js                 # 行情获取
│   ├── import.js                 # CSV / Flex XML 导入
│   └── app.js                    # 主应用逻辑 & UI
├── migration/
│   └── migration.js              # 本地数据迁移接口（预留）
├── firestore.rules               # Firestore 安全规则
├── .github/
│   └── workflows/
│       └── deploy.yml            # GitHub Actions 自动部署
└── README.md
```

---

## 第一步：填入 Firebase 配置

打开 `src/firebase-config.js`，将以下占位符替换为你的项目配置：

```
REPLACE_WITH_YOUR_API_KEY
REPLACE_WITH_YOUR_AUTH_DOMAIN
REPLACE_WITH_YOUR_PROJECT_ID
REPLACE_WITH_YOUR_STORAGE_BUCKET
REPLACE_WITH_YOUR_MESSAGING_SENDER_ID
REPLACE_WITH_YOUR_APP_ID
```

**获取方式：**
1. 打开 https://console.firebase.google.com
2. 选择你的项目 → 左上角齿轮 → 项目设置
3. 向下滚动到「您的应用」→ 点击 `</>` 新建 Web 应用
4. 复制 `firebaseConfig` 对象中的值

---

## 第二步：配置 Firebase Authentication（GitHub 登录）

1. Firebase Console → Authentication → Sign-in method → GitHub → 启用

2. 前往 https://github.com/settings/developers
   → OAuth Apps → New OAuth App：
   ```
   Application name:     TradeLog
   Homepage URL:         https://<你的GitHub用户名>.github.io/tradelog
   Authorization callback URL:
     https://<你的Firebase项目ID>.firebaseapp.com/__/auth/handler
   ```

3. 将 GitHub 生成的 **Client ID** 和 **Client Secret** 填入 Firebase Console

---

## 第三步：部署 Firestore 安全规则

**方式 A：Firebase Console（推荐，最简单）**
1. Firebase Console → Firestore Database → 规则
2. 将 `firestore.rules` 文件内容完整粘贴
3. 点击「发布」

**方式 B：CLI**
```bash
npm install -g firebase-tools
firebase login
firebase init firestore
firebase deploy --only firestore:rules
```

---

## 第四步：创建 GitHub 仓库并部署

```bash
# 1. 在 GitHub 创建新仓库（名称建议：tradelog）
# 2. 初始化并推送
cd tradelog-v2
git init
git add .
git commit -m "TradeLog v2.0 初始化"
git branch -M main
git remote add origin https://github.com/<你的用户名>/tradelog.git
git push -u origin main

# 3. 开启 GitHub Pages
# GitHub 仓库 → Settings → Pages
# Source: GitHub Actions（选择此项，deploy.yml 会自动处理）
```

部署完成后访问：`https://<你的用户名>.github.io/tradelog`

---

## 第五步：验证功能

- [ ] 打开网址，出现登录页
- [ ] 点击「使用 GitHub 账号登录」，弹出授权窗口
- [ ] 授权后，页面加载主应用
- [ ] 新增入金记录，刷新页面后数据仍在（已存云端）
- [ ] 在另一台设备打开相同网址，登录后看到相同数据

---

## Firestore 数据结构说明

```
users/
  {uid}/                          # 你的 Firebase 用户 ID
    config/
      main                        # 元数据：设置/价格/板块计划/追踪股票
    trades/
      {id}                        # 每笔交易（独立文档）
    cashFlows/
      {id}                        # 每条资金流水
    snapshots/
      {YYYY-MM-DD}                # 每日快照
    analysis/
      {TICKER__YYYY-MM-DD}        # 个股分析记录
    journal/
      {YYYY-MM-DD}                # 日志条目
```

---

## 缓存说明

以下数据仍存储在浏览器 localStorage（非敏感缓存，不占 Firestore 配额）：
- `tl_hp_v2`：历史行情收盘价（HP 数据库）
- `tl_imgs_v2`：日志图片（Base64）

清除浏览器缓存会丢失这些数据，需重新获取历史行情。

---

## 版本路线图

| 版本 | 状态 | 内容 |
|------|------|------|
| v2.0 | ✅ 当前 | 云端同步 + GitHub Pages + Firebase Auth |
| v2.1 | 计划中 | 网络状态指示器 / 同步状态 UI |
| v2.2 | 计划中 | PWA（添加到主屏幕，iOS 原生体验）|
| v2.3 | 计划中 | 继续 v1.x 功能迭代 |

---

## 迁移工具（预留）

`migration/migration.js` 中预留了本地数据迁移接口。
如需将 v1.x 的本地数据迁移到云端，将文件顶部的
`MIGRATION_ENABLED = false` 改为 `true` 并按注释操作。
