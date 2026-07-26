# -*- coding: utf-8 -*-
"""海底音阶之旅 — Flask 后端。

游戏本体是纯静态页（static/game.html），不依赖后端、不上传音频，
可直接托管到 GitHub Pages。/api/analyze 是保留的哼鸣五维评测接口，
供后续需要时接入，当前游戏页面未调用它。
"""
from flask import Flask, jsonify, redirect, request, url_for

import config
from engine import AnalysisError, analyze

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = config.AUDIO["max_upload_mb"] * 1024 * 1024


@app.route("/")
def index():
    return redirect(url_for("static", filename="game.html"))


@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    file = request.files.get("audio")
    if file is None:
        return jsonify({"error": "未收到音频文件，请录音后再提交"}), 400
    tone_freq = request.form.get("tone_freq", type=float)
    try:
        result = analyze(file.read(), tone_freq)
    except AnalysisError as e:
        return jsonify({"error": str(e)}), 400
    except Exception:
        app.logger.exception("analyze failed")
        return jsonify({"error": "音频分析失败，请重新录制后再试"}), 500
    return jsonify(result)


@app.errorhandler(413)
def too_large(_):
    return jsonify({"error": "音频文件超过 %d MB 限制，请缩短录音时长" % config.AUDIO["max_upload_mb"]}), 413


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
