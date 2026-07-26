# 海底音阶之旅

面向声乐入门学员的发声游戏化练习：13 只海螺排成 do→xi→do 的音阶山，
小海豚实时游到你唱的音高，贴住海螺唱准即点亮，配合 PERFECT / GREAT / GOOD
打击判定、震屏、镜头随进度推进等反馈，让基础音准练习变得像玩游戏。

纯前端实现（Web Audio + Canvas + 麦克风实时自相关测音高），
**不上传音频、不需要后端**，可以直接作为静态页面部署（GitHub Pages 等）。

## 功能一览

- **13 级音阶关卡**：do re mi fa sol la xi la sol fa mi re do，三个音区可选
  （男低 C3 / 中音 G3 / 女声 C4）
- **听示范**：一次连贯播放完整条音阶
- **自动引导**：每通过一关自动播放下一个目标音，跟着唱即可，无需自己找调
- **实时音高检测**：麦克风音频降采样后做归一化自相关 + 抛物线插值测基频，
  精度约 ±5 音分；判定容差 ±85 音分、稳住约 0.35 秒即算过关（对初学者友好）
- **打击感反馈**：命中按偏差大小弹出 PERFECT / GREAT / GOOD、震屏、光环扩散、
  海螺点亮弹跳、气泡爆发
- **镜头滚动**：视角随通关进度向右平滑推进，营造闯关前进感
- **评星结算**：全部点亮后按平均音准偏差给 1~3 星评价
- **隐私**：音频只在浏览器内实时分析，不上传、不保存

## 本地预览

无需安装依赖，双击 [index.html](index.html)（或 `static/game.html`）用浏览器打开即可；
部分浏览器对 `file://` 下的麦克风权限更严格，如遇无法录音，改用下面任意一种方式起一个本地服务器：

```bash
# 方式一：Python 自带
python -m http.server 8000
# 打开 http://127.0.0.1:8000

# 方式二：本仓库自带的 Flask 入口（会重定向到游戏页）
pip install -r requirements.txt
python app.py
# 打开 http://127.0.0.1:5000
```

## 部署到 GitHub Pages（推荐，免费、零后端）

1. 把整个仓库 push 到 GitHub（见下方「推送到 GitHub」）
2. 仓库页面 → **Settings → Pages**
3. **Source** 选 `Deploy from a branch`，**Branch** 选 `main` / `(root)`，保存
4. 几十秒后即可通过 `https://<用户名>.github.io/<仓库名>/` 访问
   （根目录 [index.html](index.html) 会自动跳转到 `static/game.html`；
   Pages 自带 HTTPS，手机浏览器可直接授权麦克风）

## 推送到 GitHub

```bash
git init
git add .
git commit -m "feat: 海底音阶之旅发声练习游戏"
git branch -M main
git remote add origin <你的仓库地址>
git push -u origin main
```

如果还没有仓库，先在 GitHub 网页上新建一个空仓库（不要勾选自动生成 README），
复制它的地址填入 `<你的仓库地址>`；或安装 [GitHub CLI](https://cli.github.com/)
后用 `gh repo create` 一步创建 + 推送。

## 调参

判定手感相关的常量都在 [static/game.js](static/game.js) 顶部：

- `TOL_CENTS`：判定"唱准"的音分容差，越大越宽松
- `HOLD_MS`：稳住多久才算过关
- `MIN_RMS` / `MIN_CONF`：音量 / 置信度门槛，环境噪声大时可适当调高

## 哼鸣五维评测引擎（可选，未接入游戏页面）

仓库同时保留了一套独立的哼鸣跟唱评测后端（`engine.py` + `config.py` + `app.py`
的 `/api/analyze`）：提交一段跟唱录音和提示音频率，返回气息时长 / 音量稳定性 /
音量均匀度 / 音高稳定性 / 音准准确度五维评分与练习建议，纯 numpy 实现、无第三方
评分 API。当前游戏页面未调用它，如需恢复独立的测评页面或对接课程顾问系统，
可在此基础上加一个前端表单调用该接口。

评分基准、阈值、权重、诊断话术全部集中在 [config.py](config.py)，不涉及代码逻辑即可调优。

### 部署评测后端到 PythonAnywhere（免费版）

1. 注册后进入 **Files**，把本目录上传（或 `git clone`）到 `/home/<用户名>/humming-eval`
2. **Consoles** 打开 Bash：`pip3 install --user flask numpy`
3. **Web** → Add a new web app → **Manual configuration** → Python 3.10+
4. 编辑 WSGI 配置文件，替换为：

   ```python
   import sys
   sys.path.insert(0, "/home/<用户名>/humming-eval")
   from app import app as application
   ```

5. Reload 后访问 `https://<用户名>.pythonanywhere.com`（会重定向到游戏页；
   `/api/analyze` 接口本身仍可直接调用）
