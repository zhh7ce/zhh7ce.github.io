(function () {
  var CFG = {
    json: "/assets/live2d-whale/model/c_0120.model3.json",
    height: 200,
    hOffset: 40,
    vOffset: 0,
    idleGroup: "idle",
    tapGroup: "tap",
    maxFPS: 30,
    minWidth: 800
  };

  function info() {
    console.log.apply(console, ["[鲸鱼娘]"].concat([].slice.call(arguments)));
  }

  if (typeof PIXI === "undefined") {
    console.error("[鲸鱼娘] pixi.min.js 没加载成功");
    return;
  }
  if (!PIXI.live2d || !PIXI.live2d.Live2DModel) {
    console.error("[鲸鱼娘] cubism4.min.js 没挂上 PIXI.live2d");
    return;
  }
  if (!window.Live2DCubismCore) {
    console.error("[鲸鱼娘] live2dcubismcore.min.js 没加载成功");
    return;
  }
  info("运行时就绪，开始加载模型");

  var canvas, app, model, core, mask = null;

  function localPoint(clientX, clientY) {
    var r = canvas.getBoundingClientRect();
    return {
      x: (clientX - r.left - model.x) / model.scale.x,
      y: (clientY - r.top - model.y) / model.scale.y
    };
  }

  function buildMask() {
    try {
      var w = Math.max(1, Math.round(core.width / 6));
      var h = Math.max(1, Math.round(core.height / 6));
      var rt = PIXI.RenderTexture.create({ width: w, height: h });
      app.renderer.render(model, { renderTexture: rt });
      var buf = app.renderer.texture.readPixels(rt);
      rt.destroy(true);
      var m = new Uint8Array(w * h);
      var filled = 0;
      for (var i = 0; i < m.length; i++) {
        if (buf[i * 4 + 3] > 24) { m[i] = 1; filled++; }
      }
      if (filled < 50) return;
      mask = { data: m, w: w, h: h };
    } catch (e) {
      /* 掩码失败时退回整块画布命中 */
    }
  }

  function hit(clientX, clientY) {
    if (!mask) return true;
    var p = localPoint(clientX, clientY);
    var mx = Math.floor(p.x / core.width * mask.w);
    var my = Math.floor(p.y / core.height * mask.h);
    if (mx < 0 || my < 0 || mx >= mask.w || my >= mask.h) return false;
    return mask.data[my * mask.w + mx] === 1;
  }

  function place() {
    canvas.style.width = app.screen.width + "px";
    canvas.style.height = app.screen.height + "px";
    canvas.style.position = "fixed";
    canvas.style.right = CFG.hOffset + "px";
    canvas.style.bottom = CFG.vOffset + "px";
    canvas.style.zIndex = 5;
    canvas.style.pointerEvents = "none";
  }

  function bind() {
    window.addEventListener("mousemove", function (e) {
      var over = hit(e.clientX, e.clientY);
      canvas.style.pointerEvents = over ? "auto" : "none";
      if (!over) return;
      var p = localPoint(e.clientX, e.clientY);
      model.focus(p.x, p.y);
    });

    canvas.addEventListener("click", function (e) {
      if (hit(e.clientX, e.clientY)) model.motion(CFG.tapGroup);
    });

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) app.ticker.stop();
      else app.ticker.start();
    });
  }

  function boot() {
    return PIXI.live2d.Live2DModel.from(CFG.json, {
      autoInteract: false,
      idleMotionGroup: CFG.idleGroup
    }).then(function (m) {
      model = m;
      core = model.internalModel;
      model.autoUpdate = false;

      var w = Math.round(CFG.height * core.width / core.height);
      app.resize(w, CFG.height);
      model.scale.set(CFG.height / core.height);
      model.anchor.set(0.5, 1);
      model.x = w / 2;
      model.y = CFG.height;
      app.stage.addChild(model);

      place();
      buildMask();
      bind();
      app.ticker.add(function () { model.update(app.ticker.deltaMS); });
    });
  }

  function init() {
    if (window.innerWidth < CFG.minWidth) {
      info("窗口宽度 " + window.innerWidth + "px < " + CFG.minWidth + "px，不加载");
      return;
    }

    app = new PIXI.Application({
      width: CFG.height,
      height: CFG.height,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 1.5),
      powerPreference: "low-power"
    });
    app.ticker.maxFPS = CFG.maxFPS;
    canvas = app.view;
    canvas.id = "whale-widget";
    document.body.appendChild(canvas);
    place();
    boot().then(function () {
      info("模型就绪");
    }).catch(function (e) {
      console.error("[鲸鱼娘] 模型加载失败:", e);
    });
  }

  if (document.body) init();
  else document.addEventListener("DOMContentLoaded", init);
})();
