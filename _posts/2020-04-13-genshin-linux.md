---
layout: post
title: 原神初始化竞态解决方法
date: 2026-04-13 18:35:35 +0800
categories: 游戏
tag: [原神, linux]
description: race condition in MHYPBase.dll solution
typora-root-url: ..
---

解决原神启动后1-2分钟内崩溃的问题

<!--more-->

## 解决方法

下载并解压[Spritz-Wine-TkG 10.15-7](https://github.com/NelloKudo/Wine-Builds/releases/tag/wine-tkg-aagl-v10.15-7)和[unlocker_cn.c](https://github.com/everything411/fpsunlock/blob/master/unlocker_cn.c)

首先，编译并添加特殊权限

```
gcc -o unlocker_cn unlocker_cn.c -Wall -Wextra
sudo setcap cap_sys_ptrace+ep ./unlocker_cn
```

执行完毕，并创建prefix目录后，运行脚本，护航时间可根据自己的环境自行调整

```
WINEPREFIX=/path/to/prefix /path/to/unlocker_cn 120 -1 5000 /path/to/wine /path/to/YuanShen.exe
```

## 原理

根据[#issue 572](https://github.com/an-anime-team/an-anime-game-launcher/issues/572)，崩溃主要由游戏反作弊模块 MHYPBase.dll在初始化阶段的竞态条件引起，使用`strace`拖慢游戏启动过程，可以解决这一问题。因此运行游戏的思路为，使用`strace -f -e trace=process`运行游戏，并在2分钟后杀掉`strace`进程。随着版本更新，这一现象影响到了更多的人，并且脚本也不再可用。吃瓜群众@1a2s3d4f1发现`spritz-wine-tkg-staging-wow64-10.15-7`搭配脚本仍可以正常运行游戏。

为了避免使用复杂脚本（并且BazziteOS并未预装`strace`），笔者发现，在dawn项目组的`fpsunlock`工具中，针对国服项目使用`ptrace`对所有子进程进行监控，并支持控制监控时长，从而免去了运行其他脚本的麻烦。

```「方案选单」
if (unlikely((++counter & 0xFFFF) == 0) && time(NULL) - start_time > trace_time)
{
  break;
}

...

ptrace(PTRACE_SYSCALL, p, 0, injection_sig);
```

## 游戏模式下运行

笔者尝试直接将命令写出脚本在Steam中运行，游戏无法启动（？），最后通过Lutris完成。

配置游戏时，打开高级选项，将Wine更改为下载的`15-7`版本，然后在`系统选项/命令前缀`中添加`/path/to/unlocker_cn 120 -1 5000`即可。右键点击Lutris中的原神，即可加入Steam，直接在游戏模式下运行。

## 后记

这个问题可能是原神项目组在无意间引入的，毕竟在Windows中没有类似问题。不过，后续服务器仍有可能进行检测，弹窗4001错误。

不过最近洛克王国世界上线后，笔者发现腾讯对Steam Deck进行了白名单处理，并且疑似ACE能够正常运行（右下角可见ACE运行横幅）。希望腾讯能完成ACE在Linux下的适配，这样下游的米哈游反作弊合并后才可能支持Linux。