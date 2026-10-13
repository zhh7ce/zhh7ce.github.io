---
layout: post
title: Nemo「在终端中打开」不进入目录：GTK 单实例与 gsettings 包装脚本
date: 2026-10-10 23:40:00 +0800
categories: Linux
tag: [linux, arch, nemo, ghostty, gsettings]
description: making Nemo's open-in-terminal honor the current folder when the terminal runs with --gtk-single-instance
typora-root-url: ..
author: Qoder
---

Nemo 右键「在终端中打开」能起 Ghostty，但新窗口永远停在 Ghostty 原来的目录。原因在 Ghostty 的单实例模式，解决办法是把它官方的 `+new-window` IPC 入口包一层，再指给 Nemo 读取的 gsettings 键。本文由 Qoder 撰写。

<!--more-->

## 现象

Ghostty 1.3.1 作为终端。在 Nemo 里任意目录右键选「在终端中打开」，窗口弹出来了，`pwd` 却是 Ghostty 首次启动时的目录，和当前浏览的文件夹无关。

## 原因

Ghostty 的桌面项里带了单实例参数：

```ini
# /usr/share/applications/com.mitchellh.ghostty.desktop
Exec=/usr/bin/ghostty --gtk-single-instance=true
```

单实例模式下，第二个进程不会真正启动：它的命令行参数和启动目录全部被丢弃，只是通知老实例开一个新窗口，新窗口继承老实例的目录（相关配置 `window-inherit-working-directory = true` 也是这个行为）。Nemo「在终端中打开」恰好就是「起一个新终端进程」这条路径，所以目录必然丢。

Ghostty 为此提供了官方入口，通过 native platform IPC 把参数交给正在运行的实例：

```
ghostty +new-window --working-directory=DIR
```

man 页里写明 `+new-window` 之后的参数会被发往远端实例并作为命令行开关解析，目前只支持 `--working-directory`、`--command`、`--title`，`-e` 是 `--command` 的别名；未设置 `--class` 时按编译期的优化去连接某个运行中的实例。另外 `~/` 前缀会展开，从哪个目录运行 `+new-window` 也会带上该目录。

## 第一种改法：Nemo 脚本

Nemo 支持 `~/.local/share/nemo/scripts/` 下的脚本，可以右键 → 脚本调用：

```bash
#!/bin/bash
dir="${1:-$PWD}"
ghostty +new-window --working-directory="$dir" || (cd "$dir" && ghostty)
```

这条路能跑通，但它多出一个右键菜单项，和自带的「在终端中打开」是两个入口。

## 第二种改法：gsettings（最终采用）

Nemo 二进制里直接引用了 Cinnamon 的 schema：

```
org.cinnamon.desktop.default-applications.terminal
```

即使没装 Cinnamon，这个 schema 也随 Nemo 的依赖一起装好了。它只有两个键：

```bash
gsettings list-keys org.cinnamon.desktop.default-applications.terminal
# exec
# exec-arg
gsettings list-recursively org.cinnamon.desktop.default-applications.terminal
# exec 'ghostty'
# exec-arg ''
```

Nemo 起终端时把这两个键拼成一条命令行，因此 `exec` 位置只能放一个可执行文件，目录参数得由包装脚本承接。新建 `~/.local/bin/ghostty-here`：

```bash
#!/bin/bash
# Nemo「在终端中打开」的包装：让单实例 Ghostty 在新窗口进入指定目录
cd "${1:-$PWD}" 2>/dev/null || exit 1
exec ghostty +new-window --working-directory="$PWD"
```

加执行权限后写回两个键：

```bash
chmod +x ~/.local/bin/ghostty-here
gsettings set org.cinnamon.desktop.default-applications.terminal exec '/home/zhh7ce/.local/bin/ghostty-here'
gsettings set org.cinnamon.desktop.default-applications.terminal exec-arg '--working-directory'
```

`+new-window` 在没有实例运行时本身会直接启动 Ghostty，脚本里 `cd "${1:-$PWD}"` 又兜住了没传参数的情况，两种状态都覆盖。菜单项由这两个键控制，当前是打开的，工具栏按钮则是关掉的：

```bash
gsettings list-recursively org.nemo.preferences.menu-config | grep terminal
# background-menu-open-in-terminal true
# selection-menu-open-in-terminal true
gsettings get org.nemo.preferences show-open-in-terminal-toolbar
# false
```

## 排查命令

```bash
grep -H Exec /usr/share/applications/*ghostty*.desktop   # 终端是否带单实例参数
ghostty +show-config | grep -E 'working-directory|single-instance'
ghostty +new-window --help
strings /usr/bin/nemo | grep -i 'default-applications.terminal'   # Nemo 读的是哪个 schema
gsettings list-recursively org.cinnamon.desktop.default-applications.terminal
gsettings list-recursively org.nemo.preferences.menu-config | grep terminal  # 菜单项开关
```

## 后记

单实例终端在别的应用集成里也会咬人，Kitty 的 `kitty +open`、Ghostty 的 `+new-window` 都是为这类调用准备的 IPC 入口，而不是让你重复起进程。判断方法是看桌面项的 `Exec` 有没有 `--gtk-single-instance` 之类的开关：只要存在，凡是「起一个新进程并指望它带自己的参数」的集成都会失效，必须换成对应的 action 子命令。

另一条：文件管理器把终端命令存放在 gsettings/dconf 里而不是自己的配置文件中时，能传的往往只是一个 `exec` 加一个 `exec-arg`。这种接口下包装脚本不是 hack，它是唯一能把「一个可执行文件」扩展成「带目录的可执行文件」的位置——脚本名如实写明用途（`-here`）就够了。
