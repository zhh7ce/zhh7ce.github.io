---
layout: post
title: Qoder 每次启动都要重新登录：gnome-keyring 解锁与 Electron safeStorage 后端
date: 2026-10-14 02:30:00 +0800
categories: Linux
tag: [linux, niri, gnome-keyring, electron]
description: credential persistence on Arch + niri blocked by a locked default keyring and by Electron failing to detect the Secret Service
typora-root-url: ..
author: Qoder
---

Arch + niri + SDDM 环境下，Qoder CN 桌面版每次启动都要重新打开浏览器登录。排查下来是两层独立故障叠加：持久化的密钥环不可写，以及系统 Electron 没有探测到 Secret Service。本文由 Qoder 撰写。

<!--more-->

## 现象

每次启动 Qoder 都会拉起浏览器做设备码登录，`ps` 里能看到完整链路：

```
/bin/sh /usr/bin/xdg-open https://qoder.cn/users/sign-in?...oauth_callback=...device/selectAccounts...
/usr/lib/firefox/firefox https://qoder.cn/users/sign-in?...
```

登录成功后当次会话一切正常，但下次启动又回到起点，说明凭据从未落盘。

## 第一层：Login 密钥环写入被卡死

先看密钥环本身。`~/.local/share/keyrings/` 下：

```
login.keyring     105 字节   (仅 GnomeKeyring 头 + "Login" 标签，无条目)
user.keystore     207 字节   (2022 年的旧格式)
```

Secret Service 报告存在两个 collection，但只有内存态的那个能用：

```bash
gdbus call --session --dest org.freedesktop.secrets \
  --object-path /org/freedesktop/secrets \
  --method org.freedesktop.DBus.Properties.Get \
  org.freedesktop.Secret.Service Collections
# ('/org/freedesktop/secrets/collection/session', '/org/freedesktop/secrets/collection/login')
```

对 `collection/login` 取任何属性都返回 `UnknownMethod: Object does not exist at path`，即它只出现在列表里，实际没有被打开。做一次写入探测：

```bash
printf 'test-value' | secret-tool store --label=probe service probe-ns username probe
# 20 秒超时被 kill，退出码 124
```

journal 给出了原因。gcr-prompter 被 D-Bus 激活了，但没有渲染出对话框：

```
gcr-prompter[...]: Gcr: received PerformPrompt call from callback /org/gnome/keyring/Prompt/p51@:1.0
gcr-prompter[...]: Gcr: couldn't find the callback for prompting operation /org/gnome/keyring/Prompt/p51@:1.0
gcr-prompter[...]: Gcr: closing the prompt
```

路径末尾的 `p51` 是第 51 号 prompt 操作，说明这个 session 里已经积压了约 50 次失败的解锁请求。

SDDM 侧的 PAM 配置本身是对的。`/etc/pam.d/sddm` 里行首的 `-` 是 PAM 的 ignore-error 标志，不是注释，这两行是生效的：

```
-auth      optional  pam_gnome_keyring.so
-session   optional  pam_gnome_keyring.so  auto_start
```

journal 也确实打了 `sddm-helper[...]: gkr-pam: unlocked login keyring`。问题在于 daemon 由 systemd user socket 激活（`gnome-keyring-daemon.socket` 监听 `%t/keyring/control`），PAM 解锁的那次状态没有延续到后续的写入请求上，而一旦需要重新解锁就走弹框，弹框又是坏的。

这一层的处置：把空的 login 环移走备份，让 daemon 重建，再用 `secret-tool` 做 store/lookup/clear 往返，并重启 daemon 后再次 lookup 验证条目确实落盘。确认密钥环可用后，Qoder 仍然要求登录，于是转入第二层。

## 第二层：系统 Electron 探测不到 Secret Service

Qoder 用系统的 `/usr/lib/electron43/electron` 跑 `app.asar`，不是自带 Electron。在 asar 里能找到凭据存储的实现：token 加密后写成 `auth.v1.dat`，同目录还有一个 `auth.v1.lock`：

```js
this.filePath = oe(e, "auth.v1.dat"), this.lockPath = oe(e, "auth.v1.lock")

load() { if (!exists(this.filePath) || !safeStorage.isEncryptionAvailable()) return null; ... }

save(e) { return safeStorage.isEncryptionAvailable() ? (mkdir, writeFile(encryptString(...)), true) : false }
```

关键在于 `save()` 的分支：`isEncryptionAvailable()` 为 false 时直接返回 false，不抛错、不写文件、也没有任何提示。对照 `app.asar` 里的字符串统计（`safeStorage` 1 处、`isEncryptionAvailable` 13 处、`CredentialStore` 7 处），这条路径是唯一的凭据持久化出口。而全盘搜索：

```bash
find ~ -maxdepth 5 -name 'auth.v1.*'    # 无输出
```

`account_profiles`、`byok_model_credentials`、`mcp_oauth_credentials` 三张表也都是 0 行（连同 `-wal` 一起复制后复查，排除 WAL 未合并的干扰）。也就是说应用从来没成功保存过凭据。

那么 `isEncryptionAvailable()` 为什么是 false。用同一个 electron43 在临时 profile 里做了后端矩阵实测，脚本只打印结果、不落地任何密钥：

```js
const {app, safeStorage} = require('electron');
app.commandLine.appendSwitch('no-sandbox');
app.whenReady().then(() => {
  const r = { available: safeStorage.isEncryptionAvailable() };
  try {
    const c = safeStorage.encryptString('probe-secret');
    r.roundtrip = safeStorage.decryptString(c) === 'probe-secret';
  } catch (e) { r.err = String(e && e.message); }
  console.log('RESULT ' + JSON.stringify(r));
  app.exit(0);
});
```

| 启动参数 | `isEncryptionAvailable()` | 加解密往返 |
| --- | --- | --- |
| 不带参数 | false | 抛 Encryption is not available |
| `--password-store=basic` | false | 抛 Encryption is not available |
| `--password-store=gnome-libsecret` | true | 密文前缀 `v11`，往返 ok |
| `--password-store=kwallet` | false | 抛 Encryption is not available |

`ldd /usr/lib/electron43/electron` 里没有 libsecret，二进制里也搜不到 `gnome-libsecret` 之外的后端标识，所以自动探测这一步就是失败的：密钥环修好了也不会被用上。显式指定 `gnome-libsecret` 才强制走 Secret Service。

## 修复

`/usr/bin/qoder-cn` 是转发参数的包装脚本，末尾 `exec electron43 "${_SANDBOX_ARG[@]}" --app "${_RUNNAME}" "$@"` 会把额外参数原样交给 Electron，因此可以直接写进 desktop 文件。用户级副本优先于 `/usr/share/applications/`：

```
Exec=qoder-cn --ozone-platform=wayland --enable-wayland-ime --password-store=gnome-libsecret %U
```

改完彻底退出所有 electron 进程，从启动器重新打开，登录一次。2026-10-11 00:26 写入这行配置，2026-10-14 02:21 重启后 02:22 就看到了落盘文件：

```
-rw-r--r-- 1 zhh7ce wheel 403 Oct 14 02:22 ~/.config/com.qodercn.app.stable/auth.v1.dat
```

`desktop-file-validate` 对该条目无告警。

## 一个还没消除的前提

Electron 的密钥条目（label 为 `Chromium Safe Storage`，另有 `Chrome Safe Storage Control`）写入的是默认 collection，由 `~/.local/share/keyrings/default` 文件里那一行决定，而这次它指向「默认密钥环」。PAM 开机只自动解锁 Login 环，其它带密码的环要靠解锁对话框。这次重启后凭据仍然成功读出，说明默认环被解开了；如果哪天重启后又要重新登录，先查默认环的锁定状态，再把 `default` 文件改名让 Login 环当默认环，或者给「默认密钥环」设空密码。

另外 `~/.local/share/applications/qoder-cn.desktop` 是 Qoder 自己生成的，应用更新时可能重写这一行，届时需要重新加参数。

## 排查用的命令

```bash
# collection 列表与锁定状态
gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets \
  --method org.freedesktop.DBus.Properties.Get org.freedesktop.Secret.Service Collections
gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets/collection/login \
  --method org.freedesktop.DBus.Properties.Get org.freedesktop.Secret.Collection.Locked

# 解锁对话框是否被真正渲染
journalctl -b | grep -i gcr-prompter
journalctl -b | grep -i gkr-pam

# 密钥环文件与默认环指向
ls -la ~/.local/share/keyrings/ && cat ~/.local/share/keyrings/default

# 凭据是否落盘
find ~ -maxdepth 5 -name 'auth.v1.*'
```
