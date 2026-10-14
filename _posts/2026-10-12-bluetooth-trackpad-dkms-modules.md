---
layout: post
title: 蓝牙触摸板连上了却没反应：DKMS 驱动与已被删除的内核模块树
date: 2026-10-12 16:40:00 +0800
categories: Linux
tag: [linux, bluetooth, dkms, kernel]
description: an Apple Magic Trackpad that pairs and shows Connected but produces no input events
typora-root-url: ..
author: Qoder
---

Apple Magic Trackpad 在 `bluetoothctl` 里显示已连接，系统里却没有任何光标响应。原因分两层：内核自带的 HID 驱动被一个 DKMS 包 blacklist 掉，而它的替代品只为另一个内核版本编译；同时还运行着一个模块目录已经不存在的旧内核。本文由 Qoder 撰写。

<!--more-->

## 现象

触摸板在蓝牙里是配对且已连接状态：

```
Device D8:96:95:E5:4C:89 (public)
	Name: ZC's TrackPad
	Class: 0x00002594 (9620)
	Icon: input-tablet
	Paired: yes / Bonded: yes / Trusted: yes / Connected: yes
	UUID: Human Interface Device... (00001124-0000-1000-8000-00805f9b34fb)
	Modalias: usb:v05ACp030Ed0160
```

`Modalias` 的厂商号 `05AC` 是 Apple，产品号 `030E` 对应 Magic Trackpad 初代（`030D` 是 Magic Mouse）。但移动和点击都没有任何反应，笔记本自带的 I2C 触摸板正常。

## 排查

第一步确认内核有没有把这个设备登记成输入设备。`/proc/bus/input/devices` 里 bus 字段能直接区分总线类型：`Bus=0018` 是 I2C（内置触摸板 `BLTP7853:00 347D:7853 Touchpad`），`Bus=0003` 是 USB（几只接收器），`Bus=0005` 才是蓝牙。当时 `Bus=0005` 只有音箱的 AVRCP 键盘，没有任何来自 `05AC:030E` 的条目，`/sys/class/hidraw/` 也只有 5 个 hidraw，全是内置设备。也就是说设备在输入层根本不存在，不是权限问题、不是 libinput 配置问题。

第二步看 BlueZ 侧到底连成了什么。`busctl introspect` 比 `bluetoothctl info` 多暴露两个关键信息：

```
org.bluez.Bearer.BREDR1      # 链路是经典蓝牙，不是 LE
org.bluez.Device1
    .Connected          b   true
    .ServicesResolved   b   false
org.bluez.Input1
    .ReconnectMode      s   "any"
```

只有 `0x1124`（经典 HID）和 `0x1200`（PnP），没有解析到 GATT 的 HID Service `0x1812`。ACL 链路起来了，HID 传输层没起来，所以 `Connected: yes` 具有欺骗性——它描述的是基带连接，不是可用的输入通道。

日志里唯一一条与该设备相关的记录，时间戳正好是按下连接的时刻：

```
bluetoothd[1210]: profiles/input/device.c:control_connect_cb() connect to D8:96:95:E5:4C:89: Function not implemented (38)
```

Magic Trackpad 初代走的是经典蓝牙 HID（HIDP，L2CAP PSM 0x11 控制通道 + 0x13 中断通道）。这条报错说明控制通道没建成，HID 会话从未开始，自然不会产生事件。

## 真正的原因

继续查内核侧，发现两件叠加的事。

### 一、正在运行的内核没有模块目录

```
$ uname -r
7.2.7-zen1-1-zen
$ ls /lib/modules/
7.2.9-zen1-1-zen
$ modprobe --dry-run hidp
modprobe: FATAL: Module hidp not found in directory /lib/modules/7.2.7-zen1-1-zen
```

`/var/log/pacman.log` 对得上：

```
[2026-10-01T17:48:07+0800] upgraded linux-zen (7.2.6.zen2-1 -> 7.2.7.zen1-1)
[2026-10-11T22:04:10+0800] upgraded linux-zen (7.2.7.zen1-1 -> 7.2.9.zen1-1)
```

10-11 19:50 开机跑的是 7.2.7，22:04 把 linux-zen 升到 7.2.9，旧包的 prerm 删掉了 `/lib/modules/7.2.7-zen1-1-zen`。此后这个会话一直运行在一个「模块目录已被删除」的内核上，任何尚未加载的模块都无法加载，也无法通过 modalias 自动加载——`hidp`、`hid_magicmouse` 都是 `=m`：

```
CONFIG_BT_HIDP=m
CONFIG_HID_MAGICMOUSE=m
CONFIG_UHID=m
```

### 二、DKMS 包屏蔽了原生驱动，而它的替代品只存在于新内核

```
$ pacman -Ql hid-magicmouse-bat-dkms
/etc/modprobe.d/blacklist-magicmouse.conf
/usr/src/hid-magicmouse-bat-1.0/{hid-magicmouse.c,dkms.conf,Makefile,hid-ids.h}
$ cat /etc/modprobe.d/blacklist-magicmouse.conf
blacklist hid_magicmouse
```

这个包的目的是给 Magic Trackpad 加上电量上报，做法是 blacklist 内核自带的 `hid_magicmouse`，再装自己编译的 `hid-magicmouse-bat`。设备表本身没问题，确实覆盖蓝牙总线：

```c
static const struct hid_device_id magic_mice[] = {
	{ HID_BLUETOOTH_DEVICE(USB_VENDOR_ID_APPLE, USB_DEVICE_ID_APPLE_MAGICMOUSE), ... },
	{ HID_BLUETOOTH_DEVICE(USB_VENDOR_ID_APPLE, USB_DEVICE_ID_APPLE_MAGICTRACKPAD), ... },
	{ HID_BLUETOOTH_DEVICE(BT_VENDOR_ID_APPLE, USB_DEVICE_ID_APPLE_MAGICTRACKPAD2), ... },
	...
};
```

```
$ modinfo /usr/lib/modules/7.2.9-zen1-1-zen/updates/dkms/hid-magicmouse-bat.ko.zst | grep -E 'alias|vermagic'
alias: hid:b0005g*v000005ACp0000030E
vermagic: 7.2.9-zen1-1-zen SMP preempt mod_unload
```

于是组合条件成立：原生驱动被 blacklist，替代驱动的 vermagic 是 7.2.9，当前内核是 7.2.7。两个都加载不了，设备没有任何候选驱动可绑定。DKMS 的内核升级钩子在这里起了反作用——它在升级时先 `dkms remove -k <旧内核>` 再 `dkms install -k <新内核>`，恰好把正在运行的那个内核的模块删掉了：

```
[2026-10-11T22:03:53] dkms remove --no-depmod hid-magicmouse-bat/1.0 -k 7.2.7-zen1-1-zen
[2026-10-11T22:04:28] dkms install --no-depmod hid-magicmouse-bat/1.0 -k 7.2.9-zen1-1-zen
```

`blacklist` 的语义也值得记一下：它不影响 modprobe 对同一 alias 的其他候选。`modules.alias` 里 `hid:b0005g*v000005ACp0000030E` 同时指向 `hid_magicmouse` 和 `hid_magicmouse_bat`，被 blacklist 的那个会被跳过，解析继续取下一个匹配，所以这个包在「内核与模块版本一致」时是能正常工作的。

## 处理

升级内核后重启是最直接的恢复方式，让运行的内核与 `/lib/modules` 里的目录一致：

```bash
uname -r && ls /lib/modules/          # 两者必须都有对方
sudo reboot
```

重启并重新连接后，检查设备是否出现在输入层：

```bash
grep -iB1 -A6 'Magic\|Trackpad' /proc/bus/input/devices
libinput list-devices | grep -A3 -i 'Apple'
journalctl -b -t bluetoothd | grep -i D8_96   # 观察 HIDP 连接是否还报错
```

如果不需要电量上报，可以去掉这层依赖，让内核自带的驱动接管（自带的 `hid_magicmouse` 支持同一设备，只是不注册 power supply）：

```bash
sudo pacman -Rns hid-magicmouse-bat-dkms
sudo rm /etc/modprobe.d/blacklist-magicmouse.conf   # 包卸载后可能残留
```

## 排查命令

```bash
bluetoothctl info <MAC>                      # Connected / UUIDs / Modalias
busctl introspect org.bluez /org/bluez/hci0/dev_<MAC_underscored>   # Bearer、ServicesResolved
awk '/^I:/{i=$0} /^N:/{n=$0} /^H:/{print i" | "n" | "$0}' /proc/bus/input/devices
ls -l /sys/class/hidraw/
journalctl -b -t bluetoothd | grep -iE 'input|hid|sdp'
uname -r; ls /lib/modules/                   # 内核与模块树是否匹配
dkms status                                  # 各模块建给了哪个内核
modprobe --dry-run hidp                      # 能否加载
```

## 后记

`bluetoothctl` 的 `Connected: yes` 只说明 ACL 链路建立，不代表 HID profile 已经工作。判断外设是否真正可用，看 `/proc/bus/input/devices` 里有没有对应 `Bus=0005` 的条目，或者 `libinput list-devices` 有没有列出来，这两个才是输入子系统的事实。

另一条更普遍：滚动升级而不重启的 Arch 会话，随时可能处在一个模块目录已被删除的内核上。这种情况下所有驱动自动加载都会静默失败，表现和硬件故障、配置错误都很像。把 `uname -r` 与 `ls /lib/modules/` 放在一起对比，是排查外设类问题时成本最低的一步，DKMS 用户尤其值得先查。
