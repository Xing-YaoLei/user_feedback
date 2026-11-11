"""回归测试：验证中文、人名、数字不因解码与清洗被无依据改写，
且非法字节绝不静默丢弃、改编码后记录按版本重算。
"""
from __future__ import annotations

import json
import shutil
import tempfile
import threading
import unittest
from pathlib import Path

from encoding_vault import acquire, pipeline, samples
from encoding_vault.server import make_server


class VaultTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='evault-test-'))
        cls.site = cls.tmp / 'site'
        cls.data = cls.tmp / 'data'
        samples.generate_samples(cls.site)
        cls.server = make_server(cls.site, 0)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        # 采集 + 首轮解码全部样本
        cls.shas = {}
        cls.records = {}
        manifest = json.loads((cls.site / 'manifest.json').read_text('utf-8'))
        for entry in manifest:
            url = f'http://127.0.0.1:{cls.port}/{entry["file"]}'
            sha = acquire.fetch(url, cls.data)
            cls.shas[entry['file']] = sha
            cls.records[entry['file']] = pipeline.decode_page(sha, cls.data)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # ---------- 工具 ----------

    def text_of(self, fname, version='v1'):
        sha = self.shas[fname]
        return (self.data / 'decode' / sha / f'{version}.txt').read_text('utf-8')

    def record_of(self, fname):
        return self.records[fname]

    def field_values(self, fname, field, version='v1'):
        rec = self.record_of(fname)
        hist = self.data / 'records' / 'history' / f"{rec['page_id']}__{version}.jsonl"
        return [json.loads(line)['value']
                for line in hist.read_text('utf-8').splitlines()
                if json.loads(line)['field'] == field]

    # ---------- 原始证据 ----------

    def test_raw_bytes_preserved_independently(self):
        for fname, sha in self.shas.items():
            raw = (self.data / 'raw' / f'{sha}.bin').read_bytes()
            original = (self.site / fname).read_bytes()
            self.assertEqual(raw, original, f'{fname} 原始字节被改动')
            meta = json.loads((self.data / 'raw' / f'{sha}.json').read_text('utf-8'))
            self.assertIn('response_headers', meta['fetches'][0])

    # ---------- 各样本解码正确性 ----------

    def test_ok_utf8_control_group(self):
        rec = self.record_of('ok-utf8.html')
        self.assertEqual(rec['status'], 'ok')
        self.assertEqual(rec['encoding'], 'utf-8')
        self.assertEqual(rec['replacements'], [])
        text = self.text_of('ok-utf8.html')
        for expected in ('李秀英', '1949年10月1日', 'A-00317', '1234.5', '王档案馆'):
            self.assertIn(expected, text)

    def test_gb18030_bytes_despite_utf8_declaration(self):
        """字节是 GB18030、声明谎称 UTF-8：不得照声明产出乱码。"""
        rec = self.record_of('gb-as-utf8.html')
        self.assertEqual(rec['encoding'], 'gb18030')
        self.assertEqual(rec['status'], 'needs_review')  # 声明与实际不符须复核
        text = self.text_of('gb-as-utf8.html')
        for expected in ('王建国', '1953年2月18日', 'B-11042', '86.75'):
            self.assertIn(expected, text)
        self.assertNotIn('�', text)

    def test_bom_wins_over_wrong_meta(self):
        rec = self.record_of('bom-vs-meta.html')
        self.assertEqual(rec['encoding'], 'utf-8')
        self.assertTrue(rec['evidence']['conflict'])  # BOM 与 meta 冲突被记录
        text = self.text_of('bom-vs-meta.html')
        for expected in ('张梅', '1962年7月9日', 'C-20871', '17.30'):
            self.assertIn(expected, text)

    def test_truncated_multibyte_not_silently_dropped(self):
        """截断的多字节字符：必须留下不可逆替换记录，不得悄悄忽略。"""
        rec = self.record_of('truncated-gb.html')
        self.assertGreaterEqual(len(rec['replacements']), 1)
        entry = rec['replacements'][0]
        self.assertIn('byte_start', entry)
        self.assertIn('char_index', entry)
        self.assertEqual(entry['bytes_hex'], 'cd')  # “完”的首字节 0xCD 被截孤
        text = self.text_of('truncated-gb.html')
        self.assertIn('�', text)
        self.assertIn('刘志强', text)  # 截断前的内容完好
        self.assertEqual(rec['status'], 'needs_review')

    def test_double_encoded_mojibake_recovered(self):
        """重复转码乱码：派生恢复候选应还原原文，且标记需人工复核。"""
        rec = self.record_of('double-encoded.html')
        self.assertEqual(rec['status'], 'needs_review')
        self.assertTrue(rec['encoding'].startswith('utf-8(via'))
        text = self.text_of('double-encoded.html')
        for expected in ('周文斌', '1978年12月30日', 'E-90013', '500'):
            self.assertIn(expected, text)

    def test_gb18030_four_byte_char(self):
        rec = self.record_of('gb18030-4byte.html')
        text = self.text_of('gb18030-4byte.html')
        self.assertIn('𠮷家庄', text)  # 四字节字符不得丢失
        self.assertIn('赵德柱', text)
        self.assertIn('612', text)

    # ---------- 字节↔字符对照 ----------

    def test_byte_map_contiguous_and_complete(self):
        sha = self.shas['ok-utf8.html']
        raw = (self.data / 'raw' / f'{sha}.bin').read_bytes()
        bmap = json.loads(
            (self.data / 'decode' / sha / 'v1.map.json').read_text('utf-8'))
        self.assertEqual(bmap[0]['byte_start'], 0)
        self.assertEqual(bmap[-1]['byte_end'], len(raw))
        for prev, cur in zip(bmap, bmap[1:]):
            self.assertEqual(prev['byte_end'], cur['byte_start'])
        # 非替换字符的字节区间重新解码必须等于该字符
        for m in bmap:
            if not m['replacement']:
                self.assertEqual(
                    raw[m['byte_start']:m['byte_end']].decode('utf-8'), m['char'])

    def test_report_page_generated(self):
        rec = self.record_of('truncated-gb.html')
        html = (self.data / 'report'
                / f"{rec['page_id']}__v1.html").read_text('utf-8')
        self.assertIn('不可逆替换位置', html)
        self.assertIn('字节 ↔ 字符对照表', html)
        self.assertIn('cd', html)  # 被截孤的字节出现在报告中

    # ---------- 人工指定编码重解析与版本重算 ----------

    def test_manual_override_recomputes_records(self):
        sha = self.shas['gb-as-utf8.html']
        # 先故意指定一个错误编码
        rec2 = pipeline.decode_page(sha, self.data, override='big5')
        self.assertEqual(rec2['decode_version'], 'v2')
        self.assertEqual(rec2['status'], 'manual')
        page_id = rec2['page_id']
        records_v2 = [json.loads(l) for l in
                      (self.data / 'records' / f'{page_id}.jsonl')
                      .read_text('utf-8').splitlines()]
        self.assertTrue(all(r['decode_version'] == 'v2' for r in records_v2))
        # 再指定正确编码，版本递增，记录重算且旧版本快照保留
        pipeline.set_override(self.data, sha, 'gb18030')
        rec3 = pipeline.decode_page(sha, self.data)
        self.assertEqual(rec3['decode_version'], 'v3')
        self.assertEqual(rec3['encoding'], 'gb18030')
        text3 = self.text_of('gb-as-utf8.html', 'v3')
        self.assertIn('王建国', text3)
        hist = self.data / 'records' / 'history'
        self.assertTrue((hist / f'{page_id}__v1.jsonl').exists())
        self.assertTrue((hist / f'{page_id}__v2.jsonl').exists())
        self.assertTrue((hist / f'{page_id}__v3.jsonl').exists())
        # v1 解码产物未被覆盖
        self.assertTrue((self.data / 'decode' / sha / 'v1.json').exists())

    def test_override_persisted_and_auto_applied(self):
        sha = self.shas['double-encoded.html']
        pipeline.set_override(self.data, sha, 'utf-8(via latin-1 双重转码恢复)')
        rec = pipeline.decode_page(sha, self.data)  # 不传 override 也生效
        self.assertEqual(rec['status'], 'manual')
        self.assertIn('周文斌', self.text_of('double-encoded.html',
                                             rec['decode_version']))

    # ---------- 清洗不得无依据改写 ----------

    def test_names_dates_numbers_verbatim_in_records(self):
        """结构化记录中的中文、人名、数字必须与解码文本逐字一致。"""
        expectations = {
            'ok-utf8.html': {'姓名': ['李秀英'], '日期': ['1949年10月1日'],
                             '编号': ['A-00317']},
            'gb-as-utf8.html': {'姓名': ['王建国'], '日期': ['1953年2月18日']},
            'bom-vs-meta.html': {'姓名': ['张梅'], '日期': ['1962年7月9日']},
            'double-encoded.html': {'姓名': ['周文斌'], '日期': ['1978年12月30日']},
            'gb18030-4byte.html': {'姓名': ['赵德柱'], '日期': ['1985年4月2日']},
        }
        for fname, fields in expectations.items():
            for field, values in fields.items():
                self.assertEqual(self.field_values(fname, field), values,
                                 f'{fname} 的 {field} 被改写')
        # 数字逐字核对（含小数）
        self.assertIn('1234.5', self.field_values('ok-utf8.html', '数字'))
        self.assertIn('86.75', self.field_values('gb-as-utf8.html', '数字'))
        self.assertIn('17.30', self.field_values('bom-vs-meta.html', '数字'))

    def test_records_char_offsets_match_text(self):
        """记录的字符偏移必须能在解码文本中切出同样的值（绑定版本可验证）。"""
        rec = self.record_of('ok-utf8.html')
        text = self.text_of('ok-utf8.html')
        for line in (self.data / 'records' / f"{rec['page_id']}.jsonl") \
                .read_text('utf-8').splitlines():
            r = json.loads(line)
            self.assertEqual(text[r['char_start']:r['char_end']], r['value'])

    def test_no_candidate_uses_ignore_policy(self):
        rec = self.record_of('truncated-gb.html')
        self.assertIn('replace', rec['decode_policy'])
        self.assertNotIn('ignore', rec['decode_policy'].lower())


if __name__ == '__main__':
    unittest.main()
