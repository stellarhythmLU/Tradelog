// ═══════════════════════════════════════════════════════════════
// src/firebase-config.js — Firebase 项目配置
// ═══════════════════════════════════════════════════════════════
//
// 待填入步骤：
//   1. 打开 https://console.firebase.google.com
//   2. 选择你的项目 → 点击左上角齿轮 → 「项目设置」
//   3. 向下滚动到「您的应用」区域
//   4. 若无 Web 应用：点击 </> 图标新建一个（名称随意）
//   5. 复制 firebaseConfig 对象的值，替换下方对应占位符
//   6. 保存文件即可
//
// ═══════════════════════════════════════════════════════════════

import { initializeApp }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ↓↓↓ 将下方占位符替换为你的 Firebase 项目配置 ↓↓↓
const firebaseConfig = {
  apiKey:            "AIzaSyAr8AZqqsHXzuxPUcZPUwui7ay-aJaey4c",
  authDomain:        "tradelog-5ec79.firebaseapp.com",
  projectId:         "tradelog-5ec79",
  storageBucket:     "tradelog-5ec79.firebasestorage.app",
  messagingSenderId: "1042559378150",
  appId:             "1:1042559378150:web:7636ef1c0e1ea2d9db9127"
};
// ↑↑↑ 替换到这里为止 ↑↑↑

const app  = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db   = getFirestore(app);
