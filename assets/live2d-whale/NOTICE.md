# DS 鲸鱼娘 Live2D 素材许可与署名

## 模型与角色形象（`model/`）

CC BY-NC-SA 4.0（署名 — 非商业性使用 — 相同方式共享），版权属以下三位：

| 版权所有人 | 贡献 | 主页 |
| --- | --- | --- |
| 上善无形 | 鲸鱼娘角色形象原作，原创 OC「溟月」 | https://space.bilibili.com/4456176 |
| ZipZipPipe | 加入 DeepSeek 元素的「女仆鲸鱼娘」二次设计 | https://space.bilibili.com/4168597 |
| 氵六青 | Live2D 模型（绑定、动作、表情） | https://space.bilibili.com/11272072 |

形象链：上善无形「溟月」→ ZipZipPipe 女仆鲸鱼娘 → 氵六青 Live2D 化。

获取地址：https://github.com/Andersen216/dsh-whale-girl-live2d （该仓库代码 MIT，美术素材 CC BY-NC-SA 4.0）

本仓库所做的修改：

1. `model/motions/` 下的动作文件由中文名重命名为 ASCII（`自拍.motion3.json` → `selfie.motion3.json` 等）；
2. `c_0120.model3.json` 重写：把 7 个一次性动作合并进一个 `tap` 组，未复制 `expressions/` 与 `manifest.json`。

模型画面本身未作改动。

## 运行时（`vendor/`）

| 组件 | 版本 | 许可 |
| --- | --- | --- |
| PIXI.js | 6.5.10 | MIT |
| pixi-live2d-display（`cubism4.min.js`） | 0.4.0 | MIT |
| Live2D Cubism Core | — | Live2D Proprietary License（SDK 可再分发代码） |

`whale-widget.js` 为本仓库自写，随博客代码一起发布。

## 使用范围

本博客为无广告、无收费的个人非商业站点，符合 NC 条件。若后续引入广告、赞赏或任何变现形式，需先向三位原作者确认商用授权。
