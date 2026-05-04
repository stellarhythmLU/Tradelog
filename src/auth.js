// ═══════════════════════════════════════════════════════════════
// src/auth.js — GitHub OAuth 登录 / 登出
// ═══════════════════════════════════════════════════════════════
//
// 待配置步骤（在 Firebase Console 完成）：
//   1. Firebase Console → Authentication → Sign-in method
//   2. 启用 GitHub 提供程序
//   3. 前往 https://github.com/settings/developers
//      → OAuth Apps → New OAuth App：
//        Homepage URL: https://<你的用户名>.github.io/tradelog
//        Callback URL: https://<你的projectId>.firebaseapp.com/__/auth/handler
//   4. 将 GitHub 生成的 Client ID / Secret 填入 Firebase Console
//
// ═══════════════════════════════════════════════════════════════

import {
  GithubAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

import { auth } from './firebase-config.js';

const provider = new GithubAuthProvider();

/**
 * 弹出 GitHub OAuth 授权窗口，完成登录
 * @returns {Promise<UserCredential>}
 */
export async function signInWithGitHub() {
  try {
    const result = await signInWithPopup(auth, provider);
    return result.user;
  } catch (err) {
    // 用户关闭弹窗时 err.code = 'auth/popup-closed-by-user'，正常忽略
    if (err.code !== 'auth/popup-closed-by-user') {
      console.error('GitHub 登录失败:', err);
      throw err;
    }
    return null;
  }
}

/**
 * 登出当前用户
 */
export async function signOutUser() {
  await signOut(auth);
}

/**
 * 监听认证状态变化
 * @param {(user: User|null) => void} callback
 * @returns {() => void} unsubscribe 函数
 */
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

/**
 * 获取当前已登录用户（同步，可能为 null）
 */
export function getCurrentUser() {
  return auth.currentUser;
}
