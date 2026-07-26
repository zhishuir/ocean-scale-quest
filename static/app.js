/* 哼鸣跟唱智能测评 — 前端逻辑
 * 提示音：Web Audio 合成（基频+泛音+包络，自然无爆音）
 * 录音：getUserMedia + ScriptProcessor 采集 PCM，本地编码 16bit WAV（无需转码组件）
 * 可视化：AnalyserNode 实时波形 + 音量条
 */
(function () {
  "use strict";

  var MAX_SEC = 30; // 自动停录时长（10MB 限制内绰绰有余）

  var $ = function (id) { return document.getElementById(id); };
  var panels = { tone: $("panelTone"), record: $("panelRecord"), loading: $("panelLoading"), report: $("panelReport") };

  // ---------------- 步骤条 ----------------
  function setStep(n) {
    document.querySelectorAll(".step").forEach(function (el) {
      var s = +el.dataset.step;
      el.classList.toggle("active", s === n);
      el.classList.toggle("done", s < n);
    });
  }

  // ---------------- 提示音合成 ----------------
  var toneCtx = null, toneFreq = 294, tonePlaying = false;

  document.querySelectorAll("#toneSeg .seg-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("#toneSeg .seg-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      toneFreq = +btn.dataset.freq;
    });
  });

  $("btnTone").addEventListener("click", function () {
    if (tonePlaying) return;
    toneCtx = toneCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (toneCtx.state === "suspended") toneCtx.resume();

    var now = toneCtx.currentTime, dur = 3.0;
    var master = toneCtx.createGain();
    var lp = toneCtx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 2200; lp.Q.value = 0.6;
    master.connect(lp); lp.connect(toneCtx.destination);

    // 平滑包络：淡入-保持-淡出，杜绝爆音
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.5, now + 0.15);
    master.gain.setValueAtTime(0.5, now + dur - 0.4);
    master.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    // 基频 + 泛音，模拟自然人声哼鸣的音色
    [[1, 0.62], [2, 0.22], [3, 0.1], [4, 0.05]].forEach(function (h) {
      var osc = toneCtx.createOscillator();
      var g = toneCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = toneFreq * h[0];
      g.gain.value = h[1];
      osc.connect(g); g.connect(master);
      osc.start(now); osc.stop(now + dur);
    });

    tonePlaying = true;
    $("btnToneText").textContent = "播放中…";
    setTimeout(function () {
      tonePlaying = false;
      $("btnToneText").textContent = "再听一遍";
      setStep(2);
    }, dur * 1000);
  });

  // ---------------- 录音 ----------------
  var recCtx = null, stream = null, source = null, proc = null, analyser = null;
  var chunks = [], recSampleRate = 44100, recording = false, startTime = 0, rafId = 0, timerId = 0;
  var wavBlob = null;

  var canvas = $("wave"), cctx = canvas.getContext("2d");
  drawIdle();

  $("btnRec").addEventListener("click", function () { recording ? stopRec() : startRec(); });
  $("btnRetry").addEventListener("click", function () { hidePreview(); showMsg(""); });
  $("btnAgain").addEventListener("click", function () {
    panels.report.classList.add("hidden");
    panels.tone.classList.remove("hidden");
    panels.record.classList.remove("hidden");
    hidePreview(); showMsg(""); setStep(1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  function startRec() {
    showMsg("");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return showMsg("当前浏览器不支持录音，请使用最新版 Chrome / Safari / Edge。");
    }
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    }).then(function (s) {
      stream = s;
      recCtx = new (window.AudioContext || window.webkitAudioContext)();
      recSampleRate = recCtx.sampleRate;
      source = recCtx.createMediaStreamSource(stream);

      analyser = recCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      proc = recCtx.createScriptProcessor(4096, 1, 1);
      chunks = [];
      proc.onaudioprocess = function (e) {
        chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(proc);
      proc.connect(recCtx.destination); // 部分浏览器要求接入输出节点才会回调

      recording = true;
      startTime = Date.now();
      $("btnRec").classList.add("recording");
      $("btnRecText").textContent = "停止录音";
      hidePreview();
      timerId = setInterval(updateTimer, 200);
      drawLive();
    }).catch(function () {
      showMsg("无法访问麦克风：请检查浏览器地址栏的麦克风权限，允许后重试。");
    });
  }

  function stopRec() {
    if (!recording) return;
    recording = false;
    clearInterval(timerId);
    cancelAnimationFrame(rafId);
    if (proc) { proc.disconnect(); proc.onaudioprocess = null; }
    if (source) source.disconnect();
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    if (recCtx) recCtx.close();

    $("btnRec").classList.remove("recording");
    $("btnRecText").textContent = "开始录音";
    $("volFill").style.width = "0%";
    drawIdle();

    var total = chunks.reduce(function (n, c) { return n + c.length; }, 0);
    if (total / recSampleRate < 1.2) {
      return showMsg("录音太短了，请深吸一口气，尽量长地哼唱几秒钟再停止。");
    }
    wavBlob = encodeWav(chunks, recSampleRate);
    if (wavBlob.size > 10 * 1024 * 1024) {
      return showMsg("录音文件超过 10MB，请控制在 " + MAX_SEC + " 秒以内。");
    }
    $("player").src = URL.createObjectURL(wavBlob);
    $("previewBox").classList.remove("hidden");
  }

  function updateTimer() {
    var sec = (Date.now() - startTime) / 1000;
    var m = String(Math.floor(sec / 60)).padStart(2, "0");
    var s = String(Math.floor(sec % 60)).padStart(2, "0");
    $("timer").textContent = m + ":" + s;
    if (sec >= MAX_SEC) stopRec();
  }

  // ---------------- 实时可视化 ----------------
  function drawLive() {
    if (!recording) return;
    var buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);

    var w = canvas.width, h = canvas.height;
    cctx.clearRect(0, 0, w, h);
    var grad = cctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "#8b5cf6");
    grad.addColorStop(1, "#ec4899");
    cctx.strokeStyle = grad;
    cctx.lineWidth = 2.4;
    cctx.beginPath();
    for (var i = 0; i < buf.length; i++) {
      var x = i / buf.length * w;
      var y = buf[i] / 255 * h;
      i ? cctx.lineTo(x, y) : cctx.moveTo(x, y);
    }
    cctx.stroke();

    // 音量条（RMS）
    var sum = 0;
    for (var j = 0; j < buf.length; j++) { var d = (buf[j] - 128) / 128; sum += d * d; }
    var rms = Math.sqrt(sum / buf.length);
    $("volFill").style.width = Math.min(100, rms * 320) + "%";

    rafId = requestAnimationFrame(drawLive);
  }

  function drawIdle() {
    var w = canvas.width, h = canvas.height;
    cctx.clearRect(0, 0, w, h);
    cctx.strokeStyle = "rgba(255,255,255,.18)";
    cctx.lineWidth = 2;
    cctx.setLineDash([6, 8]);
    cctx.beginPath();
    cctx.moveTo(0, h / 2); cctx.lineTo(w, h / 2);
    cctx.stroke();
    cctx.setLineDash([]);
  }

  // ---------------- WAV 编码（16bit PCM 单声道） ----------------
  function encodeWav(chunks, sampleRate) {
    var total = chunks.reduce(function (n, c) { return n + c.length; }, 0);
    var buf = new ArrayBuffer(44 + total * 2);
    var v = new DataView(buf);
    var writeStr = function (off, s) { for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

    writeStr(0, "RIFF"); v.setUint32(4, 36 + total * 2, true); writeStr(8, "WAVE");
    writeStr(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    writeStr(36, "data"); v.setUint32(40, total * 2, true);

    var off = 44;
    chunks.forEach(function (c) {
      for (var i = 0; i < c.length; i++) {
        var s = Math.max(-1, Math.min(1, c[i]));
        v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        off += 2;
      }
    });
    return new Blob([buf], { type: "audio/wav" });
  }

  // ---------------- 提交与报告 ----------------
  $("btnSubmit").addEventListener("click", function () {
    if (!wavBlob) return;
    panels.tone.classList.add("hidden");
    panels.record.classList.add("hidden");
    panels.loading.classList.remove("hidden");

    var fd = new FormData();
    fd.append("audio", wavBlob, "recording.wav");
    fd.append("tone_freq", toneFreq);
    fetch("/api/analyze", { method: "POST", body: fd })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j }; }); })
      .then(function (res) {
        panels.loading.classList.add("hidden");
        if (!res.ok) {
          panels.tone.classList.remove("hidden");
          panels.record.classList.remove("hidden");
          return showMsg(res.data.error || "分析失败，请重试。");
        }
        renderReport(res.data);
      })
      .catch(function () {
        panels.loading.classList.add("hidden");
        panels.tone.classList.remove("hidden");
        panels.record.classList.remove("hidden");
        showMsg("网络异常，提交失败，请重试。");
      });
  });

  function renderReport(r) {
    setStep(3);
    panels.report.classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });

    $("gradeChip").textContent = r.grade;
    $("summaryText").textContent = r.summary;
    $("durText").textContent = "有效发声时长 " + r.effective_sec + " 秒";

    // 总分数字滚动 + 圆环动画
    var C = 2 * Math.PI * 52;
    animateNum($("totalScore"), r.total, 1100);
    defer(function () {
      $("ringFg").style.strokeDashoffset = C * (1 - r.total / 100);
    });

    // 分项卡片
    var grid = $("dimGrid");
    grid.innerHTML = "";
    r.dimensions.forEach(function (d) {
      var cls = d.score >= 80 ? "ok" : d.score >= 60 ? "warn" : "bad";
      var card = document.createElement("div");
      card.className = "dim-card";
      card.innerHTML =
        '<div class="dim-top"><span class="dim-name">' + d.name + '</span>' +
        '<span class="dim-score ' + cls + '">' + d.score + '</span></div>' +
        '<div class="dim-bar"><i></i></div>' +
        '<div class="dim-val">实测：' + d.value + " " + d.unit + '</div>' +
        '<div class="dim-adv">' + d.advice + '</div>';
      grid.appendChild(card);
      defer(function () {
        card.querySelector(".dim-bar i").style.width = d.score + "%";
      });
    });

    $("focusName").textContent = r.focus.name;
    $("focusExercise").textContent = "练习建议：" + r.focus.exercise;
    $("courseName").textContent = r.focus.course;
    $("courseDesc").textContent = r.focus.course_desc;
  }

  function animateNum(el, target, ms) {
    var t0 = performance.now();
    (function tick(t) {
      var p = Math.min(1, (t - t0) / ms);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = (target * eased).toFixed(p === 1 ? 1 : 0);
      if (p < 1) requestAnimationFrame(tick);
    })(t0);
    // 页面在后台时 rAF 不触发，兜底保证最终数值落位
    setTimeout(function () { el.textContent = target.toFixed(1); }, ms + 300);
  }

  // rAF 优先（保证 CSS 过渡动画），后台页兜底直接生效
  function defer(fn) {
    var done = false;
    var once = function () { if (!done) { done = true; fn(); } };
    requestAnimationFrame(once);
    setTimeout(once, 300);
  }

  // ---------------- 工具 ----------------
  function showMsg(text) {
    var el = $("msg");
    if (!text) return el.classList.add("hidden");
    el.textContent = text;
    el.classList.remove("hidden");
  }
  function hidePreview() {
    $("previewBox").classList.add("hidden");
    wavBlob = null;
    $("timer").textContent = "00:00";
  }

  // ---------------- 演示模式：?demo=1 展示示例报告（供顾问向学员演示） ----------------
  if (/[?&]demo=1/.test(location.search)) {
    panels.tone.classList.add("hidden");
    panels.record.classList.add("hidden");
    renderReport({
      total: 78.5, grade: "良好", effective_sec: 5.5,
      summary: "整体表现不错，发声框架已经建立，个别维度还有明显提升空间。针对薄弱项做专项训练，短期内就能有质的飞跃。",
      dimensions: [
        { key: "breath", name: "气息时长", score: 49.9, value: 5.5, unit: "秒", advice: "气息偏短，可能在用胸式浅呼吸。这是最常见也最容易纠正的问题，需要从腹式呼吸练起。" },
        { key: "volume_stability", name: "音量稳定性", score: 77.4, value: 2.6, unit: "dB 衰减", advice: "演唱后段音量出现一定衰减，说明气息分配还不够从容，容易前松后紧。" },
        { key: "volume_evenness", name: "音量均匀度", score: 100, value: 0.8, unit: "dB 波动", advice: "音量输出平稳均匀，喉部与气息的配合协调，听感非常舒服。" },
        { key: "pitch_stability", name: "音高稳定性", score: 96.7, value: 32.5, unit: "音分波动", advice: "音高保持得相当稳定，音准意识和听觉反馈能力都不错。" },
        { key: "pitch_accuracy", name: "音准准确度", score: 71.2, value: 58.3, unit: "音分偏差", advice: "所唱音高与提示音存在一定偏差，'听到的音'和'唱出的音'还没完全对上，多做模唱校准会有明显提升。" }
      ],
      focus: {
        name: "气息时长", score: 49.9,
        exercise: "每天 3 组腹式呼吸练习：鼻子深吸 4 秒感受腹部鼓起，再用'嘶——'音均匀吐气，目标从 10 秒逐步延长到 20 秒。",
        course: "气息筑基训练营",
        course_desc: "4 周系统打通腹式呼吸与横膈膜支撑，解决唱歌没底气、长句唱不完的问题。"
      }
    });
  }
})();
