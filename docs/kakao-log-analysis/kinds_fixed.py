import json, re, collections

recs = json.load(open('msgs.json', encoding='utf-8'))
cust = [r for r in recs if r['role'] == '고객']
form = [r for r in cust if re.search(r'(\[출발지\]|＊출발지)', r['text'])]
print('접수 폼 메시지(출발지 블록 기준): %d' % len(form))

kinds = collections.Counter()
for r in form:
    head = r['text'].split('[출발지]')[0][:80]
    if '매입' in head:
        k = '매입 탁송 (지방 → 군포 입고)'
    elif re.search(r'(책임보험|보험\s*가입)', head):
        k = '탁송 + 책임보험 가입'
    elif '군포' in head:
        k = '군포 출고 탁송'
    elif head.strip():
        k = '기타 헤더 문장'
    else:
        k = '헤더 없음 (폼만 전송)'
    kinds[k] += 1
print('\n[접수 유형] n=%d' % len(form))
for k, v in kinds.most_common():
    print('  %-24s %4d  %5.1f%%' % (k, v, 100 * v / len(form)))

extras = {
    '주유 요청': r'주유',
    '서류(등록증·인감)': r'(등록증|인감|서명사실)',
    '책임보험 가입': r'(책임보험|보험\s*가입)',
    '출고일 기재': r'출고일',
    '연료 잔량(현 N칸)': r'현\s*\d\s*칸',
    '즉시 출발': r'즉시',
}
print('\n[접수 폼에 붙는 부가 조건] n=%d' % len(form))
for k, p in extras.items():
    n = sum(1 for r in form if re.search(p, r['text']))
    print('  %-18s %4d  %5.1f%%' % (k, n, 100 * n / len(form)))
n = sum(1 for r in form if len(set(re.findall(r'\d{2,3}[가-힣]\s?\d{4}', r['text']))) > 1)
print('  %-18s %4d  %5.1f%%' % ('복수 차량', n, 100 * n / len(form)))

dirs = collections.Counter()
for r in form:
    parts = r['text'].split('[도착지]')
    o = parts[0]
    d = parts[-1] if len(parts) > 1 else ''
    oo = '군포' if '군포' in o else ('서서울' if '서서울' in o else '기타지역')
    dd = '군포' if '군포' in d else ('서서울' if '서서울' in d else '기타지역')
    dirs['%s → %s' % (oo, dd)] += 1
print('\n[운행 방향] n=%d' % len(form))
for k, v in dirs.most_common(8):
    print('  %-18s %4d  %5.1f%%' % (k, v, 100 * v / len(form)))
