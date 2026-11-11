"""解码核心：候选编码评估、不可逆替换定位、字节↔字符对照。

铁律：绝不使用 errors='ignore'。所有非法字节都以 U+FFFD 替换并逐条记录
（字节区间、原始字节、原因、字符位置），保证没有静默丢失。
"""
from __future__ import annotations

import codecs
import contextvars

from .evidence import normalize_encoding

REPLACEMENT_CHAR = '\ufffd'
# 解码过程中用私用区哨兵标记替换位置，避免与原文本就有的 U+FFFD 混淆
_SENTINEL = '\ue000'

DEFAULT_ENCODINGS = ('utf-8', 'gb18030', 'big5')
DERIVED_PENALTY = 15.0   # 派生（双重转码恢复）候选的分数惩罚
SCORE_MARGIN = 5.0       # 次优候选接近最优时触发人工复核

_error_log: contextvars.ContextVar[list | None] = contextvars.ContextVar(
    'ev_error_log', default=None)


def _logging_replace(exc: UnicodeError):
    """与内置 'replace' 行为一致，但逐条记录每一次不可逆替换。"""
    if isinstance(exc, UnicodeDecodeError):
        log = _error_log.get()
        if log is not None:
            log.append({
                'byte_start': exc.start,
                'byte_end': exc.end,
                'bytes_hex': exc.object[exc.start:exc.end].hex(' '),
                'reason': exc.reason,
            })
        newpos = exc.end if exc.end > exc.start else exc.start + 1
        return (_SENTINEL, newpos)
    if isinstance(exc, UnicodeEncodeError):
        return ('?', exc.end)
    raise exc


codecs.register_error('ev_logging_replace', _logging_replace)


def _build_byte_map(data: bytes, codec: str) -> list[dict]:
    """逐字节喂给增量解码器，记录每个输出字符对应的原始字节区间。"""
    dec = codecs.getincrementaldecoder(codec)(errors='ev_logging_replace')
    token = _error_log.set(None)  # 本遍不记录，只取边界
    mapping = []
    pending = 0
    try:
        for i in range(len(data)):
            out = dec.decode(data[i:i + 1])
            if out:
                for ch in out:
                    mapping.append({
                        'char': ch,
                        'byte_start': pending,
                        'byte_end': i + 1,
                        'replacement': ch == _SENTINEL,
                    })
                pending = i + 1
        out = dec.decode(b'', final=True)
        if out:
            for ch in out:
                mapping.append({
                    'char': ch,
                    'byte_start': pending,
                    'byte_end': len(data),
                    'replacement': ch == _SENTINEL,
                })
    finally:
        _error_log.reset(token)
    return mapping


def decode_logged(data: bytes, encoding: str):
    """整体解码并记录替换位置。

    返回 (text, replacements, byte_map, bom_len)：
    - text: 解码文本（哨兵已换回 U+FFFD）
    - replacements: [{byte_start, byte_end, bytes_hex, reason, char_index}]
    - byte_map: [{char, byte_start, byte_end, replacement}]（哨兵保留在 char 中）
    - bom_len: BOM 字节数（偏移已计入上述位置）
    """
    bom_len = 0
    body = data
    if encoding == 'utf-8' and data.startswith(codecs.BOM_UTF8):
        bom_len = len(codecs.BOM_UTF8)
        body = data[bom_len:]

    log: list[dict] = []
    token = _error_log.set(log)
    try:
        text_s = body.decode(encoding, errors='ev_logging_replace')
    finally:
        _error_log.reset(token)

    byte_map = _build_byte_map(body, encoding)
    rebuilt = ''.join(m['char'] for m in byte_map)
    if rebuilt != text_s:
        raise RuntimeError(f'字节映射与解码结果不一致（{encoding}）')

    # 哨兵位置与替换日志一一对应（顺序一致）
    sentinel_positions = [i for i, c in enumerate(text_s) if c == _SENTINEL]
    for entry, pos in zip(log, sentinel_positions):
        entry['char_index'] = pos

    if bom_len:
        for m in byte_map:
            m['byte_start'] += bom_len
            m['byte_end'] += bom_len
        for entry in log:
            entry['byte_start'] += bom_len
            entry['byte_end'] += bom_len

    text = text_s.replace(_SENTINEL, REPLACEMENT_CHAR)
    return text, log, byte_map, bom_len


def _cjk_count(text: str) -> int:
    return sum(
        1 for c in text
        if '一' <= c <= '鿿'
        or '㐀' <= c <= '䶿'
        or 0x20000 <= ord(c) <= 0x2A6DF)


# 常用汉字集：真实文本中常用字占比高；错误编码产出的垃圾 CJK 近乎均匀分布，
# 常用字占比极低。借此区分"真的中文"与"碰巧合法的乱码"。
_COMMON_CJK = frozenset(
    '的一是不了人我在有他这中大来上国个到说们为子和你地出道也时年得就那要下'
    '以生会自着去之过家学对可她里后小么心多天而能好都然没日于起还发成事只作'
    '当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样现分'
    '将外但身些与新高意进法此月正世儿少门女工四非回场代建空东车水金马名期定'
    '立向合机山度化电平放解应题点位其六石办口海王张刘陈杨赵黄周吴徐孙胡朱林'
    '何郭罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘'
    '杜戴夏钟汪田任姜范方姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段雷'
    '钱汤尹黎易常武乔贺赖龚文号卷册页区县乡村社队组户人口名姓男女年龄岁月日'
    '元角分斤两尺寸亩厘公里米粮布油盐柴米茶记录表册簿据存根迁移入出增减改'
    '年月日号第册卷页档案局馆所室')


def _score(text: str, n_replacements: int, derived: bool) -> float:
    common = sum(1 for c in text if c in _COMMON_CJK)
    rare_cjk = _cjk_count(text) - common
    high_latin = sum(1 for c in text if 0x80 <= ord(c) <= 0x2FF)
    ctrl = sum(1 for c in text if ord(c) < 0x20 and c not in '\t\n\r')
    s = (3.0 * common
         - 1.0 * rare_cjk
         - 50.0 * n_replacements
         - 1.5 * high_latin
         - 5.0 * ctrl)
    if derived:
        s -= DERIVED_PENALTY
    return s


def candidate_encodings(evidence: dict) -> dict:
    """证据声明的编码 + 默认候选，去重后保留首个来源。返回 {编码名: 来源}。"""
    out: dict[str, str] = {}
    for decl in evidence.get('declarations', []):
        norm = normalize_encoding(decl['encoding'])
        if norm and norm not in out:
            out[norm] = f"evidence:{decl['source']}"
    for enc in DEFAULT_ENCODINGS:
        if enc not in out:
            out[enc] = 'default'
    return out


def _recovery_candidates(base_name: str, base_text: str) -> list[dict]:
    """双重转码恢复：UTF-8 字节被当作 latin-1/cp1252 解码后又存为 UTF-8。"""
    suspicious = sum(1 for c in base_text if 0x80 <= ord(c) <= 0x2FF)
    if suspicious < 2:
        return []
    out = []
    for wrong in ('latin-1', 'cp1252'):
        try:
            recovered = base_text.encode(wrong).decode('utf-8')
        except (UnicodeEncodeError, UnicodeDecodeError):
            continue
        if _cjk_count(recovered) > _cjk_count(base_text):
            out.append({
                'name': f'{base_name}(via {wrong} 双重转码恢复)',
                'source': 'derived:mojibake-recovery',
                'derived': True,
                'text': recovered,
                'replacements': [],
                'byte_map': None,
                'bom_len': 0,
            })
    return out


def _make_candidate(name: str, source: str, data: bytes) -> dict | None:
    try:
        text, repl, bmap, bom_len = decode_logged(data, name)
    except (LookupError, RuntimeError):
        return None
    return {
        'name': name,
        'source': source,
        'derived': False,
        'text': text,
        'replacements': repl,
        'byte_map': bmap,
        'bom_len': bom_len,
    }


def analyze(data: bytes, evidence: dict, override: str | None = None) -> dict:
    """评估所有候选编码并选定结果。

    override 不为 None 时强制使用指定编码（人工重新解析），
    可以是候选名（含派生候选）或任意 Python codec 名。
    """
    candidates: list[dict] = []
    for name, source in candidate_encodings(evidence).items():
        cand = _make_candidate(name, source, data)
        if cand is not None:
            candidates.append(cand)
    if not candidates:
        raise RuntimeError('没有任何可用候选编码')

    for base in list(candidates):
        if not base['derived']:
            candidates.extend(_recovery_candidates(base['name'], base['text']))

    for c in candidates:
        c['cjk'] = _cjk_count(c['text'])
        c['score'] = round(_score(c['text'], len(c['replacements']), c['derived']), 2)

    if override:
        selected = next((c for c in candidates if c['name'] == override), None)
        if selected is None:
            selected = _make_candidate(override, 'manual', data)
            if selected is None:
                names = ', '.join(c['name'] for c in candidates)
                raise ValueError(f'未知编码 {override!r}；可选候选：{names}')
            selected['cjk'] = _cjk_count(selected['text'])
            selected['score'] = round(_score(selected['text'],
                                             len(selected['replacements']), False), 2)
            candidates.append(selected)
        status = 'manual'
    else:
        selected = max(candidates, key=lambda c: c['score'])
        declared = set(evidence.get('normalized', []))
        runner_up = max((c for c in candidates if c is not selected),
                        key=lambda c: c['score'], default=None)
        needs_review = (
            evidence.get('conflict', False)
            or len(selected['replacements']) > 0
            or selected['derived']
            or (declared and not selected['derived']
                and selected['name'] not in declared)
            or (runner_up is not None
                and runner_up['score'] >= selected['score'] - SCORE_MARGIN)
        )
        status = 'needs_review' if needs_review else 'ok'

    summaries = [{
        'name': c['name'],
        'source': c['source'],
        'derived': c['derived'],
        'replacements': len(c['replacements']),
        'cjk_chars': c['cjk'],
        'score': c['score'],
        'selected': c is selected,
    } for c in sorted(candidates, key=lambda c: -c['score'])]

    return {
        'selected': selected,
        'candidates': summaries,
        'status': status,
        'policy': "errors='replace'（逐条记录；绝不静默丢弃非法字节）",
    }
