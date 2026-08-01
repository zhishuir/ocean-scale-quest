/* 海底音阶之旅 — 发声练习小游戏
 * 纯前端实时音高检测（ScriptProcessor + 归一化自相关，与后端 engine.py 同思路），
 * 不上传音频、不依赖后端，可静态托管（本文件与 game.html 同在 static/ 下）。
 *
 * 玩法：13 只海螺排成 do re mi fa sol la xi la sol fa mi re do 的音阶山，
 * 小海豚实时游到你唱的音高；贴住当前海螺稳住 HOLD_MS 毫秒 → 点亮海螺并弹出
 * PERFECT / GREAT / GOOD 判定，镜头随进度向右滚动，全部点亮后按平均偏差评星。
 */
(function () {
  "use strict";

  // ---------------- 常量 ----------------
  var SEMIS = [0, 2, 4, 5, 7, 9, 11, 9, 7, 5, 4, 2, 0];       // 上行到 xi 再下行回 do
  var NAMES = ["do", "re", "mi", "fa", "sol", "la", "xi", "la", "sol", "fa", "mi", "re", "do"];
  var JIANPU = ["1", "2", "3", "4", "5", "6", "7", "6", "5", "4", "3", "2", "1"];
  var HOLD_MS = 60;           // 唱准即过：约 1~2 帧即点亮，不拖沓
  var TOL_CENTS = 85;         // 判定"唱准"的音分容差（八度无关）
  var MIN_RMS = 0.008;        // 低于此音量视为没在唱（放宽，麦克风灵敏度差异大）
  var FMIN = 60, FMAX = 1000;  // 基频搜索范围（Hz），覆盖男低到女高
  var STEP_GAP = 150;         // 相邻海螺的世界坐标间距（px）
  var EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';

  var $ = function (id) { return document.getElementById(id); };

  // ---------------- 状态 ----------------
  var baseFreq = 130.81;                   // do 的频率（音区选择，默认男低 C3）
  var mode = "idle";                       // idle | play | done
  var idx = 0;                             // 当前目标海螺下标
  var holdMs = 0;                          // 连续唱准的累计音频时长（毫秒，按回调帧长累加）
  var hitDevs = [];                        // 每级通过时的平均偏差（音分）
  var holdDevs = [];                       // 当前 hold 期间的偏差采样
  var playStart = 0;
  var muteUntil = 0;                       // 提示音播放期间暂停检测（防止扬声器声音被判成跟唱）
  var curF0 = 0, curCents = null;          // 当前检测结果（cents 为相对目标的折叠偏差）
  var trail = [];                          // 音高轨迹 [{t, s}]（世界坐标）
  var burst = [];                          // 点亮海螺时的气泡爆发
  var rings = [];                          // 命中时扩散的光环
  var judgments = [];                      // PERFECT / GREAT / GOOD 弹字
  var bubbles = [];                        // 环境气泡
  var fishes = [];                         // 环境小鱼
  var shake = 0;                           // 震屏幅度（命中时激发，指数衰减）
  var lastHit = { i: -1, t0: 0 };          // 最近点亮的海螺（用于弹跳动效）
  var dolphin = { x: 160, y: 260, py: 260 };

  // ---------------- 音频 ----------------
  var actx = null, stream = null, proc = null, procSrc = null;

  function ctx() {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    return actx;
  }

  /* 合成一个哼鸣质感的音（基频+泛音+平滑包络） */
  function playNote(freq, dur, vol, when) {
    var c = ctx();
    var t = c.currentTime + (when || 0);
    var master = c.createGain();
    var lp = c.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 2200; lp.Q.value = 0.6;
    master.connect(lp); lp.connect(c.destination);
    master.gain.setValueAtTime(0.0001, t);
    master.gain.exponentialRampToValueAtTime(vol, t + 0.06);
    master.gain.setValueAtTime(vol, t + dur - 0.12);
    master.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    [[1, 0.62], [2, 0.22], [3, 0.1], [4, 0.05]].forEach(function (h) {
      var osc = c.createOscillator(), gn = c.createGain();
      osc.type = "sine"; osc.frequency.value = freq * h[0]; gn.gain.value = h[1];
      osc.connect(gn); gn.connect(master);
      osc.start(t); osc.stop(t + dur);
    });
  }

  function noteFreq(i) { return baseFreq * Math.pow(2, SEMIS[i] / 12); }

  /* YIN 基频估计算法 —— 替代简单自相关，解决男低/女高音区倍频误判。
   *
   * YIN = 差值函数 + 累积均值归一化 + 阈值挑谷 + 抛物线插值。
   * 差值函数对幅值变化不敏感（比自相关更鲁棒）；累积均值归一化消除
   * 倍频/半频假峰（这是自相关在低频男声上最常见的误判源）；抛物线
   * 插值将周期精度推到亚采样级，±5 音分以内。
   *
   * 参考: De Cheveigné & Kawahara (2002), "YIN, a fundamental frequency
   * estimator for speech and music", JASA 111(4).
   */
  function detectPitch(x, sr) {
    var i, n = x.length, rms = 0;
    for (i = 0; i < n; i++) rms += x[i] * x[i];
    rms = Math.sqrt(rms / n);
    if (rms < MIN_RMS) return { f0: 0, conf: 0, rms: rms };

    var tauMax = Math.min(Math.floor(sr / FMIN), Math.floor(n / 2));
    var tauMin = Math.max(2, Math.floor(sr / FMAX));
    if (tauMax <= tauMin + 1) return { f0: 0, conf: 0, rms: rms };

    // Step 1 — 差值函数 d(tau)
    var diff = new Float64Array(tauMax + 1);
    for (var tau = 1; tau <= tauMax; tau++) {
      var s = 0, limit = n - tau;
      for (i = 0; i < limit; i++) {
        var d = x[i] - x[i + tau];
        s += d * d;
      }
      diff[tau] = s;
    }

    // Step 2 & 3 — 累积均值归一化 cmndf
    var cmndf = new Float64Array(tauMax + 1);
    cmndf[0] = 1;
    var cum = 0;
    for (tau = 1; tau <= tauMax; tau++) {
      cum += diff[tau];
      cmndf[tau] = cum > 1e-12 ? diff[tau] * tau / cum : 1;
    }

    // Step 4 — 找第一个低于阈值的谷底（浏览器拾音噪声大，阈值放宽到 0.35）
    var YIN_THR = 0.35;
    var bestTau = 0;
    for (tau = tauMin; tau <= tauMax; tau++) {
      if (cmndf[tau] < YIN_THR) {
        while (tau + 1 <= tauMax && cmndf[tau + 1] < cmndf[tau]) tau++;
        bestTau = tau;
        break;
      }
    }

    // 退路：找不到谷底则取全局最小，始终返回一个结果（让 centsToTarget 去判断）
    if (bestTau === 0) {
      var minVal = Infinity;
      for (tau = tauMin; tau <= tauMax; tau++) {
        if (cmndf[tau] < minVal) { minVal = cmndf[tau]; bestTau = tau; }
      }
    }

    // Step 6 — 抛物线插值
    var better = bestTau;
    if (bestTau > 1 && bestTau < tauMax) {
      var a = cmndf[bestTau - 1], b = cmndf[bestTau], c = cmndf[bestTau + 1];
      var denom = a - 2 * b + c;
      if (Math.abs(denom) > 1e-9) better = bestTau + 0.5 * (a - c) / denom;
    }

    if (better <= 0) return { f0: 0, conf: 0, rms: rms };
    var f0 = sr / better;
    var conf = 1 - Math.min(1, cmndf[bestTau]);
    return { f0: f0, conf: conf, rms: rms };
  }

  /* 与目标的音分偏差，折叠到最近八度（低/高八度唱都算对） */
  function centsToTarget(f0, target) {
    var c = 1200 * Math.log2(f0 / target);
    return ((c + 600) % 1200 + 1200) % 1200 - 600;
  }

  // ---------------- 画布布局（世界坐标 + 镜头） ----------------
  var canvas = $("stage"), g = canvas.getContext("2d");
  var W = canvas.width, H = canvas.height;
  var PADL = 110, PADT = 70, PADB = 100;
  var WORLD_W = PADL + STEP_GAP * (SEMIS.length - 1) + 140;
  var camX = 0;

  function stepX(i) { return PADL + STEP_GAP * i; }               // 世界坐标
  function semiY(s) { return H - PADB - (H - PADT - PADB) * (s / 11); }
  function stepY(i) { return semiY(SEMIS[i]); }
  function clampS(s) { return Math.max(-0.8, Math.min(11.8, s)); }

  function camTarget() {
    if (mode !== "play") return 0;
    return Math.max(0, Math.min(WORLD_W - W, stepX(idx) - W * 0.42));
  }

  /* 唱的音相对 do 的半音数，折叠到 [-0.5, 11.5) 显示 */
  function foldSemi(f0) {
    var s = 12 * Math.log2(f0 / baseFreq);
    s = ((s % 12) + 12) % 12;
    if (s > 11.5) s -= 12;
    return s;
  }

  // ---------------- 海底场景绘制 ----------------
  var seaGrad = g.createLinearGradient(0, 0, 0, H);
  seaGrad.addColorStop(0, "#0d5085");
  seaGrad.addColorStop(0.45, "#0a3364");
  seaGrad.addColorStop(1, "#071c40");
  var DECO = [];
  (function () {   // 沿整个世界铺珊瑚水草（视差 0.5，所以铺到 WORLD_W 即可覆盖）
    var es = ["🪸", "🌿", "🌿", "🪸", "🌿"];
    for (var x = 50; x < WORLD_W; x += 150 + (x * 7919 % 90)) {
      DECO.push({ e: es[DECO.length % es.length], x: x, s: 22 + (x * 31 % 12) });
    }
  })();

  function drawScene(now) {
    g.fillStyle = seaGrad;
    g.fillRect(0, 0, W, H);

    // 顶部水面波光
    g.strokeStyle = "rgba(125,211,252,.3)";
    g.lineWidth = 2;
    for (var l = 0; l < 2; l++) {
      g.beginPath();
      for (var wx = 0; wx <= W; wx += 8) {
        var wy = 12 + l * 9 + Math.sin((wx + camX * 0.6) / 46 + now / (600 + l * 200)) * 3.5;
        wx ? g.lineTo(wx, wy) : g.moveTo(wx, wy);
      }
      g.globalAlpha = 0.5 - l * 0.22;
      g.stroke();
    }
    g.globalAlpha = 1;

    // 透下来的光柱（缓慢摇摆）
    g.save();
    g.globalAlpha = 0.06;
    g.fillStyle = "#7dd3fc";
    for (var r = 0; r < 4; r++) {
      var bx = 110 + r * 240 + Math.sin(now / 4200 + r * 1.7) * 44;
      g.beginPath();
      g.moveTo(bx - 16, 0); g.lineTo(bx + 44, 0);
      g.lineTo(bx + 150, H); g.lineTo(bx + 54, H);
      g.closePath(); g.fill();
    }
    g.restore();

    // 海底沙地
    g.fillStyle = "#12335e";
    g.beginPath();
    g.ellipse(W / 2, H + 34, W * 0.62, 62, 0, 0, 7);
    g.fill();
    g.fillStyle = "#1a4372";
    g.beginPath();
    g.ellipse(W * 0.24, H + 40, W * 0.3, 52, 0, 0, 7);
    g.ellipse(W * 0.82, H + 42, W * 0.26, 56, 0, 0, 7);
    g.fill();

    // 珊瑚与水草（随镜头 0.5 倍视差 + 轻轻摇曳）
    DECO.forEach(function (d, i) {
      var sx = d.x - camX * 0.5;
      if (sx < -40 || sx > W + 40) return;
      g.save();
      g.translate(sx, H - 6);
      g.rotate(Math.sin(now / 1100 + i * 2) * 0.07);
      g.font = d.s + "px " + EMOJI_FONT;
      g.textAlign = "center"; g.textBaseline = "bottom";
      g.globalAlpha = 0.9;
      g.fillText(d.e, 0, 0);
      g.restore();
    });

    // 环境气泡
    if (Math.random() < 0.09) {
      bubbles.push({ x: Math.random() * W, y: H + 8, r: 1.5 + Math.random() * 3.5, v: 0.5 + Math.random(), w: Math.random() * 6.28 });
    }
    bubbles = bubbles.filter(function (b) { return b.y > -12; });
    g.strokeStyle = "rgba(186,230,253,.35)";
    g.lineWidth = 1;
    bubbles.forEach(function (b) {
      b.y -= b.v * 1.6;
      g.beginPath();
      g.arc(b.x + Math.sin(now / 640 + b.w) * 7, b.y, b.r, 0, 7);
      g.stroke();
    });

    // 偶尔游过的小鱼
    if (Math.random() < 0.004 && fishes.length < 3) {
      fishes.push({ x: W + 30, y: 70 + Math.random() * (H - 220), v: 0.8 + Math.random() * 1.1, s: 20 + Math.random() * 8 });
    }
    fishes = fishes.filter(function (f) { return f.x > -40; });
    fishes.forEach(function (f) {
      f.x -= f.v * 1.7;
      g.font = f.s + "px " + EMOJI_FONT;
      g.textAlign = "center"; g.textBaseline = "middle";
      g.globalAlpha = 0.75;
      g.fillText("🐠", f.x, f.y + Math.sin(now / 500 + f.x / 40) * 4);
      g.globalAlpha = 1;
    });
  }

  /* 音级参考线 + 左侧唱名标尺（屏幕坐标，不随镜头滚动） */
  function drawRuler() {
    [0, 2, 4, 5, 7, 9, 11].forEach(function (s, k) {
      var y = semiY(s);
      g.strokeStyle = "rgba(186,230,253,.08)";
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(64, y); g.lineTo(W, y); g.stroke();
      g.fillStyle = "rgba(165,243,252,.55)";
      g.font = "13px sans-serif"; g.textAlign = "right"; g.textBaseline = "middle";
      g.fillText(["do", "re", "mi", "fa", "sol", "la", "xi"][k], 56, y);
    });
  }

  /* 世界坐标层：海螺、轨迹、判定弹字、光环、海豚 */
  function drawWorld(now) {
    // 音高轨迹（最近 3 秒，从海豚处向左回溯，渐隐）
    g.lineWidth = 2.5;
    for (var t2 = 1; t2 < trail.length; t2++) {
      var a = trail[t2 - 1], b = trail[t2];
      if (b.t - a.t > 220) continue;
      var age = (now - b.t) / 3000;
      if (age > 1) continue;
      g.strokeStyle = "rgba(103,232,249," + (0.5 * (1 - age)).toFixed(3) + ")";
      g.beginPath();
      g.moveTo(trailPX(a, now), semiY(clampS(a.s)));
      g.lineTo(trailPX(b, now), semiY(clampS(b.s)));
      g.stroke();
    }

    // 海螺
    for (var i = 0; i < SEMIS.length; i++) {
      var x = stepX(i), y = stepY(i);
      if (x - camX < -80 || x - camX > W + 80) continue;
      var passed = i < idx, active = i === idx && mode === "play";

      // 命中弹跳：刚点亮的海螺放大回弹
      var pop = 1;
      if (i === lastHit.i) {
        var pa = (now - lastHit.t0) / 320;
        if (pa < 1) pop = 1 + 0.45 * Math.sin(Math.min(1, pa) * Math.PI);
      }

      g.save();
      g.translate(x, y);
      g.scale(pop, pop);
      g.font = (active ? 58 : 46) + "px " + EMOJI_FONT;
      g.textAlign = "center"; g.textBaseline = "middle";
      if (passed) {
        g.shadowColor = "#fbbf24"; g.shadowBlur = 18;
      } else if (active) {
        g.shadowColor = "#22d3ee"; g.shadowBlur = 14 + 8 * Math.sin(now / 260);
      } else {
        g.globalAlpha = 0.45;
      }
      g.fillText("🐚", 0, 0);
      g.restore();
      if (passed) {
        g.font = "15px " + EMOJI_FONT;
        g.textAlign = "center"; g.textBaseline = "middle";
        g.fillText("✨", x + 24, y - 24);
      }

      // hold 进度环（贴住海螺的进度）
      if (active && holdMs > 0) {
        var p = Math.min(1, holdMs / HOLD_MS);
        g.strokeStyle = "#34d399"; g.lineWidth = 4;
        g.beginPath(); g.arc(x, y, 40, -Math.PI / 2, -Math.PI / 2 + p * 2 * Math.PI); g.stroke();
      }

      g.fillStyle = passed ? "#fde68a" : active ? "#a5f3fc" : "rgba(186,230,253,.45)";
      g.font = (active ? "bold 16px" : "13px") + " sans-serif";
      g.textAlign = "center"; g.textBaseline = "top";
      g.fillText(NAMES[i], x, y + 34);
      g.fillStyle = "rgba(165,243,252,.5)"; g.font = "11px sans-serif";
      g.fillText(JIANPU[i], x, y + 54);
    }

    drawDolphin(now);

    // 命中扩散光环
    rings = rings.filter(function (r) { return now - r.t0 < 420; });
    rings.forEach(function (r) {
      var p = (now - r.t0) / 420;
      g.strokeStyle = "rgba(251,191,36," + (0.8 * (1 - p)).toFixed(2) + ")";
      g.lineWidth = 3;
      g.beginPath(); g.arc(r.x, r.y, 14 + p * 66, 0, 7); g.stroke();
    });

    // 气泡爆发
    burst = burst.filter(function (p) { return now - p.t0 < p.life; });
    burst.forEach(function (p) {
      var dt = (now - p.t0) / 1000, k = 1 - (now - p.t0) / p.life;
      g.strokeStyle = "rgba(165,243,252," + (0.85 * k).toFixed(2) + ")";
      g.lineWidth = 1.4;
      g.beginPath();
      g.arc(p.x + p.vx * dt, p.y + p.vy * dt, p.r * (0.6 + 0.4 * k), 0, 7);
      g.stroke();
    });

    // PERFECT / GREAT / GOOD 弹字（放大弹入 → 上浮淡出）
    judgments = judgments.filter(function (j) { return now - j.t0 < 900; });
    judgments.forEach(function (j) {
      var age = now - j.t0;
      var sc = age < 120 ? 0.4 + (age / 120) * 0.8 : age < 260 ? 1.2 - (age - 120) / 140 * 0.2 : 1;
      var alpha = age < 600 ? 1 : 1 - (age - 600) / 300;
      g.save();
      g.translate(j.x, j.y - age / 900 * 26);
      g.scale(sc, sc);
      g.font = "bold 28px sans-serif";
      g.textAlign = "center"; g.textBaseline = "middle";
      g.globalAlpha = Math.max(0, alpha);
      g.lineWidth = 5; g.strokeStyle = "rgba(6,20,45,.85)";
      g.strokeText(j.txt, 0, 0);
      g.fillStyle = j.color;
      g.fillText(j.txt, 0, 0);
      g.restore();
    });
  }

  function trailPX(p, now) {
    return dolphin.x - (now - p.t) / 3000 * 220;
  }

  function drawDolphin(now) {
    var tx, ty;
    if (mode === "play") {
      tx = stepX(idx) - 84;
      ty = curF0 > 0 ? semiY(clampS(foldSemi(curF0)))
                     : dolphin.y + Math.sin(now / 520) * 0.8;
    } else {
      tx = PADL + 80;
      ty = H * 0.55 + Math.sin(now / 750) * 9;
    }
    dolphin.x += (tx - dolphin.x) * 0.06;
    dolphin.py = dolphin.y;
    dolphin.y += (ty - dolphin.y) * 0.22;
    var vy = dolphin.y - dolphin.py;
    var on = mode === "play" && curCents !== null && Math.abs(curCents) <= TOL_CENTS;

    g.save();
    g.translate(dolphin.x, dolphin.y);
    g.scale(-1, 1);                                   // 素材海豚朝左，翻转成朝右
    g.rotate(Math.max(-0.4, Math.min(0.4, vy * 0.05)));
    if (on) { g.shadowColor = "#34d399"; g.shadowBlur = 26; }
    g.font = "48px " + EMOJI_FONT;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("🐬", 0, 2);
    g.restore();

    if (on) {
      g.fillStyle = "rgba(52,211,153,.95)";
      g.font = "17px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText("♪", dolphin.x + 30, dolphin.y - 28 + Math.sin(now / 200) * 3);
    }
  }

  function spawnBurst(x, y) {
    for (var i = 0; i < 22; i++) {
      burst.push({
        x: x + (Math.random() - 0.5) * 30, y: y + (Math.random() - 0.5) * 20,
        vx: (Math.random() - 0.5) * 60, vy: -(40 + Math.random() * 90),
        r: 2 + Math.random() * 4, t0: performance.now(), life: 700 + Math.random() * 400,
      });
    }
  }

  function draw(now) {
    camX += (camTarget() - camX) * 0.06;   // 镜头缓动跟随当前海螺

    g.save();
    if (shake > 0.3) {                     // 命中震屏
      g.translate((Math.random() - 0.5) * 2 * shake, (Math.random() - 0.5) * 2 * shake);
      shake *= 0.86;
    } else {
      shake = 0;
    }
    drawScene(now);
    drawRuler();
    g.save();
    g.translate(-camX, 0);
    drawWorld(now);
    g.restore();
    g.restore();
  }

  // ---------------- 游戏主循环 ----------------
  // 检测由 ScriptProcessor 的音频线程回调驱动（约 43ms 一次），
  // 不受后台标签页 rAF 冻结 / 定时器节流影响；rAF 只负责画面渲染。
  var rafId = 0;

  function detectTick(x, sr) {
    if (mode !== "play") return;
    var now = performance.now();
    if (now < muteUntil) return;           // 提示音播放中：暂停判定，防止自己"听见"提示音
    var frameMs = x.length / sr * 1000;
    var det = detectPitch(x, sr);
    curF0 = det.f0;

    if (curF0 > 0) {
      trail.push({ t: now, s: foldSemi(curF0) });
      if (trail.length > 200) trail.shift();
      curCents = centsToTarget(curF0, noteFreq(idx));
      $("stPitch").textContent = nearestName(curF0) + " " + (curCents > 0 ? "+" : "") + curCents.toFixed(0) + "¢";
      $("stPitch").classList.toggle("on", Math.abs(curCents) <= TOL_CENTS);

      if (Math.abs(curCents) <= TOL_CENTS) {
        if (holdMs === 0) holdDevs = [];
        holdMs += frameMs;
        holdDevs.push(Math.abs(curCents));
        if (holdMs >= HOLD_MS) hitStep();
      } else {
        holdMs = Math.max(0, holdMs - frameMs * 2);   // 偶尔飘出容差不清零，缓慢回退（降低难度）
      }
    } else {
      curCents = null;
      holdMs = Math.max(0, holdMs - frameMs * 2);
      $("stPitch").textContent = "—";
      $("stPitch").classList.remove("on");
    }
    $("stTime").textContent = ((now - playStart) / 1000).toFixed(1) + "s";
  }

  function loop() {
    draw(performance.now());
    rafId = requestAnimationFrame(loop);
  }

  function nearestName(f0) {
    var s = Math.round(foldSemi(f0));
    var m = { 0: "do", 1: "do#", 2: "re", 3: "re#", 4: "mi", 5: "fa", 6: "fa#", 7: "sol", 8: "sol#", 9: "la", 10: "la#", 11: "xi", 12: "do" };
    return m[((s % 12) + 12) % 12] || "—";
  }

  function hitStep() {
    var now = performance.now();
    var avg = holdDevs.reduce(function (a, b) { return a + b; }, 0) / holdDevs.length;
    hitDevs.push(avg);

    // 判定与打击感
    var grade = avg <= 25 ? ["PERFECT", "#fbbf24"] : avg <= 50 ? ["GREAT", "#34d399"] : ["GOOD", "#7dd3fc"];
    judgments.push({ x: stepX(idx), y: stepY(idx) - 56, txt: grade[0], color: grade[1], t0: now });
    rings.push({ x: stepX(idx), y: stepY(idx), t0: now });
    lastHit = { i: idx, t0: now };
    shake = grade[0] === "PERFECT" ? 9 : 6;
    spawnBurst(stepX(idx), stepY(idx));
    playNote(noteFreq(idx), 0.26, 0.18);
    if (grade[0] === "PERFECT") playNote(noteFreq(idx) * 2, 0.18, 0.12, 0.06);
    holdMs = 0;

    idx += 1;
    $("stProgress").textContent = Math.min(idx, SEMIS.length) + " / " + SEMIS.length;

    if (idx >= SEMIS.length) return finish();
    updateTarget();
    // 自动播下一个目标音做引导，播放期间暂停判定
    playNote(noteFreq(idx), 0.5, 0.22, 0.25);
    muteUntil = now + 950;
  }

  function updateTarget() {
    var i = Math.min(idx, SEMIS.length - 1);
    $("stTarget").textContent = NAMES[i] + "（" + noteFreq(i).toFixed(0) + " Hz）";
  }

  function finish() {
    stopMic();
    mode = "done";
    var total = (performance.now() - playStart) / 1000;

    // ---- 统计 ----
    var n = hitDevs.length;
    var sum = 0, minD = Infinity, maxD = 0, sumSq = 0;
    var worstI = 0, bestI = 0;
    for (var i = 0; i < n; i++) {
      var d = hitDevs[i];
      sum += d; sumSq += d * d;
      if (d < minD) { minD = d; bestI = i; }
      if (d > maxD) { maxD = d; worstI = i; }
    }
    var avgDev = sum / n;
    var stdDev = Math.sqrt(Math.max(0, sumSq / n - avgDev * avgDev));
    var stars = avgDev <= 25 ? 3 : avgDev <= 50 ? 2 : 1;

    // ---- 等级 ----
    var gradeLabel, gradeColor;
    if (avgDev <= 20)      { gradeLabel = "音准大师 · 完美航线"; gradeColor = "#fbbf24"; }
    else if (avgDev <= 40) { gradeLabel = "唱得很稳 · 继续精进"; gradeColor = "#34d399"; }
    else if (avgDev <= 65) { gradeLabel = "基础扎实 · 潜力巨大"; gradeColor = "#7dd3fc"; }
    else                   { gradeLabel = "完成挑战 · 找到感觉"; gradeColor = "#a5b4fc"; }

    // ---- 一致性 ----
    var consLabel, consTag;
    if (stdDev <= 15)      { consLabel = "各音表现非常均匀"; consTag = "good"; }
    else if (stdDev <= 35) { consLabel = "整体较稳，个别音有波动"; consTag = "ok"; }
    else                   { consLabel = "音准波动较大，需多听示范"; consTag = "warn"; }

    // ---- 诊断建议 ----
    var advice;
    if (stars === 3) {
      advice = "音准控制已达较高水准！下一步可以尝试加快速度、减少犹豫，或者换到另一个音区挑战不同音域的协调感。";
    } else if (stars === 2) {
      advice = "音准框架已经建立，但" + NAMES[worstI] + "音（" + JIANPU[worstI] + "）偏差偏大（" + maxD.toFixed(0) + "¢）。建议单独模唱这个音，先听示范 3 秒，心里默唱再开口，用调音器辅助校准。每天 5 分钟定点练习，一周内就会明显改善。";
    } else {
      advice = "目前还比较依赖本能发声，音高'听到→唱出'的闭环还需要时间建立。建议先不急着通关：① 多听「完整音阶示范」感受音高走向；② 用调音器 APP 练习 do→sol 五个音，每个音稳住 2 秒；③ 每天练 10 分钟，一周后回来再测会有惊喜。";
    }

    // ---- 渲染 ----
    $("stars").innerHTML =
      "★★★".slice(0, stars) + '<span class="dim">' + "★★★".slice(stars) + "</span>";
    $("resultTitle").textContent = gradeLabel;
    $("resultTitle").style.color = gradeColor;
    $("resultDetail").textContent =
      "用时 " + total.toFixed(1) + " 秒 · 平均偏差 " + avgDev.toFixed(0) + " 音分 · " + n + "/" + SEMIS.length + " 通关";

    $("reportMini").innerHTML =
      '<div class="rm-section">' +
        '<div class="rm-title">🎵 音准分析</div>' +
        '<div class="rm-row"><span>平均偏差</span><b>' + avgDev.toFixed(0) + ' 音分</b></div>' +
        '<div class="rm-row"><span>最佳音</span><b>' + NAMES[bestI] + '（' + JIANPU[bestI] + '）+ ' + minD.toFixed(0) + '¢</b></div>' +
        '<div class="rm-row"><span>最需加强</span><b>' + NAMES[worstI] + '（' + JIANPU[worstI] + '）+ ' + maxD.toFixed(0) + '¢</b></div>' +
        '<div class="rm-row"><span>稳定性</span><span class="rm-tag ' + consTag + '">' + consLabel + '</span></div>' +
      '</div>' +
      '<div class="rm-section">' +
        '<div class="rm-title">💡 练习建议</div>' +
        '<div class="rm-advice">' + advice + '</div>' +
      '</div>';

    $("resultOverlay").classList.remove("hidden");
    $("btnPlayText").textContent = "开始挑战";

    // ---- 结算旋律（按表现分级） ----
    if (stars === 3) {
      // 完整上行音阶 do→do'  triumph
      [0, 2, 4, 5, 7, 9, 11, 12].forEach(function (s, k) {
        playNote(baseFreq * Math.pow(2, s / 12) * (k === 7 ? 2 : 1), 0.28, 0.3, k * 0.15);
      });
    } else if (stars === 2) {
      // 主和弦分解 (do-mi-sol-do)
      [0, 4, 7, 12].forEach(function (s, k) {
        playNote(baseFreq * Math.pow(2, s / 12) * 2, 0.3, 0.3, k * 0.18);
      });
    } else {
      // 上行三音鼓励 (do-re-mi)
      [0, 2, 4].forEach(function (s, k) {
        playNote(baseFreq * Math.pow(2, s / 12), 0.32, 0.28, k * 0.22);
      });
    }
  }

  // ---------------- 控制 ----------------
  function startGame() {
    showMsg("");
    stopMic();   // 防御：避免重复开始时挂两条检测链
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return showMsg("当前浏览器不支持录音，请使用最新版 Chrome / Safari / Edge。");
    }
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    }).then(function (s) {
      stream = s;
      var c = ctx();
      procSrc = c.createMediaStreamSource(s);
      proc = c.createScriptProcessor(2048, 1, 1);
      proc.onaudioprocess = function (e) {
        detectTick(e.inputBuffer.getChannelData(0), c.sampleRate);
      };
      procSrc.connect(proc);
      proc.connect(c.destination); // 部分浏览器要求接入输出节点才会回调；输出缓冲恒为静音，无回授

      mode = "play";
      idx = 0; hitDevs = []; trail = []; burst = []; rings = []; judgments = [];
      lastHit = { i: -1, t0: 0 };
      holdMs = 0; playStart = performance.now();
      $("resultOverlay").classList.add("hidden");
      $("stProgress").textContent = "0 / " + SEMIS.length;
      $("btnPlayText").textContent = "结束练习";
      updateTarget();
      playNote(noteFreq(0), 0.8, 0.3);   // 起步先给一个 do 的参考音
      muteUntil = performance.now() + 1100;
    }).catch(function () {
      showMsg("无法访问麦克风：请检查浏览器地址栏的麦克风权限，允许后重试。");
    });
  }

  function stopMic() {
    if (proc) { proc.disconnect(); proc.onaudioprocess = null; proc = null; }
    if (procSrc) { procSrc.disconnect(); procSrc = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  }

  function stopGame() {
    stopMic();
    mode = "idle";
    holdMs = 0; curF0 = 0; curCents = null;
    $("btnPlayText").textContent = "开始挑战";
    $("stPitch").textContent = "—";
  }

  /* 示范：一次连贯播放完整条音阶 */
  function playDemo() {
    if (mode === "play") return showMsg("练习进行中，先点「结束练习」再听示范。");
    showMsg("");
    SEMIS.forEach(function (s, i) {
      playNote(baseFreq * Math.pow(2, s / 12), 0.5, 0.35, i * 0.55);
    });
  }

  function showMsg(text) {
    var el = $("msg");
    if (!text) return el.classList.add("hidden");
    el.textContent = text;
    el.classList.remove("hidden");
  }

  // ---------------- 事件绑定 ----------------
  document.querySelectorAll("#keySeg .seg-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (mode === "play") return showMsg("练习进行中，结束后再切换音区。");
      document.querySelectorAll("#keySeg .seg-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      baseFreq = +btn.dataset.base;
      updateTarget();
    });
  });

  $("btnDemo").addEventListener("click", playDemo);
  $("btnPlay").addEventListener("click", function () {
    mode === "play" ? stopGame() : startGame();
  });
  $("btnRetry").addEventListener("click", function () {
    $("resultOverlay").classList.add("hidden");
    mode = "idle"; idx = 0; camX = 0;
    $("stProgress").textContent = "0 / " + SEMIS.length;
    startGame();
  });

  updateTarget();
  loop();
})();
