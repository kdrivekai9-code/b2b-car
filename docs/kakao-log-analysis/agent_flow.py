import json, re, collections, statistics, datetime

recs = json.load(open('msgs.json', encoding='utf-8'))
ag = [r for r in recs if r['role'] == '상담원']
cust = [r for r in recs if r['role'] == '고객']

# ---------- 1. 상담원 메시지 분류 ----------
apats = [
    ('사진 전송', r'^사진(\s*\d+장)?$|사진입니다|사진\s*\d+장'),
    ('접수 확인(단순 ack)', r'^\s*(네+|넵+|안녕하세요)?\s*(접수하겠습니다|접수했습니다|접수완료)[\s.!~]*$'),
    ('출발/도착 사진 캡션', r'(출발사진|도착사진|출발전|도착후)'),
    ('배차/기사 안내', r'(기사님\s*(성함|연락처|번호)|배차\s*(완료|되었|했습니다)|기사\s*배정|담당기사)'),
    ('진행상태 통보', r'(출발했습니다|출발합니다|도착했습니다|도착예정|이동\s*중|출발\s*예정|완료되었습니다|탁송완료)'),
    ('주행거리 보고', r'(주행거리|키로수|km|계기판)'),
    ('요금/정산 안내', r'(요금|금액|비용|정산|세금계산서|계산서|입금|청구|단가)'),
    ('보험 가입 처리', r'(가입하겠습니다|가입완료|책임보험)'),
    ('서류 안내', r'(등록증|인감|위임장|서류)'),
    ('취소/변경 처리', r'(취소하겠습니다|취소되었|변경하겠습니다|변경완료)'),
    ('사과/지연 설명', r'(죄송|지연|늦어|양해)'),
    ('안전운행 필수안내', r'(운행시작전|이상유무|필수안내|특이사항)'),
    ('단순 응대', r'^[\s]*(네+[~\s.!]*|넵+[~\s.!]*|감사합니다[\s.!~]*|알겠습니다[\s.!]*|확인했습니다[\s.!]*)+$'),
]
hit = collections.Counter(); un = []
for r in ag:
    got = False
    for k, p in apats:
        if re.search(p, r['text']):
            hit[k] += 1; got = True
    if not got:
        un.append(r['text'])
print('[상담원 메시지 분류] 총 %d (중복집계)' % len(ag))
for k, _ in apats:
    print('  %-20s %5d  %5.1f%%' % (k, hit[k], 100 * hit[k] / len(ag)))
print('  %-20s %5d  %5.1f%%' % ('미분류', len(un), 100 * len(un) / len(ag)))
json.dump(un, open('agent_unmatched.json', 'w', encoding='utf-8'), ensure_ascii=False)

# ---------- 2. 첫 응답 지연 ----------
def dt(r):
    return datetime.datetime.strptime(r['date'] + ' ' + r['t'], '%Y-%m-%d %H:%M')

byreq = collections.defaultdict(list)
for r in recs:
    if r['req'] and r['date']:
        byreq[r['req']].append(r)
lat = []
for q, ms in byreq.items():
    ms.sort(key=dt)
    first_c = next((m for m in ms if m['role'] == '고객'), None)
    if not first_c:
        continue
    i = ms.index(first_c)
    first_a = next((m for m in ms[i:] if m['role'] == '상담원'), None)
    if not first_a:
        continue
    d = (dt(first_a) - dt(first_c)).total_seconds() / 60
    if 0 <= d <= 24 * 60:
        lat.append(d)
lat.sort()
print('\n[고객 첫 메시지 → 상담원 첫 응답] n=%d' % len(lat))
print('  중앙값 %.0f분 / 평균 %.0f분 / p75 %.0f분 / p90 %.0f분 / p95 %.0f분 / 최대 %.0f분'
      % (statistics.median(lat), sum(lat) / len(lat), lat[int(len(lat) * .75)], lat[int(len(lat) * .9)],
         lat[int(len(lat) * .95)], lat[-1]))
for th in (1, 5, 10, 30, 60):
    print('  %d분 이내 응답: %.1f%%' % (th, 100 * sum(1 for x in lat if x <= th) / len(lat)))

# ---------- 3. 시간대 / 요일 / 월별 ----------
hours = collections.Counter(int(r['t'][:2]) for r in cust)
print('\n[고객 메시지 시간대 분포]')
for h in range(24):
    if hours[h]:
        print('  %02d시 %4d %s' % (h, hours[h], '█' * (hours[h] // 15)))
off = sum(v for h, v in hours.items() if h < 9 or h >= 18)
print('  업무시간외(09시 이전·18시 이후) 비중: %.1f%%' % (100 * off / sum(hours.values())))

mon = collections.Counter(r['date'][:7] for r in recs if r['date'])
print('\n[월별 메시지량 최근 14개월]')
for k in sorted(mon)[-14:]:
    print('  %s %5d %s' % (k, mon[k], '█' * (mon[k] // 20)))

# 요청 건수 월별
reqmon = collections.Counter()
seen = set()
for r in recs:
    if r['req'] and r['req'] not in seen and r['date']:
        seen.add(r['req']); reqmon[r['date'][:7]] += 1
print('\n[월별 요청(대화 블록) 수 최근 14개월]')
for k in sorted(reqmon)[-14:]:
    print('  %s %4d' % (k, reqmon[k]))
