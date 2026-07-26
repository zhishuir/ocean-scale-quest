# -*- coding: utf-8 -*-
"""自建声学分析引擎（纯 numpy，无第三方评分 API）。

流程：WAV 解码 → 重采样 → 分帧 → 有效发声段识别（VAD）→
四维特征提取（气息时长 / 音量稳定性 / 音量均匀度 / 音高稳定性）→
按 config 中的锚点与权重打分 → 生成诊断报告。
"""
import io
import wave

import numpy as np

import config


class AnalysisError(Exception):
    """业务可预期的分析失败（录音无效/过短等），返回给前端的提示信息。"""


# ---------------------------------------------------------------- 解码与预处理

def decode_wav(data: bytes):
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            nch = w.getnchannels()
            sw = w.getsampwidth()
            sr = w.getframerate()
            raw = w.readframes(w.getnframes())
    except Exception:
        raise AnalysisError("无法解析音频文件，请在页面内录音后直接提交（WAV 格式）")

    if sr <= 0 or not raw:
        raise AnalysisError("音频文件为空或已损坏，请重新录音")

    if sw == 2:
        x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif sw == 1:
        x = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif sw == 4:
        x = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise AnalysisError("暂不支持该位深的 WAV 文件，请使用页面内置录音功能")

    if nch > 1:
        x = x[: len(x) // nch * nch].reshape(-1, nch).mean(axis=1)
    return x, sr


def resample(x: np.ndarray, sr: int, target: int) -> np.ndarray:
    if sr == target:
        return x
    n = int(round(len(x) * target / sr))
    if n < 2:
        raise AnalysisError("录音过短，请重新录制")
    src_t = np.linspace(0.0, 1.0, len(x), endpoint=False)
    dst_t = np.linspace(0.0, 1.0, n, endpoint=False)
    return np.interp(dst_t, src_t, x).astype(np.float32)


def frame_signal(x: np.ndarray):
    size, hop = config.AUDIO["frame_size"], config.AUDIO["hop_size"]
    if len(x) < size:
        raise AnalysisError("录音过短，请至少哼唱 1~2 秒后再提交")
    n = 1 + (len(x) - size) // hop
    idx = np.arange(size)[None, :] + hop * np.arange(n)[:, None]
    return x[idx]


# ---------------------------------------------------------------- 有效发声段识别

def detect_voiced(rms: np.ndarray):
    """返回布尔掩码与发声段 (start, end) 列表（帧下标，end 不含）。"""
    peak = float(rms.max())
    if peak < config.VAD["min_peak_rms"]:
        raise AnalysisError("几乎没有检测到声音，请离麦克风近一些、声音放开一点重录")

    thr = max(peak * config.VAD["rel_threshold"], config.VAD["abs_threshold"])
    voiced = rms > thr

    # 填补短间隙（换气/瞬时停顿视为连续），丢弃孤立短段（咳嗽/碰撞等杂音）
    segs = _runs(voiced)
    for i in range(len(segs) - 1):
        if segs[i + 1][0] - segs[i][1] <= config.VAD["max_gap_frames"]:
            voiced[segs[i][1]: segs[i + 1][0]] = True
    segs = [s for s in _runs(voiced) if s[1] - s[0] >= config.VAD["min_seg_frames"]]
    if not segs:
        raise AnalysisError("未识别到有效的哼唱片段，请深吸一口气、平稳地哼唱几秒钟")

    mask = np.zeros_like(voiced)
    for a, b in segs:
        mask[a:b] = True
    return mask, segs


def _runs(mask: np.ndarray):
    diff = np.diff(mask.astype(np.int8), prepend=0, append=0)
    starts = np.where(diff == 1)[0]
    ends = np.where(diff == -1)[0]
    return list(zip(starts.tolist(), ends.tolist()))


# ---------------------------------------------------------------- 特征提取

def pitch_track(frames: np.ndarray, sr: int):
    """FFT 自相关法逐帧估计基频，返回 (f0数组, 有清晰音高的布尔掩码)。"""
    size = frames.shape[1]
    win = frames * np.hanning(size)
    nfft = 2 * size
    spec = np.fft.rfft(win, nfft)
    acf = np.fft.irfft(np.abs(spec) ** 2, nfft)[:, :size]
    acf0 = acf[:, 0] + 1e-12

    lag_lo = max(2, int(sr / config.PITCH["fmax"]))
    lag_hi = min(size - 1, int(sr / config.PITCH["fmin"]))
    seg = acf[:, lag_lo: lag_hi + 1]
    best = seg.argmax(axis=1) + lag_lo
    conf = seg.max(axis=1) / acf0

    f0 = sr / best.astype(np.float64)
    pitched = conf > config.PITCH["conf_threshold"]
    return f0, pitched


def extract_features(x: np.ndarray, sr: int, tone_freq: float = None):
    frames = frame_signal(x)
    rms = np.sqrt((frames ** 2).mean(axis=1))
    mask, segs = detect_voiced(rms)

    hop_sec = config.AUDIO["hop_size"] / sr
    effective_sec = float(mask.sum() * hop_sec)
    longest_sec = float(max(b - a for a, b in segs) * hop_sec)
    if effective_sec < config.VAD["min_effective_sec"]:
        raise AnalysisError(
            "有效发声时长不足 %.0f 秒，请深吸一口气后尽量长地哼唱一声再提交"
            % config.VAD["min_effective_sec"]
        )

    # 发声帧的音量包络（dB），轻度平滑去掉帧间毛刺
    v_rms = rms[mask]
    v_db = 20.0 * np.log10(np.maximum(v_rms, 1e-6))
    k = 5
    v_db_smooth = np.convolve(v_db, np.ones(k) / k, mode="valid") if len(v_db) > k else v_db

    # 音量稳定性：前 1/3 与后 1/3 的平均音量差（正值 = 后段衰减）
    third = max(1, len(v_db_smooth) // 3)
    decay_db = float(max(0.0, v_db_smooth[:third].mean() - v_db_smooth[-third:].mean()))

    # 音量均匀度：去趋势后的波动标准差（避免把整体渐强/渐弱重复计入抖动）
    t = np.arange(len(v_db_smooth))
    trend = np.polyval(np.polyfit(t, v_db_smooth, 1), t) if len(v_db_smooth) > 2 else v_db_smooth
    flutter_db = float((v_db_smooth - trend).std())

    # 音高稳定性：发声帧中有清晰基频的帧，相对中位音高的音分波动
    # 音准准确度：中位音高相对提示音 tone_freq 的音分偏差（八度无关——
    # 男声跟唱女声音区提示音时低一个八度属于"唱准了"，不应判为跑调）
    f0, pitched = pitch_track(frames[mask], sr)
    f0p = f0[pitched]
    accuracy_cents = None
    if len(f0p) < max(3, int(config.PITCH["min_pitched_ratio"] * mask.sum())):
        pitch_cents = config.DIMENSIONS["pitch_stability"]["worst"]
        pitch_note = "未检测到清晰连贯的音高"
    else:
        median_f0 = float(np.median(f0p))
        cents = 1200.0 * np.log2(f0p / median_f0)
        cents = cents[np.abs(cents) < config.PITCH["octave_cents"]]  # 剔除倍频错误
        pitch_cents = float(cents.std()) if len(cents) else config.DIMENSIONS["pitch_stability"]["worst"]
        pitch_note = None

        if tone_freq and tone_freq > 0:
            diff = 1200.0 * np.log2(median_f0 / tone_freq)
            diff = ((diff + 600.0) % 1200.0) - 600.0  # 折算到最近八度内 [-600, 600)
            accuracy_cents = float(abs(diff))

    measures = {
        "breath": longest_sec,
        "volume_stability": decay_db,
        "volume_evenness": flutter_db,
        "pitch_stability": pitch_cents,
    }
    if accuracy_cents is not None:
        measures["pitch_accuracy"] = accuracy_cents

    return {
        "effective_sec": effective_sec,
        "measures": measures,
        "pitch_note": pitch_note,
    }


# ---------------------------------------------------------------- 打分与报告

def _score(value: float, best: float, worst: float) -> float:
    if best == worst:
        return 100.0
    return float(np.clip(100.0 * (value - worst) / (best - worst), 0.0, 100.0))


def _band(score: float) -> str:
    hi, mid = config.ADVICE_BANDS
    return "good" if score >= hi else ("mid" if score >= mid else "low")


def analyze(data: bytes, tone_freq: float = None) -> dict:
    x, sr = decode_wav(data)
    x = resample(x, sr, config.AUDIO["target_sr"])
    feats = extract_features(x, config.AUDIO["target_sr"], tone_freq)

    # pitch_accuracy 在缺少 tone_freq 或未测到清晰音高时不会出现在 measures 中，
    # 此时按剩余维度重新归一化权重，而不是把它计 0 分拉低总分。
    active = {k: c for k, c in config.DIMENSIONS.items() if k in feats["measures"]}
    total_weight = sum(d["weight"] for d in active.values())
    dims, total = [], 0.0
    for key, cfg in active.items():
        value = feats["measures"][key]
        score = _score(value, cfg["best"], cfg["worst"])
        total += score * cfg["weight"] / total_weight
        advice = config.ADVICE[key][_band(score)]
        if key == "pitch_stability" and feats["pitch_note"]:
            advice = feats["pitch_note"] + "，" + advice
        dims.append({
            "key": key,
            "name": cfg["name"],
            "score": round(score, 1),
            "value": round(value, 1),
            "unit": cfg["unit"],
            "advice": advice,
        })

    total = round(total, 1)
    grade = next(g for th, g in config.GRADES if total >= th)
    weakest = min(dims, key=lambda d: d["score"])
    plan = config.FOCUS_PLAN[weakest["key"]]

    return {
        "total": total,
        "grade": grade,
        "effective_sec": round(feats["effective_sec"], 1),
        "dimensions": dims,
        "summary": config.GRADE_SUMMARY[grade],
        "focus": {
            "name": weakest["name"],
            "score": weakest["score"],
            "exercise": plan["exercise"],
            "course": plan["course"],
            "course_desc": plan["course_desc"],
        },
    }
