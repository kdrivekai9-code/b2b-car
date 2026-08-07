# 핸들모빌리티 탁송 상담톡 로그 → 메시지 단위 구조화(msgs.json).
# 원본 로그(고객·기사 실명과 휴대폰 번호 포함)는 개인정보라 저장소에 넣지 않는다 —
# 작업용 임시 디렉터리에 두고 경로만 인자로 넘긴다.
#
#   python3 parse_log.py <로그파일> [출력=msgs.json]
import json, re, sys, collections, statistics

src_path = sys.argv[1] if len(sys.argv) > 1 else 'handle-consult.txt'
out_path = sys.argv[2] if len(sys.argv) > 2 else 'msgs.json'

lines = open(src_path, encoding='utf-8').read().split('\n')

date_re = re.compile(r'^=+\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*(\S+)\s*=+')
req_re = re.compile(r'^─+\s*요청\s*#(\d+)\s*─+')
msg_re = re.compile(r'^\[(고객|상담원)\]\s*\[(오전|오후)\s*(\d{1,2}):(\d{2})\]\s?(.*)$')

recs = []
cur = None
date = None
req = None
for ln in lines:
    m = date_re.match(ln)
    if m:
        date = '%s-%02d-%02d' % (m.group(1), int(m.group(2)), int(m.group(3)))
        continue
    m = req_re.match(ln)
    if m:
        req = int(m.group(1))
        continue
    m = msg_re.match(ln)
    if m:
        role, ap, h, mi, rest = m.groups()
        h = int(h) % 12
        if ap == '오후':
            h += 12
        cur = {'role': role, 'date': date, 't': '%02d:%s' % (h, mi), 'req': req, 'text': rest}
        recs.append(cur)
        continue
    # 여러 줄에 걸친 메시지 본문(접수 폼 등)은 직전 메시지에 이어붙인다.
    if cur is not None:
        cur['text'] += '\n' + ln

json.dump(recs, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False)

print('messages:', len(recs))
print('by role:', dict(collections.Counter(r['role'] for r in recs)))
ds = [r['date'] for r in recs if r['date']]
print('date range:', min(ds), max(ds), '/ days:', len(set(ds)))
per = collections.Counter(r['req'] for r in recs if r['req'])
v = list(per.values())
print('requests:', len(per))
print('msgs/request: mean %.1f median %d p90 %d max %d'
      % (sum(v) / len(v), statistics.median(v), sorted(v)[int(len(v) * .9)], max(v)))
