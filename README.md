# 本地 MQTT 遥测采集项目

不依赖 Docker，使用本机开源 broker（mosquitto）+ Python 标准库与 paho-mqtt，
模拟多设备遥测上报并完成采集、去重、异常标注与背压处理，附带单页排障面板。

## 1. Broker 安装与启动（本机，无 Docker）

### macOS（Homebrew）

```bash
brew install mosquitto
# 前台试跑（可选）：/opt/homebrew/sbin/mosquitto -c mosquitto/mosquitto.conf
bash scripts/start_broker.sh     # 后台启动，监听 127.0.0.1:1883
bash scripts/stop_broker.sh      # 停止
```

### Debian/Ubuntu

```bash
sudo apt update && sudo apt install -y mosquitto
# 用项目配置前台启动（systemd 自带实例占用 1883 时先 sudo systemctl stop mosquitto）
mosquitto -c mosquitto/mosquitto.conf
```

项目配置 `mosquitto/mosquitto.conf` 要点：

- 只监听 `127.0.0.1:1883`，允许匿名，本地开发免账号；
- `persistence true`：**必须开启**。采集器使用固定 client_id +
  `clean_session=false`，离线期间 broker 靠持久化把 QoS1 消息排队，重连后补投；
- 日志：`/tmp/mosquitto-telemetry/broker.log`。

自检：`mosquitto_pub -h 127.0.0.1 -t test -m hello` 不报错即正常。

## 2. 安装 Python 依赖

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## 3. 运行

开三个终端（broker 已在后台运行时只需后两个）：

```bash
# 终端 A：采集服务（含排障面板 http://127.0.0.1:8080）
.venv/bin/python -m mqtt_telemetry.collector_app

# 终端 B：端到端演示（内嵌采集器，独立 db，可直接看断言结果）
.venv/bin/python scripts/run_demo.py

# 单台设备模拟器（可选）
.venv/bin/python -m mqtt_telemetry.simulator --device dev-1 --count 20 \
    --duplicate-prob 0.3 --restart-at 5 --unit-switch-at 8 \
    --skew-at 10 --skew-seconds -60
```

背压演示（小队列 + 人为慢下游，过载丢弃与缺口会明确记录）：

```bash
.venv/bin/python -m mqtt_telemetry.collector_app --queue-max 8 \
    --slow-processing 0.02 --db data/bp.db --web-port 8091
.venv/bin/python scripts/run_backpressure_demo.py
# 打开 http://127.0.0.1:8091 查看「过载事件」「序号缺口」
```

## 4. 报文协议与核心语义

主题：`telemetry/<device_id>/up`，载荷 JSON：

```json
{"boot_id": "4973a228…", "seq": 12, "device_ts": 1731283200.512,
 "value": 21.4, "unit": "degC"}
```

**消息身份 = `(device_id, boot_id, seq)`**，SQLite 上有 UNIQUE 约束硬保证。

| 场景 | 判定与处理 |
|---|---|
| 网络重复投递 | 三元组完全相同（QoS1 重发、broker 持久会话补投、应用层重发）→ 不新增行，`dup_count+1`，状态 `duplicate_network` |
| 设备重启后 seq 重用 | `boot_id` 变了，seq 从 1 重新开始是**合法新测量**，标 `device_restart`；绝不能只按 `(device_id, seq)` 判重 |
| retained 保留消息 | 设备从未出现过的 retained → 存为 `retained_snapshot`，**不计新测量、不写设备状态**；同身份在线消息到达后快照行删除并转走完整入账状态机，标 `retained_snapshot_promoted`。设备已在线时收到的 retained 标 `retained_redelivery` 仍按新测量入账 |
| 单位切换 | 原值/原单位原样保留，另列 `canonical_value/canonical_unit` 折算标准单位（degF/kelvin→degC，kPa/Pa→hPa，ratio→percent），标 `unit_switched` 并写解释 |
| 时钟回拨 | 新 `device_ts` 早于该设备上一条 → 原始时间戳保留不改，标 `clock_skew`，解释回拨秒数，排序以接收时间为准 |
| 序号缺口 | 同 boot 内 `seq > last_seq+1` → 写 `gap_events`（期望/实际/缺失条数），这是丢失数据的权威统计口径 |
| 背压过载 | 网络线程向有界队列 `put_nowait`，满即丢并写 `overload_events`（队列大小+被丢身份），**绝不阻塞网络线程**；后续 seq 缺口量化实际丢失条数 |

多个异常可叠加在同一条消息上（如重启同时回拨+换单位，flags 以逗号拼接）。

## 5. 架构与背压策略

```
设备模拟器(s)  --QoS1-->  mosquitto(持久化)  --QoS1, 订阅 telemetry/+/up -->
  paho 网络线程: 解析 -> 有界 Queue(默认256), 满则过载丢弃并落库
                           |
  db-worker 线程: Storage.ingest() 单连接 + RLock + WAL，全部语义判定与落库
                           |
                    SQLite(data/telemetry.db)
  http 线程(标准库): 排障面板 / 与 /api/state、/healthz
```

有限缓冲策略的取舍：

- 只缓冲已解析的领域对象，容量固定（`--queue-max`），内存有上界；
- 过载选择**丢新不阻塞**：阻塞网络线程会导致 keepalive 超时、broker 断连，
  故障放大；丢弃事件全部留痕，且 seq 缺口能事后精确还原丢了哪几条；
- 关停时先断 MQTT 再排空队列（drain 5s），避免正常停机丢数据。

## 6. 排障面板

`http://127.0.0.1:8080`（2 秒自动刷新）：连接状态/session_present、关键计数卡片、
设备当前 boot 与最后序号、最近测量（原值与标准值并列、异常解释）、序号缺口、
过载事件、运行事件流。程序化访问用 `GET /api/state`。

## 7. 测试

```bash
.venv/bin/python -m pytest          # 25 个测试，约 15s
```

- `tests/test_protocol.py`：报文校验、主题规则、单位换算（无需 broker）；
- `tests/test_storage.py`：身份去重、重启 seq 重用、retained 快照与转正、
  单位切换原值保留、时钟回拨、缺口、多异常叠加（无需 broker）；
- `tests/test_integration.py`：每个用例启动**独立端口的真实 mosquitto**，
  验证重连前后记录身份一致（补投只增 `dup_count`）、重启 seq 重用识别、
  真实链路上的单位转换、缺口统计、retained 快照、背压过载落库。
  本机未装 mosquitto 时该文件自动 skip。

## 8. 目录结构

```
mosquitto/mosquitto.conf      broker 配置（本机回环+持久化）
mqtt_telemetry/
  config.py                   全部可调参数
  protocol.py                 报文解析、身份定义、单位换算
  storage.py                  SQLite 落库与全部语义状态机
  collector.py                MQTT 采集、有界队列背压、工作线程
  simulator.py                设备模拟器（重启/离线/重发/回拨/换单位/retained）
  dashboard.py                排障面板（标准库 http.server）
  collector_app.py            采集服务入口
scripts/start_broker.sh, stop_broker.sh
scripts/run_demo.py           端到端场景（含断言）
scripts/run_backpressure_demo.py
tests/                        单元 + 集成测试
```

## 9. 直接查库

```bash
sqlite3 data/telemetry.db \
  "SELECT device_id,boot_id,seq,status,flags FROM measurements ORDER BY id DESC LIMIT 20;"
```
