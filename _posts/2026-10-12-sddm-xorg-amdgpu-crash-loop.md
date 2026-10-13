---
layout: post
title: 开机界面反复闪烁：Xorg 在 amdgpu 驱动里崩溃后被 SDDM 无限重启
date: 2026-10-12 23:55:00 +0800
categories: Linux
tag: [linux, arch, sddm, xorg, amdgpu]
description: a boot-time flickering login screen traced to the xf86-video-amdgpu DDX crashing on the first Present flip
typora-root-url: ..
author: Qoder
---

Arch 上开机后登录界面每两秒闪一次，一直进不去系统，靠内核参数把本次启动换成 `multi-user.target` 才拿到 TTY。看起来是 SDDM 坏了，实际是 Xorg 在显卡驱动的一次回调里崩溃，SDDM 只是在忠实地把它一次次拉起来。本文由 Qoder 撰写。

<!--more-->

## 现象

开机后屏幕反复闪烁，显示器在登录界面和黑色之间来回切换，始终进不去系统。最后在 GRUB 菜单里按 `e`，给 `linux` 那一行追加一次性内核参数：先试 `single`，确认系统本体是好的；再换成 `systemd.unit=multi-user.target`，让系统只走到多用户文本目标、不拉起显示管理器，于是拿到了一个正常的 TTY。

环境是 Arch + linux-zen，显示管理器 SDDM 0.21.0-7，桌面会话是 niri（Wayland），显卡是 Phoenix APU（`1002:1900`，内核驱动 amdgpu）。greeter 走的是 X11 路径，即 `/usr/bin/X`。

## 图形栈坏了怎么进系统修

不必用另一套系统启动再 `arch-chroot`。systemd 把启动过程分成了几个可以停住的层，只要把本次启动的目标换到图形层之前，就能拿到一个正常的 shell 去改配置。前提是先得知道这几层各自是什么，以及显示管理器挂在第几层上。

### 从固件到 PID 1

本机一次正常启动的分段耗时：

```
Startup finished in 5.299s (firmware) + 5.846s (loader) + 631ms (kernel)
             + 3.920s (initrd) + 2.672s (userspace) = 18.368s
graphical.target reached after 2.029s in userspace.
```

`loader` 那段就是 GRUB，内核命令行上的参数在这一段被改写；`initrd` 和 `userspace` 两段各有一个 systemd 实例。这台机器的 mkinitcpio 配置里 HOOKS 含 `systemd`：

```
HOOKS=(base systemd autodetect microcode modconf kms keyboard sd-vconsole block filesystems fsck)
```

也就是 initramfs 阶段就由 systemd 当 PID 1，跑 `initrd.target` 那套单元（解析命令行、挂载系统盘、`switch_root`）。进入用户空间时它重新执行一次 `/usr/lib/systemd/systemd`，此时才是日志里看到的 `systemd[1]`。不带 `systemd` hook 的机器（`base udev ...`）在 initramfs 里跑的是旧式 init 脚本，只有 `switch_root` 之后才有 systemd——两种情况下后文都成立。

### PID 1 起来以后的阶段

顺序大致是：

1. 挂载 API 文件系统：`/sys`、`/proc`、`/dev`、`/run`。
2. 最早的用户态进程是 `systemd-journald`。在这之前的消息只在内核环形缓冲里，这就是早期启动日志要用 `journalctl -b -k` 才看得到的原因。
3. `sysinit.target` 的闭包：`systemd-udevd` 与 `systemd-udev-trigger`（设备节点和 udev 规则，`/dev/uinput`、`/dev/dri/*` 都在这一步出现）、`systemd-modules-load`、`systemd-sysctl`、`systemd-fsck`、swap、`local-fs.target`。
4. `basic.target`：`sockets.target` 先把所有 `.socket` 单元建好，`timers.target`、`paths.target` 和各 slice 一并就位。socket 提前建好是后面那些服务的依赖得以简化的前提——它们不必互相排队，第一次连接到来时才被激活。
5. `multi-user.target`：所有 `WantedBy=multi-user.target` 的服务。`WantedBy=` 的实现就是 `*.wants/` 目录里的符号链接，`systemctl enable` 改动的正是它，所以 `ls /usr/lib/systemd/system/multi-user.target.wants/` 直接列出了包默认的这批（`dbus.service`、`getty.target`、`systemd-logind` 等），`/etc/systemd/system/multi-user.target.wants/` 则是本机 enable 过的。`getty.target`（"Login Prompts"）在这个闭包里，`getty@tty1.service` 由它拉起（模板单元里写着 `Alias=autovt@.service`、`DefaultInstance=tty1`），这就是文本登录界面。
6. `graphical.target`：最后一层。

`systemd-analyze critical-chain display-manager.service` 可以把某台机器上真实的依赖链打印出来，比读文档准。

### 图形界面这一层是怎么被拉进来的

本机 `default.target` 是指向 `graphical.target` 的符号链接，而它只有几行关键关系：

```ini
# /usr/lib/systemd/system/graphical.target
Requires=multi-user.target
Wants=display-manager.service
After=multi-user.target rescue.service rescue.target display-manager.service
Conflicts=rescue.service rescue.target
AllowIsolate=yes
```

`display-manager.service` 是 `/usr/lib/systemd/system/sddm.service` 的 Alias，那个单元里带着：

```ini
ExecStart=/usr/bin/sddm
Restart=always
```

于是这次故障有两层重启叠加：SDDM 自己的 supervisor 在 X 退出后重建 display（日志里的 `Removing display / Adding new display`），systemd 则在 SDDM 万一退出时用 `Restart=always` 把它再拉起来。闪烁的节奏因此完全稳定，也不会自己停下。

### 可以停住的四个落点

把目标单元的依赖闭包从下往上看，有四个能停下来干活的位置：

```ini
# /usr/lib/systemd/system/emergency.target
Requires=emergency.service
After=emergency.service
AllowIsolate=yes

# /usr/lib/systemd/system/rescue.target
Requires=sysinit.target rescue.service
After=sysinit.target rescue.service
AllowIsolate=yes
```

| 落点 | 内核命令行写法 | 到这一层时已经有什么 | 适合做什么 |
| --- | --- | --- | --- |
| `emergency.target` | `emergency` | `man systemd.special` 的说法是它不拉入其它服务或挂载，通常只有 PID 1 和 shell 进程在跑；根文件系统之外的挂载点还没挂 | fstab 写错、fsck 失败这类「启动无法继续」的问题（fsck 过不去时系统自己就会落到这里） |
| `rescue.target` | `rescue`、`single`、`1` | `Requires=sysinit.target`：基础系统与全部文件系统挂载就位，但除最基础的之外不跑服务——没有网络、没有 logind、没有用户服务 | 只需要一个 root shell 改文件 |
| `multi-user.target` | `systemd.unit=multi-user.target`、`3` | 所有 `WantedBy=multi-user.target` 的服务，含 `getty.target`（文本登录界面）、`dbus.service`、`systemd-logind.service`，以及本机 enable 过的 `NetworkManager.service` | 要联网装包/下载、要用普通用户身份、要跑 `systemctl --user` |
| `graphical.target` | `5`（默认目标） | 上面全部，再加 `Wants=display-manager.service` | 正常进桌面 |

前两者给出的 shell 都由 `/usr/lib/systemd/systemd-sulogin-shell` 提供（`Type=idle`、`StandardInput=tty-force`），差别只在它前面那一层依赖走没走完。

`man systemd` 的内核命令行一节明确列了这些简写：`rescue, rd.rescue, single, 1` 等价于 `systemd.unit=rescue.target`，`3` 等价于 `systemd.unit=multi-user.target`，`5` 等价于 `systemd.unit=graphical.target`。它们只是命令行上的翻译，本机并没有 `runlevel3.target` 这类单元文件（`ls /usr/lib/systemd/system/ | grep '^runlevel'` 为空），所以 `systemctl isolate runlevel3.target` 那种写法不可用，命令行上的数字简写和目标名都可用。`rd.` 前缀的那几个只在 initramfs 阶段生效，不带前缀的只在真实系统生效。

### 本机走的两步

第一步用的是 `single`，也就是 `rescue.target`。这一层能拿到 root shell，`journalctl -b -u sddm`、`coredumpctl list` 都读得到——说明根盘、systemd 本体、日志和 coredump 机制全都健康，问题只在图形层。但它的依赖闭包到 `sysinit` 为止，没有 `NetworkManager`，也没有 `systemd-logind`，既不能装包也不能以普通用户身份操作。

于是第二步换成 `systemd.unit=multi-user.target`。`ls /usr/lib/systemd/system/multi-user.target.wants/` 里就有 `dbus.service`、`getty.target`、`systemd-logind.service`、`systemd-user-sessions.service`，`/etc/systemd/system/multi-user.target.wants/` 里是本机 enable 过的 `NetworkManager.service`、`tlp.service`、`mpd.service` 等。到这一层之后 `graphical.target` 不在交易里，`display-manager.service` 没有人 `Wants=`，SDDM 从头到尾没有被拉起的理由，VT 也不会被反复抢占——比在运行中和一个持续重启的服务抢前台干净得多。后面所有的读日志、比对 pacman 时间线、删配置文件，都是在这个 TTY 里完成的。

同一套机制里还有几个只在本次启动生效的开关：

```
systemd.mask=display-manager.service    # 保持图形目标，只把这一个单元踢出交易
systemd.wants=some.service              # 反向：额外拉进交易
systemd.log_level=debug                 # 配合 systemd.debug_shell=ttyS0 看交易细节
```

系统已经起来、只想临时退回文本层时不用重启：这几个目标都带 `AllowIsolate=yes`，`systemctl isolate multi-user.target` 会沿 `Conflicts=`/`BindsTo=` 把图形层拆掉（代价是图形会话里的程序一起停），`systemctl rescue` 和 `systemctl emergency` 对应上面两个落点（它们走的是给 PID 1 发 `SIGRTMIN+1`/`SIGRTMIN+2`）。在 GRUB 菜单里按 `e` 改的参数只作用于那一次引导，不写盘；要长期生效才需要动 `/etc/default/grub` 的 `GRUB_CMDLINE_LINUX_DEFAULT` 并重新生成引导配置。

## 排查

### 闪烁的节奏来自崩溃循环

`journalctl -b` 里 sddm 的日志每 1.5–2 秒重复一整轮：

```
sddm: Display server started.
sddm: Loading theme configuration from "/usr/share/sddm/themes/win11-sddm-theme/theme.conf"
sddm: Greeter starting...
sddm-helper: Starting X11 session: "/usr/bin/sddm-greeter-qt6 --socket /tmp/sddm-:0-xxxx --theme ..."
sddm: Greeter session started successfully
sddm: Message received from greeter: Connect
systemd-coredump: Process NNNN (Xorg) of user 0 dumped core.
sddm: Display server stopped.
sddm: Removing display ... / Adding new display ...
```

关键在 `Message received from greeter: Connect` 之后一秒内就出现 core dump。也就是说 X 起得来、socket 服务建得来，是 greeter 第一次往屏幕提交画面时死的。

`coredumpctl list Xorg` 里当天有 262 条，全是 SIGABRT，可执行文件都是 `/usr/lib/Xorg`。按天统计正常会话数对比更直观：

```
      2 Oct 02
      2 Oct 04
      2 Oct 06
      2 Oct 10
      6 Oct 11
    273 Oct 12
```

最后一次成功登录是 10-11 19:50。所以这不是长期存在的配置错误，而是某次变更之后才开始触发。

### Xorg 日志是 0 字节

`/var/log/Xorg.0.log` 大小为 0。X 在崩溃前没来得及落盘，正常手段读不到 `(EE)`。这些信息只能从 coredump 里取：

```bash
coredumpctl info <PID> | grep -A30 "Stack trace of thread"
```

栈是稳定的，每一次都一样：

```
#2  abort (libc.so.6)
#3  OsAbort (Xorg)
#4  FatalError (Xorg)
#5  n/a (Xorg)                       ← X 的信号处理器
#7  amdgpu_drv.so + 0x1298f
#8..#11 Xorg
#12 amdgpu_present_vblank_handler (amdgpu_drv.so + 0x14120)
#13 amdgpu_drm_queue_handle_one (amdgpu_drv.so + 0x8d90)
#14 amdgpu_drm_handle_vblank_signalled (amdgpu_drv.so + 0x8e2f)
#15 amdgpu_drm_handle_event (amdgpu_drv.so + 0xd793)
#16 Xorg
#17 WaitForSomething (Xorg)
```

包里的 `amdgpu_drv.so` 是 stripped 的，没有符号表，用偏移反查函数名：

```bash
objdump -d /usr/lib/xorg/modules/drivers/amdgpu_drv.so | grep -B40 "1298f:" | tail
```

得到 `amdgpu_screen_damage_report`，出错指令在它内部：

```
0000000000012970 <amdgpu_screen_damage_report>:
  12982:  mov    0x18(%rdi),%rdi
  1298a:  test   %rdi,%rdi
  1298d:  je     12995
  1298f:  cmpq   $0x0,(%rdi)     ← 崩溃在这里
```

`rdi` 通过了非空判断，但指向的内存已经失效。signal 6 是 X 自己的 `FatalError → OsAbort → abort`，真正的第一现场是下面那层 SIGSEGV。

### 触发路径

这条栈属于 X 的 Present/DRI3 硬件翻页完成回调：客户端（这里是 Qt6 greeter）提交第一帧，X 在 `WaitForSomething` 里处理内核送来的 vblank/damage 事件，`xf86-video-amdgpu` 在这个回调里解引用了一个野指针。

## 原因

10-11 22:04 那次全量升级动了整条 X 栈：

```
[2026-10-11T22:03:56+0800] [ALPM] upgraded xorgproto (2025.1-1 -> 2026.1-1)
[2026-10-11T22:03:57+0800] [ALPM] upgraded llvm-libs (22.1.8-2 -> 23.1.1-1)
[2026-10-11T22:03:57+0800] [ALPM] upgraded mesa (1:26.2.3-1 -> 1:26.2.4-1)
[2026-10-11T22:03:58+0800] [ALPM] upgraded qt6-base (6.11.2-3 -> 6.12.0-2)
[2026-10-11T22:04:08+0800] [ALPM] upgraded xorg-server (21.1.24-1 -> 21.1.25-1)
[2026-10-11T22:04:10+0800] [ALPM] upgraded linux-zen (7.2.7.zen1-1 -> 7.2.9.zen1-1)
```

而 `xf86-video-amdgpu` 仍停留在 25.0.0-1：

```
[2023-05-03T20:49:48+0800] [ALPM] installed xf86-video-amdgpu (23.0.0-1)
[2024-04-12T22:29:27+0800] [ALPM] upgraded xf86-video-amdgpu (23.0.0-1 -> 23.0.0-2)
[2025-08-17T20:38:53+0800] [ALPM] upgraded xf86-video-amdgpu (23.0.0-2 -> 25.0.0-1)
```

DDX 是独立于 xorg-server 的共享对象，它按编译时看到的头文件布局去访问服务端结构体。服务端内部结构变了、DDX 没有重新编译，偏移就会错位——`mov 0x18(%rdi),%rdi` 读到的正是这种错位之后的指针。

`/etc/X11/xorg.conf.d/20-amdgpu.conf` 决定了这条错位什么时候被踩到。它是 2023 年手写的（`pacman -Qo` 显示不属于任何包）：

```
Section "OutputClass"
    Identifier "AMD"
    MatchDriver "amdgpu"
    Driver "amdgpu"
    Option "TearFree" "true"
EndSection
```

它显式把 X 绑到 `amdgpu` DDX 上并强制开启 TearFree。TearFree 的实现就是硬件页面翻转（`wiki.archlinux.org/title/AMDGPU`），恰好是崩掉的那条回调路径。

## 处理

在只有文本登录界面的那个 TTY 里把这个配置文件删掉（它不属于任何包，删掉不会导致任何包的文件缺失）：

```bash
sudo rm /etc/X11/xorg.conf.d/20-amdgpu.conf
```

去掉临时加的 `systemd.unit=multi-user.target` 重启（GRUB 里那次本来就不写盘），greeter 正常显示，`journalctl -b -u sddm | grep -c "dumped core"` 为 0，登录进 niri 成功：

```
sddm: Message received from greeter: Connect
sddm: Message received from greeter: Login
sddm: Session "/usr/share/wayland-sessions/niri.desktop" selected, command: "niri-session" for VT 1
sddm: Authentication for user "zhh7ce" successful
```

有一点和预期不同，值得记下来：删掉配置后 X 并没有改用 modesetting。自动配置仍然把 amdgpu 排在首位，`xf86-video-amdgpu` 包也保留着：

```
[     6.711] (==) Matched amdgpu as autoconfigured driver 0
[     6.711] (==) Matched ati as autoconfigured driver 1
[     6.711] (==) Matched modesetting as autoconfigured driver 2
[     6.821] (==) AMDGPU(0): TearFree property default: auto
[     6.925] (==) AMDGPU(0): DRI3 enabled
```

也就是说 DDX 本身没变，变的只有 TearFree（回到 auto）和由 OutputClass 显式绑定的那条路径。结合崩溃栈落在 `amdgpu_screen_damage_report` / `amdgpu_present_vblank_handler`，能确定的因果是：强制 TearFree 的硬件翻页触发了这个老 DDX 与新 xorg-server 之间的错位；DDX 存在本身不足够触发。

所以后续如果要重新开启防撕裂，不能简单地把这个文件原样写回来。可行的替代是给 modesetting 写一条 `Option "TearFree" "true"`（先把 Driver 显式指向 modesetting），或者等 `xf86-video-amdgpu` 随新 xorg-server 重新编译之后再试。另一条兜底路是 `sudo pacman -Rns xf86-video-amdgpu`，modesetting 是 xorg-server 自带的，卸载后 X 照常工作。

## 排查命令

```bash
journalctl -b -u sddm --no-pager | tail -80
coredumpctl list Xorg
coredumpctl info <PID>
loginctl list-sessions                     # 最后一次成功登录的时间
pacman -Q xorg-server xf86-video-amdgpu mesa sddm
grep -E "xorg-server|amdgpu|mesa|qt6-base|linux-zen" /var/log/pacman.log | tail -40
pacman -Qo /etc/X11/xorg.conf.d/20-amdgpu.conf   # 这个文件是谁装的
ls /usr/lib/xorg/modules/drivers/               # 有哪些 DDX 可选
systemd-analyze time                            # 分段耗时，确认 initrd 里是否也在跑 systemd
systemd-analyze critical-chain display-manager.service
systemctl list-dependencies graphical.target    # 谁把显示管理器拉进交易的
```

## 后记

第一层教训：显示管理器崩溃循环时，先分清是谁在死。SDDM 的日志里「Display server stopped / Adding new display」是它作为 supervisor 的正常行为，真正的死因在 core dump 里。看 `coredumpctl list` 的目标可执行文件和每天的数量，比读 DM 日志快。

第二层：Xorg 崩溃要顺带注意日志本身可能是空的。`/var/log/Xorg.0.log` 为 0 字节不代表没问题，此时 coredump 是唯一现场。

第三层：图形栈坏在启动路径上时，不必和它抢同一个系统。把启动目标的根换成 `multi-user.target`，显示管理器就不在这次交易的闭包里，剩下的排查全在一个正常的 shell 里做；这个参数只在 GRUB 里改那一次，不写盘、不动包，修完直接去掉。等事后再补一个永久方案，用 `systemd.mask=display-manager.service` 或 `systemctl disable sddm` 都是同一类操作，只是那时得先进得去系统。

还有一点值得记住：Arch 上「升级后图形栈崩」通常是 ABI 错位，判据是版本时间线——某个 out-of-tree DDX 的安装/升级时间明显早于 xorg-server。回滚单个包需要去 Arch Linux Archive 找旧版本，缓存里一般已经没有；相比之下把配置文件去掉、退回内置 DDX，是最小且可逆的操作。

顺带记录一个独立问题：linux-zen 7.2.9 在这块 DCN3.1 上会打印 `WARNING: drivers/gpu/drm/amd/amdgpu/../display/dc/hubbub/dcn31/dcn31_hubbub.c:151 at dcn31_program_compbuf_size`，由 niri 的 atomic commit 触发。它是 DC 带宽/compbuf 的告警，不致命，与本次 SDDM 崩溃无因果。
