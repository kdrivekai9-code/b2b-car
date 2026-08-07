import json, re, collections, datetime

recs = json.load(open('msgs.json', encoding='utf-8'))


def dt(r):
    return datetime.datetime.strptime(r['date'] + ' ' + r['t'], '%Y-%m-%d %H:%M')


byreq = collections.defaultdict(list)
for r in recs:
    if r['req'] and r['date']:
        byreq[r['req']].append(r)
for ms in byreq.values():
    ms.sort(key=dt)

# 1) 배차 통보 커버리지 / 지연
assign_re = r'(배정되었|배정\s*기사|기사명\s*[:：]|기사\s*01\d{8,9}|기사\s*010-)'
cov = 0; lat = []
for q, ms in byreq.items():
    c0 = next((m for m in ms if m['role'] == '고객'), None)
    a = next((m for m in ms if m['role'] == '상담원' and re.search(assign_re, m['text'])), None)
    if a:
        cov += 1
        if c0:
            d = (dt(a) - dt(c0)).total_seconds() / 60
            if 0 <= d <= 24 * 60:
                lat.append(d)
lat.sort()
print('[기사 배정 통보]')
print('  통보가 있는 요청 %d / %d (%.1f%%)' % (cov, len(byreq), 100 * cov / len(byreq)))
if lat:
    print('  접수→배정통보 중앙값 %.0f분 / p75 %.0f분 / p90 %.0f분' % (lat[len(lat)//2], lat[int(len(lat)*.75)], lat[int(len(lat)*.9)]))

# 2) 사진 커버리지
ph = sum(1 for ms in byreq.values() if any(re.search(r'사진', m['text']) for m in ms if m['role'] == '상담원'))
print('\n[사진 전송이 있는 요청] %d / %d (%.1f%%)' % (ph, len(byreq), 100 * ph / len(byreq)))

# 3) 주요 거점(출발/도착 키워드) 빈도
places = ['군포', '서서울모터리움', '안성', '롯데렌탈오토옥션', '평택', '인천', '부산', '대전', '광주', '대구', '창원', '천안', '원주', '강서']
cust_txt = '\n'.join(r['text'] for r in recs if r['role'] == '고객')
print('\n[고객 메시지 내 지역/거점 언급 빈도]')
for p in sorted(places, key=lambda x: -cust_txt.count(x)):
    print('  %-14s %4d' % (p, cust_txt.count(p)))

# 4) 차종 분포
models = ['티볼리', '토레스', '렉스턴스포츠', '렉스턴', '코란도', '액티언', '무쏘', '체어맨', '카이런', '봉고']
alltxt = '\n'.join(r['text'] for r in recs)
print('\n[차종 언급 빈도]')
for m in sorted(models, key=lambda x: -alltxt.count(x)):
    print('  %-12s %4d' % (m, alltxt.count(m)))

# 5) 즉시 vs 예약
intake = [r for r in recs if r['role'] == '고객' and re.search(r'\[출발지\]', r['text'])]
imm = sum(1 for r in intake if '즉시' in r['text'])
print('\n[접수 폼 %d건 중] 즉시 요청 %d (%.1f%%) / 시간 지정 %d (%.1f%%)'
      % (len(intake), imm, 100 * imm / len(intake), len(intake) - imm, 100 * (len(intake) - imm) / len(intake)))

# 6) 접수 폼 필드 추출 성공률 시뮬레이션 (룰 파서로 뽑히는지)
def parse(t):
    out = {}
    m = re.search(r'\[출발지\](.*?)(\[도착지\]|$)', t, re.S)
    if m: out['origin_block'] = m.group(1).strip()
    m = re.search(r'\[도착지\](.*)$', t, re.S)
    if m: out['dest_block'] = m.group(1).strip()
    out['plates'] = re.findall(r'\d{2,3}[가-힣]\s?\d{4}', t)
    out['phones'] = re.findall(r'01[016789][-\s]?\d{3,4}[-\s]?\d{4}', t)
    m = re.search(r'(즉시|\d{1,2}\s*[/월]\s*\d{1,2}[^\n]*|\d{1,2}\s*시\s*\d{0,2}\s*분?)', t)
    if m: out['when'] = m.group(1).strip()
    return out

ok = collections.Counter()
for r in intake:
    p = parse(r['text'])
    ok['출발지 블록'] += bool(p.get('origin_block'))
    ok['도착지 블록'] += bool(p.get('dest_block'))
    ok['차량번호 1개 이상'] += bool(p['plates'])
    ok['연락처 2개 이상(양쪽)'] += len(p['phones']) >= 2
    ok['일시'] += bool(p.get('when'))
    ok['전체 필수필드 충족'] += bool(p.get('origin_block') and p.get('dest_block') and p['plates'] and p.get('when'))
print('\n[룰 파서만으로 접수 폼에서 뽑히는 비율] n=%d' % len(intake))
for k, v in ok.items():
    print('  %-20s %4d  %5.1f%%' % (k, v, 100 * v / len(intake)))
