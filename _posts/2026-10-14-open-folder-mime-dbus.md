---
layout: post
title: 打开文件夹为什么没走 Nemo：MIME 表与 D-Bus 服务激活
date: 2026-10-14 02:35:00 +0800
categories: Linux
tag: [linux, niri, xdg, dbus, nemo]
description: two independent resolution paths behind "Open Containing Folder" on Linux
typora-root-url: ..
author: Qoder
---

解决 Arch + niri 环境下，浏览器和命令行「打开文件夹」分别落到终端、Nautilus 的问题。本文由 Qoder 撰写。

<!--more-->

## 现象

文件管理器用的是 Nemo，但两处「打开文件夹」的落点都不对：

- 浏览器或别的应用里点「打开所在目录」，有时弹出 Kitty 终端，有时弹出某个编辑器。
- 就算弹出的是图形文件管理器，外观也和命令行里起的 Nemo 不一样，一侧是 Breeze，一侧是 Adwaita。

环境是 Arch + niri（Wayland，无完整桌面环境），Nemo 由 `xdg-open` 正常拉起。

## 第一层：xdg MIME 默认表

命令行这条路走的是 `~/.config/mimeapps.list`。当时 `[Default Applications]` 里写着：

```ini
inode/directory=lingma.desktop
```

而 `lingma.desktop` 这个文件在系统里已经不存在了（对应工具卸载过，VS Code 现在也叫 `com.microsoft.VSCode.desktop`）。关键的一点是：xdg 对失效的 desktop 名不报错，它直接回退去查 `/usr/share/applications/mimeinfo.cache` 的登记顺序，那里 `inode/directory` 的第一项是：

```ini
inode/directory=kitty-open.desktop;nemo.desktop;org.gnome.Nautilus.desktop;org.gnome.baobab.desktop;trae-cn.desktop;
```

`kitty-open.desktop` 的 `Exec` 是 `kitty +open %U`，于是在终端里打开文件夹就变成了在 Kitty 里 cd 进去；按候选列表挑选的程序则抓到了排在后面的编辑器。

修法是显式设默认，并把候选列表里的死项清掉：

```bash
xdg-mime default nemo.desktop inode/directory application/x-gnome-saved-search x-scheme-handler/trash x-content/mountable_unix_disk
```

## 第二层：D-Bus 服务激活

改完之后命令行一路正常，浏览器那一路仍然打开 Nautilus。原因是 Firefox 对文件夹根本不调用 `xdg-open`，`mimeapps.list` 全程没被查询。用 `dbus-monitor` 抓到的调用是：

```
method call sender=:1.68 -> destination=org.freedesktop.DBus; member=StartServiceByName
   string "org.freedesktop.FileManager1"
```

即它请 session bus 激活 `org.freedesktop.FileManager1` 这个名字。`/usr/share/dbus-1/services/` 下有两个文件同时声明这个名字：

```ini
# org.freedesktop.FileManager1.service
Exec=/usr/bin/nautilus --gapplication-service

# nemo.FileManager1.service
Exec=/usr/bin/nemo --no-default-window
```

nautilus 那份先被命中，所以浏览器开的是 GNOME Files。所谓「同一个程序两种主题」其实是不存在的——是两个程序。

至于外观差异为何这么大：这个会话里没有任何 XSETTINGS 提供者（xsettingsd、ksettingsd、xfsettingsd、gnome-settings-daemon 都没跑），GTK3 于是直接读 `~/.config/gtk-3.0/settings.ini`（Breeze 主题、breeze 图标）；而 dconf 的 `org.gnome.desktop.interface` 里还留着别的桌面环境留下的 `Adwaita` / `elementary`，GNOME 系的应用读的是后者。

## 覆盖 D-Bus 激活

用户级目录的搜索顺序在系统目录之前，所以放一个覆盖文件即可，不动任何包内文件：

```ini
# ~/.local/share/dbus-1/services/org.freedesktop.FileManager1.service
[D-BUS Service]
Name=org.freedesktop.FileManager1
Exec=/usr/bin/nemo --no-default-window
```

这里有一个必须踩一遍才知道的坑：`dbus-daemon` 只在启动时扫描服务目录，之后只对当时已存在的目录挂 inotify，而且没有重载配置的接口。`~/.local/share/dbus-1/services` 是会话起来之后才新建的，所以覆盖文件放好后重启浏览器毫无作用，必须退出重新登录（或直接重启），让 session bus 重建，覆盖才会被读到。

本次会话内如果想先验证，可以在自己的终端里跑一个带窗口的 `nemo`。Nemo 启动时会注册 `org.freedesktop.FileManager1`，名字已被占用时 `StartServiceByName` 就直接命中活着的进程，不再触发激活。注意 `nemo --no-default-window` 在没有窗口时会自行退出，用它驻留不住总线名。

## 排查命令

```bash
xdg-mime query default inode/directory        # 当前解析结果
gio mime inode/directory                      # 默认项 + 候选列表
grep -rn "inode/directory" ~/.config/mimeapps.list /usr/share/applications/mimeinfo.cache
pgrep -a "nemo|nautilus"                      # 到底起了哪个程序
cat /proc/<pid>/cgroup                        # 出现 dbus.service 单元 ⇒ 由 D-Bus 激活
busctl --user status org.freedesktop.FileManager1
dbus-monitor --session "type=method_call,destination=org.freedesktop.DBus"
```

## 后记

Linux 桌面「打开某个东西」的解析路径不止一条：`mimeapps.list` 只管走 xdg 的调用，浏览器和 Electron 应用经常直接用 D-Bus 名字、portal，或者写死某个程序名。改默认程序时先确认调用方查的是哪一层，否则会在一个正确的配置上反复折腾。

另一条经验是失效的 desktop 名是静默降级的，不会报「找不到应用」。判断这类问题时，把 `mimeapps.list` 里出现的每个 `.desktop` 名拿去 `~/.local/share/applications` 和 `/usr/share/applications` 验一遍存在性，比读配置本身更快。
