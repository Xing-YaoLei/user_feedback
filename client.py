"""HTTP 客户端：访问测试目录接口。

接口约定：
- GET /api/datasets                      -> {"objects": [{type,id,version}, ...]}
- GET /api/object?type=T&id=I&version=V  -> 200 {"type","id","version","data","refs"}
                                            404 不存在 / 410 已删除 / 5xx 临时故障
返回的 FetchResult 保留服务端声明的版本号，供采集器做版本一致性校验。
"""
import json
import urllib.error
import urllib.parse
import urllib.request
from collections import namedtuple

Ref = namedtuple("Ref", ["type", "id", "version"])


class FetchResult:
    def __init__(self, status, payload=None, refs=None, returned_version=None, error=None):
        self.status = status                  # HTTP 状态码；网络错误时为 None
        self.payload = payload                # data 字段（业务数据）
        self.refs = refs or []                # [Ref, ...] 出边
        self.returned_version = returned_version
        self.error = error

    @property
    def ok(self):
        return self.status == 200


class HttpClient:
    def __init__(self, base_url, timeout=5):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def list_datasets(self):
        with urllib.request.urlopen(self.base_url + "/api/datasets",
                                    timeout=self.timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        return [Ref(o["type"], o["id"], o["version"]) for o in body["objects"]]

    def get_object(self, ref):
        qs = urllib.parse.urlencode(
            {"type": ref.type, "id": ref.id, "version": ref.version})
        url = f"{self.base_url}/api/object?{qs}"
        try:
            with urllib.request.urlopen(url, timeout=self.timeout) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return FetchResult(e.code, error=str(e))
        except Exception as e:  # 连接错误等
            return FetchResult(None, error=str(e))
        refs = [Ref(r["type"], r["id"], r["version"]) for r in body.get("refs", [])]
        return FetchResult(200, payload=body.get("data", {}), refs=refs,
                           returned_version=body.get("version"))
