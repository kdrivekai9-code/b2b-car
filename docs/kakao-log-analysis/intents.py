import json, re, collections

recs = json.load(open('msgs.json', encoding='utf-8'))
cust = [r for r in recs if r['role'] == '고객']


def is_intake(t):
    return bool(re.search(r'(\[출발지\]|＊출발지|출발지\s*[:：])', t)) and bool(
        re.search(r'(\[도착지\]|＊도착지|도착지\s*[:：])', t))


intake = [r for r in cust if is_intake(r['text'])]
print('접수 폼 메시지: %d / 고객 %d (%.1f%%)' % (len(intake), len(cust), 100 * len(intake) / len(cust)))
hdr = collections.Counter()
for r in intake:
    first = r['text'].split('\n')[0].strip()
    hdr['헤더없음(바로 [출발지])' if first.startswith('[출발지]') else '헤더문장 있음'] += 1
print(dict(hdr))

rest = [r for r in cust if not is_intake(r['text'])]
pats = [
    ('기사 연락처/배차정보 요청', r'(기사(님|분)?\s*(연락처|전화|번호|성함)|탁송기사\s*연락처|배차\s*(정보|되면|완료|확인))'),
    ('주행거리/키로수 확인', r'(주행거리|키로수|킬로|km|출발\s*키로|도착\s*키로)'),
    ('사진 요청/전달', r'사진'),
    ('서류(등록증·인감·위임장)', r'(등록증|인감|위임장|서명사실|서류)'),
    ('책임보험 가입', r'(책임보험|보험\s*가입|가입\s*(요청|부탁|완료))'),
    ('상태확인(어디/도착?)', r'(어디|언제쯤|도착\s*(했|하셨|예정|시간)|출발\s*(했|하셨)|미도착|얼마나|몇\s*시)'),
    ('변경', r'(변경|수정|바꿔|바뀌|연기|미뤄|당겨)'),
    ('취소', r'(취소|캔슬)'),
    ('요금·정산·계산서', r'(요금|금액|비용|정산|세금계산서|계산서|입금|송금|결제|단가|청구)'),
    ('과태료·통행료·주유비', r'(과태료|통행료|하이패스|주유비|기름값|범칙금)'),
    ('현장/주차 위치 안내', r'(주차|지하|입구|경비실|키\s*(맡|전달|인계)|정문|후문)'),
    ('지연·불만·사고', r'(늦|지연|아직|왜\s|안\s*(오|왔)|사고|파손|스크래치|기스|찍힘|클레임|문제가)'),
    ('단순 응대', r'^[\s]*(네+[~\s.!ㅣ]*|넵+[~\s.!]*|예[.,\s]*|감사합니다[\s.!~]*|확인(했|하겠)습니다[\s.!]*|알겠습니다[\s.!]*|수고(하세요|하셨습니다)[\s.!]*)+$'),
]
print('\n[접수 외 고객 메시지 인텐트] 총 %d (중복집계)' % len(rest))
hit = collections.Counter()
un = []
for r in rest:
    got = False
    for k, p in pats:
        if re.search(p, r['text']):
            hit[k] += 1
            got = True
    if not got:
        un.append(r['text'])
for k, _ in pats:
    print('  %-24s %4d  %5.1f%%' % (k, hit[k], 100 * hit[k] / len(rest)))
print('  %-24s %4d  %5.1f%%' % ('미분류', len(un), 100 * len(un) / len(rest)))
json.dump(un, open('unmatched2.json', 'w', encoding='utf-8'), ensure_ascii=False)
