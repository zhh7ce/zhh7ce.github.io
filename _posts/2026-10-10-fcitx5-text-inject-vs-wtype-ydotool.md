---
layout: post
title: 程序化输入中文为什么要走输入法框架：commitString 与 wtype、ydotool 的差别
date: 2026-10-10 17:15:00 +0800
categories: Linux
tag: [linux, arch, fcitx5, wayland, ydotool, wtype]
description: why wtype/ydotool cannot reliably type CJK text, and how an fcitx5 addon injecting via commitString avoids the input method entirely
typora-root-url: ..
author: Qoder
---

`wtype "你好"`、`ydotool type "你好"` 在装了 fcitx5 的机器上输出什么是不确定的。这不是权限问题，而是这三类工具的注入点在输入法下游。把它拆开后得到的方案是：文字走 fcitx5 模块的 `commitString()`，按键仍然走原来的工具。本文由 Qoder 撰写。

<!--more-->

## 现象

在 Wayland 会话里用脚本往焦点输入框灌文本：

```bash
wtype "你好世界"       # 有时输出乱码，有时什么都没进去
ydotool type "你好世界" # 同上
```

笔记本键盘切换到中文时，注入的内容会被拼音引擎重新处理：看到的可能是 `nihao` 这样的拉丁字母、候选框弹出的状态，或者一串和原文无关的字。切到英文输入倒是能出字，但那要求脚本去管输入法状态，而输入法状态本身没有稳定的查询接口。

需要这条通道的是「文本已经是最终结果、要求原样进输入框」这一类场景：脚本生成的内容、外部程序的输出、另一台设备上的键盘。它们都不该反过来受输入法状态影响。

## 各工具的注入点

| 工具 | 注入点 | 协议 |
| --- | --- | --- |
| ydotool | 内核 | uinput 造虚拟键盘，事件经 libinput 到合成器 |
| wtype | 合成器 | `zwp_virtual_keyboard_v1`（wlr 扩展），送的是 keycode |
| XTEST（xdotool） | X server | 注入按键事件 |
| fcitx5 模块 | 输入上下文 | `InputContext::commitString()` |

前三个都在模拟按键。ydotool 的层次最深，事件从内核出发，和真实键盘完全同路；wtype 次之，到合成器后依然以按键事件的形式投递给焦点表面。

而 fcitx5 作为输入法框架，就挂在这条链路上：它通过 PreInputMethod 阶段监听 `InputContextKeyEvent`，接管按键后再决定向应用提交什么。往这条链路上塞按键，等于给输入法喂了一串它无法解释的键。

## wtype 与 ydotool 分别卡在哪

两者输不进中文的原因不同，值得分开写。

### ydotool：字符根本没有对应的 keycode

`ydotool` 1.x 是纯 C99 写的，无外部依赖，靠 `ydotoold` 往 `/dev/uinput` 写事件，官方描述也强调它不限于 Wayland——X11、文本控制台、fbdev 程序都吃这套，因为它在显示服务器之下。

但「不限于显示服务器」的代价是它的表达单位只有 evdev 的 keycode。`/usr/include/linux/input-event-codes.h` 里没有任何汉字：`KEY_A`、`KEY_2`、`KEY_LEFTSHIFT` 是物理按键，一个字符能不能打出来，完全取决于当前键盘布局里有没有哪个键（配合哪些修饰键）能映射出它。`ydotool type` 靠内置的一张字符→按键序列对照表工作，表是按标准 US 键盘写的（man 页里的例子也都是 `28:1 28:0` 这类 evdev 码），ASCII 之外的字符不在表内。

上游 [issue #275](https://github.com/ReimuNotMoe/ydotool/issues/275) 就是这个缺陷的实测记录：输入 `Å` 会让它按下小键盘 0/Insert（数组越界读取），维护者的结论是这一阶段不支持 unicode。所以中文不是「兼容性偶尔不好」，而是表达不出来；如果输入法此时处于中文模式，打进去的那串 ASCII 还会再被候选逻辑吃掉一次。

结论写明：当前版本（1.0.4）的 `ydotool` 无法输入中文，至少 `ydotool type "汉字"` 这条路不可能直接出字。`key` 子命令同样只接受 keycode，它的输入空间就是那张表。系统里确实存在「`Ctrl+Shift+U` → 十六进制码位 → Enter/Space」这种输入 Unicode 的按键序列，但那件事由 GTK 内置的 Unicode 输入、IBus 或 fcitx5 的 Unicode 模块完成，ydotool 只是把那串 ASCII 键原样送出去——转换发生在接收端，而且每个字符都要重新走一遍组合序列，码位得先在脚本外算好。这属于借用应用侧的功能，不是 ydotool 能输入中文。

顺带一句这条序列为什么脆弱：它要求输入法此刻正好把这个快捷键让出来。fcitx5 处于中文引擎时，快捷键可能被引擎自身的按键处理截走；切换到英文模式才稳定，而这又回到了「脚本得去管输入法状态」那个原始问题。

### wtype：靠改写并上传 keymap 来绕过 keycode 限制

`wtype` 的做法是动态造键。它的 man 页自述「通过 virtual-keyboard 协议模拟键盘输入」，源码里两步是连着的：

```c
// main.c:188  xkb_keysym_t xkb = xkb_utf32_to_keysym(ch);
// main.c:160-169  给这个字符追加一个逻辑 keycode，返回 keymap_len 作为编号
static unsigned int append_keymap_entry(struct wtype *wtype, wchar_t ch, xkb_keysym_t xkb)
{
    wtype->keymap = realloc(..., ++wtype->keymap_len * sizeof(...));
    wtype->keymap[wtype->keymap_len - 1].wchr = ch;
    wtype->keymap[wtype->keymap_len - 1].xkb = xkb;
    return wtype->keymap_len;
}
```

每遇到一个当前 keymap 里没有的字符，就分配一个新的逻辑 keycode；解析完参数后先把整份 `xkb_keycodes` 文本序列化出来，用 `zwp_virtual_keyboard_v1_keymap(format=XKB, fd, size)` 传给合成器，然后才逐键发送 `key(logical_code, state)`（`main.c` 里的顺序是 `create_virtual_keyboard` → `upload_keymap` → `run_commands`）。理论上任意码位都能造出一个「键」。

代价落在两处：

一是合成器必须实现 `zwp_virtual_keyboard_manager_v1`。这是 [wlr-protocols](https://gitlab.freedesktop.org/wlroots/wlr-protocols) 里的一个 misc 扩展（由 wlroots 和 smithay 实现），不在 Wayland 核心协议里，也不是每个合成器都注册这个全局。niri 是支持的（`src/niri.rs` 里持有 smithay 的 `VirtualKeyboardManagerState` 并注册该全局）；registry 里绑不到 manager 时 wtype 直接退出并打印 `Compositor does not support the virtual keyboard protocol`。X11 会话下则根本没有这条通道。

二是这份 keymap 会顶替焦点表面正在用的那份。smithay 侧处理 `key` 请求时，先把虚拟键盘的 keymap 作为焦点的键盘布局发下去，再投递按键：

```rust
// smithay/src/wayland/virtual_keyboard/virtual_keyboard_handle.rs
keyboard_handle.send_keymap(user_data, &focus, &vk_state.keymap, vk_state.mods);
...
kbd.key(SERIAL_COUNTER.next_serial().0, time, key, key_state);
```

于是客户端怎么处理自己收到的 keymap 决定了结果。缓存了原 keymap、或者按物理键位回退的实现就会出错——wtype 源码里那张 `text_keycodes[]` 表旁边的注释写得很直白：

```c
// Linux evdev codes for the printable section of a PC keyboard. Chromium may
// fall back to a key's physical meaning even when its keysym is printable.
static const unsigned int text_keycodes[] = { 2, 3, 4, ..., 53, 57, };
```

默认只打文本时（`literal_only` 为真），wtype 会把这些逻辑编号折回真实物理键码去发，正是为了迁就 Chromium 这类行为；这台机器上装的是带 [PR #77](https://github.com/atx/wtype/pull/77)（修 Chromium 的 keymap 处理）的 `wtype-fix-git`，而不是发行版仓库里的 0.4。

XWayland 是这一层最容易出问题的地方。虚拟键盘的事件最终要以 Xwayland 的按键形式送达 X11 客户端，而 wtype 追加的那些逻辑 keycode 只存在于它上传给虚拟键盘的那份 keymap 里；X11 侧的 keycode→keysym 表由 Xwayland 自己维护，两边不同步时，ASCII 这类原生命码里有的字符还能出，靠动态追加的字符就可能变成别的键或什么都不出。这类问题不会有报错，表现为「同一个字符串在原生 Wayland 窗口里正常，在 XWayland 窗口里丢字或错字」，且随合成器版本变化。

### 归纳

- ydotool：字符无法用 keycode 表达 → `type` 打不出中文，越界时还会打错键；`key` 也只是 keycode，没有例外。
- wtype：可以给任意码位造键，但要求合成器支持 wlr 的 virtual-keyboard，并且客户端接受它临时替换的 keymap → XWayland 与 Chromium 一类实现上是兼容性问题的高发区。
- 两者就算都成功「打出了字」，也仍是按键事件，位于输入法上游：fcitx5 处于中文引擎时，这串键会被当作拼音编码去查候选。

`commitString()` 这三处都不涉及：不需要合成器支持某个扩展（走的是 fcitx5 已经建好的输入上下文），不需要把字符折成 keycode，也不产生按键事件，所以输入法引擎的状态不参与。它本来就是输入法向应用交付最终文本的那一步，调用点已经在布局映射和候选处理之后，提交的是 UTF-8 字符串，中文、日文、emoji、组合字符都是同一个动作。

## 实现：一个 fcitx5 全局模块

`fcitx5-text-injector` 是一个独立工具，职责只有「外部程序 → 焦点输入框」这一条通道。模块加载在 fcitx5 进程内部，起一个 Unix stream socket 服务，收到 JSON 命令后调用 `commitString()`：

```
外部程序                          fcitx5 进程
   │                                │
   │  Unix Socket (JSON)            │  ┌──────────────────────────────┐
   ├───────────────────────────────►│  │ text_injector.so             │
   │  {"type":"commit",             │  │                              │
   │   "text":"你好世界"}            │  │  IPC Server ──► commitString()│
   │                                │  │                              │
   │  ◄── {"success":true} ────────┤  └──────────────────────────────┘
```

代码只有四个文件：`src/module.cpp`（fcitx5 模块本体）、`src/ipc_server.cpp`（socket 服务）及各自头文件。

线程模型是这里唯一需要留意的地方。accept 循环跑在独立线程上：

```cpp
// ipc_server.cpp:125
accept_thread_ = std::thread([this] { acceptLoop(); });
```

而 `InputContext` 不是线程安全的，跨线程直接调用会破坏 fcitx5 的事件序。做法是在模块构造时把 `EventDispatcher` 绑到主事件循环，IPC 线程只负责把闭包排进去：

```cpp
// module.cpp:56
event_dispatcher_.attach(&instance_->eventLoop());

// module.cpp:66-78
ipc_server_ = std::make_unique<IPCServer>(
    socket_path_,
    [this](const std::string &text) {
        event_dispatcher_.schedule([this, text] { commitText(text); });
    },
    ...);
```

析构里对应 `detach()`，停止顺序是先 `ipc_server_->stop()`（join 线程）再解绑。

真正的提交先取最近聚焦的输入上下文，再判断它当前是否有焦点：

```cpp
// module.cpp:144-157
void TextInjectorModule::commitText(const std::string &text) {
    auto *ic = instance_->lastFocusedInputContext();
    if (!ic || !ic->hasFocus()) {
        FCITX_WARN() << "commitText: no focused input context";
        return;
    }
    if (text.empty()) {
        return;
    }
    clearUI();
    ic->commitString(text);
}
```

焦点缺失是这条路径唯一的失败模式，但它目前只体现在 fcitx5 的日志里（`commitText: no focused input context`）。IPC 层对 `commit` 一律回 `{"success": true}`，协议里带 `error` 字段的分支只有空文本和未知命令两类。也就是说响应为 true 不代表文字落进了输入框，验证要落在界面上。

### IPC 协议

socket 默认在 `$XDG_RUNTIME_DIR/text-injector.sock`，备选 `/tmp/text-injector-<uid>.sock`，可在 `~/.config/fcitx5/conf/text_injector.conf` 里覆盖：

```ini
[TextInjector]
SocketPath=/custom/path/to/socket.sock
```

每个请求是一个 JSON 对象，发完关闭写端（`SHUT_WR`），服务端读到 EOF 后回一个 JSON 响应。命令共五条：`ping`、`commit`、`show`（在输入面板显示状态消息）、`preedit`（显示预编辑文本、模拟组合状态）、`clear`（清除面板内容）。

`commit` 支持多行：字符串里的 `\n` 原样留在 `commitString()` 的参数里，模块本身不会额外发出 Enter 键。落到界面上是换行还是提交，取决于接收方对文本里换行的处理，与粘贴行为一致。

```bash
echo '{"type":"commit","text":"第一段\n第二段"}' \
  | socat - UNIX-CONNECT:$XDG_RUNTIME_DIR/text-injector.sock
```

Python 侧十几行就够：

```python
import json, os, socket

def send_command(cmd: dict) -> dict:
    path = os.path.expandvars("$XDG_RUNTIME_DIR/text-injector.sock")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.connect(path)
        s.sendall(json.dumps(cmd).encode())
        s.shutdown(socket.SHUT_WR)
        return json.loads(s.recv(4096))
```

`preedit`/`show`/`clear` 不是装饰：调用方有时需要一条不占用应用输入框的反馈通道，而 fcitx5 的输入面板本来就是为「显示组合中的文本」准备的，复用它能省去一个悬浮窗程序。

## 与 wtype / ydotool 的对比

| | ydotool | wtype | fcitx5-text-injector |
| --- | --- | --- | --- |
| 注入点 | 内核 `/dev/uinput` | 合成器 `zwp_virtual_keyboard_v1` | fcitx5 的输入上下文 |
| 表达单位 | keycode | keycode + 自行上传的 xkb keymap | UTF-8 文本 |
| 中文 | 无法输入，`type` 对表外字符越界打错键 | 靠追加逻辑 keycode 造键，成败看合成器和客户端 | 直接交付最终文本 |
| 会话范围 | X11、Wayland、VT、fbdev 都行 | 仅实现了该 wlr 扩展的合成器 | X11、Wayland 都行，取决于 fcitx5 |
| 额外权限 | `/dev/uinput` 访问权 + 守护进程 | 无 | 无 |
| 前置条件 | ydotoold 在跑 | 合成器注册该全局 | fcitx5 必须在运行 |
| 失败表现 | 打出别的键或无输出 | 丢字、错字，界面无报错 | 无焦点时只在日志里告警 |

代价说清楚：它把可用性绑在输入法框架上。fcitx5 没跑就没有 socket；换 ibus 需要另写一个模块。以及「文字经过输入法」在这里是优点而不是缺点——调用点已经在候选处理之后。

## 实际用法：文字与按键分通道

文字与按键分开之后，调用方的输入是两条互不相干的通道，`remote-input-board` 就是这么接的：

```
文字：Unix socket JSON → fcitx5-text-injector → ic->commitString()
按键：ydotool 或 wtype → 合成按键事件（回车等控制键）
```

文字不再受输入法状态影响，中文、日文、emoji 原样进入；回车这类真正的按键保留在后端里，`KEY_BACKEND` 在 ydotool 与 wtype 之间切换，不做自动回退。多行文本原样提交，换行不触发回车——这两条通道分开之后才是可控的。

## 验证

```bash
ls -la /usr/lib/fcitx5/text_injector.so                     # 模块已安装
ls -la "$XDG_RUNTIME_DIR/text-injector.sock"                # socket 已建
echo '{"type":"ping"}' | socat - UNIX-CONNECT:$XDG_RUNTIME_DIR/text-injector.sock
# {"pong":true}
```

`ping` 通了但界面上没出字，去 fcitx5 的日志里看是否走到了 `no focused input context` 这条分支（fcitx5 由 xdg autostart 拉起，单元名带 `@autostart`）：

```bash
journalctl --user --no-pager | grep -i "commitText" | tail
```

构建：

```bash
cd packaging/arch && makepkg -f && sudo pacman -U fcitx5-text-injector-*.pkg.tar.zst
# 或
mkdir build && cd build
cmake .. -DCMAKE_INSTALL_PREFIX=/usr -DCMAKE_BUILD_TYPE=Release && cmake --build build
```

依赖 fcitx5 开发头文件、nlohmann-json、cmake ≥ 3.10、C++20 编译器。装完需要重启 fcitx5 才会加载新模块。

## 后记

`wtype` 手册的自我描述是「像 xdotool type 那样模拟键盘输入，通过 virtual-keyboard 协议」——这句话里就写着它和输入法的冲突点：它模拟的是键盘，不是文本。程序化输入只要落在按键层，就必须和输入法商量；落在 `commitString` 层，就不需要商量。

另一条经验：这类「系统里已经有一个专门干这事的概念」的场景（把最终文本交付给应用），优先去找框架自己的 API，而不是在更底层伪造输入。fcitx5 的 `InputContext` / `CommitString`、Wayland 的 text-input 与 input-_method 协议族，本质都是同一个接口的不同实现。

顺带说明适用范围：注入到焦点输入框只覆盖「文本框」这一类目标。需要全局快捷键、需要游戏或裸 X 客户端响应按键时，按键模拟仍然不可替代——所以最终形态是两套通道并存，而不是一个工具取代另一个。

把三次排查串起来看，按键模拟路径上其实有三层彼此独立的关口：keycode 层能不能表达某个字符，取决于所加载的键盘布局；上传替换 keymap 能不能生效，取决于合成器和客户端各自的处理；输入法会不会拦截这次按键，取决于引擎的当前状态。三层中任何一层的差异，都能让同一行脚本得到不同的结果，而报错信息往往只在最后一层，甚至完全没有。
