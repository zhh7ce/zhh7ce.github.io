---
layout: post
title: VS Code 里 C++ 自动补全的花括号位置：没有开关，只有 snippet
date: 2026-10-14 04:05:00 +0800
categories: Linux
tag: [vscode, cpp, cpptools, clang-format, snippets]
description: why the opening brace inserted by C++ completion in VS Code can't be reconfigured, and what the format-time alternatives actually do
typora-root-url: ..
author: Qoder
---

需求很具体：在 C++ 文件里敲 `if` 触发补全，希望结果就是 `if (条件) {`，左花括号跟着条件在同一行，而不是另起一行。把设置页里能搜到的 `brace`、`format`、`snippet` 相关项都试了一遍之后没有解决，最后是用自建的 C/Cpp Snippets 扩展提供的补全项绕开的。本文由 Qoder 撰写。

结论先说：补全插入的那一刻，文本由 C/C++ 扩展的语言服务器提供，它不带可配置的花括号风格；带花括号开关的设置全部属于格式化引擎，只在「格式化」这个动作发生时生效，不参与补全。这两者不是同一个阶段，所以在设置里怎么搜都找不到那个开关——不是漏找了，是这个开关不存在。

## 补全项里的花括号是谁写的

`ms-vscode.cpptools` 的补全项里混着一批 snippet，由配置项 `C_Cpp.suggestSnippets` 控制，默认 `true`，官方描述是「If `true`, snippets are provided by the language server」。这批 snippet 的正文不在任何 `.json` 文件里，而是编译进了语言服务器可执行文件 `bin/cpptools`。

用 `strings` 看会得到一个误导性的结果：

```bash
strings -n 4 ~/.vscode/extensions/ms-vscode.cpptools-1.34.4-linux-x64/bin/cpptools | grep -F -A2 'if (${1:condition})'
```

```
if (${1:condition})
	${0:/* code */}
```

花括号凭空不见了。原因是 `-n 4` 只保留四个字符以上的可打印串，而正文里独占一行的 `{` 和 `}` 各只有一个字符，被过滤掉了；换成 `strings -n 1` 就能看到它们各自成一行。按字节直接读更可靠：

```python
import re
data = open('.../bin/cpptools', 'rb').read()
for m in list(re.finditer(rb'if \(\\\$\{1:condition\}\)', data))[:3]:
    print(repr(data[m.start():m.start()+70]))
```

```
b'if (${1:condition})\n{\n\t${0:/* code */}\n}\n\x00\x00...'
b'if (${1:condition})\n{\n\t${2:/* code */}\n}\nelse\n{\n\t${0:/* code */}\n}\n...'
b'int main(int argc, char const *argv[])\n{\n\t${1:/* code */}\n\treturn 0;\n}...'
```

也就是说 `if` 这一条的正文写死成 Allman 风格：`{` 独占一行，`else` 也独占一行；同批的 `main`、`switch`、`for`、`while`、`class` 同样是 `{` 换行。VS Code 核心在采纳补全项时不会改写 snippet 正文，它只负责把 `${1}` 之类的占位符变成可跳转的 tab stop。所以补全出来的花括号在哪一行，完全由上面这串字节决定，而这串字节没有对应的配置项——`C_Cpp` 里关于 snippet 的设置只有 `suggestSnippets` 这一个布尔开关，只能决定「要不要它」，不能决定「它长什么样」。

这就解释了现象：同一个 `if`，从语言服务器补全出来是换行风格，从自己的 snippet 补全出来是同行风格，两者来源不同。

## 能改花括号位置的设置都在另一个阶段

把候选方案按「什么时候生效」排一遍，就能看清它们为什么都不满足需求。

| 方案 | 作用对象 | 生效时机 | 能否让补全结果就是同一行 |
| --- | --- | --- | --- |
| `C_Cpp.suggestSnippets` | 语言服务器的 snippet 列表 | 补全 | 否，只能整批关掉 |
| `C_Cpp.vcFormat.newLine.beforeOpenBrace.*` | VC++ 格式化引擎 | 格式化 | 否 |
| `BreakBeforeBraces` / `BraceWrapping` | clang-format | 格式化 | 否 |
| `typescript.format.placeOpenBraceOnNewLine*` | TS/JS 语言服务 | 格式化 | 不适用 C++ |
| `editor.formatOnType` | 当前语言的格式化器 | 键入触发字符后 | 间接可以，代价见下 |
| 自己的 snippet（扩展或 user snippets） | 补全项正文 | 补全 | 是 |

### vcFormat：确实有同行开关，但只在格式化时生效

C/C++ 扩展自带一个 Visual C++ 格式化引擎，花括号位置是它的一组独立参数：

```json
{
  # "C_Cpp.formatting" 必须显式设为 "vcFormat"，默认值 "default" 走的是 clang-format
  "C_Cpp.formatting": "vcFormat",
  # 下面五项分别对应控制流语句、函数、类型、命名空间、lambda
  "C_Cpp.vcFormat.newLine.beforeOpenBrace.block": "sameLine",
  "C_Cpp.vcFormat.newLine.beforeOpenBrace.function": "sameLine",
  "C_Cpp.vcFormat.newLine.beforeOpenBrace.type": "sameLine",
  "C_Cpp.vcFormat.newLine.beforeOpenBrace.namespace": "sameLine",
  "C_Cpp.vcFormat.newLine.beforeOpenBrace.lambda": "sameLine"
}
```

五个作用域各自的取值是 `newLine` / `sameLine` / `ignore`，默认全是 `ignore`；`sameLine` 的描述原文是「Opening braces are kept on the same line and a space is added before each one」。配套的还有 `C_Cpp.vcFormat.newLine.beforeElse`、`beforeCatch`（默认 `true`）。

两个限制：一是 `C_Cpp.formatting` 默认值为 `default`，其描述明确说「By default, `clang-format` will be used to format code」，只有当被格式化的代码附近有带相应设置的 `.editorconfig`、且 `C_Cpp.clang_format_style` 保持默认 `file` 时才会改用 VC++ 引擎。所以直接改 `vcFormat.*` 而不改 `C_Cpp.formatting`，通常完全没有效果——这副开关藏在另一个引擎里。二是它属于格式化，补全落地时不运行。

### clang-format：同类开关，同样只在格式化时跑

本机装的是 clang-format 23.1.1，`C_Cpp.clang_format_style` 默认 `file`，即优先读工程里的 `.clang-format`。

顺手记下排查中发现的一个自己的配置问题。leetcode 目录下的 `.clang-format`：

```yaml
BasedOnStyle: Google
IndentWidth: 4
BraceWrapping:
  AfterControlStatement: false
  BeforeElse: true
```

`BeforeElse: true` 是想让 `}` 和 `else` 分行，但实测并不生效：

```bash
printf 'int main() {\nif (x)\n{\ny();\n}\nelse\n{\nz();\n}\n}\n' > t.cpp
clang-format --style=file:/path/to/leetcode/.clang-format t.cpp
```

```cpp
int main() {
    if (x) {
        y();
    } else {
        z();
    }
}
```

`IndentWidth: 4` 生效了（Google 默认 2），`BraceWrapping` 整块没生效。原因是 `BraceWrapping` 只在 `BreakBeforeBraces: Custom` 下被读取；Google 基础风格自带 `BreakBeforeBraces: Attach`，于是所有换行细节都按 Attach 来。补上这一行之后同一份配置才按预期输出：

```yaml
BasedOnStyle: Google
IndentWidth: 4
BreakBeforeBraces: Custom
BraceWrapping:
  AfterControlStatement: false
  BeforeElse: true
```

```cpp
int main() {
    if (x) {
        y();
    }
    else {
        z();
    }
}
```

这个坑和本文主题同一性质：花括号的规则写在了一个不会执行它的地方。附带结论是，即便把 clang-format 配成 `Attach`，它管的也只是已经写下的代码，`if` 补全出来的那一瞬间它不在场。

### TypeScript 有那个开关，C++ 没有

之所以会觉得「这个应该能配」，可能是因为 TypeScript 确实能配。在 VS Code 安装目录里搜内置扩展：

```bash
grep -rl "placeOpenBraceOnNewLine" /usr/share/code/resources/app/extensions/*/package.json
# extensions/typescript-language-features/package.json
```

只有这一个扩展定义 `typescript.format.placeOpenBraceOnNewLineForFunctions` 和 `...ForControlBlocks`，内置的 `cpp` 扩展没有任何同类设置，编辑器核心里也搜不到 `editor.*BracePosition` 之类的通用项。这两项也是它语言服务的格式化参数，作用的仍是格式化动作。换句话说，C++ 这边不存在任何「补全时」的花括号配置；TypeScript 有对应的设置，但管的也是「格式化时」。

### 用 formatOnType 把时机补上，代价是范围失控

既然格式化器能产出同行花括号，那就让它来得更及时：`editor.formatOnType: true`，键入 `}`、`;` 等触发字符后立即格式化，视觉上接近「补全完就是我要的样子」。

代价要写清楚：格式化器处理的是行或块，不是那一个花括号。刚补全出的 `if` 还停在中途时它就可能被触发，条件表达式里的空格、换行、缩进一并被改；未闭合的半截代码被格式化会得到和预期不同的结果；写在顶层的 `editor.formatOnType` 对所有语言同时生效，只想覆盖 C++ 得用 `"[cpp]": { "editor.formatOnType": true }`。本机的这个设置是 `false`：走自建 snippet 这条路之后，排版在插入那一刻已经确定，不需要格式化器来补，也就不必承受上面这些副作用。

### 改扩展不可行

理论上可以把语言服务器的 snippet 改成同行风格，实际做不到：那些字节在 `bin/cpptools` 这个原生可执行文件里，不是 `snippets/*.json`。二进制补丁会在下一次扩展更新时消失，也没有可校验的手段。这一条属于想过但不该走。

## 本机的做法：关掉语言服务器的 snippet，补全项自己提供

`C_Cpp.suggestSnippets` 只能整批关掉，关掉之后 `if`、`for`、`while`、`main` 这些补全项从哪来，就是这一步要解决的。

```json
# ~/.config/Code/User/settings.json（节选）
{
  # 不再提供那批 Allman 风格的内置 snippet
  "C_Cpp.suggestSnippets": false,
  # 自建 snippet 排在补全列表最前
  "editor.snippetSuggestions": "top",
  # 不做键入即格式化
  "editor.formatOnType": false
}
```

补全项由自建的 C/Cpp Snippets 扩展（`zhh7ce.c-cpp-snippets`）提供，正文就是普通 JSON：

```json
# snippets/c_cpp_snippets.json（节选，body 支持整段字符串或按行数组两种写法）
{
  "if": {
    "prefix": "if",
    "body": "if (${1:/* condition */}) {\n\t${0:/* code */}\n}\n",
    "description": "if(…)"
  },
  "main": {
    "prefix": "main",
    "body": [
      "int main(int argc, char const *argv[]) {",
      "\t${1:/* code */}",
      "\treturn 0;",
      "}\n"
    ],
    "description": "main(…)"
  }
}
```

`contributes.snippets` 把同一份文件挂到 `c`、`cpp`、`h`、`hpp` 四个「语言」上，其中只有前两个是 VS Code 的语言标识符：内置 cpp 扩展的语言定义里，`c` 收 `.c`/`.i`，`cpp` 收 `.cpp`、`.h`、`.hpp` 等一串后缀，并不存在名为 `h` 或 `hpp` 的语言，那两条声明不会命中任何文件（头文件本来就走 `cpp` 那份）。补全出来的第一个字符序列就已经是 `) {`，VS Code 与语言服务器都不再参与花括号的决定。

```bash
python3 -c "
import json
d = json.load(open('/usr/share/code/resources/app/extensions/cpp/package.json'))
for l in d['contributes']['languages']: print(l['id'], l.get('extensions'))
"
```

不想做扩展的等价方案是 user snippets：把上面这段 JSON 放进 `~/.config/Code/User/snippets/cpp.json`，同样生效，且改完即时无需重载。两者差别只在分发方式——扩展形态便于跨机器安装和版本化，user snippets 便于随手改。

这套配置和格式化器并存不冲突，分工是按阶段划开的：补全阶段由 snippet 决定排版，所以内置那批必须关掉；保存或手动格式化阶段仍由 clang-format 兜底，负责把非补全产生的代码（手写、粘贴、重构）对齐到同一套风格。前提是两边风格一致——本机的 `.clang-format` 是 `Attach` 系（Google 基础），与自建 snippet 的同行写法一致；若哪天把格式化器换成 Allman，补全出来的同行花括号会在下一次保存时被整体挪走，看起来就像「snippet 失效了」。

## 验证

```bash
# 内置 snippet 正文与风格
strings -n 4 ~/.vscode/extensions/ms-vscode.cpptools-*/bin/cpptools | grep -E '\$\{1:condition\}'

# 相关的设置项都在哪个扩展里
grep -rn '"C_Cpp.suggestSnippets"' ~/.vscode/extensions/ms-vscode.cpptools-*/package.json
grep -rl "placeOpenBraceOnNewLine" /usr/share/code/resources/app/extensions/*/package.json

# 自己的 snippet 扩展挂上了哪些语言
python3 -c "import json;print(json.load(open('/home/$USER/.vscode/extensions/zhh7ce.c-cpp-snippets-0.1.1/package.json'))['contributes'])"

# 格式化器行为
clang-format --style=file:<project>/.clang-format t.cpp
clang-format --style='{BasedOnStyle: Google, BreakBeforeBraces: Allman}' t.cpp
```

编辑器里确认的方式：在 `.cpp` 文件敲 `if` 打开补全列表，选中项的预览应当是自己的模板；如果同时出现两份 `if`，说明 `C_Cpp.suggestSnippets` 没生效（它是 `resource` 级作用域，可能被工作区设置覆盖）。

## 后记

这次排查真正的结论只有一句：补全和格式化是两个阶段，而 VS Code 的设置页把它们混在同一个搜索框里。搜 `brace` 出来的结果全部属于后者，前者的内容属于语言服务器的静态数据，没有配置入口。判断某个设置属于哪个阶段，办法是看它挂在哪个扩展的 `contributes.configuration` 下、以及描述里出现的动词是「provide/suggest」还是「format」。

第二点：`BraceWrapping` 需要 `BreakBeforeBraces: Custom` 这件事，配置文件本身不会报错，写了就写了，效果上等于没写。这类「静默失效」的配置项值得用命令行版本单独跑一次小样本验证，成本比在编辑器里反复试低得多。

第三点：关掉 `C_Cpp.suggestSnippets` 是有代价的交易——语言服务器那批 snippet 里还有 `class`、`switch`、`#ifndef` 之类自己没覆盖的条目，关掉之后它们一起没了，需要自己补。本机选择接受这个代价，因为内置那批的排版风格正是需求要改的东西，而它改不了。
